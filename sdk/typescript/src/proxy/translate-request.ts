/**
 * Request translation: OpenAI Responses API (as sent by the Codex binary)
 * to OpenAI Chat Completions (as spoken by the Kimi coding endpoint).
 *
 * The translation is intentionally tolerant: unknown input items are dropped,
 * unknown content parts are flattened to text where possible, and Codex-private
 * request fields (`include`, `store`, `prompt_cache_key`, `client_metadata`,
 * `truncation`, `stream_options`) are stripped because Kimi has no equivalents.
 */

export interface NamespaceMapping {
  /** Flattened tool name sent upstream, e.g. "multi_agent_v1.spawn_agent". */
  flattened: string;
  namespace: string;
  name: string;
}

export interface TranslateRequestOptions {
  /** Optional model rename map (from PROXY_MODEL_MAP). */
  modelMap?: Record<string, string>;
  /** Forward the internal `web_search` tool instead of dropping it. */
  passthroughWebSearch?: boolean;
  /**
   * Request field used to steer Kimi thinking effort.
   *
   * ASSUMPTION (not yet verified against the live Kimi API): K3 thinking is
   * controlled with a flat `reasoning_effort` field accepting "low" | "high" |
   * "max". If the real API expects e.g. `thinking: { type: ... }` instead, set
   * PROXY_THINKING_FIELD accordingly and adjust here.
   */
  thinkingField?: string;
  /**
   * How the mapped effort is expressed in the upstream body:
   *
   * - "effort" (default): flat string value written to `thinkingField` —
   *   Kimi Code style (`reasoning_effort: "high"`).
   * - "toggle": boolean-ish object written to `thinkingField` — Z.ai GLM
   *   style (`thinking: { type: "enabled" }`). Effort "low" maps to
   *   `disabled`, every other effort to `enabled`; GLM models have no
   *   effort ladder, only a thinking on/off switch.
   */
  thinkingStyle?: "effort" | "toggle";
}

export interface TranslatedRequest {
  /** Chat Completions request body. */
  body: Record<string, unknown>;
  /** Flattened -> namespace mapping, needed to restore tool call names. */
  namespaces: NamespaceMapping[];
  /** True when the client asked for SSE streaming. */
  stream: boolean;
}

const DEFAULT_THINKING_FIELD = "reasoning_effort";

/** Codex reasoning effort -> Kimi thinking level. */
const EFFORT_MAP: Record<string, string> = {
  low: "low",
  medium: "high",
  high: "high",
  xhigh: "max",
  max: "max",
  ultra: "max",
};

type Json = Record<string, unknown>;

function asObject(value: unknown): Json | undefined {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Json;
  }
  return undefined;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** Extract plain text from a function_call_output payload. */
function toolOutputToText(output: unknown): string {
  if (typeof output === "string") {
    return output;
  }
  const parts = asArray(output);
  const texts: string[] = [];
  let images = 0;
  for (const part of parts) {
    const obj = asObject(part);
    if (!obj) {
      continue;
    }
    if (obj["type"] === "input_text" || obj["type"] === "output_text") {
      const text = asString(obj["text"]);
      if (text !== undefined) {
        texts.push(text);
      }
    } else if (obj["type"] === "input_image") {
      images += 1;
    }
  }
  if (images > 0) {
    texts.push(`[${images} image(s) omitted: not supported by upstream]`);
  }
  return texts.join("\n");
}

/** Convert Responses content parts to a Chat Completions content value. */
function messageContent(
  content: unknown,
  role: string,
): string | Array<Record<string, unknown>> {
  // Plain string content passes through unchanged.
  if (typeof content === "string") {
    return content;
  }
  const parts = asArray(content);
  const textParts: string[] = [];
  const richParts: Array<Record<string, unknown>> = [];
  let hasImages = false;
  for (const part of parts) {
    const obj = asObject(part);
    if (!obj) {
      continue;
    }
    const type = obj["type"];
    if (type === "input_text" || type === "output_text" || type === "text") {
      const text = asString(obj["text"]);
      if (text !== undefined) {
        textParts.push(text);
        richParts.push({ type: "text", text });
      }
    } else if (type === "input_image") {
      const url = asString(obj["image_url"]);
      if (url !== undefined) {
        hasImages = true;
        richParts.push({ type: "image_url", image_url: { url } });
      }
    }
    // Unknown part types are dropped.
  }
  // Use a plain string whenever there is no image; that is the most widely
  // supported shape for OpenAI-compatible endpoints.
  if (!hasImages) {
    return textParts.join("\n");
  }
  void role;
  return richParts;
}

