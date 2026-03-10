# Architecture decision: Worker + Durable Object bootstrap

## Decision

Use `cloudflare/moltworker` as the baseline reference, but bootstrap this repo as
a standard Cloudflare Worker + Durable Object application instead of preserving a
Cloudflare Sandbox container runtime.

## Reuse boundary

### Preserve where sensible
- Browser-first control-surface patterns
- Cloudflare-native request/gateway conventions
- Edge-friendly composition patterns that do not depend on sandboxed containers

### Replace for this project
- Sandbox/container lifecycle management
- Container-first runtime execution assumptions
- Local runtime persistence as the core memory model

## State architecture handoff

The Worker/DO shell now uses an AaronDB-style state model:

1. **Worker** accepts browser/API traffic and resolves one Durable Object per session.
2. **Durable Object** owns the hot in-memory projection for that session.
3. **D1** stores the immutable AaronDB fact log for session facts, messages, tool
   events, and recall terms.
4. **Rehydration** rebuilds session state from D1 so replay survives Durable Object
   restart/reload.
5. **Recall** uses persisted recall-term facts, giving the next wave a stable
   AaronDB-backed memory endpoint to call.

This keeps the architecture Cloudflare-native and browser-first while avoiding a
return to container-first runtime assumptions.

## AaronDB Edge import seam

- The repo now vendors a tight runtime slice from `criticalinsight/aarondb-edge`
  under `vendor/aarondb-edge/` rather than treating AaronDB Edge as a separate
  HTTP sidecar Worker.
- `src/aarondb-edge-substrate.ts` is the explicit seam AaronClaw imports today.
  It exposes the upstream entrypoint, source manifests, route surface, and FFI
  helpers while keeping the current session repository as a temporary adapter.
- Binding bridge for the current app shape:
  - `AARONDB_STATE` upstream Durable Object → `SESSION_RUNTIME`
  - `DB` upstream D1 binding → `AARONDB`
  - `AI` already matches
  - `CONFIG_KV`, `VECTOR_INDEX`, and `ARCHIVE` are not mounted yet and remain
    follow-up bindings for the real adapter wave.
- Build implication: upstream `src/index.mjs` imports generated Gleam output from
  `build/dev/javascript`. Vendoring the source slice now keeps the runtime
  contract in-repo, but the next wave must either vendor built artifacts or add
  an explicit Gleam build step before replacing AaronClaw's handwritten
  repository with imported AaronDB Edge runtime pieces.

## Dogfood deployment path

- The checked-in `wrangler.jsonc` is local-first: it keeps a stable
  `preview_database_id` (`aaronclaw-local`) for `wrangler dev` and local D1
  migrations.
- The remote `database_id` is intentionally injected at deploy time from
  `AARONCLAW_D1_DATABASE_ID` into `.wrangler/deploy/wrangler.jsonc`.
- This avoids committing a real Cloudflare resource UUID while still making the
  production deployment path explicit and repeatable.

## Minimal auth stance

- Personal dogfood mode uses a single bearer token (`APP_AUTH_TOKEN`).
- The landing page remains public so the browser can load and prompt for that
  token.
- All `/api/*` routes are protected when the token is configured.
- This is acceptable for a single-user Worker deployment, but it is not a
  substitute for Cloudflare Access or a real multi-user auth system.

## Assistant fallback stance

- Workers AI is the intended production assistant path.
- Deterministic fallback remains enabled so first-run create/send/reload flows
  continue to work even if AI is not bound or the model call degrades.
- Fallback is therefore an operational continuity path, not the target quality
  mode for real assistant dogfooding.

## Companion docs

- `docs/setup.md` — local setup and first-run flow
- `docs/deployment.md` — Cloudflare deployment, auth posture, and troubleshooting
- `docs/runtime.md` — public routes, browser control surface, and API behavior
- `docs/state-model.md` — AaronDB-style fact model, replay, and recall details