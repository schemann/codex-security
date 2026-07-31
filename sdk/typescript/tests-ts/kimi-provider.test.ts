import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import type { CodexOptions } from "@openai/codex-sdk";
import {
  AuthenticationRequiredError,
  CodexSecurity,
  ConfigurationError,
  type ScanAuthentication,
} from "../src/index.js";
import { scanAuthentication } from "../src/api.js";
import {
  KIMI_CODEX_PROVIDER_PRESET,
  mergedCodexConfig,
  resolveScanProvider,
} from "../src/config.js";
import { estimateScanCost } from "../src/cost.js";
import { kimiProxyScriptPath, startKimiProxy } from "../src/kimi-proxy.js";
import { main as cliMain } from "../src/cli.js";
import { parseCodexOverrides } from "../src/cli.js";
import { capture, dependencies } from "./cli-fixtures.js";
import { PLUGIN_ROOT } from "./plugin-root.js";

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
    await mkdtemp(join(tmpdir(), "codex-security-kimi-")),
  );
  temporaryDirectories.push(path);
  return path;
}

const TestClientBase = CodexSecurity as unknown as new (
  config: Record<string, unknown>,
  dependencies: Record<string, unknown>,
) => CodexSecurity;

const TEST_SNAPSHOT_DIGEST = `codex-security-snapshot/v1:sha256:${"a".repeat(64)}`;

