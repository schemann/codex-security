# Codex Security

> **Fork notice:** This repository is a fork of
> [openai/codex-security](https://github.com/openai/codex-security)
> (Apache-2.0, © OpenAI). It adds first-class support for running scans
> against subscription providers via a local translation proxy — the
> **Kimi Code API** (see [Kimi K3 (Subscription)](#kimi-k3-subscription)) and
> the **Z.ai GLM API** (see [GLM (Z.ai
> Subscription)](#glm-zai-subscription)). All upstream behavior, including
> the OpenAI default provider, is unchanged. Upstream code remains under the
> Apache License 2.0; see [LICENSE](LICENSE).

`@openai/codex-security` is a CLI and TypeScript SDK for defining security policy and finding, validating, and fixing security vulnerabilities in your code.

**👉👉 See the [Codex Security documentation](https://learn.chatgpt.com/docs/security/cli)** for full documentation.

Some cybersecurity requests and protected findings require approval through
Trusted Access for Cyber. To join the program, visit
[chatgpt.com/cyber](https://chatgpt.com/cyber).

## Quick start

Requires Node.js 22.13.0 or later and Python 3.10 or later.

```bash
npm install @openai/codex-security
npx @openai/codex-security login
npx @openai/codex-security scan /path/to/directory
```

For CI, set `OPENAI_API_KEY` instead of signing in.

## Generate SECURITY.md

Draft repository-wide or component-scoped `SECURITY.md` guidance for future scans:

```bash
npx @openai/codex-security policy .
npx @openai/codex-security policy . --path services/api --knowledge-base architecture.md
```

The command saves a draft outside the checkout; it does not install it or run a
vulnerability scan. Review the proposed diff before copying the policy. Supporting architecture,
threat-model, and review documents stay outside the repository and may contain
sensitive details. See the [SDK policy guide](sdk/typescript/README.md#generate-a-security-policy)
for headless generation, saved artifacts, and SDK usage.

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
| `PROXY_THINKING_STYLE`        | `effort`                         | `toggle` writes the mapped effort as `thinking: { type: "enabled" \| "disabled" }` (Z.ai GLM style) instead of a flat string.                                                                                                                                      |
| `PROXY_PASSTHROUGH_WEBSEARCH` | —                                | `1` forwards Codex's internal `web_search` tool instead of dropping it.                                                                                                                                                                                            |
| `PROXY_LOG`                   | —                                | `1` enables debug logs on stderr (request summaries, stream completion with finish_reason/usage/tool calls). When the SDK spawns the proxy, `PROXY_LOG=1` is forwarded and the proxy's stderr is teed through to the SDK's stderr. Logs never contain the API key. |

## GLM (Z.ai Subscription)

Scans can equally run against the **Z.ai GLM API** (GLM Coding Plan
subscription) instead of OpenAI. OpenAI remains the default provider; nothing
changes unless you pass `--provider glm`.

### Prerequisites

- A Z.ai subscription with the GLM Coding Plan.
- An API key from <https://z.ai> (API keys section), exported as:

```bash
export GLM_API_KEY=…
```

No OpenAI login or OpenAI API key is required for GLM scans.

### Usage

```bash
codex-security scan . --provider glm                 # defaults: glm-5.3, effort high
codex-security scan . --provider glm --model glm-4.7 # smaller/cheaper variant
codex-security scan . --provider glm --effort low    # thinking reduced
```

The default model is `glm-5.3` with reasoning effort `high`. GLM models have
no effort ladder — the proxy maps effort onto the Z.ai thinking switch
(`low → thinking disabled`, everything else → `thinking enabled`).
`--model`, `--effort`, and `--codex KEY=VALUE` overrides work as usual and
win over the preset. The upstream endpoint defaults to the Coding Plan URL
(`https://api.z.ai/api/coding/paas/v4`) and can be overridden with
`GLM_BASE_URL`.

### How it works

Same translation-proxy architecture as Kimi (see above): the SDK spawns the
local proxy on an ephemeral loopback port, points Codex at it, and kills it
when the scan ends:

```
Codex binary → POST http://127.0.0.1:<port>/v1/responses  (Responses API, SSE)
             → local proxy (spawned per runtime, ephemeral port)
             → POST https://api.z.ai/api/coding/paas/v4/chat/completions  (Chat SSE)
```

The stream translator already understands the `reasoning_content` deltas that
Z.ai streams for GLM thinking, and tool calls follow the same
OpenAI-compatible Chat shape — so scan artifacts, continuations, and quota
behavior behave like the Kimi path. GLM models have no per-token pricing
entry, so `--max-cost` is not enforceable (warning, not error).

### Proxy configuration (GLM)

```bash
GLM_API_KEY=… KIMI_BASE_URL=https://api.z.ai/api/coding/paas/v4 \
PROXY_THINKING_FIELD=thinking PROXY_THINKING_STYLE=toggle PORT=8321 \
codex-security-proxy
```

`PROXY_THINKING_STYLE=toggle` maps the Codex effort onto
`thinking: { type: "enabled" | "disabled" }` instead of a flat effort field.

## TypeScript SDK

To suggest owners for existing findings from source and Git history, see
[Suggest finding owners](sdk/typescript/README.md#suggest-finding-owners).

Codex Security is a Javascript package:

```ts
import { CodexSecurity } from "@openai/codex-security";

const security = new CodexSecurity();
const result = await security.run("/path/to/directory");
await security.run("/path/to/directory", {
  mode: "deep",
  workers: 2,
  subagents: 0,
  stopAfterNoNew: 3,
  maxDiscoveryRuns: 10,
  maxTimeHours: 1.5,
});

console.log(result.reportPath);
await security.close();
```

## Containerized bulk scans

Use the included Docker Compose configuration for scans of many repositories. See the [container quick start](sdk/typescript/README.md#containerized-bulk-scans) for more detail.

For individual CLI stages with durable state and access to a separately deployed
findings service, use the same scanner image with the
[workflow runner Compose example](docker/README.md#workflow-runner).

## Findings service (preview)

Run `npx @openai/codex-security serve` to start the service without Docker. See
[running without Docker](sdk/typescript/README.md#running-without-docker)
for prerequisites, credentials, and storage configuration.

The [findings service](sdk/typescript/README.md#findings-service-preview) runs
from the same `ghcr.io/openai/codex-security` image as the scanner (or a local
source build), with a separate container and state volume configured by
`compose.findings.yaml`. It stores findings and embeddings in SQLite and lists
findings with pagination. Its read-only dashboard at `/dashboard` refreshes every
five seconds and shows stored findings and duplicate groups from the service's
database. It also returns potential duplicates by embedding similarity within a
repository or an explicit all-repository scope. The
`npx @openai/codex-security publish scan --to custom --findings-url http://localhost:3000`
command uploads completed findings and their repository ID. The SDK and
`npx @openai/codex-security dedupe` command retrieve candidates, run independent Codex
reviews locally, and persist accepted duplicate groups; `--all-repositories`
opts into the broader scope.

Use `npx @openai/codex-security classify-severity --scan SCAN_ID --rubric /path/to/policy.md`
to assess selected findings under your own policy before publishing tickets.
Scan classification checkpoints each finding in SQLite and reuses matching
assessments on reruns; `--reprocess` forces reassessment. The SDK exposes the same
classification operation; original scan severity stays unchanged. See [severity classification](sdk/typescript/README.md#classify-finding-severity).

## Other providers

To use another inference provider, set its API key and select a model:

```bash
export AWS_BEARER_TOKEN_BEDROCK="<your-bedrock-api-key>"
export AWS_REGION="us-east-2"
npx @openai/codex-security scan . --provider amazon-bedrock --model openai.gpt-5.6-luna

export OPENROUTER_API_KEY="<your-openrouter-api-key>"
npx @openai/codex-security scan . --provider openrouter --model anthropic/claude-sonnet-4.5

export FIREWORKS_API_KEY="<your-fireworks-api-key>"
npx @openai/codex-security scan . --provider fireworks --model accounts/fireworks/models/qwen3-235b-a22b
```

## Documentation

**👉👉 See the [Codex Security documentation](https://learn.chatgpt.com/docs/security/cli)** for full documentation.

See [project configuration](docs/project-configuration.md) for reusable YAML/JSON
settings, CLI overrides, and editor schema support.
