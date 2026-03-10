# Architecture decision: Worker + Durable Object bootstrap

## Decision

Use `cloudflare/moltworker` as the baseline reference, but bootstrap this repo asa standard Cloudflare Worker + Durable Object application instead of preserving aCloudflare Sandbox container runtime.

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
3. **D1** stores the immutable AaronDB fact log for session facts, messages, toolevents, and recall terms.
4. **Rehydration** rebuilds session state from D1 so replay survives Durable Objectrestart/reload.
5. **Recall** uses persisted recall-term facts, giving the next wave a stableAaronDB-backed memory endpoint to call.

This keeps the architecture Cloudflare-native and browser-first while avoiding areturn to container-first runtime assumptions.

## AaronDB Edge import seam

- The repo now vendors a tight runtime slice from `criticalinsight/aarondb-edge`under `vendor/aarondb-edge/` rather than treating AaronDB Edge as a separateHTTP sidecar Worker.
- `src/aarondb-edge-substrate.ts` is the explicit seam AaronClaw imports today.It exposes the upstream entrypoint, source manifests, route surface, and FFIhelpers while keeping the current session repository as a temporary adapter.
- Binding bridge for the current app shape:
  - `AARONDB_STATE` upstream Durable Object → `SESSION_RUNTIME`
  - `DB` upstream D1 binding → `AARONDB`
  - `AI` already matches
  - `VECTOR_INDEX` now maps through directly and backs the knowledge-vault /Hyper-Recall compatibility path when available.
  - `CONFIG_KV` and `ARCHIVE` are still not mounted and remain follow-upbindings for the fuller adapter wave.
- Build implication: upstream `src/index.mjs` imports generated Gleam output from`build/dev/javascript`. Vendoring the source slice now keeps the runtimecontract in-repo, but the next wave must either vendor built artifacts or addan explicit Gleam build step before replacing AaronClaw's handwrittenrepository with imported AaronDB Edge runtime pieces.

## Hands and skills runtime

- Bundled hands stay Cloudflare-native. The Worker `scheduled` handler dispatchescron events into `runScheduledHands`, and the current`scheduled-maintenance` hand reuses the existing reflection/maintenance pathinstead of introducing a second runtime.
- Hand lifecycle is operator-controlled through `/api/hands/:id/activate` and`/api/hands/:id/pause`, with run summaries and structured audit history storedin AaronDB under a synthetic hand session.
- Bundled skills are manifest-driven and local-only. Each manifest declares itstool set, memory scope, prompt instructions, and required secrets.
- The session runtime applies that manifest on every chat turn: declared toolsgate session recall, knowledge-vault access, and model-selection behavior, andblocked paths are recorded in audit history instead of silently expandingcapability.

## Dogfood deployment path

- The checked-in `wrangler.jsonc` is local-first: it keeps a stable`preview_database_id` (`aaronclaw-local`) for `wrangler dev` and local D1migrations.
- The remote `database_id` is intentionally injected at deploy time from`AARONCLAW_D1_DATABASE_ID` into `.wrangler/deploy/wrangler.jsonc`.
- This avoids committing a real Cloudflare resource UUID while still making theproduction deployment path explicit and repeatable.

## Minimal auth stance

- Personal dogfood mode uses a single bearer token (`APP_AUTH_TOKEN`).
- The landing page remains public so the browser can load and prompt for thattoken.
- All `/api/*` routes are protected when the token is configured.
- This is acceptable for a single-user Worker deployment, but it is not asubstitute for Cloudflare Access or a real multi-user auth system.

## Assistant fallback stance

- Gemini is the intended default operator-facing assistant path once key validation succeeds.
- Workers AI remains the explicit safe fallback path when Gemini is unavailable or not yet validated.
- Deterministic fallback remains enabled so first-run create/send/reload flowscontinue to work even if AI is not bound or the model call degrades.
- Fallback is therefore an operational continuity path, not the target qualitymode for real assistant dogfooding.

## Companion docs

- `docs/setup.md` — local setup and first-run flow
- `docs/deployment.md` — Cloudflare deployment, auth posture, and troubleshooting
- `docs/runtime.md` — public routes, browser control surface, and API behavior
- `docs/state-model.md` — AaronDB-style fact model, replay, and recall details