import { cp, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import type { ThreadEvent } from "@openai/codex-sdk";
import {
  CodexSecurity,
  IncompleteScanError,
  ScanInterruptedError,
  ScanResult,
} from "../src/index.js";
import { PLUGIN_ROOT } from "./plugin-root.js";

const EXAMPLE = join(PLUGIN_ROOT, "examples", "completed-scan");
const TEST_SNAPSHOT_DIGEST = `codex-security-snapshot/v1:sha256:${"a".repeat(64)}`;
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function temporaryDirectory(): Promise<string> {
  const path = await realpath(
    await mkdtemp(join(tmpdir(), "codex-security-kimi-cont-")),
  );
  temporaryDirectories.push(path);
  return path;
}

const TestClientBase = CodexSecurity as unknown as new (
  config: Record<string, unknown>,
  dependencies: Record<string, unknown>,
) => CodexSecurity;

function mockScanRegistration(args: readonly string[], input?: string) {
  const recipe = JSON.parse(input!).recipe as {
    repositoryRevision?: string;
    target: { kind: string };
  };
  const kind =
    recipe.target.kind === "refs" || recipe.target.kind === "working_tree"
      ? "git_diff"
      : recipe.repositoryRevision === undefined
        ? "directory_snapshot"
        : "git_revision";

  return {
    scanId: "scan_example_001",
    targetId: "target_sha256_example",
    targetRevision: recipe.repositoryRevision ?? "unversioned",
    scanDir: args[args.indexOf("--scan-dir") + 1],
    contract: {
      target: {
        allowedKinds: [kind],
        ...(kind === "directory_snapshot"
          ? { requiredSnapshotDigest: TEST_SNAPSHOT_DIGEST }
          : {}),
      },
    },
  };
}

async function copyCompletedScan(root: string): Promise<string> {
  const scanDir = join(root, "scan");
  await cp(EXAMPLE, scanDir, { recursive: true });
  await writeFile(join(scanDir, "report.md"), "# Scan report\n");
  return scanDir;
}

async function* completedEvents(): AsyncGenerator<ThreadEvent> {
  yield { type: "thread.started", thread_id: "thread-1" };
  yield { type: "turn.started" };
  yield {
    type: "item.completed",
    item: { id: "message-1", type: "agent_message", text: "scan complete" },
  };
  yield {
    type: "turn.completed",
    usage: {
      input_tokens: 10,
      cached_input_tokens: 2,
      cache_write_input_tokens: 0,
      output_tokens: 3,
      reasoning_output_tokens: 1,
    },
  };
}

interface FakeThread {
  prompts: string[];
  thread: {
    id: null;
    runStreamed(
      input: string,
    ): Promise<{ events: AsyncGenerator<ThreadEvent> }>;
  };
}

/**
 * A thread whose runs each invoke the corresponding behavior; extra runs
 * repeat the last behavior. Each behavior may prepare the scan directory
 * before its events stream completes (mirroring the model writing files).
 */
function fakeThread(
  behaviors: Array<{
    events: () => AsyncGenerator<ThreadEvent>;
    beforeComplete?: () => Promise<void>;
  }>,
): FakeThread {
  const prompts: string[] = [];
  let calls = 0;
  return {
    prompts,
    thread: {
      id: null,
      async runStreamed(input: string) {
        prompts.push(input);
        const behavior = behaviors[Math.min(calls, behaviors.length - 1)]!;
        calls += 1;
        await behavior.beforeComplete?.();
        return { events: behavior.events() };
      },
    },
  };
}

function workbenchMock(
  commands: Array<readonly string[]>,
  overrides: Record<string, (args: readonly string[]) => unknown> = {},
) {
  return async (_options: unknown, args: readonly string[], input?: string) => {
    commands.push(args);
    const command = args[0] ?? "";
    if (overrides[command] !== undefined) return overrides[command](args);
    if (command === "register-cli-scan") {
      return mockScanRegistration(args, input);
    }
    if (command === "get-scan-feedback") {
      return {
        scanId: "scan_example_001",
        targetId: "target_sha256_example",
        falsePositives: [],
      };
    }
    if (command === "complete-scan") return { scan: { warnings: [] } };
    return {};
  };
}

function clientWithThread(
  root: string,
  codexHome: string,
  thread: FakeThread,
  commands: Array<readonly string[]>,
  config: Record<string, unknown> = { provider: "kimi" },
  environment: Record<string, string> = { KIMI_API_KEY: "synthetic-kimi-key" },
  workbenchOverrides: Record<string, (args: readonly string[]) => unknown> = {},
): CodexSecurity {
  return new (class extends TestClientBase {})(config, {
    environment,
    prepareRuntime: async () => ({
      codexHome,
      plugin: {
        pluginRoot: PLUGIN_ROOT,
        marketplaceRoot: PLUGIN_ROOT,
        installedRoot: PLUGIN_ROOT,
        marketplaceName: "codex-security-sdk",
        name: "codex-security",
        version: "0.1.0",
      },
      environment: {},
      credentialsAvailable: true,
    }),
    resolvePluginPython: async () => "/managed/python",
    prepareOutputDir: async () => {
      // The real prepareOutputDir creates the scan directory privately
      // (mode 0700); since v0.1.5 requireScanRoot enforces that invariant
      // at read time, the double must create it the same way.
      const scanDir = join(root, "scan");
      await mkdir(scanDir, { recursive: true, mode: 0o700 });
      return scanDir;
    },
    repositoryRevision: async () => "deadbeef",
    runWorkbench: workbenchMock(commands, workbenchOverrides),
    createCodex: () => ({ startThread: () => thread.thread }),
  });
}

describe("Kimi scan continuation", () => {
  test("continues once when the first turn ends without artifacts, then succeeds", async () => {
    const root = await temporaryDirectory();
    const repository = join(root, "repository");
    const codexHome = join(root, "codex-home");
    await mkdir(repository);
    await mkdir(codexHome);
    const commands: Array<readonly string[]> = [];
    const thread = fakeThread([
      { events: completedEvents }, // ends "successfully" but writes nothing
      {
        events: completedEvents,
        beforeComplete: async () => {
          await copyCompletedScan(root);
        },
      },
    ]);
    const warnings: string[] = [];
    const client = clientWithThread(root, codexHome, thread, commands);

    const result = await client.run(repository, {
      onWarning: (warning) => warnings.push(warning),
    });
    expect(result).toBeInstanceOf(ScanResult);
    expect(result.threadId).toBe("thread-1");
    expect(thread.prompts.length).toBe(2);
    expect(thread.prompts[0]).toContain("$codex-security:security-scan");
    expect(thread.prompts[1]).toContain(
      "The Codex Security scan is not complete",
    );
    expect(thread.prompts[1]).toContain("scan-manifest.json");
    expect(thread.prompts[1]).toContain("Do not restart completed phases");
    expect(warnings).toEqual([
      "The model ended its turn before the scan artifacts were complete; continuing in the same thread (attempt 2/4).",
    ]);
    // complete-scan runs exactly once, after the final successful attempt.
    expect(commands.filter((args) => args[0] === "complete-scan").length).toBe(
      1,
    );
    await client.close();
  });

  test("continuation loop also runs for the glm provider", async () => {
    const root = await temporaryDirectory();
    const repository = join(root, "repository");
    const codexHome = join(root, "codex-home");
    await mkdir(repository);
    await mkdir(codexHome);
    const commands: Array<readonly string[]> = [];
    const thread = fakeThread([
      { events: completedEvents }, // ends "successfully" but writes nothing
      {
        events: completedEvents,
        beforeComplete: async () => {
          await copyCompletedScan(root);
        },
      },
    ]);
    const warnings: string[] = [];
    const client = clientWithThread(
      root,
      codexHome,
      thread,
      commands,
      { provider: "glm" },
      { GLM_API_KEY: "synthetic-glm-key" },
    );

    const result = await client.run(repository, {
      onWarning: (warning) => warnings.push(warning),
    });
    expect(result).toBeInstanceOf(ScanResult);
    expect(thread.prompts.length).toBe(2);
    expect(thread.prompts[1]).toContain(
      "The Codex Security scan is not complete",
    );
    await client.close();
  });

  test("gives up after 3 continuations and propagates the original error", async () => {
    const root = await temporaryDirectory();
    const repository = join(root, "repository");
    const codexHome = join(root, "codex-home");
    await mkdir(repository);
    await mkdir(codexHome);
    const commands: Array<readonly string[]> = [];
    const thread = fakeThread([{ events: completedEvents }]);
    const warnings: string[] = [];
    const client = clientWithThread(root, codexHome, thread, commands);

    const failure: unknown = await client
      .run(repository, {
        onWarning: (warning) => warnings.push(warning),
      })
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(IncompleteScanError);
    // The v0.1.5 "without required artifacts" message variant (including the
    // workbench-generated report.md) is the retryable artifact class.
    expect((failure as Error).message).toContain(
      "completed without required artifacts: scan-manifest.json, findings.json, coverage.json, report.md",
    );
    // 1 initial run + 3 continuations.
    expect(thread.prompts.length).toBe(4);
    expect(warnings.length).toBe(3);
    expect(warnings[2]).toContain("(attempt 4/4)");
    expect(commands.filter((args) => args[0] === "complete-scan").length).toBe(
      0,
    );
    await client.close();
  });

  test("does not retry genuine stream/model failures", async () => {
    const root = await temporaryDirectory();
    const repository = join(root, "repository");
    const codexHome = join(root, "codex-home");
    await mkdir(repository);
    await mkdir(codexHome);
    const commands: Array<readonly string[]> = [];
    async function* failedEvents(): AsyncGenerator<ThreadEvent> {
      yield { type: "thread.started", thread_id: "thread-1" };
      yield { type: "turn.started" };
      yield { type: "turn.failed", error: { message: "model exploded" } };
    }
    const thread = fakeThread([{ events: failedEvents }]);
    const client = clientWithThread(root, codexHome, thread, commands);

    await expect(client.run(repository)).rejects.toThrow("model exploded");
    expect(thread.prompts.length).toBe(1);
    await client.close();
  });

  test("does not retry non-artifact workbench failures from finalization", async () => {
    const root = await temporaryDirectory();
    const repository = join(root, "repository");
    const codexHome = join(root, "codex-home");
    await mkdir(repository);
    await mkdir(codexHome);
    const commands: Array<readonly string[]> = [];
    const thread = fakeThread([{ events: completedEvents }]);
    const client = clientWithThread(
      root,
      codexHome,
      thread,
      commands,
      { provider: "kimi" },
      { KIMI_API_KEY: "synthetic-kimi-key" },
      {
        "prepare-scan-completion": () => {
          throw new Error(
            "Could not save the Codex Security scan: database connection failed",
          );
        },
      },
    );

    await expect(client.run(repository)).rejects.toThrow(
      "database connection failed",
    );
    expect(thread.prompts.length).toBe(1);
    await client.close();
  });

  test("does not retry after an abort", async () => {
    const root = await temporaryDirectory();
    const repository = join(root, "repository");
    const codexHome = join(root, "codex-home");
    await mkdir(repository);
    await mkdir(codexHome);
    const commands: Array<readonly string[]> = [];
    const controller = new AbortController();
    async function* abortingEvents(): AsyncGenerator<ThreadEvent> {
      yield { type: "thread.started", thread_id: "thread-1" };
      // Abort mid-stream: the missing-artifact outcome must not be retried
      // once the scan was interrupted.
      controller.abort(new Error("user interrupt"));
      yield { type: "turn.started" };
    }
    const thread = fakeThread([{ events: abortingEvents }]);
    const client = clientWithThread(root, codexHome, thread, commands);

    await expect(
      client.run(repository, { signal: controller.signal }),
    ).rejects.toBeInstanceOf(ScanInterruptedError);
    expect(thread.prompts.length).toBe(1);
    await client.close();
  });

  test("continues when the manifest exists but is schema-invalid", async () => {
    const root = await temporaryDirectory();
    const repository = join(root, "repository");
    const codexHome = join(root, "codex-home");
    await mkdir(repository);
    await mkdir(codexHome);
    const commands: Array<readonly string[]> = [];
    let preflightCalls = 0;
    const thread = fakeThread([
      { events: completedEvents },
      {
        events: completedEvents,
        beforeComplete: async () => {
          await copyCompletedScan(root);
        },
      },
    ]);
    const warnings: string[] = [];
    const client = clientWithThread(
      root,
      codexHome,
      thread,
      commands,
      { provider: "kimi" },
      { KIMI_API_KEY: "synthetic-kimi-key" },
      {
        "prepare-scan-completion": () => {
          preflightCalls += 1;
          if (preflightCalls === 1) {
            throw new Error(
              "Could not save the Codex Security scan: scan-manifest.schema.scan.scope.limitations: expected schema type array",
            );
          }
          return {};
        },
      },
    );

    const result = await client.run(repository, {
      onWarning: (warning) => warnings.push(warning),
    });
    expect(result.threadId).toBe("thread-1");
    expect(thread.prompts.length).toBe(2);
    expect(thread.prompts[1]).toContain("scan-manifest.schema");
    expect(warnings.length).toBe(1);
    expect(commands.filter((args) => args[0] === "complete-scan").length).toBe(
      1,
    );
    await client.close();
  });

  test("never retries for the OpenAI provider", async () => {
    const root = await temporaryDirectory();
    const repository = join(root, "repository");
    const codexHome = join(root, "codex-home");
    await mkdir(repository);
    await mkdir(codexHome);
    const commands: Array<readonly string[]> = [];
    const thread = fakeThread([{ events: completedEvents }]);
    const warnings: string[] = [];
    const client = clientWithThread(
      root,
      codexHome,
      thread,
      commands,
      {},
      { OPENAI_API_KEY: "synthetic-openai-key" },
    );

    await expect(
      client.run(repository, {
        onWarning: (warning) => warnings.push(warning),
      }),
    ).rejects.toBeInstanceOf(IncompleteScanError);
    expect(thread.prompts.length).toBe(1);
    expect(warnings).toEqual([]);
    await client.close();
  });
});
