/**
 * Response translation: Kimi Chat Completions (JSON or SSE chunks) back to
 * the OpenAI Responses API shape that the Codex binary parses.
 *
 * Verified against codex-rs 0.144.6 (`codex-api/src/sse/responses.rs`): the
 * client only acts on `response.created`, `response.output_item.added`,
 * `response.output_item.done` (full item, parsed as `ResponseItem`),
 * `response.output_text.delta`, `response.reasoning_summary_text.delta`,
 * `response.completed` (requires `response.id`, optional `usage` with
 * input/output/total tokens) and `response.failed`. Everything else we emit
 * (`content_part.*`, `function_call_arguments.*`, `in_progress`) follows the
 * OpenAI spec and is ignored by the client but keeps the stream spec-valid.
 *
 * `reasoning_content` deltas (K3 thinking) are forwarded as
 * `response.reasoning_summary_text.delta` events on a synthetic reasoning
 * item. The client treats these as display-only deltas; they never enter the
 * conversation history (which is built from `output_item.done` items), so this
 * is safe. Dropping them would also be safe, but surfacing thinking matches
 * Codex UX expectations for a thinking model.
 */

import {
  NAMESPACE_SEPARATOR,
  type NamespaceMapping,
} from "./translate-request.js";

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

let idCounter = 0;
function generateId(prefix: string): string {
  idCounter += 1;
  return `${prefix}_${Date.now().toString(36)}_${idCounter.toString(36)}${Math.random()
    .toString(36)
    .slice(2, 10)}`;
}

interface OpenItem {
  kind: "reasoning" | "message" | "function_call";
  id: string;
  outputIndex: number;
  /** Accumulated text: reasoning summary, message text, or arguments JSON. */
  text: string;
  callId?: string;
  name?: string;
  namespace?: string;
}

function mapUsage(usage: Json | undefined): Json | undefined {
  if (!usage) {
    return undefined;
  }
  const input = usage["prompt_tokens"];
  const output = usage["completion_tokens"];
  const total = usage["total_tokens"];
  const result: Json = {
    input_tokens: typeof input === "number" ? input : 0,
    output_tokens: typeof output === "number" ? output : 0,
    total_tokens: typeof total === "number" ? total : 0,
  };
  const outputDetails = asObject(usage["completion_tokens_details"]);
  const reasoningTokens = outputDetails?.["reasoning_tokens"];
  if (typeof reasoningTokens === "number") {
    result["output_tokens_details"] = { reasoning_tokens: reasoningTokens };
  }
  const inputDetails = asObject(usage["prompt_tokens_details"]);
  const cachedTokens = inputDetails?.["cached_tokens"];
  if (typeof cachedTokens === "number") {
    result["input_tokens_details"] = { cached_tokens: cachedTokens };
  }
  return result;
}

export interface StreamTranslateOptions {
  namespaces: NamespaceMapping[];
  /** Model name to report when the upstream chunk does not carry one. */
  model?: string;
}

/**
 * Incremental translator from Chat Completions SSE chunks to Responses API
 * SSE events. Feed parsed upstream `data:` JSON objects via `handleChunk`;
 * call `finish()` when the upstream stream ends.
 */
export class ChatToResponsesTranslator {
  private readonly namespaceByFlat = new Map<string, NamespaceMapping>();
  private readonly responseId = generateId("resp");
  private readonly createdAt = Math.floor(Date.now() / 1000);
  private readonly fallbackModel: string | undefined;
  private started = false;
  private failed = false;
  private completedEmitted = false;
  private finishReason: string | undefined;
  private usage: Json | undefined;
  private model: string | undefined;
  private outputIndex = 0;
  /** Currently open non-tool item (reasoning or message). */
  private openItem: OpenItem | undefined;
  /** Open tool call items keyed by upstream tool_calls index. */
  private readonly toolCalls = new Map<number, OpenItem>();
  private readonly completedItems: Json[] = [];

  constructor(options: StreamTranslateOptions) {
    for (const mapping of options.namespaces) {
      this.namespaceByFlat.set(mapping.flattened, mapping);
    }
    this.fallbackModel = options.model;
  }

