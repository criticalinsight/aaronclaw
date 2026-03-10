# Runtime and API behavior

This doc describes what the Worker exposes today and how the browser controlsurface maps to the API.

## Public routes

| Method | Path | Behavior |
| --- | --- | --- |
| GET / HEAD | / | Serves the browser UI. HEAD is safe for probes. |
| GET / HEAD | /health | Returns runtime/auth/assistant status. HEAD is safe for probes. |
| POST | /telegram/webhook | Optional Telegram ingress. Validates the Telegram secret header when configured, maps the Telegram sender/chat to a deterministic session ID, runs the existing chat path, and replies through Telegram Bot API. |

`/health` is the quickest way to confirm whether a deployment is open or token-protected and which assistant path is the default versus the current activefallback.

The JSON payload reports the runtime contract for the current deployment,including:

- service and control-surface identity
- Durable Object and memory-source labels
- auth mode and auth boundary
- assistant default path, active path, and fallback policy
- the public session route list

## Browser control surface

The landing page includes:

- a deployment token field (visible only when auth is enabled)
- a session ID field
- **Create session**, **Load session**, and **Reload state** actions
- a protected **Operator controls** section for bundled hands and skills
- a message composer
- a status panel that shows the current auth/runtime mode

Important browser behavior:

- The UI stores `APP_AUTH_TOKEN` in browser local storage.
- The active session ID is written to `?session=<id>` in the page URL.
- Reloading the page does not create a new session automatically; it reloads thesession you already selected.
- The operator section reuses the same token and lets an operator refresh handsand skills, activate/pause a hand, and inspect recent run/audit summaries.
- The landing page does **not** currently expose a skill picker for chat turns.Skill selection is API-driven through `POST /api/sessions/:id/chat` with`skillId`.

## Session API

| Method | Path | Notes |
| --- | --- | --- |
| POST | /api/sessions | Creates a new session and returns { sessionId, session }. |
| GET | /api/sessions/:id | Returns { session } for the current projection. Supports optional ?asOf=<tx>. |
| POST | /api/sessions/:id/chat | Appends a user message, optionally applies one bundled skill for that turn via skillId, generates an assistant reply, persists both turns, returns { assistant, session }. |
| POST | /api/sessions/:id/messages | Lower-level append endpoint for one message event. |
| POST | /api/sessions/:id/tool-events | Lower-level append endpoint for one tool-event record. |
| GET | /api/sessions/:id/recall?q=... | Returns recall matches. Supports optional limit and asOf. |

### Skill turn semantics

- `skillId` is optional and applies to one chat turn only; there is no persisted"active skill" on the browser landing page.
- Unknown skills return `404`.
- Skills that are not ready because required secrets are missing return `409`with the resolved manifest payload.
- When a skill is active, the runtime attaches skill metadata plus a`toolAuditTrail` to the assistant message metadata so the chosen capabilitiesremain inspectable after reload.
- Knowledge-vault access is gated by the skill manifest's declared tools andmemory scope. When enabled, the runtime prefers Vectorize-backed lookup andfalls back to D1-compatible ranking if needed.

## Operator settings routes

| Method | Path | Notes |
| --- | --- | --- |
| GET | /api/model | Lists runtime model availability, persisted selection, active model, and fallback state. |
| POST | /api/model | Persists a selectable operator model ID. |
| GET | /api/key | Lists provider-key status with masked-only output. Never returns raw secret material. |
| POST | /api/key | Protected Gemini-first key set/validate flow. action: "set" validates before storing; action: "validate" re-checks the current configured key. |
| GET | /api/hands | Lists bundled hands with lifecycle status, recent run summaries, and recent audit snippets. |
| GET | /api/hands/:id | Returns one hand with detailed recent status/audit information for operator inspection. |
| POST | /api/hands/:id/activate | Protected hand lifecycle action. Persists operator audit metadata. |
| POST | /api/hands/:id/pause | Protected hand lifecycle action. Persists operator audit metadata. |
| GET | /api/skills | Lists bundled manifest-driven skills with readiness, declared tool policies, and secret state. |
| GET | /api/skills/:id | Returns one bundled skill manifest with resolved readiness details. |

`/api/hands` and `/api/skills` back the landing page's operator section. The UIcan inspect both surfaces today, but only hands expose browser actions; skillsremain inspectable manifests that are selected from the chat API.

## Capability-gated tools and audit history

