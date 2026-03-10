# aaronclaw

AaronClaw is a Cloudflare-native OpenClaw-style assistant with a browser-first
control surface, a standard Worker + Durable Object runtime, and an AaronDB-style
immutable D1 fact log as the source of truth for session memory.

The current live deployment is:

- `https://aaronclaw.moneyacad.workers.dev`

## Start here

Use the smallest doc that answers your question:

- [`docs/setup.md`](docs/setup.md) — local install, first run, and browser flow.
- [`docs/deployment.md`](docs/deployment.md) — Cloudflare deploy path,
  auth/security posture, operational checks, and troubleshooting.
- [`docs/runtime.md`](docs/runtime.md) — HTTP routes, browser control surface,
  session behavior, and assistant runtime semantics.
- [`docs/state-model.md`](docs/state-model.md) — the AaronDB-style fact model,
  replay flow, recall semantics, and why Durable Objects stay lightweight.
- [`docs/architecture.md`](docs/architecture.md) — architecture decision and
  reuse boundary relative to `cloudflare/moltworker`.

## What is deployed now

As verified against the live Worker on 2026-03-09:

- `GET /health` reports `authMode: none` and `assistantRuntime: workers-ai`.
- `defaultModel` is `@cf/meta/llama-3.1-8b-instruct`.
- `HEAD /` and `HEAD /health` both return `200`, so simple probes work.
- A full remote smoke flow passed: create session → chat → reload persisted
  state → recall persisted matches.

That means the public deployment is currently usable without an auth token.
Treat that as a personal dogfood posture, not a hardened multi-user setup.

## Quick local loop

```sh
npm install
wrangler d1 migrations apply aaronclaw-aarondb --local
npm run validate:config
npm run dev
```

Then:

1. Open the local Worker URL in a browser.
2. Create a session.
3. Send a prompt.
4. Reload the session and confirm history replays.
5. Visit `/health` and confirm the auth/assistant runtime you expect.

Use these verification commands when you need a quick confidence pass:

```sh
npm run typecheck
npm test
```

See [`docs/setup.md`](docs/setup.md) for the full first-run path.

## Quick Cloudflare deploy loop

```sh
wrangler d1 create aaronclaw-aarondb
export AARONCLAW_D1_DATABASE_ID=<uuid-from-create>
wrangler d1 migrations apply aaronclaw-aarondb --remote
npm run deploy:prep
npm run deploy:dry-run
npm run deploy
```

Optional but recommended for anything non-public:

```sh
wrangler secret put APP_AUTH_TOKEN
```

See [`docs/deployment.md`](docs/deployment.md) for the complete sequence,
validation notes, and troubleshooting guidance.

## Runtime summary

- `GET /` serves the browser UI.
- `GET /health` reports runtime, auth, and assistant status.
- `POST /api/sessions` creates a session.
- `GET /api/sessions/:id` reloads a projected session snapshot.
- `POST /api/sessions/:id/chat` appends a user message, generates an assistant
  reply, and persists both turns.
- `POST /api/sessions/:id/messages` and `POST /api/sessions/:id/tool-events`
  are the lower-level append endpoints.
- `GET /api/sessions/:id/recall?q=...` performs AaronDB-style recall over the
  persisted fact log.
- `POST /telegram/webhook` is an optional Telegram ingress that maps Telegram
  chat/user pairs onto the same session runtime.

See [`docs/runtime.md`](docs/runtime.md) for request semantics and browser usage.

## Baseline and reuse boundary

- **Baseline:** `cloudflare/moltworker`
- **Keep:** Cloudflare-native gateway and control-surface patterns that fit a
  browser-first Worker app.
- **Do not keep:** Cloudflare Sandbox container runtime assumptions, container
  lifecycle management, or container-local persistence as the core architecture.
- **State source of truth:** `criticalinsight/aarondb-edge` as an architectural
  model, now vendored as an in-repo runtime slice with the current AaronClaw
  session layer still acting as the temporary adapter.

## AaronDB Edge import strategy

- Upstream runtime source is vendored under `vendor/aarondb-edge/` from
  `criticalinsight/aarondb-edge` (`master@dafbba3f02da02c8812ef1026deb2062c41ea96b`).
- `src/aarondb-edge-substrate.ts` exposes the vendored runtime's binding map,
  route surface, and imported FFI utilities to AaronClaw code.
- Current seam mapping is `AARONDB_STATE -> SESSION_RUNTIME` and `DB -> AARONDB`;
  `CONFIG_KV`, `VECTOR_INDEX`, and `ARCHIVE` remain explicit next-wave mounts.
- Build implication: upstream `src/index.mjs` expects generated Gleam JS under
  `build/dev/javascript`, so the next wave must add that bridge before swapping
  AaronClaw's live repository implementation.

## Repository map

- `src/index.ts` — Worker entrypoint, auth checks, public routes, Durable Object
  dispatch.
- `src/aarondb-edge-substrate.ts` — vendored AaronDB Edge import seam, binding
  map, and reusable upstream FFI helpers.
- `src/routes.ts` — landing page HTML/JS and runtime status metadata.
- `src/session-runtime.ts` — session Durable Object runtime and API handlers.
- `src/session-state.ts` — immutable fact append, projection replay, and recall.
- `src/assistant.ts` — Workers AI call path plus deterministic fallback.
- `migrations/0001_aarondb_edge.sql` — D1 schema for the fact log.
- `vendor/aarondb-edge/` — vendored upstream AaronDB Edge runtime slice
  (Gleam source, JS entrypoint, wrangler manifest, migration).
- `scripts/validate-config.mjs` — local-first Wrangler config validation.
- `scripts/render-deploy-config.mjs` — injects the real D1 UUID for deploys.
