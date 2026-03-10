# Cloudflare deployment, auth, and operations

This doc covers the real Cloudflare deploy path for AaronClaw, plus the current
security posture and the smallest useful troubleshooting guide.

## Deployment model

AaronClaw deploys as one Worker with:

- a Durable Object binding named `SESSION_RUNTIME`
- a D1 binding named `AARONDB`
- an optional Workers AI binding named `AI`

The checked-in `wrangler.jsonc` stays local-first. Real deploys inject the remote
D1 UUID into `.wrangler/deploy/wrangler.jsonc` through `npm run deploy:prep`.

## Deploy sequence

### 1. Validate the checked-in config

```sh
npm run validate:config
```

This confirms the repo still has the expected Worker name, D1 binding, Durable
Object binding, local preview database ID, and placeholder remote database ID.

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

Workers AI is optional for first-run usability, but recommended for real
assistant behavior. The checked-in config already expects the binding name `AI`
and defaults the model to `@cf/meta/llama-3.1-8b-instruct`.

## Telegram deployment notes

Telegram support uses Worker secrets, not checked-in config, for both the bot
token and the webhook secret header.

Important sequencing for this repo:

- do **not** request or set the Telegram bot token during implementation-only
  work
- request the rotated Telegram bot token from the user only when live Telegram
  deployment starts
- add the bot token and webhook secret through Cloudflare secrets at that time

When that later deployment step begins, use:

```sh
wrangler secret put TELEGRAM_BOT_TOKEN
wrangler secret put TELEGRAM_WEBHOOK_SECRET
```

The Worker expects Telegram webhooks at `POST /telegram/webhook` and validates
`X-Telegram-Bot-Api-Secret-Token` when `TELEGRAM_WEBHOOK_SECRET` is present.

This task does **not** include calling Telegram's live `setWebhook` API or
running the final live webhook smoke test; keep that in the separate Telegram
deployment-verification follow-up.

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
working, and `/health` reports:

- `authMode: none`
- `assistantRuntime: workers-ai`
- `defaultModel: @cf/meta/llama-3.1-8b-instruct`

That is accurate for the current dogfood deployment, but it also means the API
is public today. For anything you do not want exposed, set `APP_AUTH_TOKEN` or
front the Worker with Cloudflare Access.

## Auth and security posture

AaronClaw intentionally uses a minimal single-user auth model:

- `GET /` stays public so the UI can load.
- `GET /health` also stays public for status checks.
- Only `/api/*` routes are protected when `APP_AUTH_TOKEN` is configured.
- The browser UI stores the token in local browser storage for convenience.
- Telegram ingress is separate from `/api/*` bearer auth; use
  `TELEGRAM_WEBHOOK_SECRET` so Telegram can authenticate without `APP_AUTH_TOKEN`.

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
- `GET /health` → `200` JSON with auth/runtime metadata

Then run one end-to-end session check:

1. `POST /api/sessions`
2. `POST /api/sessions/:id/chat`
3. `GET /api/sessions/:id`
4. `GET /api/sessions/:id/recall?q=...`

That exact flow is what the current live deployment was verified against.

## Troubleshooting

| Symptom | Likely cause | What to check |
| --- | --- | --- |
| `npm run validate:config` fails | `wrangler.jsonc` drifted from the expected binding names or local-first D1 shape | Restore `SESSION_RUNTIME`, `AARONDB`, `preview_database_id: aaronclaw-local`, and the placeholder `database_id` in the checked-in config |
| `npm run deploy:prep` fails immediately | `AARONCLAW_D1_DATABASE_ID` is missing or malformed | Export a real D1 UUID before running the command |
| `/api/*` returns `401` | `APP_AUTH_TOKEN` is configured | Send `Authorization: Bearer <APP_AUTH_TOKEN>` or paste the token into the landing page |
| `/telegram/webhook` returns `503` | `TELEGRAM_BOT_TOKEN` is not configured in Worker secrets | Add the bot token later during the Telegram deployment task with `wrangler secret put TELEGRAM_BOT_TOKEN` |
| `/telegram/webhook` returns `401` | `TELEGRAM_WEBHOOK_SECRET` is configured but Telegram is not sending the expected header | Re-check the webhook setup step and the `X-Telegram-Bot-Api-Secret-Token` value used during Telegram webhook registration |
| Chat replies come back as fallback | Workers AI is not bound, or the model call failed | Check `/health` for `assistantRuntime` and fallback policy; verify the `AI` binding and `AI_MODEL` |
| `GET /api/sessions/:id` returns `404 session not initialized` | The session ID was never created in D1 | Create a session first, or confirm you are using the correct environment and D1 database |
| Reloaded sessions appear empty after deploy | Remote migrations were not applied or the Worker is pointed at the wrong D1 database | Re-run remote migrations and confirm the deploy config injected the intended D1 UUID |

For endpoint semantics and request behavior, see [`docs/runtime.md`](runtime.md).