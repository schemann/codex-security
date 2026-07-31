/**
 * Local HTTP proxy that lets the Codex binary (OpenAI Responses API, SSE)
 * talk to the Kimi Code API (OpenAI Chat Completions).
 *
 *   Codex -> POST http://127.0.0.1:<port>/v1/responses
 *         -> proxy -> POST <KIMI_BASE_URL>/chat/completions
 *
 * Configuration is entirely environment-driven (see `proxyConfigFromEnv`):
 * KIMI_API_KEY (required), KIMI_BASE_URL, PORT, PROXY_MODEL_MAP,
 * PROXY_THINKING_FIELD, PROXY_PASSTHROUGH_WEBSEARCH, PROXY_LOG.
 * The API key is only ever sent upstream as a bearer token and is never
 * logged.
 */

import { createRequire } from "node:module";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import {
  translateRequest,
  type TranslateRequestOptions,
} from "./translate-request.js";
import {
  ChatToResponsesTranslator,
  chatCompletionToResponse,
} from "./translate-stream.js";

type Json = Record<string, unknown>;

/**
 * Honest, identifiable User-Agent for upstream Kimi requests (the Kimi API
 * terms require an untampered client identity). The version is read from the
 * package manifest at startup (dist/proxy/server.js and src/proxy/server.ts
 * are both two levels below the package root); falls back to a static
 * placeholder when the manifest is unavailable.
 */
const PROXY_USER_AGENT = `codex-security-kimi/${packageVersion()}`;

function packageVersion(): string {
  try {
    const require = createRequire(import.meta.url);
    const manifest = require("../../package.json") as { version?: unknown };
    if (typeof manifest.version === "string" && manifest.version.length > 0) {
      return manifest.version;
    }
  } catch {
    // fall through to the static fallback
  }
  return "0.0.0-unknown";
}

/**
 * Minimal fetch-compatible signature. Deliberately not `typeof fetch`: the
 * global fetch type carries extras (e.g. Bun's `preconnect`) that simple
 * async test doubles do not implement.
 */
export type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface ProxyConfig {
  apiKey: string;
  baseUrl: string;
  port: number;
  modelMap?: Record<string, string>;
  thinkingField?: string;
  passthroughWebSearch?: boolean;
  log?: (message: string) => void;
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: FetchLike;
}

export interface ProxyOptionsFromEnv {
  env?: NodeJS.ProcessEnv;
  log?: (message: string) => void;
  fetchImpl?: FetchLike;
}

function parseModelMap(
  raw: string | undefined,
): Record<string, string> | undefined {
  if (!raw) {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed)
    ) {
      const map: Record<string, string> = {};
      for (const [key, value] of Object.entries(parsed)) {
        if (typeof value === "string") {
          map[key] = value;
        }
      }
      return map;
    }
  } catch {
    // fall through
  }
  throw new Error("PROXY_MODEL_MAP must be a JSON object of string->string");
}

export function proxyConfigFromEnv(
  options: ProxyOptionsFromEnv = {},
): ProxyConfig {
  const env = options.env ?? process.env;
  const apiKey = env["KIMI_API_KEY"];
  if (!apiKey) {
    throw new Error("KIMI_API_KEY is required");
  }
  const port = env["PORT"] ? Number.parseInt(env["PORT"], 10) : 0;
  if (!Number.isFinite(port) || port < 0 || port > 65535) {
    throw new Error(`PORT must be a valid TCP port, got: ${env["PORT"] ?? ""}`);
  }
  const debug = env["PROXY_LOG"] === "1";
  return {
    apiKey,
    baseUrl: (env["KIMI_BASE_URL"] ?? "https://api.kimi.com/coding/v1").replace(
      /\/+$/,
      "",
    ),
    port,
    modelMap: parseModelMap(env["PROXY_MODEL_MAP"]),
    thinkingField: env["PROXY_THINKING_FIELD"],
    passthroughWebSearch: env["PROXY_PASSTHROUGH_WEBSEARCH"] === "1",
    log: debug
      ? (message) => {
          process.stderr.write(`[proxy] ${message}\n`);
        }
      : undefined,
    fetchImpl: options.fetchImpl,
  };
}

