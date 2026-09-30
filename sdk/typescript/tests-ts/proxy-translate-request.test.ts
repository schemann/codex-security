import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { translateRequest } from "../src/proxy/translate-request.js";

const fixtureDir = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

function codexCapture(): Record<string, unknown> {
  const capture = JSON.parse(
    readFileSync(join(fixtureDir, "codex-request.json"), "utf8"),
  ) as { body: Record<string, unknown> };
  return capture.body;
}

function toolNames(body: Record<string, unknown>): string[] {
  const tools = (body["tools"] ?? []) as Array<{
    function: { name: string };
  }>;
  return tools.map((tool) => tool.function.name);
}

describe("translateRequest with the real Codex capture", () => {
  const translated = translateRequest(codexCapture());
  const body = translated.body;

  test("passes the model through unchanged and applies PROXY_MODEL_MAP", () => {
    expect(body["model"]).toBe("k3-256k");
    const mapped = translateRequest(codexCapture(), {
      modelMap: { "k3-256k": "k3-128k" },
    });
    expect(mapped.body["model"]).toBe("k3-128k");
  });

  test("keeps streaming enabled and asks upstream for usage", () => {
    expect(body["stream"]).toBe(true);
    expect(body["stream_options"]).toEqual({ include_usage: true });
  });

  test("strips Codex-private request fields", () => {
    for (const field of [
      "include",
      "store",
      "prompt_cache_key",
      "client_metadata",
      "truncation",
      "parallel_tool_calls",
      "reasoning",
    ]) {
      expect(body[field]).toBeUndefined();
    }
  });

  test("instructions become the leading system message", () => {
    const messages = body["messages"] as Array<{
      role: string;
      content: unknown;
    }>;
    expect(messages[0]?.role).toBe("system");
    expect(typeof messages[0]?.content).toBe("string");
    expect(messages[0]?.content as string).toContain(
      "You are a coding agent running in the Codex CLI",
    );
  });

  test("developer role maps to system, user content is flattened text", () => {
    const messages = body["messages"] as Array<{
      role: string;
      content: unknown;
    }>;
    const developer = messages.find((message) =>
      typeof message.content === "string"
        ? message.content.includes("<permissions instructions>")
        : false,
    );
    expect(developer?.role).toBe("system");
    const users = messages.filter((message) => message.role === "user");
    expect(users.length).toBe(2);
    expect(users[1]?.content).toBe("say hi");
    expect(typeof users[0]?.content).toBe("string");
    expect(users[0]?.content as string).toContain("<environment_context>");
  });

  test("regular function tools are converted to chat tool shape", () => {
    const names = toolNames(body);
    for (const expected of [
      "exec_command",
      "write_stdin",
      "update_plan",
      "view_image",
      "get_goal",
    ]) {
      expect(names).toContain(expected);
    }
    const tools = body["tools"] as Array<Record<string, unknown>>;
    for (const tool of tools) {
      expect(tool["type"]).toBe("function");
      const fn = tool["function"] as Record<string, unknown>;
      expect(typeof fn["name"]).toBe("string");
      expect(typeof fn["description"]).toBe("string");
      expect(fn["parameters"]).toBeDefined();
    }
  });

  test("namespace tools are flattened with a restorable mapping", () => {
    const names = toolNames(body);
    for (const expected of [
      "multi_agent_v1__spawn_agent",
      "multi_agent_v1__close_agent",
      "multi_agent_v1__send_input",
      "multi_agent_v1__wait_agent",
      "multi_agent_v1__resume_agent",
    ]) {
      expect(names).toContain(expected);
    }
    // No collisions between flattened names.
    expect(new Set(names).size).toBe(names.length);
    const spawn = translated.namespaces.find(
      (mapping) => mapping.flattened === "multi_agent_v1__spawn_agent",
    );
    expect(spawn).toEqual({
      flattened: "multi_agent_v1__spawn_agent",
      namespace: "multi_agent_v1",
      name: "spawn_agent",
    });
  });

  test("all flattened tool names satisfy Kimi's function-name rule", () => {
    // Kimi rejects names outside this shape with HTTP 400 ("function name is
    // invalid, must start with a letter and can contain letters, numbers,
    // underscores, and dashes") — observed live with dotted names.
    const kimiNameRule = /^[A-Za-z][A-Za-z0-9_-]*$/;
    const names = toolNames(body);
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) {
      expect({ name, ok: kimiNameRule.test(name) }).toEqual({
        name,
        ok: true,
      });
    }
  });

  test("flatten collisions between a namespace tool and a plain tool are disambiguated", () => {
    const { body: collisionBody, namespaces } = translateRequest({
      model: "k3-256k",
      input: [],
      tools: [
        // Plain tool whose name equals the flattened namespace tool name.
        {
          type: "function",
          name: "agent__run",
          description: "plain",
          parameters: { type: "object", properties: {} },
        },
        {
          type: "namespace",
          name: "agent",
          tools: [
            {
              type: "function",
              name: "run",
              description: "namespaced",
              parameters: { type: "object", properties: {} },
            },
          ],
        },
      ],
    });
    const names = toolNames(collisionBody);
    expect(names).toEqual(["agent__run", "agent__run_2"]);
    // The mapping keeps the exact reverse target despite the suffix.
    expect(namespaces).toEqual([
      { flattened: "agent__run_2", namespace: "agent", name: "run" },
    ]);
  });

  test("internal web_search tool is dropped unless passthrough is enabled", () => {
    const tools = body["tools"] as Array<Record<string, unknown>>;
    expect(tools.some((tool) => tool["type"] === "web_search")).toBe(false);
    const passthrough = translateRequest(codexCapture(), {
      passthroughWebSearch: true,
    });
    const passthroughTools = passthrough.body["tools"] as Array<
      Record<string, unknown>
    >;
    expect(passthroughTools.some((tool) => tool["type"] === "web_search")).toBe(
      true,
    );
  });

  test("tool_choice is forwarded", () => {
    expect(body["tool_choice"]).toBe("auto");
  });
});

