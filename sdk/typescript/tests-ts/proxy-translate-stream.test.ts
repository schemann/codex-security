import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ChatToResponsesTranslator,
  chatCompletionToResponse,
} from "../src/proxy/translate-stream.js";
import type { NamespaceMapping } from "../src/proxy/translate-request.js";

const fixtureDir = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

type Json = Record<string, unknown>;

function feedSseFixture(
  translator: ChatToResponsesTranslator,
  fixtureName: string,
): Json[] {
  const raw = readFileSync(join(fixtureDir, fixtureName), "utf8");
  const events: Json[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) {
      continue;
    }
    const data = trimmed.slice("data:".length).trim();
    if (data === "[DONE]") {
      continue;
    }
    events.push(...translator.handleChunk(JSON.parse(data)));
  }
  events.push(...translator.finish());
  return events;
}

function eventTypes(events: Json[]): string[] {
  return events.map((event) => event["type"] as string);
}

describe("ChatToResponsesTranslator with a recorded Kimi stream", () => {
  const namespaces: NamespaceMapping[] = [
    {
      flattened: "multi_agent_v1__spawn_agent",
      namespace: "multi_agent_v1",
      name: "spawn_agent",
    },
  ];
  const events = feedSseFixture(
    new ChatToResponsesTranslator({ namespaces, model: "k3-256k" }),
    "kimi-chat-stream.sse",
  );
  const types = eventTypes(events);

  test("emits a well-formed Responses event sequence", () => {
    expect(types[0]).toBe("response.created");
    expect(types[1]).toBe("response.in_progress");
    expect(types[types.length - 1]).toBe("response.completed");
    // Reasoning first, then message text, then the tool call.
    expect(types).toContain("response.reasoning_summary_part.added");
    expect(types).toContain("response.reasoning_summary_text.delta");
    expect(types).toContain("response.reasoning_summary_text.done");
    expect(types).toContain("response.output_text.delta");
    expect(types).toContain("response.content_part.done");
    expect(types).toContain("response.function_call_arguments.delta");
    expect(types).toContain("response.function_call_arguments.done");
    // Strict ordering: reasoning done before text delta, text part done
    // before the tool call item is added.
    const idx = (type: string) => types.indexOf(type);
    expect(idx("response.reasoning_summary_text.done")).toBeLessThan(
      idx("response.output_text.delta"),
    );
    expect(idx("response.content_part.done")).toBeLessThan(
      types.indexOf("response.function_call_arguments.delta"),
    );
    // output_item.done events precede response.completed.
    expect(types.lastIndexOf("response.output_item.done")).toBeLessThan(
      idx("response.completed"),
    );
  });

  test("thinking deltas arrive as reasoning summary deltas with summary_index", () => {
    const deltas = events.filter(
      (event) => event["type"] === "response.reasoning_summary_text.delta",
    );
    expect(deltas.length).toBe(2);
    expect(deltas[0]?.["summary_index"]).toBe(0);
    const text = deltas.map((event) => event["delta"]).join("");
    expect(text).toBe("The user wants me to run a command.");
  });

  test("function_call item carries complete arguments and identity fields", () => {
    const doneItems = events
      .filter((event) => event["type"] === "response.output_item.done")
      .map((event) => event["item"] as Json);
    const functionCall = doneItems.find(
      (item) => item["type"] === "function_call",
    );
    expect(functionCall).toBeDefined();
    expect(functionCall?.["call_id"]).toBe("call_abc123");
    expect(functionCall?.["name"]).toBe("exec_command");
    expect(functionCall?.["arguments"]).toBe('{"cmd":"echo hi"}');
    // arguments must be valid JSON once assembled.
    JSON.parse(functionCall?.["arguments"] as string);
  });

  test("message item accumulates the full text", () => {
    const doneItems = events
      .filter((event) => event["type"] === "response.output_item.done")
      .map((event) => event["item"] as Json);
    const message = doneItems.find((item) => item["type"] === "message");
    expect(message?.["role"]).toBe("assistant");
    const content = message?.["content"] as Array<Json>;
    expect(content[0]?.["type"]).toBe("output_text");
    expect(content[0]?.["text"]).toBe("I'll run that for you.");
  });

  test("response.completed maps usage and lists all output items", () => {
    const completed = events[events.length - 1]?.["response"] as Json;
    expect(completed["status"]).toBe("completed");
    expect(typeof completed["id"]).toBe("string");
    const usage = completed["usage"] as Json;
    expect(usage["input_tokens"]).toBe(120);
    expect(usage["output_tokens"]).toBe(35);
    expect(usage["total_tokens"]).toBe(155);
    expect((usage["output_tokens_details"] as Json)["reasoning_tokens"]).toBe(
      12,
    );
    const output = completed["output"] as Array<Json>;
    expect(output.map((item) => item["type"])).toEqual([
      "reasoning",
      "message",
      "function_call",
    ]);
  });

  test("item_id / output_index stay consistent per item", () => {
    const added = events.filter(
      (event) => event["type"] === "response.output_item.added",
    );
    for (const addEvent of added) {
      const item = addEvent["item"] as Json;
      const outputIndex = addEvent["output_index"];
      const done = events.find(
        (event) =>
          event["type"] === "response.output_item.done" &&
          (event["item"] as Json)["id"] === item["id"],
      );
      expect(done).toBeDefined();
      expect(done?.["output_index"]).toBe(outputIndex);
    }
  });
});

