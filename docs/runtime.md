# Runtime and API behavior

This doc describes what the Worker exposes today and how the browser control
surface maps to the API.

## Public routes

| Method | Path | Behavior |
| --- | --- | --- |
| `GET` / `HEAD` | `/` | Serves the browser UI. `HEAD` is safe for probes. |
| `GET` / `HEAD` | `/health` | Returns runtime/auth/assistant status. `HEAD` is safe for probes. |
| `POST` | `/telegram/webhook` | Optional Telegram ingress. Validates the Telegram secret header when configured, maps the Telegram sender/chat to a deterministic session ID, runs the existing chat path, and replies through Telegram Bot API. |

`/health` is the quickest way to confirm whether a deployment is open or token-
protected and whether Workers AI is primary or fallback-only.

The JSON payload reports the runtime contract for the current deployment,
including:

- service and control-surface identity
- Durable Object and memory-source labels
- auth mode and auth boundary
- assistant runtime, fallback policy, and default model
- the public session route list

## Browser control surface

The landing page includes:

- a deployment token field (visible only when auth is enabled)
- a session ID field
- **Create session**, **Load session**, and **Reload state** actions
- a message composer
- a status panel that shows the current auth/runtime mode

Important browser behavior:

- The UI stores `APP_AUTH_TOKEN` in browser local storage.
- The active session ID is written to `?session=<id>` in the page URL.
- Reloading the page does not create a new session automatically; it reloads the
  session you already selected.

## Session API

| Method | Path | Notes |
| --- | --- | --- |
| `POST` | `/api/sessions` | Creates a new session and returns `{ sessionId, session }`. |
| `GET` | `/api/sessions/:id` | Returns `{ session }` for the current projection. Supports optional `?asOf=<tx>`. |
| `POST` | `/api/sessions/:id/chat` | Appends a user message, generates an assistant reply, persists both turns, returns `{ assistant, session }`. |
| `POST` | `/api/sessions/:id/messages` | Lower-level append endpoint for one message event. |
| `POST` | `/api/sessions/:id/tool-events` | Lower-level append endpoint for one tool-event record. |
| `GET` | `/api/sessions/:id/recall?q=...` | Returns recall matches. Supports optional `limit` and `asOf`. |

## Request bodies and common errors

- `POST /api/sessions/:id/chat`
  - body: `{ "content": string, "metadata"?: object }`
  - `400` if `content` is missing or empty
- `POST /api/sessions/:id/messages`
  - body: `{ "role": "user" | "assistant", "content": string, "metadata"?: object }`
  - `400` if `role` or `content` is missing
- `POST /api/sessions/:id/tool-events`
  - body: `{ "toolName": string, "summary": string, "metadata"?: object }`
  - `400` if `toolName` or `summary` is missing

## Telegram webhook behavior

- `POST /telegram/webhook`
  - expects a Telegram update JSON payload
  - returns `503` if `TELEGRAM_BOT_TOKEN` is not configured in Worker secrets
  - returns `401` if `TELEGRAM_WEBHOOK_SECRET` is configured and the request is
    missing `X-Telegram-Bot-Api-Secret-Token`
  - returns `200 { ok: true, ignored: ... }` for unsupported or non-text updates

Telegram turns reuse the same AaronDB-backed session runtime rather than a
parallel channel-specific state model:

- session ID shape: `telegram:chat:<chat-id>:user:<user-id>`
- inbound Telegram metadata is stored on the appended user message
- assistant generation still flows through `POST /api/sessions/:id/chat`
- the final assistant text is sent back with Telegram `sendMessage`

For append endpoints, `404 session not initialized` means the session ID exists in
the URL but has not been created in D1 for that environment yet.

## Auth boundary

- If `APP_AUTH_TOKEN` is unset, the deployment is effectively open.
- If `APP_AUTH_TOKEN` is set, every `/api/*` route requires:

  ```http
  Authorization: Bearer <APP_AUTH_TOKEN>
  ```

- `GET /` and `GET /health` stay public even when auth is enabled.
- `/telegram/webhook` also stays outside `/api/*` bearer auth because Telegram
  cannot send `APP_AUTH_TOKEN`; protect it with `TELEGRAM_WEBHOOK_SECRET`
  instead when you enable Telegram.

This split is deliberate so the UI can load before you supply a token.

## Assistant runtime behavior

AaronClaw returns assistant metadata alongside chat results.

- `assistant.source = "workers-ai"` when the AI binding succeeds.
- `assistant.source = "fallback"` when the app uses deterministic fallback.
- `assistant.fallbackReason = "no-ai-binding"` when no AI binding exists.
- `assistant.fallbackReason = "ai-unavailable"` when the AI binding exists but
  the model call fails or returns no usable text.

Fallback is not an error path for persistence. AaronClaw still appends and
stores both the user turn and the fallback assistant turn.

## Session snapshot shape

Projected sessions include:

- `id`, `createdAt`, `lastActiveAt`, `lastTx`
- `events` ordered by transaction
- filtered `messages` and `toolEvents` lists
- `recallableMemoryCount`
- `persistence: "aarondb-edge"`
- `memorySource: "aarondb-edge"`

Those values are reconstructed from the D1 fact log, not from Durable Object-
local state.

## Recall behavior

Recall queries search the persisted per-event `memoryTerm` facts and return:

- the matching `eventId`
- `kind`
- `tx`
- `matchedTerms`
- a simple relevance `score`
- a human-readable `preview`

See [`docs/state-model.md`](state-model.md) for how those memory terms are built.