describe("translateRequest reasoning effort", () => {
  function bodyWithReasoning(reasoning: unknown): Record<string, unknown> {
    return translateRequest({
      model: "k3-256k",
      input: [],
      stream: true,
      reasoning,
    }).body;
  }

  test("null reasoning sets no thinking field", () => {
    expect(bodyWithReasoning(null)["reasoning_effort"]).toBeUndefined();
  });

  test("effort mapping low/medium/high/xhigh -> low/high/high/max", () => {
    expect(bodyWithReasoning({ effort: "low" })["reasoning_effort"]).toBe(
      "low",
    );
    expect(bodyWithReasoning({ effort: "medium" })["reasoning_effort"]).toBe(
      "high",
    );
    expect(bodyWithReasoning({ effort: "high" })["reasoning_effort"]).toBe(
      "high",
    );
    expect(bodyWithReasoning({ effort: "xhigh" })["reasoning_effort"]).toBe(
      "max",
    );
  });

  test("thinking field name is configurable", () => {
    const body = translateRequest(
      { model: "k3-256k", input: [], reasoning: { effort: "high" } },
      { thinkingField: "thinking" },
    ).body;
    expect(body["thinking"]).toBe("high");
    expect(body["reasoning_effort"]).toBeUndefined();
  });

  test("toggle style maps effort onto the Z.ai GLM thinking switch", () => {
    const enabled = translateRequest(
      { model: "glm-5.3", input: [], reasoning: { effort: "xhigh" } },
      { thinkingField: "thinking", thinkingStyle: "toggle" },
    ).body;
    expect(enabled["thinking"]).toEqual({ type: "enabled" });
    const disabled = translateRequest(
      { model: "glm-5.3", input: [], reasoning: { effort: "low" } },
      { thinkingField: "thinking", thinkingStyle: "toggle" },
    ).body;
    expect(disabled["thinking"]).toEqual({ type: "disabled" });
    // Ohne Effort-Angabe bleibt der Body unberuehrt (GLM-Denken default an).
    const untouched = translateRequest(
      { model: "glm-5.3", input: [] },
      { thinkingField: "thinking", thinkingStyle: "toggle" },
    ).body;
    expect(untouched["thinking"]).toBeUndefined();
  });
});