  private event(type: string, fields: Json = {}): Json {
    return { type, ...fields };
  }

  private responseShell(status: string): Json {
    return {
      id: this.responseId,
      object: "response",
      created_at: this.createdAt,
      status,
      model: this.model ?? this.fallbackModel ?? "unknown",
      output: [],
    };
  }

  private startEvents(): Json[] {
    if (this.started) {
      return [];
    }
    this.started = true;
    return [
      this.event("response.created", {
        response: this.responseShell("in_progress"),
      }),
      this.event("response.in_progress", {
        response: this.responseShell("in_progress"),
      }),
    ];
  }

  private restoreName(flat: string): { name: string; namespace?: string } {
    const mapping = this.namespaceByFlat.get(flat);
    if (mapping) {
      return { name: mapping.name, namespace: mapping.namespace };
    }
    // Fallback for models that invent a namespaced-looking name on their own:
    // split on the separator only when the prefix is a known namespace.
    for (const candidate of this.namespaceByFlat.values()) {
      const prefix = `${candidate.namespace}${NAMESPACE_SEPARATOR}`;
      if (flat.startsWith(prefix) && flat.length > prefix.length) {
        return {
          name: flat.slice(prefix.length),
          namespace: candidate.namespace,
        };
      }
    }
    return { name: flat };
  }

  private closeReasoning(item: OpenItem): Json[] {
    return [
      this.event("response.reasoning_summary_text.done", {
        item_id: item.id,
        output_index: item.outputIndex,
        summary_index: 0,
        text: item.text,
      }),
      this.event("response.output_item.done", {
        output_index: item.outputIndex,
        item: {
          id: item.id,
          type: "reasoning",
          summary: [{ type: "summary_text", text: item.text }],
        },
      }),
    ];
  }

  private closeMessage(item: OpenItem): Json[] {
    const part = { type: "output_text", text: item.text, annotations: [] };
    return [
      this.event("response.content_part.done", {
        item_id: item.id,
        output_index: item.outputIndex,
        content_index: 0,
        part,
      }),
      this.event("response.output_item.done", {
        output_index: item.outputIndex,
        item: {
          id: item.id,
          type: "message",
          status: "completed",
          role: "assistant",
          content: [{ type: "output_text", text: item.text }],
        },
      }),
    ];
  }

  private closeToolCall(item: OpenItem): Json[] {
    return [
      this.event("response.function_call_arguments.done", {
        item_id: item.id,
        output_index: item.outputIndex,
        arguments: item.text,
      }),
      this.event("response.output_item.done", {
        output_index: item.outputIndex,
        item: {
          id: item.id,
          type: "function_call",
          status: "completed",
          call_id: item.callId ?? "",
          name: item.name ?? "",
          ...(item.namespace ? { namespace: item.namespace } : {}),
          arguments: item.text,
        },
      }),
    ];
  }

  private closeItem(item: OpenItem): Json[] {
    const events =
      item.kind === "reasoning"
        ? this.closeReasoning(item)
        : item.kind === "message"
          ? this.closeMessage(item)
          : this.closeToolCall(item);
    const doneItem = asObject(events[events.length - 1]?.["item"]);
    if (doneItem) {
      this.completedItems.push(doneItem);
    }
    return events;
  }

  /** Close the open reasoning/message item (tool calls close separately). */
  private closeOpenItem(): Json[] {
    if (!this.openItem) {
      return [];
    }
    const item = this.openItem;
    this.openItem = undefined;
    return this.closeItem(item);
  }

  private openReasoning(): Json[] {
    const item: OpenItem = {
      kind: "reasoning",
      id: generateId("rs"),
      outputIndex: this.outputIndex,
      text: "",
    };
    this.outputIndex += 1;
    this.openItem = item;
    return [
      this.event("response.output_item.added", {
        output_index: item.outputIndex,
        item: { id: item.id, type: "reasoning", summary: [] },
      }),
      this.event("response.reasoning_summary_part.added", {
        item_id: item.id,
        output_index: item.outputIndex,
        summary_index: 0,
        part: { type: "summary_text", text: "" },
      }),
    ];
  }