async function readRequestBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function writeSseEvent(res: ServerResponse, event: Json): void {
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}

function writeSseFailure(
  res: ServerResponse,
  translator: ChatToResponsesTranslator,
  message: string,
  code?: string,
): void {
  for (const event of translator.fail(message, code)) {
    writeSseEvent(res, event);
  }
  res.end();
}

function sendJson(res: ServerResponse, status: number, body: Json): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function errorBody(message: string, code: string): Json {
  return { error: { message, type: "proxy_error", code } };
}

async function readUpstreamError(response: Response): Promise<string> {
  try {
    const text = await response.text();
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed === "object" && parsed !== null) {
      const error = (parsed as Json)["error"];
      if (typeof error === "object" && error !== null) {
        const message = (error as Json)["message"];
        if (typeof message === "string") {
          return message;
        }
      }
    }
    return text.slice(0, 500);
  } catch {
    return response.statusText || `HTTP ${response.status}`;
  }
}

async function handleResponses(
  req: IncomingMessage,
  res: ServerResponse,
  config: ProxyConfig,
): Promise<void> {
  const log = config.log ?? (() => {});
  const fetchImpl = config.fetchImpl ?? fetch;

  let clientBody: Json;
  try {
    clientBody = JSON.parse(await readRequestBody(req)) as Json;
  } catch {
    sendJson(
      res,
      400,
      errorBody("request body must be valid JSON", "invalid_json"),
    );
    return;
  }

  const translateOptions: TranslateRequestOptions = {
    modelMap: config.modelMap,
    passthroughWebSearch: config.passthroughWebSearch,
    thinkingField: config.thinkingField,
  };
  const translated = translateRequest(clientBody, translateOptions);
  const wantsStream = translated.stream;
  log(
    `POST /v1/responses model=${String(translated.body["model"] ?? "?")} stream=${wantsStream} ` +
      `messages=${(translated.body["messages"] as unknown[]).length} tools=${((translated.body["tools"] as unknown[] | undefined) ?? []).length}`,
  );

  const upstreamUrl = `${config.baseUrl}/chat/completions`;
  let upstream: Response;
  try {
    upstream = await fetchImpl(upstreamUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${config.apiKey}`,
        "user-agent": PROXY_USER_AGENT,
      },
      body: JSON.stringify(translated.body),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log(`upstream fetch failed: ${message}`);
    if (wantsStream) {
      const translator = new ChatToResponsesTranslator({
        namespaces: translated.namespaces,
        model:
          typeof translated.body["model"] === "string"
            ? translated.body["model"]
            : undefined,
      });
      res.writeHead(200, sseHeaders());
      writeSseFailure(
        res,
        translator,
        `upstream request failed: ${message}`,
        "upstream_unreachable",
      );
    } else {
      sendJson(
        res,
        502,
        errorBody(
          `upstream request failed: ${message}`,
          "upstream_unreachable",
        ),
      );
    }
    return;
  }

  const model =
    typeof translated.body["model"] === "string"
      ? translated.body["model"]
      : undefined;
  const translator = new ChatToResponsesTranslator({
    namespaces: translated.namespaces,
    model,
  });

  if (!upstream.ok) {
    const message = await readUpstreamError(upstream);
    log(`upstream error ${upstream.status}: ${message.slice(0, 200)}`);
    if (wantsStream) {
      res.writeHead(200, sseHeaders());
      writeSseFailure(
        res,
        translator,
        `upstream HTTP ${upstream.status}: ${message}`,
        "upstream_error",
      );
    } else {
      sendJson(
        res,
        upstream.status,
        errorBody(
          `upstream HTTP ${upstream.status}: ${message}`,
          "upstream_error",
        ),
      );
    }
    return;
  }

  if (!wantsStream) {
    let completion: unknown;
    try {
      completion = await upstream.json();
    } catch {
      sendJson(
        res,
        502,
        errorBody("upstream returned invalid JSON", "upstream_invalid"),
      );
      return;
    }
    sendJson(
      res,
      200,
      chatCompletionToResponse(completion, translated.namespaces),
    );
    return;
  }

  // Streaming path: parse upstream SSE and forward translated events.
  res.writeHead(200, sseHeaders());
  const body = upstream.body;
  if (!body) {
    writeSseFailure(
      res,
      translator,
      "upstream response has no body",
      "upstream_invalid",
    );
    return;
  }
  const decoder = new TextDecoder();
  let buffer = "";
  const clientGone = { value: false };
  res.on("close", () => {
    clientGone.value = true;
  });
  let finishReason: string | undefined;
  let usageSummary: string | undefined;
  const toolCallNames: string[] = [];
  try {
    const reader = body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (clientGone.value) {
        await reader.cancel().catch(() => {});
        return;
      }
      buffer += decoder.decode(value, { stream: true });
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line.startsWith("data:")) {
          continue;
        }
        const data = line.slice("data:".length).trim();
        if (data === "[DONE]") {
          continue;
        }
        let chunk: unknown;
        try {
          chunk = JSON.parse(data);
        } catch {
          log(`skipping unparseable upstream SSE data (${data.length} bytes)`);
          continue;
        }
        const raw = chunk as {
          choices?: {
            finish_reason?: unknown;
            delta?: { tool_calls?: { function?: { name?: unknown } }[] };
          }[];
          usage?: { prompt_tokens?: unknown; completion_tokens?: unknown };
        };
        const choice = raw.choices?.[0];
        if (typeof choice?.finish_reason === "string") {
          finishReason = choice.finish_reason;
        }
        for (const tc of choice?.delta?.tool_calls ?? []) {
          const name = tc?.function?.name;
          if (typeof name === "string" && !toolCallNames.includes(name)) {
            toolCallNames.push(name);
          }
        }
        if (raw.usage) {
          usageSummary = `in=${String(raw.usage.prompt_tokens)} out=${String(raw.usage.completion_tokens)}`;
        }
        for (const event of translator.handleChunk(chunk)) {
          writeSseEvent(res, event);
        }
      }
    }
    for (const event of translator.finish()) {
      writeSseEvent(res, event);
    }
    log(
      `stream done finish_reason=${finishReason ?? "?"} ${usageSummary ?? "usage=?"} tool_calls=[${toolCallNames.join(",")}]`,
    );
    res.end();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log(`mid-stream failure: ${message}`);
    if (!clientGone.value) {
      writeSseFailure(
        res,
        translator,
        `upstream stream failed: ${message}`,
        "upstream_stream_error",
      );
    }
  }
}

function sseHeaders(): Record<string, string> {
  return {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  };
}

export function createProxyServer(config: ProxyConfig): Server {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname.replace(/\/+$/, "") || "/";
    if (
      req.method === "GET" &&
      (path === "/healthz" || path === "/v1/healthz")
    ) {
      sendJson(res, 200, { status: "ok" });
      return;
    }
    if (
      req.method === "POST" &&
      (path === "/v1/responses" || path === "/responses")
    ) {
      handleResponses(req, res, config).catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        config.log?.(`unhandled handler error: ${message}`);
        if (!res.headersSent) {
          sendJson(res, 500, errorBody(message, "internal_error"));
        } else {
          res.end();
        }
      });
      return;
    }
    sendJson(
      res,
      404,
      errorBody(`not found: ${req.method ?? "?"} ${path}`, "not_found"),
    );
  });
  // Codex streams can idle for a long time between tokens; disable the
  // default Node request/idle timeouts instead of imposing our own budget.
  server.requestTimeout = 0;
  server.keepAliveTimeout = 0;
  server.headersTimeout = 0;
  return server;
}

export async function main(): Promise<number> {
  let config: ProxyConfig;
  try {
    config = proxyConfigFromEnv();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`codex-security-proxy: ${message}\n`);
    return 1;
  }
  const server = createProxyServer(config);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port, "127.0.0.1", () => {
      resolve();
    });
  });
  const address = server.address();
  const port =
    typeof address === "object" && address !== null
      ? address.port
      : config.port;
  // Machine-readable line for wrappers that need the chosen port.
  process.stdout.write(`PROXY_LISTENING port=${port}\n`);
  await new Promise<void>((resolve) => {
    const shutdown = () => {
      server.close(() => {
        resolve();
      });
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  });
  return 0;
}