describe("translateRequest tool-call roundtrip items", () => {
  test("function_call and function_call_output items become chat tool messages", () => {
    const { body } = translateRequest({
      model: "k3-256k",
      input: [
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "run echo" }],
        },
        {
          type: "function_call",
          id: "fc_1",
          call_id: "call_1",
          name: "exec_command",
          arguments: '{"cmd":"echo hi"}',
        },
        {
          type: "function_call_output",
          call_id: "call_1",
          output: "hi\n",
        },
      ],
    });
    const messages = body["messages"] as Array<Record<string, unknown>>;
    expect(messages[1]).toEqual({
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: "call_1",
          type: "function",
          function: { name: "exec_command", arguments: '{"cmd":"echo hi"}' },
        },
      ],
    });
    expect(messages[2]).toEqual({
      role: "tool",
      tool_call_id: "call_1",
      content: "hi\n",
    });
  });

  test("namespaced function_call items are flattened on the way out", () => {
    const { body } = translateRequest({
      model: "k3-256k",
      input: [
        {
          type: "function_call",
          call_id: "call_9",
          name: "spawn_agent",
          namespace: "multi_agent_v1",
          arguments: '{"message":"go"}',
        },
      ],
    });
    const messages = body["messages"] as Array<Record<string, unknown>>;
    const toolCalls = messages[0]?.["tool_calls"] as Array<
      Record<string, unknown>
    >;
    expect(toolCalls[0]?.["function"]).toEqual({
      name: "multi_agent_v1__spawn_agent",
      arguments: '{"message":"go"}',
    });
  });

  test("consecutive function_call items share one assistant message", () => {
    const { body } = translateRequest({
      model: "k3-256k",
      input: [
        {
          type: "function_call",
          call_id: "call_a",
          name: "exec_command",
          arguments: "{}",
        },
        {
          type: "function_call",
          call_id: "call_b",
          name: "write_stdin",
          arguments: "{}",
        },
      ],
    });
    const messages = body["messages"] as Array<Record<string, unknown>>;
    expect(messages.length).toBe(1);
    expect((messages[0]?.["tool_calls"] as unknown[]).length).toBe(2);
  });

  test("reasoning items are dropped, unknown items tolerated", () => {
    const { body } = translateRequest({
      model: "k3-256k",
      input: [
        { type: "reasoning", summary: [], encrypted_content: "abc" },
        { type: "item_reference", id: "ref_1" },
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "hi" }],
        },
      ],
    });
    const messages = body["messages"] as Array<{ role: string }>;
    expect(messages.length).toBe(1);
    expect(messages[0]?.role).toBe("user");
  });

  test("structured function_call_output content items are flattened to text", () => {
    const { body } = translateRequest({
      model: "k3-256k",
      input: [
        {
          type: "function_call_output",
          call_id: "call_img",
          output: [
            { type: "input_text", text: "image follows" },
            { type: "input_image", image_url: "data:image/png;base64,AAAA" },
          ],
        },
      ],
    });
    const messages = body["messages"] as Array<{
      role: string;
      content: string;
    }>;
    expect(messages[0]?.role).toBe("tool");
    expect(messages[0]?.["content"] as string).toContain("image follows");
    expect(messages[0]?.["content"] as string).toContain("image(s) omitted");
  });
});

describe("translateRequest misc", () => {
  test("does not duplicate system message when input already has one", () => {
    const { body } = translateRequest({
      model: "k3-256k",
      instructions: "base instructions",
      input: [
        {
          type: "message",
          role: "system",
          content: [{ type: "input_text", text: "already here" }],
        },
      ],
    });
    const messages = body["messages"] as Array<{ role: string }>;
    expect(messages.filter((message) => message.role === "system").length).toBe(
      1,
    );
  });

  test("json_schema text format maps to response_format", () => {
    const { body } = translateRequest({
      model: "k3-256k",
      input: [],
      text: {
        format: {
          type: "json_schema",
          name: "scan_result",
          strict: true,
          schema: { type: "object" },
        },
      },
    });
    expect(body["response_format"]).toEqual({
      type: "json_schema",
      json_schema: {
        name: "scan_result",
        schema: { type: "object" },
        strict: true,
      },
    });
  });

  test("non-streaming requests stay non-streaming without stream_options", () => {
    const { body, stream } = translateRequest({
      model: "k3-256k",
      input: [],
      stream: false,
    });
    expect(stream).toBe(false);
    expect(body["stream"]).toBe(false);
    expect(body["stream_options"]).toBeUndefined();
  });
});