describe("ChatToResponsesTranslator namespace restore", () => {
  test("flattened namespaced tool calls get name + namespace back", () => {
    const translator = new ChatToResponsesTranslator({
      namespaces: [
        {
          flattened: "multi_agent_v1__spawn_agent",
          namespace: "multi_agent_v1",
          name: "spawn_agent",
        },
      ],
      model: "k3-256k",
    });
    const events = [
      ...translator.handleChunk({
        model: "k3-256k",
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "call_ns1",
                  type: "function",
                  function: {
                    name: "multi_agent_v1__spawn_agent",
                    arguments: '{"message":"go"}',
                  },
                },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
      ...translator.finish(),
    ];
    const doneItem = events
      .filter((event) => event["type"] === "response.output_item.done")
      .map((event) => event["item"] as Json)
      .find((item) => item["type"] === "function_call");
    expect(doneItem?.["name"]).toBe("spawn_agent");
    expect(doneItem?.["namespace"]).toBe("multi_agent_v1");
  });
});

describe("ChatToResponsesTranslator error passthrough", () => {
  test("upstream error chunk becomes response.failed and terminates", () => {
    const translator = new ChatToResponsesTranslator({
      namespaces: [],
      model: "k3-256k",
    });
    const events = translator.handleChunk({
      error: { message: "invalid api key", code: "invalid_api_key" },
    });
    const types = eventTypes(events);
    expect(types[0]).toBe("response.created");
    expect(types[types.length - 1]).toBe("response.failed");
    const failed = events[events.length - 1]?.["response"] as Json;
    expect(failed["status"]).toBe("failed");
    const error = failed["error"] as Json;
    expect(error["message"]).toBe("invalid api key");
    expect(error["code"]).toBe("invalid_api_key");
    // Terminal: no further events afterwards.
    expect(translator.handleChunk({ choices: [] })).toEqual([]);
    expect(translator.finish()).toEqual([]);
  });

  test("explicit fail() mid-stream emits response.failed once", () => {
    const translator = new ChatToResponsesTranslator({
      namespaces: [],
      model: "k3-256k",
    });
    translator.handleChunk({
      model: "k3-256k",
      choices: [{ delta: { content: "partial" }, finish_reason: null }],
    });
    const events = translator.fail(
      "upstream stream failed: reset",
      "upstream_stream_error",
    );
    expect(events[events.length - 1]?.["type"]).toBe("response.failed");
    expect(translator.finish()).toEqual([]);
  });

  test("stream ending without usage still completes", () => {
    const translator = new ChatToResponsesTranslator({
      namespaces: [],
      model: "k3-256k",
    });
    const events = [
      ...translator.handleChunk({
        model: "k3-256k",
        choices: [{ delta: { content: "hi" }, finish_reason: "stop" }],
      }),
      ...translator.finish(),
    ];
    const completed = events[events.length - 1]?.["response"] as Json;
    expect(completed["status"]).toBe("completed");
    expect(completed["usage"]).toBeUndefined();
  });
});

describe("chatCompletionToResponse (non-streaming)", () => {
  test("converts a full chat completion into a Responses object", () => {
    const response = chatCompletionToResponse(
      {
        id: "chatcmpl-1",
        object: "chat.completion",
        model: "k3-256k",
        choices: [
          {
            index: 0,
            finish_reason: "tool_calls",
            message: {
              role: "assistant",
              reasoning_content: "thinking...",
              content: "Let me check.",
              tool_calls: [
                {
                  id: "call_1",
                  type: "function",
                  function: {
                    name: "multi_agent_v1__spawn_agent",
                    arguments: '{"message":"go"}',
                  },
                },
              ],
            },
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      },
      [
        {
          flattened: "multi_agent_v1__spawn_agent",
          namespace: "multi_agent_v1",
          name: "spawn_agent",
        },
      ],
    );
    expect(response["object"]).toBe("response");
    expect(response["status"]).toBe("completed");
    const output = response["output"] as Array<Json>;
    expect(output.map((item) => item["type"])).toEqual([
      "reasoning",
      "message",
      "function_call",
    ]);
    const functionCall = output.find(
      (item) => item["type"] === "function_call",
    );
    expect(functionCall?.["name"]).toBe("spawn_agent");
    expect(functionCall?.["namespace"]).toBe("multi_agent_v1");
    expect(functionCall?.["call_id"]).toBe("call_1");
    const usage = response["usage"] as Json;
    expect(usage).toEqual({
      input_tokens: 10,
      output_tokens: 5,
      total_tokens: 15,
    });
  });

  test("plain text completion without tools", () => {
    const response = chatCompletionToResponse(
      {
        model: "k3-256k",
        choices: [
          {
            finish_reason: "stop",
            message: { role: "assistant", content: "done" },
          },
        ],
        usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
      },
      [],
    );
    const output = response["output"] as Array<Json>;
    expect(output.length).toBe(1);
    expect(output[0]?.["type"]).toBe("message");
    const content = output[0]?.["content"] as Array<Json>;
    expect(content[0]?.["text"]).toBe("done");
  });
});
