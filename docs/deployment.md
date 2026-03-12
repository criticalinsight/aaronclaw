# Cloudflare deployment, auth, and operations

This doc covers the real Cloudflare deploy path for AaronClaw, plus the currentsecurity posture and the smallest useful troubleshooting guide.

## Deployment model

AaronClaw deploys as one Worker with:

- a Durable Object binding named `SESSION_RUNTIME`
- a D1 binding named `AARONDB`
- an optional Workers AI binding named `AI`
- a Vectorize binding named `VECTOR_INDEX` for the knowledge-vault path
- cron triggers for the bundled hands runtime (`*/30 * * * *` and `0 8 * * *`)

The checked-in `wrangler.jsonc` stays local-first. Real deploys inject the remoteD1 UUID into `.wrangler/deploy/wrangler.jsonc` through `npm run deploy:prep`.

The current checked-in config expects the knowledge-vault index name`aaronclaw-knowledge-vault`. If Vectorize is unavailable, the session runtimedegrades to D1-compatible vault ranking instead of breaking chat, but the liveproduction posture now assumes the binding is present.

## Automatic deploy verification status (2026-03-10)

Rich Hickey warning: do not invent deploy certainty that the repo and production
surface cannot prove.

What is verified today:

- the repo contains a working **manual** Wrangler deploy path
- the approved branch is still `plan-cloudflare-openclaw`
- the public production Worker is `https://aaronclaw.moneyacad.workers.dev`

What is **not** verified today:

- the committed branch state does not yet prove an active checked-in auto-deploy workflow for the chosen branch
- the GitHub `production` environment exists, but automatic deploys still need a least-privilege `CLOUDFLARE_API_TOKEN` added there before the workflow can run successfully
- this task has not yet observed a successful GitHub Actions deploy run for the chosen branch
- recent pushes to `plan-cloudflare-openclaw` did **not** prove automatic publish,
  because the public landing page and `/health` still expose the older operator
  surface without `/api/improvements` or the improvement-candidate panel that now
  exists in the repo

Operator conclusion: if automatic deploys are enabled later, the intended
direction is a repo-managed GitHub Actions path rather than a dashboard-only
Cloudflare Git integration. But the Wrangler path below remains the **only
verified deploy path** for this branch until a real push-triggered publish is
demonstrated with fresh GitHub/Cloudflare build evidence plus matching live
runtime behavior.

## GitHub production environment contract

Rich Hickey warning: keep production deploy credentials simple, explicit, and
least-privileged.

- GitHub environment: `production`
- Allowed deploy branch: `plan-cloudflare-openclaw`
- Required **environment secrets**:
  - `CLOUDFLARE_API_TOKEN`
  - `CLOUDFLARE_ACCOUNT_ID`
  - `AARONCLAW_D1_DATABASE_ID`
- Optional **environment variables**:
  - `AARONCLAW_D1_DATABASE_NAME` (defaults to `aaronclaw-aarondb`)
  - `AARONCLAW_DEPLOY_WITH_VECTORIZE` (set only after verifying the intended index binding for automated deploys)

Do **not** store a broad Cloudflare global API key in GitHub Actions for this
repo. The manual deploy verification used operator-supplied credentials only to
verify the target account and public Worker. The automation path should use a
scoped Cloudflare API token created outside the repo and then stored as the
`production` environment secret `CLOUDFLARE_API_TOKEN`.

## Operator guidance for future auto-deploy checks

If automatic deploys are wired later, do not trust a push alone. Verify all of
these:

1. A concrete automation record exists for the pushed commit:
   - a GitHub Actions run, or
   - a Cloudflare-side Git/Workers Builds log
2. The public Worker passes the live checks in this doc:
   - `HEAD /` returns `200`
   - `GET /health` returns `200`
3. The live landing page / bootstrap payload reflects the expected branch `HEAD`
   features, not an older route manifest

If any of those fail, assume automatic publish is not active and fall back to the
manual Wrangler deploy sequence.

## Disable and rollback notes

- **Disable safely:** keep automatic deploys off until verified. If a future
  GitHub Actions workflow is introduced, disable that workflow or remove its push
  trigger. If a future Cloudflare-side Git integration is introduced, disconnect
  the tracked branch/build in Cloudflare.
