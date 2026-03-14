# aaronclaw

AaronClaw is a Cloudflare-native OpenClaw-style assistant with a browser-first
control surface, a standard Worker + Durable Object runtime, a Cloudflare-native
hands runtime, manifest-driven bundled skills, capability-gated tool/audit
history, and an AaronDB-style immutable D1 fact log as the source of truth for
session memory.

The current live deployment is:

- `https://aaronclaw.moneyacad.workers.dev` (Mission Control)
- `https://docs.moneyacad.workers.dev` (Documentation Suite)

**Roadmap Status: [PHASE 15: COMPLETE - AETERNUS REACHED]**

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

## Current shipped posture

In the current codebase and live deployment (`/health`):

- `GET /health` reports `authMode: bearer-token`; the landing page and `/health`
  stay public, while `/api/*` stays bearer-protected.
- `assistantRuntime` and `activeAssistantRuntime` are both Gemini with
  `defaultModel` / `activeModel` set to `gemini-3.1-pro-preview`.
- `skillRuntime: manifest-driven`, `skillInstallScope: bundled-local-only`,
  `toolPolicyRuntime: capability-gated`, and
  `toolAuditHistory: structured-session-and-hand-history` describe the current
  hands/skills rollout.
- **Autonomous Engines**: The factory is powered by a redundant optimization loop consisting of `Economos` (Economic Auditor), `Sophia` (Knowledge Generator), `Architectura` (Refactor Engine), and `Aeturnus` (The Eternal Swarm).
- These join the existing Hand bundle: `scheduled-maintenance`, `improvement-hand`, `user-correction-miner`, `regression-watch`, `provider-health-watchdog`, `docs-drift`, `ttl-garbage-collector`, `orphan-fact-cleanup`, and `daily-briefing-generator`.
- Those hands stay bounded: they persist run/audit history and operator-visible
  findings or proposals, but they do not mutate live production behavior
  automatically.
- Bundled skills are manifest-driven and currently ship as
  `aarondb-research` (session recall + knowledge vault), `gemini-review`
  (session-only review path), `incident-triage` (bounded diagnostics),
  `gap-analysis-pro` (coverage metrics), `datalog-query-expert` (schema evidence),
  and `security-posture-audit` (anomaly detection).
- The shipped self-improvement foundation has reached **COMPLETE (Phase 15: Aeturnus)**:
  the factory is now a fully autonomous, self-healing sovereign entity.
  `/api/improvements` remains the audit surface for these actions.
- Skill selection for chat is API-driven per turn via `skillId`; the landing
  page currently exposes hands/skills inspection, protected hand controls, and
  protected improvement-candidate review controls, not a skill picker.
- `HEAD /` and `HEAD /health` are kept probe-safe.
- Session create → chat → reload → recall remains the expected smoke path.

The production posture is still single-operator and token-gated, not a hardened
multi-user deployment.

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

Rich Hickey warning: this manual Wrangler path is the only deploy path verified
from the repo right now. Do **not** assume a push to `plan-cloudflare-openclaw`
updates `https://aaronclaw.moneyacad.workers.dev` until automatic publish is
proven with live evidence.

## Philosophical Positioning: AaronClaw vs. OpenClaw vs. Hermes 🧙🏾‍♂️

AaronClaw is a specialized **Cloudflare-native Software Factory**, while
OpenClaw and Hermes Agent represent different approaches to autonomous agency.
The differences are rooted in Rich Hickey's principles:

| Capability | **AaronClaw** (The Factory) | **OpenClaw** (The OS) | **Hermes Agent** (Procedural) |
| :--- | :--- | :--- | :--- |
| **Root** | **De-complecting**: Functional Edge. | **Integration**: Local/Host OS. | **Procedural**: Skill Learning. |
| **State** | **Value**: Immutable Fact Log. | **Place**: Mutable Memory. | **Place**: Markdown docs. |
| **Persistence** | **Sovereign Swarm**: Absolute. | **Standard**: Backup/Sync. | **Execution**: Session-bound. |
| **Focus** | **System Synthesis**. | **General Agency**. | **AI Growth and Training**. |

### Why AaronClaw?
Rich Hickey asks: *"Is the increased complexity worth the utility?"*

1. **Value-at-the-Edge**: By treating state as an **Immutable Fact Log**
   (AaronDB), AaronClaw de-complects "What happened" from "Where it is stored".
   OpenClaw and Hermes remain complected with the "Place" (Disk/Docker/Container)
   where their memory lives.