function mockScanRegistration(args: readonly string[]) {
  const recipe = JSON.parse(args[args.indexOf("--recipe-json") + 1]!) as {
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
    scanId: "scan_kimi_001",
    targetId: "target_sha256_kimi",
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

class TestClient extends TestClientBase {
  public constructor(
    config: Record<string, unknown>,
    dependencies: Record<string, unknown>,
  ) {
    super(config, {
      runWorkbench: async (_options: unknown, args: readonly string[]) => {
        if (args[0] === "register-cli-scan") {
          return mockScanRegistration(args);
        }
        if (args[0] === "get-scan-feedback") {
          return {
            scanId: "scan_kimi_001",
            targetId: "target_sha256_kimi",
            falsePositives: [],
          };
        }
        return {};
      },
      ...dependencies,
    });
  }
}

function preparedRuntime(codexHome: string): Record<string, unknown> {
  return {
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
  };
}

describe("provider configuration", () => {
  test("defaults to the OpenAI provider and leaves its config untouched", async () => {
    expect(resolveScanProvider({})).toBe("openai");
    const merged = await mergedCodexConfig({});
    expect(merged["model"]).toBe("gpt-5.6-sol");
    expect(merged["model_reasoning_effort"]).toBe("xhigh");
    expect(merged["model_provider"]).toBeUndefined();
    expect(merged["model_providers"]).toBeUndefined();
  });

  test("applies the Kimi preset without a base_url (injected at runtime)", async () => {
    expect(resolveScanProvider({ provider: "kimi" })).toBe("kimi");
    const merged = await mergedCodexConfig({ provider: "kimi" });
    expect(merged["model"]).toBe("k3-256k");
    expect(merged["model_reasoning_effort"]).toBe("high");
    expect(merged["model_provider"]).toBe("kimi");
    expect(merged["model_providers"]).toEqual({
      kimi: { name: "Kimi", wire_api: "responses" },
    });
    // Default capabilities stay intact.
    expect(merged["features"]).toMatchObject({
      plugins: true,
      multi_agent_v2: { enabled: true },
    });
  });

  test("codexOverrides win over the Kimi preset", async () => {
    const merged = await mergedCodexConfig({
      provider: "kimi",
      codexOverrides: {
        model: "k3-128k",
        model_reasoning_effort: "low",
        model_providers: { kimi: { name: "Kimi Custom" } },
      },
    });
    expect(merged["model"]).toBe("k3-128k");
    expect(merged["model_reasoning_effort"]).toBe("low");
    expect(merged["model_providers"]).toEqual({
      kimi: { name: "Kimi Custom", wire_api: "responses" },
    });
  });

  test("rejects unknown provider values", async () => {
    expect(() => resolveScanProvider({ provider: "kortex" as "kimi" })).toThrow(
      ConfigurationError,
    );
    await expect(
      mergedCodexConfig({ provider: "kortex" as "kimi" }),
    ).rejects.toThrow(
      'Unknown Codex provider: kortex. Expected "openai" or "kimi".',
    );
    // The frozen preset cannot be mutated by callers.
    expect(Object.isFrozen(KIMI_CODEX_PROVIDER_PRESET)).toBe(true);
  });
});

describe("Kimi authentication", () => {
  test("accepts KIMI_API_KEY as sufficient credential", () => {
    expect(
      scanAuthentication(
        { KIMI_API_KEY: "synthetic-kimi-key" },
        "auto",
        "kimi",
      ),
    ).toEqual({
      method: "api_key",
      source: "KIMI_API_KEY",
      verified: false,
    });
  });

  test("falls back to stored_credentials without a key and rejects --auth api-key", () => {
    expect(scanAuthentication({}, "auto", "kimi")).toEqual({
      method: "stored_credentials",
      verified: false,
    });
    expect(() => scanAuthentication({}, "api-key", "kimi")).toThrow(
      AuthenticationRequiredError,
    );
    expect(() => scanAuthentication({}, "api-key", "kimi")).toThrow(
      "KIMI_API_KEY",
    );
  });

  test("ignores OpenAI credentials for the Kimi provider", () => {
    expect(
      scanAuthentication({ OPENAI_API_KEY: "synthetic" }, "auto", "kimi"),
    ).toEqual({ method: "stored_credentials", verified: false });
  });

  test("leaves OpenAI behavior unchanged", () => {
    expect(scanAuthentication({}, "auto")).toEqual({
      method: "stored_credentials",
      verified: false,
    });
    expect(scanAuthentication({ OPENAI_API_KEY: "k" }, "auto")).toEqual({
      method: "api_key",
      source: "OPENAI_API_KEY",
      verified: false,
    });
    expect(() => scanAuthentication({}, "api-key")).toThrow(
      AuthenticationRequiredError,
    );
  });
});

describe("Kimi proxy lifecycle", () => {
  test("resolves the packaged proxy launcher", () => {
    expect(existsSync(kimiProxyScriptPath())).toBe(true);
  });

  test("spawns the proxy on an ephemeral port, serves health, and shuts down", async () => {
    const handle = await startKimiProxy({ apiKey: "synthetic-test-key" });
    expect(handle.port).toBeGreaterThan(0);
    expect(handle.baseUrl).toBe(`http://127.0.0.1:${handle.port}/v1`);
    const health = await fetch(
      `${handle.baseUrl}/healthz`.replace("/v1/", "/"),
    );
    expect(health.status).toBe(200);
    await handle.close();
    // After close the port is gone: the connection is refused.
    await expect(
      fetch(`http://127.0.0.1:${handle.port}/healthz`),
    ).rejects.toThrow();
    // close() is idempotent.
    await handle.close();
  });

  test("fails with a clear error (and without leaking anything) when the key is missing", async () => {
    await expect(startKimiProxy({ apiKey: "" })).rejects.toThrow(
      "exited before reporting its port",
    );
    await expect(startKimiProxy({ apiKey: "" })).rejects.toThrow(
      "KIMI_API_KEY",
    );
  });

  test("honors an abort signal during startup", async () => {
    const controller = new AbortController();
    controller.abort(new Error("scan cancelled"));
    await expect(
      startKimiProxy({
        apiKey: "synthetic-test-key",
        signal: controller.signal,
      }),
    ).rejects.toThrow("scan cancelled");
  });
});

describe("CodexSecurity Kimi integration", () => {
  test("preflight reports the Kimi model and KIMI_API_KEY authentication", async () => {
    const root = await temporaryDirectory();
    const repository = join(root, "repository");
    await mkdir(repository);
    let runtimeStarted = false;
    const client = new TestClient(
      { provider: "kimi" },
      {
        environment: { KIMI_API_KEY: "synthetic-kimi-key" },
        prepareRuntime: async () => {
          runtimeStarted = true;
          throw new Error("runtime should not initialize");
        },
      },
    );
    await expect(client.preflight(repository)).resolves.toMatchObject({
      model: "k3-256k",
      reasoningEffort: "high",
      authentication: {
        method: "api_key",
        source: "KIMI_API_KEY",
        verified: false,
      },
    });
    expect(runtimeStarted).toBe(false);
    await client.close();
  });

  test("run reaches Codex without an OpenAI apiKey and reports Kimi auth", async () => {
    const root = await temporaryDirectory();
    const repository = join(root, "repository");
    const codexHome = join(root, "codex-home");
    const scanDir = join(root, "scan");
    await mkdir(repository);
    await mkdir(codexHome);
    await mkdir(scanDir, { mode: 0o700 });
    let codexOptions: CodexOptions | null = null;
    let authentication: ScanAuthentication | undefined;
    const client = new TestClient(
      { provider: "kimi" },
      {
        environment: { KIMI_API_KEY: "synthetic-kimi-key" },
        prepareRuntime: async () => preparedRuntime(codexHome),
        resolvePluginPython: async () => "/managed/python",
        prepareOutputDir: async () => scanDir,
        repositoryRevision: async () => "deadbeef",
        createCodex: (options: CodexOptions) => {
          codexOptions = options;
          throw new Error("kimi scan reached");
        },
      },
    );
    await expect(
      client.run(repository, {
        onAuthentication: (value) => {
          authentication = value;
        },
      }),
    ).rejects.toThrow("kimi scan reached");
    expect(authentication).toEqual({
      method: "api_key",
      source: "KIMI_API_KEY",
      verified: false,
    });
    // The Kimi key must not be handed to the Codex subprocess as its API
    // key; the loopback proxy needs no downstream auth.
    expect((codexOptions as CodexOptions | null)?.apiKey).toBeUndefined();
    await client.close();
  });

  test("run without KIMI_API_KEY fails with AuthenticationRequiredError", async () => {
    const root = await temporaryDirectory();
    const repository = join(root, "repository");
    const codexHome = join(root, "codex-home");
    await mkdir(repository);
    await mkdir(codexHome);
    const client = new TestClient(
      { provider: "kimi" },
      {
        environment: {},
        prepareRuntime: async () => preparedRuntime(codexHome),
        resolvePluginPython: async () => "/managed/python",
        repositoryRevision: async () => "deadbeef",
        createCodex: () => {
          throw new Error("must not reach Codex");
        },
      },
    );
    await expect(client.run(repository)).rejects.toBeInstanceOf(
      AuthenticationRequiredError,
    );
    await expect(client.run(repository)).rejects.toThrow("KIMI_API_KEY");
    await client.close();
  });

  test("close() tears down the runtime's Kimi proxy handle", async () => {
    const root = await temporaryDirectory();
    const repository = join(root, "repository");
    const codexHome = join(root, "codex-home");
    const scanDir = join(root, "scan");
    await mkdir(repository);
    await mkdir(codexHome);
    await mkdir(scanDir, { mode: 0o700 });
    let proxyClosed = false;
    const client = new TestClient(
      { provider: "kimi" },
      {
        environment: { KIMI_API_KEY: "synthetic-kimi-key" },
        prepareRuntime: async () => ({
          ...preparedRuntime(codexHome),
          kimiProxy: {
            port: 1,
            baseUrl: "http://127.0.0.1:1/v1",
            close: async () => {
              proxyClosed = true;
            },
          },
        }),
        resolvePluginPython: async () => "/managed/python",
        prepareOutputDir: async () => scanDir,
        repositoryRevision: async () => "deadbeef",
        createCodex: () => {
          throw new Error("stop after runtime preparation");
        },
      },
    );
    await expect(client.run(repository)).rejects.toThrow(
      "stop after runtime preparation",
    );
    await client.close();
    expect(proxyClosed).toBe(true);
  });
});

describe("cost estimation for the Kimi model", () => {
  test("k3-256k has no pricing entry (flat subscription)", () => {
    expect(
      estimateScanCost("k3-256k", { input_tokens: 0, output_tokens: 0 }),
    ).toBeNull();
    // OpenAI models keep their pricing.
    expect(
      estimateScanCost("gpt-5.6-sol", { input_tokens: 0, output_tokens: 0 }),
    ).not.toBeNull();
  });
});

describe("CLI --provider", () => {
  test("passes --provider kimi into the CodexSecurity config", async () => {
    const stdout = capture();
    const stderr = capture();
    let config: Record<string, unknown> | undefined;
    const exitCode = await cliMain(
      ["scan", "repo", "--provider", "kimi", "--dry-run"],
      stdout.stream,
      stderr.stream,
      dependencies({
        environment: { KIMI_API_KEY: "synthetic-kimi-key" },
        onConfig: (value) => {
          config = value as Record<string, unknown>;
        },
      }),
    );
    expect(exitCode).toBe(0);
    expect(config?.["provider"]).toBe("kimi");
  });

  test("rejects an unknown --provider value", async () => {
    const stdout = capture();
    const stderr = capture();
    const exitCode = await cliMain(
      ["scan", "repo", "--provider", "kortex", "--dry-run"],
      stdout.stream,
      stderr.stream,
      dependencies(),
    );
    expect(exitCode).toBe(2);
  });

  test("parses dotted model_providers overrides for validate/fix", () => {
    const overrides = parseCodexOverrides(
      ['model_providers.kimi.base_url="http://127.0.0.1:8321/v1"'],
      undefined,
      undefined,
    );
    expect(overrides).toEqual({
      model_providers: { kimi: { base_url: "http://127.0.0.1:8321/v1" } },
    });
  });
});
