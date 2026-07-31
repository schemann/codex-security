# Codex Security

> **Fork notice:** This repository is a fork of
> [openai/codex-security](https://github.com/openai/codex-security)
> (Apache-2.0, © OpenAI). It adds first-class support for running scans against
> the **Kimi Code API** (K3 models, subscription) via a local translation
> proxy — see [Kimi K3 (Subscription)](#kimi-k3-subscription) below. All
> upstream behavior, including the OpenAI default provider, is unchanged.
> Upstream code remains under the Apache License 2.0; see
> [LICENSE](LICENSE).

`@openai/codex-security` is a CLI and TypeScript SDK for finding, validating, and fixing security vulnerabilities in your code.

**See the [Codex Security documentation](https://learn.chatgpt.com/docs/security/cli)** for more details.

> Note: for best results, we recommend that your account is verified for [Trusted Access](https://chatgpt.com/cyber).

## Quick start

Requires Node.js 22.13.0 or later in the 22.x release line, Node.js 24.x, or
Node.js 26.x; Python 3.10 or later; and access to Codex Security.

```bash
npm install @openai/codex-security
npx @openai/codex-security login
npx @openai/codex-security scan .
npx @openai/codex-security scan . --model gpt-5.6-terra --effort high
```

For CI, set `OPENAI_API_KEY` or `CODEX_API_KEY` instead of signing in. Environment API keys are
passed directly to the current scan and are never stored in Codex's credential
home or system keyring.

Local sign-in honors Codex's configured credential backend, including a system
keyring required by a managed device. Codex Security keeps login and scan
credentials in the same private, persistent state directory.

If both a ChatGPT sign-in and an API key are available, interactive scans ask
which credential to use. CI and other noninteractive scans keep the existing
API-key precedence. Select a credential explicitly when needed:

```bash
npx @openai/codex-security scan . --auth chatgpt
npx @openai/codex-security scan . --auth api-key
```

To make your ChatGPT sign-in the automatic default, unset any configured API
keys:

```bash
unset OPENAI_API_KEY CODEX_API_KEY
```

Scan history is stored in the Codex Security workbench state directory. If that
directory cannot be written, set `CODEX_SECURITY_STATE_DIR` to a writable
directory outside the repository.

`scans compare BEFORE_SCAN_ID AFTER_SCAN_ID` automatically matches findings by
root cause, reuses saved matches, and identifies new, persisting, reopened,
resolved, or unknown findings. Missing findings remain unknown when coverage is
incomplete or their original location was not reviewed.

## Kimi K3 (Subscription)

Scans can run against the **Kimi Code API** (K3 thinking models, flat-rate
subscription) instead of OpenAI. OpenAI remains the default provider; nothing
changes unless you pass `--provider kimi`.

### Prerequisites

- A Kimi membership with the Kimi Code benefit (Moderato tier or higher for
  the `k3` / `k3-256k` models).
- An API key from <https://www.kimi.com/code/console>, exported as:

```bash
export KIMI_API_KEY=…
```

No OpenAI login or OpenAI API key is required for Kimi scans.

### Usage

```bash
codex-security scan . --provider kimi                 # defaults: k3-256k, effort high
codex-security scan . --provider kimi --model k3      # 1M-token context variant
codex-security scan . --provider kimi --effort low    # cheaper/faster thinking
```

The default model is `k3-256k` with reasoning effort `high`. Codex effort
levels map onto Kimi thinking levels as `low→low`, `medium→high`, `high→high`,
`xhigh→max`. `--model`, `--effort`, and `--codex KEY=VALUE` overrides work as
usual and win over the preset.

### How it works

The Codex binary only speaks the OpenAI Responses API (SSE streaming), while
the Kimi Code API offers OpenAI-style Chat Completions. When `provider=kimi`
is selected, the SDK automatically spawns a small local translation proxy
(`codex-security-proxy`, no extra dependencies) on an ephemeral loopback port,
points Codex at it, and kills it again when the scan ends:

```
Codex binary → POST http://127.0.0.1:<port>/v1/responses  (Responses API, SSE)
             → local proxy (spawned per runtime, ephemeral port)
             → POST https://api.kimi.com/coding/v1/chat/completions  (Chat SSE)
```

The proxy translates requests (messages, tool definitions incl. namespace
flattening, reasoning effort) and responses (text/tool-call/thinking deltas,
usage) bidirectionally.

### Quota notes

- Kimi enforces rate limits per 5-hour window (roughly 300–1200 requests
  depending on model/tier, ~30 concurrent). For scale: one scan of a small
  fixture repository consumed **39 requests over ~15 minutes** (≈2.5M input
  tokens, of which ≈2.47M were served from prompt cache).
- `k3` (1M context) consumes roughly **2× the quota** of `k3-256k` per
  request; prefer `k3-256k` unless you need the large context.
- Prompt caching on the Kimi side reduces effective token costs
  substantially on multi-turn scans (observed: ~99% cached input tokens).

### Known limitations

- **No video input** (Codex client limitation, not specific to Kimi).
- `view_image` tool outputs are replaced with a text placeholder; the model
  cannot see images returned by tools. User-attached images are forwarded.
- **Cost estimation / `--max-cost` are not enforceable** for Kimi models
  (flat-rate subscription, no per-token pricing). The SDK emits a warning
  instead of failing; OpenAI models keep exact cost tracking.
- **Stability:** Kimi K3 sometimes ends a turn early, before the scan
  pipeline wrote all canonical artifacts. The SDK detects this and
  automatically continues the scan in the same thread (up to 3 continuations,
  visible as a CLI warning). If a scan still finishes without results, re-run
  it.

### Proxy configuration

The SDK spawns the proxy with sensible defaults. For standalone or advanced
use, the proxy binary is available directly:

```bash
KIMI_API_KEY=… PORT=8321 codex-security-proxy   # prints PROXY_LISTENING port=<p>
```

Environment variables:

| Variable                      | Default                          | Purpose                                                                                                                                                                                                                                                            |
| ----------------------------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `KIMI_API_KEY`                | — (required)                     | Bearer credential sent upstream; never logged or persisted.                                                                                                                                                                                                        |
| `KIMI_BASE_URL`               | `https://api.kimi.com/coding/v1` | Upstream base URL; generic by design, so other OpenAI-Chat-compatible providers can be proxied too.                                                                                                                                                                |
| `PORT`                        | `0` (ephemeral)                  | Listen port; the chosen port is printed as `PROXY_LISTENING port=<p>`.                                                                                                                                                                                             |
| `PROXY_MODEL_MAP`             | —                                | JSON object renaming models, e.g. `{"gpt-5.6-sol":"k3-256k"}`.                                                                                                                                                                                                     |
| `PROXY_THINKING_FIELD`        | `reasoning_effort`               | Request field carrying the mapped thinking effort (verified against the live API).                                                                                                                                                                                 |
| `PROXY_PASSTHROUGH_WEBSEARCH` | —                                | `1` forwards Codex's internal `web_search` tool instead of dropping it.                                                                                                                                                                                            |
| `PROXY_LOG`                   | —                                | `1` enables debug logs on stderr (request summaries, stream completion with finish_reason/usage/tool calls). When the SDK spawns the proxy, `PROXY_LOG=1` is forwarded and the proxy's stderr is teed through to the SDK's stderr. Logs never contain the API key. |

### Outlook: other providers (e.g. GLM)

The proxy architecture is provider-generic: it translates between two API
shapes, not between two vendors. `KIMI_BASE_URL` already accepts any
OpenAI-Chat-Completions-compatible endpoint, so a future provider preset
(e.g. GLM-5.2 via its coding endpoint) only needs a new named preset in the
SDK config — the proxy itself requires no changes.

## TypeScript SDK

```ts
import { CodexSecurity } from "@openai/codex-security";

const security = new CodexSecurity();
const result = await security.run(".");

console.log(result.reportPath);
await security.close();
```

For complete command help, runtime defaults, native multi-agent worker limits,
environment variables, deep-scan configuration, and SDK options, see the
[package README](sdk/typescript/README.md) and the
[official CLI reference](https://learn.chatgpt.com/docs/security/cli/reference).
