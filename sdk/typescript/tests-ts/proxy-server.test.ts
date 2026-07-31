import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createProxyServer,
  proxyConfigFromEnv,
  type FetchLike,
  type ProxyConfig,
} from "../src/proxy/server.js";

const fixtureDir = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

type Json = Record<string, unknown>;

const runningServers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    runningServers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => {
            resolve();
          });
        }),
    ),
  );
});

async function startProxy(
  fetchImpl: FetchLike,
  overrides: Partial<ProxyConfig> = {},
): Promise<{ server: Server; baseUrl: string; requests: string[] }> {
  const requests: string[] = [];
  const recordingFetch: FetchLike = async (input, init) => {
    if (typeof init?.body === "string") {
      requests.push(init.body);
    }
    return fetchImpl(input, init);
  };
  const server = createProxyServer({
    apiKey: "test-key-not-logged",
    baseUrl: "https://upstream.invalid/v1",
    port: 0,
    fetchImpl: recordingFetch,
    ...overrides,
  });
  runningServers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      resolve();
    });
  });
  const { port } = server.address() as AddressInfo;
  return { server, baseUrl: `http://127.0.0.1:${port}`, requests };
}

function sseResponse(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "text/event-stream" },
  });
}

function parseSse(text: string): Json[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice("data:".length).trim())
    .filter((data) => data !== "[DONE]")
    .map((data) => JSON.parse(data) as Json);
}

const STREAM_FIXTURE = readFileSync(
  join(fixtureDir, "kimi-chat-stream.sse"),
  "utf8",
);

function minimalRequest(stream: boolean): Json {
  return {
    model: "k3-256k",
    instructions: "You are helpful.",
    input: [
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "say hi" }],
      },
    ],
    stream,
    store: false,
    include: [],
  };
}