- **Rollback safely:** redeploy a known-good commit through the manual Wrangler
  path below. Do not rely on an unverified auto-publish system for rollback.
- **Branch behavior note:** pushes to `plan-cloudflare-openclaw` currently push to
  GitHub, but operators should not assume they update the public Worker without a
  separate deploy verification.

## Deploy sequence

### 1. Validate the checked-in config

```sh
npm run validate:config
```

This confirms the repo still has the expected Worker name, D1 binding, DurableObject binding, local preview database ID, and placeholder remote database ID.

### 2. Create the remote D1 database

```sh
wrangler d1 create aaronclaw-aarondb
```

Export the returned UUID for the deploy helper:

```sh
export AARONCLAW_D1_DATABASE_ID=<uuid-from-wrangler-d1-create>
```

If you intentionally use a different D1 database name, also export:

```sh
export AARONCLAW_D1_DATABASE_NAME=<your-d1-name>
```

### 3. Apply remote migrations

```sh
wrangler d1 migrations apply aaronclaw-aarondb --remote
```

If you changed the database name, use that name consistently here too.

### 4. Configure auth and optional AI

Protect the API with a bearer token:

```sh
wrangler secret put APP_AUTH_TOKEN
```

Workers AI is still useful for first-run usability and as the explicit safe
fallback path. The checked-in config expects the binding name `AI`, and its
configured `AI_MODEL` remains the Workers AI fallback model rather than the
operator-facing default.

## Provider-key management notes

External-provider `/api/key` management now uses the existing admin bearer token
boundary plus D1-backed encrypted storage.

Operational requirements:

- set `APP_AUTH_TOKEN` before using `/api/key`
- use `/api/key` for Gemini key set/update + validation in the protected app
  surface
- raw provider keys are never returned by the Worker; responses are masked-only
- Worker-secret fallback still works if `GEMINI_API_KEY` is injected directly at
  deploy time, but `/api/key` stores the operator-managed copy in D1 so later
  routing can read it without requiring a new config file shape

Current storage compromise:

- the encrypted D1 provider-key store derives its AES-GCM key from
  `APP_AUTH_TOKEN`
- if you rotate `APP_AUTH_TOKEN`, re-enter the provider key through `/api/key`
  afterward so the Worker can decrypt it again

You do **not** need a new Wrangler binding for the current shipped key-management
surface. The protected route reuses the existing D1 fact log and admin token
secret.

## Telegram deployment notes

Telegram support uses Worker secrets, not checked-in config, for both the bot
token and the webhook secret header.

Use Worker secrets for Telegram configuration changes:

```sh
wrangler secret put TELEGRAM_BOT_TOKEN
wrangler secret put TELEGRAM_WEBHOOK_SECRET
```

The Worker expects Telegram webhooks at `POST /telegram/webhook` and validates
`X-Telegram-Bot-Api-Secret-Token` when `TELEGRAM_WEBHOOK_SECRET` is present.

If you rotate either Telegram secret, update Telegram's webhook registration to
keep the upstream secret header aligned with the Worker.

### 5. Generate the deploy config

```sh
npm run deploy:prep
```

This writes `.wrangler/deploy/wrangler.jsonc` with the real remote D1 UUID.

### 6. Dry-run the deploy

```sh
npm run deploy:dry-run
```

This command uses the generated deploy config and is the safest way to catch bad
binding or config assumptions before a real deploy.

### 7. Deploy

```sh
npm run deploy
```

## Current live posture

The current public deployment at `https://aaronclaw.moneyacad.workers.dev` is
working. As of the current rollout, `GET /health` reports:

- `authMode: bearer-token`
- `assistantRuntime: gemini`
- `defaultModel: gemini-3.1-pro-preview`
- `activeAssistantRuntime: gemini`
- `activeModel: gemini-3.1-pro-preview`
- `skillRuntime: manifest-driven`
- `toolPolicyRuntime: capability-gated`
- `toolAuditHistory: structured-session-and-hand-history`
- `VECTOR_INDEX` mapped; `CONFIG_KV` and `ARCHIVE` not mounted

That means the landing page and `/health` remain public, while `/api/*`
(including `/api/model`, `/api/key`, `/api/skills`, `/api/hands`, and
`/api/improvements`) require the current bearer token. This is still a
single-operator deployment posture; for stronger identity and policy
enforcement, front it with Cloudflare Access.

