# AGENTS.md

Guidance for agentic coding sessions in this repository.

## What this repository is

Fork of [openai/codex-security](https://github.com/openai/codex-security)
(Apache-2.0). Upstream: CLI + TypeScript SDK (`sdk/typescript`) that drives the
Codex binary for security scans. Fork addition: `kimi` and `glm` providers that
run scans against subscription APIs (Kimi Code API with K3 models; Z.ai GLM
API with glm-5.3) through a local translation proxy. OpenAI remains the
default provider — keep upstream behavior unchanged.

## Build, lint, test

All commands run in `sdk/typescript/`:

- Build: `corepack pnpm build` (tsc → `dist/`)
- Lint/typecheck: `corepack pnpm lint` (strict tsc, no emit)
- Format: `corepack pnpm exec prettier --check|write <files>`
- Tests use **bun:test** (not vitest): run targeted files only, e.g.
  `bun test --timeout 30000 tests-ts/kimi-provider.test.ts`
- The full suite (`bun test ./tests-ts`) has known flaky 30s-timeout failures
  in CLI/auth/keyring tests under parallel load; re-run affected files
  individually before suspecting a regression.

## Kimi proxy architecture (3 sentences)

The Codex binary speaks only the OpenAI Responses API (SSE); the Kimi Code
API offers only OpenAI Chat Completions, so `sdk/typescript/src/proxy/`
implements a dependency-free HTTP proxy (`bin/codex-security-proxy.mjs`) that
translates requests and SSE streams bidirectionally, including tool-call
round-trips and namespace-tool flattening (`ns__name`, double underscore —
Kimi rejects dots in function names). When `provider=kimi`, the SDK
(`src/kimi-proxy.ts`, wired in `src/api.ts`) spawns this proxy on an ephemeral
loopback port, injects `model_providers.kimi.base_url` into the isolated
CODEX_HOME config, and kills the child on runtime teardown. Thinking effort
is sent as `reasoning_effort` (verified live; low/medium/high/xhigh →
low/high/high/max), configurable via `PROXY_THINKING_FIELD`. K3 occasionally
ends a turn before all scan artifacts exist; `src/api.ts` therefore retries
artifact-completion failures (`isMissingScanArtifactError`, incl. schema
validation errors naming `scan-manifest|findings|coverage`) with up to
`KIMI_MAX_CONTINUATIONS` continuation prompts in the same thread — Kimi
provider only, never for OpenAI.

## Hard rules

- **No secrets in code, tests, fixtures, or logs.** `KIMI_API_KEY` may only
  travel as an environment variable to the proxy child; the proxy must never
  log it. Tests use synthetic dummy values only.
- **No git commits, pushes, or other git mutations without explicit user
  approval.**
- Verify before claiming done: build + lint + the targeted tests of the area
  you touched.

## Upstream sync workflow

Branch layout: `main` mirrors upstream and stays clean; all fork work lives
on the `develop` branch (formerly `kimi`, renamed when the GLM provider
joined — the branch carries every fork provider). Remotes:
`origin` = schemann/codex-security (fork), `upstream` = openai/codex-security.

To pull in upstream updates:

```bash
git fetch upstream
git checkout main && git merge --ff-only upstream/main
git checkout develop && git merge main
# resolve conflicts, then verify:
cd sdk/typescript && corepack pnpm install && corepack pnpm lint && corepack pnpm build
bun test tests-ts/kimi-provider.test.ts tests-ts/kimi-continuation.test.ts \
  tests-ts/proxy-server.test.ts tests-ts/proxy-translate-request.test.ts \
  tests-ts/proxy-translate-stream.test.ts
git push origin main develop
```

Typical conflict hotspots when upstream changes: `src/api.ts` (auth gate,
run loop, continuation logic), `src/config.ts` (defaults), `src/cli.ts`
(flags), `src/cost.ts` (pricing). After any upstream bump of
`@openai/codex`, re-verify that the bundled binary still only speaks the
Responses API and that the proxy acceptance test (tool-call turn) passes.