2. **Sovereign Persistence**: AaronClaw doesn't just "run" on a server; it exists
   as a globally distributed swarm (Phase 15: Aeturnus). It is de-complected
   from hardware failure.
3. **Synthesis vs. Execution**: While Hermes excels at learning new procedures
   and OpenClaw at managing local tools, AaronClaw focuses on
   **Structural Synthesis**—autonomously optimizing the factory logic itself.

For the definitive technical mapping and the deeper contrast between
Structural and Procedural intelligence, see the:
- [Rich Hickey Gap Analysis (Overview)](file:///Users/brixelectronics/.gemini/antigravity/brain/bf7d562f-53cd-44e8-a943-fd13d79da49a/gap_analysis_sovereignty.md)
- [Deep Dive: AaronClaw vs. Hermes Agent](file:///Users/brixelectronics/.gemini/antigravity/brain/bf7d562f-53cd-44e8-a943-fd13d79da49a/deep_gap_aaronclaw_vs_hermes.md)

---

## Runtime summary

- `GET /` serves the browser UI.
- `GET /health` reports runtime, auth, and assistant status.
- `GET /api/model` and `POST /api/model` inspect or persist the operator model
  route.
- `GET /api/key` and `POST /api/key` inspect or manage protected Gemini key
  state.
- `GET /api/improvements`, `GET /api/improvements/:proposalKey`, and
  `POST /api/improvements/:proposalKey/{approve|reject|pause}` expose the
  protected self-improvement review surface with evidence and lifecycle status.
- `GET /api/skills` and `GET /api/skills/:id` expose manifest-driven bundled
  skills with readiness and declared tool policies.
- `GET /api/hands`, `GET /api/hands/:id`, `POST /api/hands/:id/activate`, and
  `POST /api/hands/:id/pause` expose the Cloudflare-native hands runtime.
- `GET /api/economos/*`, `GET /api/sophia/*`, `GET /api/architectura/*`, and
  `GET /api/aeturnus/*` expose the autonomous optimization loop engines.
- `POST /api/sessions` creates a session.
- `GET /api/sessions/:id` reloads a projected session snapshot.
- `POST /api/sessions/:id/chat` appends a user message, generates an assistant
  reply, and persists both turns. Chat can optionally opt into one bundled
  skill for that turn with `skillId`.
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
- Current seam mapping is `AARONDB_STATE -> SESSION_RUNTIME`, `DB -> AARONDB`,
  `AI -> AI`, and `VECTOR_INDEX -> VECTOR_INDEX`; `CONFIG_KV` and `ARCHIVE`
  are not mounted in the current shipped slice because the live runtime does
  not depend on them.
- Build implication: upstream `src/index.mjs` expects generated Gleam JS under
  `build/dev/javascript`. The current vendored slice is sufficient for the
  shipped runtime; deeper replacement of AaronClaw's handwritten repository
  would require vendored built artifacts or an explicit Gleam build step.

## Repository map

- `src/index.ts` — Worker entrypoint, auth checks, public routes, Durable Object
  dispatch.
- `src/aarondb-edge-substrate.ts` — vendored AaronDB Edge import seam, binding
  map, and reusable upstream FFI helpers.
- `src/routes.ts` — landing page HTML/JS and runtime status metadata.
- `src/session-runtime.ts` — session Durable Object runtime and API handlers.
- `src/session-state.ts` — immutable fact append, projection replay, and recall.
- `src/hands-runtime.ts` — bundled Cloudflare-native hands lifecycle, cron
  execution, run summaries, and audit history.
- `src/skills-runtime.ts` — bundled manifest-driven skills, readiness
  resolution, and skill prompt/runtime metadata.
- `src/tool-policy.ts` — capability/policy catalog for skill-declared,
  operator-only, and scheduled tools.
- `src/knowledge-vault.ts` — cross-session knowledge-vault recall with
  Vectorize-first lookup and D1-compatible fallback ranking.
- `src/assistant.ts` — Workers AI call path plus deterministic fallback.
- `migrations/0001_aarondb_edge.sql` — D1 schema for the fact log.
- `vendor/aarondb-edge/` — vendored upstream AaronDB Edge runtime slice
  (Gleam source, JS entrypoint, wrangler manifest, migration).
- `scripts/validate-config.mjs` — local-first Wrangler config validation.
- `scripts/render-deploy-config.mjs` — injects the real D1 UUID for deploys.
