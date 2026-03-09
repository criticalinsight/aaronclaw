# aaronclaw

Cloudflare-native OpenClaw-style assistant that uses a standard Worker + Durable
Object architecture with AaronDB-style D1 facts as the source of truth for
session memory.

## Baseline and reuse boundary

- **Baseline**: `cloudflare/moltworker`
- **Keep**: Cloudflare-native gateway/control-surface patterns where they fit a
  browser-first Worker app.
- **Do not keep**: Cloudflare Sandbox container runtime assumptions,
  container lifecycle management, or local database/runtime coupling as the core
  architecture.
- **State source of truth**: `criticalinsight/aarondb-edge`

See `docs/architecture.md` for the architecture decision and handoff boundary.

## MVP control surface

- `GET /` serves a browser-first chat UI for personal deployments.
- `POST /api/sessions` creates a new session.
- `GET /api/sessions/:id` reloads a persisted session projection.
- `POST /api/sessions/:id/chat` stores a user prompt, generates an assistant
  reply through Workers AI when available, and persists both messages.
- `POST /api/sessions/:id/messages` and `POST /api/sessions/:id/tool-events`
  remain available as lower-level runtime endpoints.
- `GET /api/sessions/:id/recall?q=...` exposes AaronDB-style recall over the
  immutable fact log.

Core files:

- `src/index.ts` wires Worker routes, auth checks, and Durable Object dispatch.
- `src/routes.ts` renders the browser control surface and route metadata.
- `src/session-runtime.ts` runs the session Durable Object and persists chat
  turns through the AaronDB-style repository.
- `src/session-state.ts` implements immutable fact storage, replay, and recall.
- `src/assistant.ts` provides the Workers AI call path plus a deterministic
  fallback reply for local/personal smoke testing.
- `migrations/0001_aarondb_edge.sql` defines the D1 fact-log schema.

## Personal deployment auth model

This app keeps the auth story intentionally minimal for single-user dogfooding:

- If `APP_AUTH_TOKEN` is **unset**, the browser UI and API are open.
- If `APP_AUTH_TOKEN` is **set** as a Wrangler secret, all `/api/*` routes
  require `Authorization: Bearer <APP_AUTH_TOKEN>`.
- `GET /` stays public so the browser can load the UI and let you paste the
  token.
- The browser UI stores the token in local browser
  storage for convenience.

For a personal deployment this is good enough to dogfood the app, but it is not
multi-user auth. If you want stronger protection, front the Worker with
Cloudflare Access or replace this bearer-token gate entirely.

## Configuration and deployment

### 1. Validate the checked-in Wrangler config

Run:

- `npm run validate:config`

What this means:

- The repo config is intentionally local-first.
- `preview_database_id` is set to `aaronclaw-local` so `wrangler dev` and
  `wrangler d1 ... --local` have a stable local D1 identity.
- The checked-in `database_id` stays as the all-zero placeholder on purpose and
  is replaced only for real deploys.

### 2. Create the real D1 database

Run:

- `wrangler d1 create aaronclaw-aarondb`

Copy the returned database UUID and export it for deployment:

- `export AARONCLAW_D1_DATABASE_ID=<uuid-from-wrangler-d1-create>`

If you create the database with a different name, also export:

- `export AARONCLAW_D1_DATABASE_NAME=<your-d1-name>`

### 3. Apply migrations

Local development database:

- `wrangler d1 migrations apply aaronclaw-aarondb --local`

Remote dogfood database:

- `wrangler d1 migrations apply aaronclaw-aarondb --remote`

Cloudflare D1 docs currently recommend using the database name for migrations so
you do not accidentally target the wrong binding.

### 4. Configure secrets and optional AI

- `wrangler secret put APP_AUTH_TOKEN` to protect `/api/*` with a bearer token.
- Optional: bind Workers AI as `AI` for model-backed assistant responses.
- Optional: set `AI_MODEL` in `wrangler.jsonc` or via environment-specific
  config to override the default model.

### 5. Generate a deploy-ready Wrangler config

Run:

- `npm run deploy:prep`

This writes `.wrangler/deploy/wrangler.jsonc` with the real remote D1 database
UUID injected from `AARONCLAW_D1_DATABASE_ID`.

### 6. Dry-run and deploy

Run:

- `npm run deploy:dry-run`
- `npm run deploy`

## Production and fallback assistant behavior

- When the `AI` binding is present and healthy, chat uses Workers AI.
- When the `AI` binding is missing, the app returns a deterministic fallback
  assistant reply and still persists the user + assistant turn so the dogfood
  loop works.
- When the `AI` binding exists but the model call fails, the app also falls back
  deterministically and labels the response as degraded fallback behavior rather
  than claiming AI is “not configured”.

This means the app always preserves session state and first-run usability, but a
real production dogfood deployment should bind Workers AI if you want actual
assistant quality instead of a persistence/smoke-test mode.

The `/health` endpoint reports:

- whether auth is enabled,
- whether Workers AI is primary or fallback-only,
- how fallback behaves for this deployment.

## Manual usage

1. Run `wrangler d1 migrations apply aaronclaw-aarondb --local` once for the
   local preview database.
2. Run `npm run dev`.
3. Open the Worker root URL in a browser.
4. If `APP_AUTH_TOKEN` is configured, paste it into the deployment token field.
5. Create a new session.
6. Send a prompt and confirm you receive either a Workers AI response or a
   deterministic fallback response.
7. Reload the page or re-load the same session ID and confirm the history is
   replayed from persisted state.
8. Visit `/health` and confirm the reported auth mode and assistant runtime
   match how you configured the deployment.

## First remote dogfood checklist

1. `wrangler d1 create aaronclaw-aarondb`
2. Export `AARONCLAW_D1_DATABASE_ID`
3. `wrangler d1 migrations apply aaronclaw-aarondb --remote`
4. `wrangler secret put APP_AUTH_TOKEN`
5. Optionally bind Workers AI and confirm `AI_MODEL`
6. `npm run deploy:dry-run`
7. `npm run deploy`
8. Open the deployment URL, enter the token, create a session, send a message,
   reload the session, and inspect `/health`

## Planned commands

Run these to verify the MVP locally:

- `npm run typecheck`
- `npm test`
- `npm run validate:config`
- `wrangler d1 migrations apply aaronclaw-aarondb --local`
- `npm run dev`