The hands/skills rollout ships a small explicit tool-policy catalog:

- **automatic-safe** — skill-declared runtime reads like `session-recall` and`knowledge-vault`, plus the core `model-selection` route resolution.
- **operator-protected** — operator-only controls like `hand-lifecycle`.
- **admin-sensitive** — protected provider-key management through `/api/key`.
- **scheduled-safe** — scheduled runtime work like `hand-run`,`session-reflection`, `scheduled-maintenance`, and `morning-briefing`.

Audit history stays close to where work happened:

- session chat turns persist `toolAuditTrail` in assistant message metadata
- bundled hand lifecycle/run events expose `recentAudit` and `recentRuns`
- audit records include capability, policy, actor, scope, outcome, and detail

`/api/key` has a stricter expectation than the rest of `/api/*`: it requires`APP_AUTH_TOKEN` to be configured so the route stays admin-only and the storedprovider key can be encrypted at rest.

Current key-management behavior:

- provider support starts with Gemini only
- raw key material is accepted only on `POST /api/key`
- validation calls Gemini with `X-Goog-Api-Key` header auth, not a query-stringkey
- stored provider keys are written into the existing D1 settings fact stream asAES-GCM ciphertext derived from `APP_AUTH_TOKEN`
- responses expose only masked key state (for example `••••••••1234`), a shortfingerprint, validation status, and timestamps

Because the current encrypted store derives from `APP_AUTH_TOKEN`, rotating theoperator bearer token requires re-entering the protected provider key.

## Request bodies and common errors

- `POST /api/sessions/:id/chat`
  - body: `{ "content": string, "skillId"?: string, "metadata"?: object }`
  - `400` if `content` is missing or empty
  - `404` if `skillId` does not match a bundled manifest
  - `409` if `skillId` is known but its required secrets are not ready
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
  - returns `401` if `TELEGRAM_WEBHOOK_SECRET` is configured and the request ismissing `X-Telegram-Bot-Api-Secret-Token`
  - returns `200 { ok: true, ignored: ... }` for unsupported or non-text updates

Telegram turns reuse the same AaronDB-backed session runtime rather than aparallel channel-specific state model:

- session ID shape: `telegram:chat:<chat-id>:user:<user-id>`
- inbound Telegram metadata is stored on the appended user message
- assistant generation still flows through `POST /api/sessions/:id/chat`
- the final assistant text is sent back with Telegram `sendMessage`

For append endpoints, `404 session not initialized` means the session ID exists inthe URL but has not been created in D1 for that environment yet.

## Auth boundary

- If `APP_AUTH_TOKEN` is unset, the deployment is effectively open.
- If `APP_AUTH_TOKEN` is set, every `/api/*` route requires:`Authorization: Bearer <APP_AUTH_TOKEN>`
- `GET /` and `GET /health` stay public even when auth is enabled.
- `/telegram/webhook` also stays outside `/api/*` bearer auth because Telegramcannot send `APP_AUTH_TOKEN`; protect it with `TELEGRAM_WEBHOOK_SECRET`instead when you enable Telegram.

This split is deliberate so the UI can load before you supply a token.

## Assistant runtime behavior

AaronClaw returns assistant metadata alongside chat results.

- `assistant.source = "workers-ai"` when the AI binding succeeds.
- `assistant.source = "gemini"` when the validated Gemini route succeeds.
- `assistant.source = "fallback"` when the app uses deterministic fallback.
- `assistant.fallbackReason = "no-ai-binding"` when no AI binding exists.
- `assistant.fallbackReason` reports the exact upstream failure class (forexample Workers AI error/empty-response or Gemini provider error/empty-response) when the selected route degrades.

Fallback is not an error path for persistence. AaronClaw still appends andstores both the user turn and the fallback assistant turn.

## Session snapshot shape

Projected sessions include:

- `id`, `createdAt`, `lastActiveAt`, `lastTx`
- `events` ordered by transaction
- filtered `messages` and `toolEvents` lists
- `recallableMemoryCount`
- `persistence: "aarondb-edge"`
- `memorySource: "aarondb-edge"`

Those values are reconstructed from the D1 fact log, not from Durable Object-local state.

## Recall behavior

Recall queries search the persisted per-event `memoryTerm` facts and return:

- the matching `eventId`
- `kind`
- `tx`
- `matchedTerms`
- a simple relevance `score`
- a human-readable `preview`

See `docs/state-model.md` for how those memory terms are built.