  private openMessage(): Json[] {
    const item: OpenItem = {
      kind: "message",
      id: generateId("msg"),
      outputIndex: this.outputIndex,
      text: "",
    };
    this.outputIndex += 1;
    this.openItem = item;
    return [
      this.event("response.output_item.added", {
        output_index: item.outputIndex,
        item: {
          id: item.id,
          type: "message",
          status: "in_progress",
          role: "assistant",
          content: [],
        },
      }),
      this.event("response.content_part.added", {
        item_id: item.id,
        output_index: item.outputIndex,
        content_index: 0,
        part: { type: "output_text", text: "", annotations: [] },
      }),
    ];
  }

  private openToolCall(callId: string, flatName: string): [Json[], OpenItem] {
    const restored = this.restoreName(flatName);
    const item: OpenItem = {
      kind: "function_call",
      id: generateId("fc"),
      outputIndex: this.outputIndex,
      text: "",
      callId,
      name: restored.name,
      namespace: restored.namespace,
    };
    this.outputIndex += 1;
    return [
      [
        this.event("response.output_item.added", {
          output_index: item.outputIndex,
          item: {
            id: item.id,
            type: "function_call",
            status: "in_progress",
            call_id: callId,
            name: restored.name,
            ...(restored.namespace ? { namespace: restored.namespace } : {}),
            arguments: "",
          },
        }),
      ],
      item,
    ];
  }

  /** Handle one parsed upstream SSE chunk (`data: {...}`). */
  handleChunk(chunk: unknown): Json[] {
    if (this.failed || this.completedEmitted) {
      return [];
    }
    const obj = asObject(chunk);
    if (!obj) {
      return [];
    }
    // Some providers stream error objects mid-stream.
    const error = asObject(obj["error"]);
    if (error) {
      return this.fail(
        asString(error["message"]) ?? "upstream stream error",
        asString(error["code"]) ?? asString(error["type"]),
      );
    }
    const events: Json[] = [];
    const model = asString(obj["model"]);
    if (model) {
      this.model = model;
    }
    const usage = asObject(obj["usage"]);
    if (usage) {
      this.usage = usage;
    }
    const choice = asObject(asArray(obj["choices"])[0]);
    if (!choice) {
      return events;
    }
    events.push(...this.startEvents());
    const delta = asObject(choice["delta"]) ?? {};

    // Thinking deltas first.
    const reasoningDelta =
      asString(delta["reasoning_content"]) ?? asString(delta["reasoning"]);
    if (reasoningDelta) {
      if (!this.openItem || this.openItem.kind !== "reasoning") {
        events.push(...this.closeOpenItem());
        events.push(...this.openReasoning());
      }
      const reasoningItem = this.openItem;
      if (reasoningItem) {
        reasoningItem.text += reasoningDelta;
        events.push(
          this.event("response.reasoning_summary_text.delta", {
            item_id: reasoningItem.id,
            output_index: reasoningItem.outputIndex,
            summary_index: 0,
            delta: reasoningDelta,
          }),
        );
      }
    }

    // Visible text deltas.
    const contentDelta = asString(delta["content"]);
    if (contentDelta) {
      if (!this.openItem || this.openItem.kind !== "message") {
        events.push(...this.closeOpenItem());
        events.push(...this.openMessage());
      }
      const messageItem = this.openItem;
      if (messageItem) {
        messageItem.text += contentDelta;
        events.push(
          this.event("response.output_text.delta", {
            item_id: messageItem.id,
            output_index: messageItem.outputIndex,
            content_index: 0,
            delta: contentDelta,
          }),
        );
      }
    }

    // Tool call deltas.
    for (const rawCall of asArray(delta["tool_calls"])) {
      const call = asObject(rawCall);
      if (!call) {
        continue;
      }
      const index =
        typeof call["index"] === "number" ? (call["index"] as number) : 0;
      let item = this.toolCalls.get(index);
      if (!item) {
        events.push(...this.closeOpenItem());
        const fn = asObject(call["function"]) ?? {};
        const [openEvents, opened] = this.openToolCall(
          asString(call["id"]) ?? generateId("call"),
          asString(fn["name"]) ?? "",
        );
        events.push(...openEvents);
        item = opened;
        this.toolCalls.set(index, item);
      }
      const fn = asObject(call["function"]);
      const argsDelta = asString(fn?.["arguments"]);
      if (argsDelta) {
        item.text += argsDelta;
        events.push(
          this.event("response.function_call_arguments.delta", {
            item_id: item.id,
            output_index: item.outputIndex,
            delta: argsDelta,
          }),
        );
      }
    }

    const finishReason = asString(choice["finish_reason"]);
    if (finishReason) {
      this.finishReason = finishReason;
      events.push(...this.closeOpenItem());
      for (const item of [...this.toolCalls.values()].sort(
        (a, b) => a.outputIndex - b.outputIndex,
      )) {
        events.push(...this.closeItem(item));
      }
      this.toolCalls.clear();
    }
    return events;
  }