/**
 * Separator between namespace and tool name in flattened upstream tool names.
 *
 * Kimi validates function names as `^[A-Za-z][A-Za-z0-9_-]*$` (no dots —
 * verified live: `multi_agent_v1.spawn_agent` is rejected with HTTP 400), so
 * we flatten with a double underscore: `multi_agent_v1__spawn_agent`.
 *
 * Uniqueness: the reverse mapping is stored per request (flattened -> exact
 * {namespace, name}), so restore is unambiguous even though "__" can in
 * principle appear inside a tool name. Two different tools flattening to the
 * same string (e.g. namespace "a" tool "b__c" vs. plain tool "a__b__c") are
 * disambiguated by the `taken` set, which suffixes later duplicates. Codex's
 * real tool names (see tests-ts/fixtures/codex-request.json) only contain
 * single underscores, so no such collision occurs in practice.
 */
export const NAMESPACE_SEPARATOR = "__";

function flattenFunctionTool(
  tool: Json,
  namespace: string | undefined,
  taken: Set<string>,
  namespaces: NamespaceMapping[],
): Json | undefined {
  const name = asString(tool["name"]);
  if (!name) {
    return undefined;
  }
  let flat = namespace ? `${namespace}${NAMESPACE_SEPARATOR}${name}` : name;
  if (taken.has(flat)) {
    // Extremely unlikely (Codex tools are uniquely named), but never emit two
    // tools with the same name: suffix until free.
    let counter = 2;
    while (taken.has(`${flat}_${counter}`)) {
      counter += 1;
    }
    flat = `${flat}_${counter}`;
  }
  taken.add(flat);
  if (namespace) {
    namespaces.push({ flattened: flat, namespace, name });
  }
  const fn: Json = {
    name: flat,
    description: asString(tool["description"]) ?? "",
    parameters: tool["parameters"] ?? { type: "object", properties: {} },
  };
  if (typeof tool["strict"] === "boolean") {
    fn["strict"] = tool["strict"];
  }
  return { type: "function", function: fn };
}

