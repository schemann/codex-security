/**
 * Lifecycle management for the local Kimi translation proxy
 * (bin/codex-security-proxy.mjs). The SDK spawns the proxy on an ephemeral
 * port when `provider: "kimi"` is configured, hands the loopback base_url to
 * Codex via the isolated CODEX_HOME config, and kills the child again when
 * the runtime is torn down.
 *
 * The Kimi API key is only passed to the proxy child as an environment
 * variable; it is never written to files or logs. The proxy itself never
 * logs the key either, so captured stderr is safe to include in errors.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CodexSecurityError } from "./errors.js";

export interface KimiProxyHandle {
  port: number;
  /** Loopback base URL for the Codex provider config, e.g. http://127.0.0.1:8321/v1 */
  baseUrl: string;
  close(): Promise<void>;
}

export interface StartKimiProxyOptions {
  apiKey: string;
  signal?: AbortSignal;
  /**
   * Additional child environment (never secrets other than the upstream
   * credential itself): provider-specific tuning such as KIMI_BASE_URL,
   * PROXY_THINKING_FIELD or PROXY_THINKING_STYLE.
   */
  extraEnv?: Record<string, string>;
}

const LISTENING_LINE = /PROXY_LISTENING port=(\d{1,5})/;
const START_TIMEOUT_MS = 10_000;
const STOP_GRACE_MS = 2_000;
const STDERR_LIMIT = 8192;

/** Resolve the proxy launcher shipped inside this package. */
export function kimiProxyScriptPath(): string {
  // dist/kimi-proxy.js in the built package and src/kimi-proxy.ts under the
  // test runner are both one level below the package root.
  const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
  const script = join(packageRoot, "bin", "codex-security-proxy.mjs");
  if (!existsSync(script)) {
    throw new CodexSecurityError(
      `The Kimi translation proxy launcher is missing from the installed package: ${script}`,
    );
  }
  return script;
}

export async function startKimiProxy(
  options: StartKimiProxyOptions,
): Promise<KimiProxyHandle> {
  // Check upfront: not every runtime fires abort listeners registered on an
  // already-aborted signal synchronously.
  if (options.signal?.aborted) {
    throw options.signal.reason instanceof Error
      ? options.signal.reason
      : new CodexSecurityError("The Kimi proxy startup was aborted.");
  }
  const script = kimiProxyScriptPath();
  const child = spawn(process.execPath, [script], {
    env: {
      // Keep the child environment minimal: the proxy only needs the API
      // key (bearer credential upstream) and PATH to be a well-behaved
      // process. The key never appears in argv or logs.
      PATH: process.env["PATH"] ?? "",
      KIMI_API_KEY: options.apiKey,
      PORT: "0",
      ...options.extraEnv,
      ...(process.env["PROXY_LOG"] === "1" ? { PROXY_LOG: "1" } : {}),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  const debugTee = process.env["PROXY_LOG"] === "1";
  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    if (debugTee) {
      process.stderr.write(chunk);
    }
    if (stderr.length < STDERR_LIMIT) {
      stderr += chunk.toString("utf8").slice(0, STDERR_LIMIT - stderr.length);
    }
  });

  // Last-resort orphan guard: if the SDK process dies without close(), the
  // proxy must not outlive it.
  const killOnParentExit = (): void => {
    child.kill("SIGKILL");
  };
  process.once("exit", killOnParentExit);

  const stopChild = async (): Promise<void> => {
    process.removeListener("exit", killOnParentExit);
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise<void>((resolve) => {
      child.once("exit", () => {
        resolve();
      });
    });
    child.kill("SIGTERM");
    const grace = new Promise<void>((resolve) => {
      setTimeout(resolve, STOP_GRACE_MS).unref();
    });
    await Promise.race([exited, grace]);
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await exited.catch(() => undefined);
    }
  };

  const failure = (message: string): CodexSecurityError => {
    const excerpt = stderr.trim();
    return new CodexSecurityError(
      excerpt.length > 0 ? `${message}\nProxy output: ${excerpt}` : message,
    );
  };

  const port = await new Promise<number>((resolve, reject) => {
    let stdout = "";
    let settled = false;
    const cleanup = (): void => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
    };
    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      void stopChild().finally(() => {
        reject(error);
      });
    };
    const succeed = (value: number): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };
    const onAbort = (): void => {
      fail(
        options.signal?.reason instanceof Error
          ? options.signal.reason
          : new CodexSecurityError("The Kimi proxy startup was aborted."),
      );
    };
    const timer = setTimeout(() => {
      fail(
        failure(
          "The Kimi translation proxy did not report its listening port in time.",
        ),
      );
    }, START_TIMEOUT_MS);
    timer.unref();
    options.signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      const match = LISTENING_LINE.exec(stdout);
      if (match !== null) {
        succeed(Number.parseInt(match[1] ?? "", 10));
      }
    });
    child.once("error", (error) => {
      fail(
        failure(`The Kimi translation proxy failed to start: ${error.message}`),
      );
    });
    child.once("exit", (code) => {
      fail(
        failure(
          `The Kimi translation proxy exited before reporting its port (exit code ${String(code)}).`,
        ),
      );
    });
  });

  return {
    port,
    baseUrl: `http://127.0.0.1:${port}/v1`,
    close: stopChild,
  };
}