  /** Emit response.failed; terminal. */
  fail(message: string, code?: string): Json[] {
    if (this.failed || this.completedEmitted) {
      return [];
    }
    this.failed = true;
    const events = this.startEvents();
    events.push(
      this.event("response.failed", {
        response: {
          ...this.responseShell("failed"),
          error: { code: code ?? "upstream_error", message },
        },
      }),
    );
    return events;
  }

  /**
   * Terminal events once the upstream stream ends. Emits
   * `response.completed` (with usage when the upstream provided it) unless
   * the stream already failed.
   */
  finish(): Json[] {
    if (this.failed || this.completedEmitted) {
      return [];
    }
    this.completedEmitted = true;
    const events: Json[] = [];
    // Upstream ended without finish_reason: still close open items so the
    // client sees a well-formed response.
    events.push(...this.closeOpenItem());
    for (const item of [...this.toolCalls.values()].sort(
      (a, b) => a.outputIndex - b.outputIndex,
    )) {
      events.push(...this.closeItem(item));
    }
    this.toolCalls.clear();
    const mappedUsage = mapUsage(this.usage);
    const finishReason = this.finishReason;
    events.push(
      this.event("response.completed", {
        response: {
          ...this.responseShell("completed"),
          output: this.completedItems,
          ...(mappedUsage ? { usage: mappedUsage } : {}),
          ...(finishReason === "length"
            ? { incomplete_details: { reason: "max_output_tokens" } }
            : {}),
        },
      }),
    );
    return events;
  }
}

/** Convert a non-streaming Chat Completions response to a Responses object. */
export function chatCompletionToResponse(
  completion: unknown,
  namespaces: NamespaceMapping[],
): Json {
  const obj = asObject(completion) ?? {};
  const translator = new ChatToResponsesTranslator({
    namespaces,
    model: asString(obj["model"]),
  });
  const choice = asObject(asArray(obj["choices"])[0]);
  const message = asObject(choice?.["message"]) ?? {};
  const events: Json[] = [];
  // Reuse the streaming state machine by feeding it synthetic deltas.
  const delta: Json = {};
  const reasoning = asString(message["reasoning_content"]);
  if (reasoning) {
    delta["reasoning_content"] = reasoning;
  }
  const content = asString(message["content"]);
  if (content) {
    delta["content"] = content;
  }
  const toolCalls = asArray(message["tool_calls"]).map((call, index) => {
    const callObj = asObject(call) ?? {};
    const fn = asObject(callObj["function"]) ?? {};
    return {
      index,
      id: callObj["id"],
      function: { name: fn["name"], arguments: fn["arguments"] },
    };
  });
  if (toolCalls.length > 0) {
    delta["tool_calls"] = toolCalls;
  }
  events.push(
    ...translator.handleChunk({
      model: obj["model"],
      choices: [
        {
          delta,
          finish_reason: asString(choice?.["finish_reason"]) ?? "stop",
        },
      ],
      usage: obj["usage"],
    }),
  );
  events.push(...translator.finish());
  const completed = events[events.length - 1];
  const response = asObject(completed?.["response"]);
  return (
    response ?? {
      id: "resp_unknown",
      object: "response",
      status: "completed",
      output: [],
    }
  );
}