describe("proxy server", () => {
  test("GET /healthz responds ok", async () => {
    const { baseUrl } = await startProxy(async () => sseResponse(""));
    const response = await fetch(`${baseUrl}/healthz`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
  });

  test("POST /v1/responses streams translated Responses events", async () => {
    const { baseUrl, requests } = await startProxy(async (input, init) => {
      const url = String(input);
      expect(url).toBe("https://upstream.invalid/v1/chat/completions");
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toBe("Bearer test-key-not-logged");
      expect(headers.get("user-agent")).toMatch(/^codex-security-kimi\//);
      return sseResponse(STREAM_FIXTURE);
    });
    const response = await fetch(`${baseUrl}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(minimalRequest(true)),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    const events = parseSse(await response.text());
    const types = events.map((event) => event["type"]);
    expect(types[0]).toBe("response.created");
    expect(types[types.length - 1]).toBe("response.completed");
    expect(types).toContain("response.function_call_arguments.done");

    // The upstream request body is the translated chat request.
    expect(requests.length).toBe(1);
    const upstreamBody = JSON.parse(requests[0] ?? "{}") as Json;
    expect(upstreamBody["model"]).toBe("k3-256k");
    expect(upstreamBody["stream"]).toBe(true);
    const messages = upstreamBody["messages"] as Array<Json>;
    expect(messages[0]).toEqual({
      role: "system",
      content: "You are helpful.",
    });
    expect(upstreamBody["store"]).toBeUndefined();
    expect(upstreamBody["include"]).toBeUndefined();
  });

  test("path works without the /v1 prefix", async () => {
    const { baseUrl } = await startProxy(async () =>
      sseResponse(STREAM_FIXTURE),
    );
    const response = await fetch(`${baseUrl}/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(minimalRequest(true)),
    });
    expect(response.status).toBe(200);
    const events = parseSse(await response.text());
    expect(events[events.length - 1]?.["type"]).toBe("response.completed");
  });

  test("upstream 4xx becomes response.failed inside the SSE stream", async () => {
    const { baseUrl } = await startProxy(
      async () =>
        new Response(JSON.stringify({ error: { message: "bad key" } }), {
          status: 401,
          headers: { "content-type": "application/json" },
        }),
    );
    const response = await fetch(`${baseUrl}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(minimalRequest(true)),
    });
    expect(response.status).toBe(200);
    const events = parseSse(await response.text());
    const failed = events.find((event) => event["type"] === "response.failed");
    expect(failed).toBeDefined();
    const failedResponse = failed?.["response"] as Json;
    expect((failedResponse["error"] as Json)["message"]).toContain(
      "upstream HTTP 401",
    );
    expect((failedResponse["error"] as Json)["message"]).toContain("bad key");
  });

  test("upstream fetch failure becomes response.failed", async () => {
    const { baseUrl } = await startProxy(async () => {
      throw new Error("connect ECONNREFUSED");
    });
    const response = await fetch(`${baseUrl}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(minimalRequest(true)),
    });
    expect(response.status).toBe(200);
    const events = parseSse(await response.text());
    const failed = events.find((event) => event["type"] === "response.failed");
    expect(
      ((failed?.["response"] as Json)["error"] as Json)["message"],
    ).toContain("ECONNREFUSED");
  });

  test("non-streaming request returns a full Responses JSON object", async () => {
    const { baseUrl } = await startProxy(
      async () =>
        new Response(
          JSON.stringify({
            id: "chatcmpl-1",
            object: "chat.completion",
            model: "k3-256k",
            choices: [
              {
                index: 0,
                finish_reason: "stop",
                message: { role: "assistant", content: "hello there" },
              },
            ],
            usage: { prompt_tokens: 7, completion_tokens: 2, total_tokens: 9 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    const response = await fetch(`${baseUrl}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(minimalRequest(false)),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as Json;
    expect(body["object"]).toBe("response");
    expect(body["status"]).toBe("completed");
    const output = body["output"] as Array<Json>;
    expect(output[0]?.["type"]).toBe("message");
    const usage = body["usage"] as Json;
    expect(usage["input_tokens"]).toBe(7);
    expect(usage["output_tokens"]).toBe(2);
  });

  test("non-streaming upstream error mirrors the status code", async () => {
    const { baseUrl } = await startProxy(
      async () => new Response("overloaded", { status: 503 }),
    );
    const response = await fetch(`${baseUrl}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(minimalRequest(false)),
    });
    expect(response.status).toBe(503);
    const body = (await response.json()) as Json;
    expect((body["error"] as Json)["code"]).toBe("upstream_error");
  });

  test("unknown routes and invalid JSON are rejected cleanly", async () => {
    const { baseUrl } = await startProxy(async () => sseResponse(""));
    const notFound = await fetch(`${baseUrl}/v1/models`);
    expect(notFound.status).toBe(404);
    const badJson = await fetch(`${baseUrl}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });
    expect(badJson.status).toBe(400);
  });
});

describe("proxyConfigFromEnv", () => {
  test("requires KIMI_API_KEY", () => {
    expect(() => proxyConfigFromEnv({ env: {} })).toThrow("KIMI_API_KEY");
  });

  test("applies defaults and parses PROXY_MODEL_MAP", () => {
    const config = proxyConfigFromEnv({
      env: {
        KIMI_API_KEY: "k",
        PROXY_MODEL_MAP: '{"gpt-5.6-sol":"k3-256k"}',
      },
    });
    expect(config.baseUrl).toBe("https://api.kimi.com/coding/v1");
    expect(config.port).toBe(0);
    expect(config.modelMap).toEqual({ "gpt-5.6-sol": "k3-256k" });
  });

  test("rejects a malformed PROXY_MODEL_MAP", () => {
    expect(() =>
      proxyConfigFromEnv({
        env: { KIMI_API_KEY: "k", PROXY_MODEL_MAP: "not json" },
      }),
    ).toThrow("PROXY_MODEL_MAP");
  });
});