export function translateRequest(
  input: unknown,
  options: TranslateRequestOptions = {},
): TranslatedRequest {
  const source = asObject(input) ?? {};
  const namespaces: NamespaceMapping[] = [];
  const messages: Array<Record<string, unknown>> = [];

  // --- input items -> messages ---------------------------------------------
  const items = asArray(source["input"]);
  let hasSystemMessage = false;
  // Pending assistant tool calls are flushed together with the next item so
  // that consecutive function_call items land on one assistant message.
  let pendingToolCalls: Array<Record<string, unknown>> = [];

  const flushToolCalls = () => {
    if (pendingToolCalls.length > 0) {
      messages.push({
        role: "assistant",
        content: null,
        tool_calls: pendingToolCalls,
      });
      pendingToolCalls = [];
    }
  };

  for (const rawItem of items) {
    const item = asObject(rawItem);
    if (!item) {
      continue;
    }
    const type = asString(item["type"]);
    if (type === "message" || type === undefined) {
      flushToolCalls();
      const roleRaw = asString(item["role"]) ?? "user";
      // Chat Completions has no "developer" role; system is the equivalent.
      const role = roleRaw === "developer" ? "system" : roleRaw;
      if (roleRaw === "system") {
        hasSystemMessage = true;
      }
      messages.push({
        role,
        content: messageContent(item["content"], role),
      });
    } else if (type === "function_call") {
      const callId = asString(item["call_id"]) ?? "";
      const namespace = asString(item["namespace"]);
      const name = asString(item["name"]) ?? "";
      const flat = namespace
        ? `${namespace}${NAMESPACE_SEPARATOR}${name}`
        : name;
      pendingToolCalls.push({
        id: callId,
        type: "function",
        function: {
          name: flat,
          arguments: asString(item["arguments"]) ?? "",
        },
      });
    } else if (type === "function_call_output") {
      flushToolCalls();
      messages.push({
        role: "tool",
        tool_call_id: asString(item["call_id"]) ?? "",
        content: toolOutputToText(item["output"]),
      });
    }
    // reasoning / item_reference / other Codex-internal items are dropped:
    // Kimi does not consume them and would reject the unknown shape.
  }
  flushToolCalls();

  // --- instructions -> leading system message -------------------------------
  const instructions = asString(source["instructions"]);
  if (instructions && !hasSystemMessage) {
    messages.unshift({ role: "system", content: instructions });
  }

  // --- tools -----------------------------------------------------------------
  const tools: Array<Record<string, unknown>> = [];
  const taken = new Set<string>();
  for (const rawTool of asArray(source["tools"])) {
    const tool = asObject(rawTool);
    if (!tool) {
      continue;
    }
    const type = asString(tool["type"]);
    if (type === "function") {
      const flat = flattenFunctionTool(tool, undefined, taken, namespaces);
      if (flat) {
        tools.push(flat);
      }
    } else if (type === "namespace") {
      // Namespace tools (e.g. multi_agent_v1) are flattened to plain function
      // tools named "<namespace>__<name>" (see NAMESPACE_SEPARATOR); the
      // mapping is restored on the way
      // back so Codex receives function_call items with a `namespace` field,
      // matching codex-rs `ResponseItem::FunctionCall`.
      const namespace = asString(tool["name"]) ?? "";
      for (const rawNested of asArray(tool["tools"])) {
        const nested = asObject(rawNested);
        if (!nested || asString(nested["type"]) !== "function") {
          continue;
        }
        const flat = flattenFunctionTool(nested, namespace, taken, namespaces);
        if (flat) {
          tools.push(flat);
        }
      }
    } else if (type === "web_search") {
      // Internal Codex tool with no Kimi equivalent. Dropped unless the
      // operator explicitly opts into passthrough (PROXY_PASSTHROUGH_WEBSEARCH).
      if (options.passthroughWebSearch === true) {
        tools.push(tool);
      }
    }
    // Other hosted tool types (local_shell, custom, ...) have no chat
    // equivalent and are dropped.
  }

  // --- assemble body ----------------------------------------------------------
  const body: Json = {};
  const model = asString(source["model"]);
  if (model) {
    body["model"] = options.modelMap?.[model] ?? model;
  }
  body["messages"] = messages;
  if (tools.length > 0) {
    body["tools"] = tools;
  }
  const toolChoice = source["tool_choice"];
  if (typeof toolChoice === "string" || asObject(toolChoice)) {
    body["tool_choice"] = toolChoice;
  }
  const stream = source["stream"] === true;
  body["stream"] = stream;
  if (stream) {
    // Ask the upstream to attach a usage chunk so response.completed can
    // carry real token counts.
    body["stream_options"] = { include_usage: true };
  }
  const maxOutputTokens = source["max_output_tokens"];
  if (typeof maxOutputTokens === "number") {
    body["max_tokens"] = maxOutputTokens;
  }
  const temperature = source["temperature"];
  if (typeof temperature === "number") {
    body["temperature"] = temperature;
  }
  const topP = source["top_p"];
  if (typeof topP === "number") {
    body["top_p"] = topP;
  }

  // text.format (output schema) -> response_format
  const text = asObject(source["text"]);
  const format = asObject(text?.["format"]);
  const formatType = asString(format?.["type"]);
  if (format && formatType === "json_schema") {
    body["response_format"] = {
      type: "json_schema",
      json_schema: {
        name: asString(format["name"]) ?? "response",
        schema: format["schema"] ?? {},
        ...(typeof format["strict"] === "boolean"
          ? { strict: format["strict"] }
          : {}),
      },
    };
  } else if (format && formatType === "json_object") {
    body["response_format"] = { type: "json_object" };
  }

  // reasoning effort -> configurable thinking field (see
  // TranslateRequestOptions.thinkingField / thinkingStyle).
  const reasoning = asObject(source["reasoning"]);
  const effort = asString(reasoning?.["effort"]);
  if (effort) {
    const mapped = EFFORT_MAP[effort] ?? effort;
    const field = options.thinkingField ?? DEFAULT_THINKING_FIELD;
    if (options.thinkingStyle === "toggle") {
      body[field] = { type: mapped === "low" ? "disabled" : "enabled" };
    } else {
      body[field] = mapped;
    }
  }

  // Deliberately NOT forwarded (Codex/OpenAI-private or unsupported):
  // include, store, prompt_cache_key, client_metadata, truncation,
  // parallel_tool_calls, stream_options (client variant), metadata.
  return { body, namespaces, stream };
}