## Auth and security posture

AaronClaw intentionally uses a minimal single-user auth model:

- `GET /` stays public so the UI can load.
- `GET /health` also stays public for status checks.
- Only `/api/*` routes are protected when `APP_AUTH_TOKEN` is configured.
- The browser UI stores the token in local browser storage for convenience.
- Telegram ingress is separate from `/api/*` bearer auth; use
  `TELEGRAM_WEBHOOK_SECRET` so Telegram can authenticate without
  `APP_AUTH_TOKEN`.

This is acceptable for personal dogfooding, but not a replacement for stronger
user identity, session management, or Cloudflare Access policies.

## Post-deploy operational checks

These checks match the current runtime behavior:

```sh
curl -I https://aaronclaw.moneyacad.workers.dev/
curl -sS https://aaronclaw.moneyacad.workers.dev/health
```

You should expect:

- `HEAD /` → `200` with `content-type: text/html; charset=UTF-8`
- `GET /health` → `200` JSON with bearer-auth, Gemini, hands/skills, and runtime-substrate metadata

If `APP_AUTH_TOKEN` is configured, also check the protected operator surfaces:

```sh
curl -sS -H "Authorization: Bearer <APP_AUTH_TOKEN>" https://aaronclaw.moneyacad.workers.dev/api/skills
curl -sS -H "Authorization: Bearer <APP_AUTH_TOKEN>" https://aaronclaw.moneyacad.workers.dev/api/hands
curl -sS -H "Authorization: Bearer <APP_AUTH_TOKEN>" https://aaronclaw.moneyacad.workers.dev/api/improvements
```

You should expect bundled skill readiness / declared tool policy data, hand
lifecycle plus recent audit history, and structured improvement candidates with
evidence and lifecycle metadata.

Then run one end-to-end session check:

1. `POST /api/sessions`
2. `POST /api/sessions/:id/chat`
3. `GET /api/sessions/:id`
4. `GET /api/sessions/:id/recall?q=...`

That exact flow is what the current live deployment was verified against.

## Troubleshooting

| Symptom | Likely cause | What to check |
| --- | --- | --- |
| npm run validate:config fails | wrangler.jsonc drifted from the expected binding names or local-first D1 shape | Restore SESSION_RUNTIME, AARONDB, preview_database_id: aaronclaw-local, and the placeholder database_id in the checked-in config |
| npm run deploy:prep fails immediately | AARONCLAW_D1_DATABASE_ID is missing or malformed | Export a real D1 UUID before running the command |
| /api/* returns 401 | APP_AUTH_TOKEN is configured | Send Authorization: Bearer <APP_AUTH_TOKEN> or paste the token into the landing page |
| /api/key returns 412 | APP_AUTH_TOKEN is not configured | Set APP_AUTH_TOKEN first; protected key storage derives encryption from that token |
| /telegram/webhook returns 503 | TELEGRAM_BOT_TOKEN is not configured in Worker secrets | Add TELEGRAM_BOT_TOKEN as a Worker secret with wrangler secret put TELEGRAM_BOT_TOKEN |
| /telegram/webhook returns 401 | TELEGRAM_WEBHOOK_SECRET is configured but Telegram is not sending the expected header | Re-check the webhook setup step and the X-Telegram-Bot-Api-Secret-Token value used during Telegram webhook registration |
| Chat replies come back as fallback | Gemini is unavailable and the fallback path also failed, or no runtime path is configured | Check /health for the default/active path plus fallback policy; verify /api/key, the Gemini validation state, and the AI binding / AI_MODEL fallback configuration |
| POST /api/sessions/:id/chat returns 409 for a skill | The bundled skill is known but not ready yet | Inspect /api/skills and satisfy the missing required secret (for example, configure Gemini key material for gemini-review); validation status remains a separate provider-health signal in /api/key |
| GET /api/sessions/:id returns 404 session not initialized | The session ID was never created in D1 | Create a session first, or confirm you are using the correct environment and D1 database |
| Reloaded sessions appear empty after deploy | Remote migrations were not applied or the Worker is pointed at the wrong D1 database | Re-run remote migrations and confirm the deploy config injected the intended D1 UUID |

For endpoint semantics and request behavior, see `docs/runtime.md`.