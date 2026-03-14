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
3. **D1** stores the immutable AaronDB fact log for session facts, messages,
   tool events, and recall terms.
4. **Rehydration** rebuilds session state from D1 so replay survives Durable
   Object restart/reload.
5. **Recall** uses persisted recall-term facts, so the current chat, skill, and
   hand flows can query memory without introducing a second substrate.

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
  - `VECTOR_INDEX` now maps through directly and backs the knowledge-vault /
    Hyper-Recall compatibility path when available.
  - `CONFIG_KV` and `ARCHIVE` are not mounted in the current shipped slice; the
    live runtime does not depend on them today.
- Build implication: upstream `src/index.mjs` imports generated Gleam output
  from `build/dev/javascript`. Vendoring the source slice keeps the shipped
  runtime contract in-repo; replacing more of AaronClaw's handwritten
  repository would require vendored built artifacts or an explicit Gleam build
  step.

## Autonomous Optimization & Self-Healing

The AaronClaw factory now operates with a redundant **Autonomous Optimization Loop**:

1.  **Economos (Economic Auditor)**: Monitors operational efficiency and compute/API costs.
2.  **Sophia (Knowledge Generator)**: Mines logs and patterns to propose structural improvements.
3.  **Architectura (Refactor Engine)**: Generates and applies de-complecting refactors to maintain architectural purity.
4.  **Aeturnus (The Eternal Swarm)**: Ensures the factory's persistence through distributed health monitoring and autonomous recovery pulse.

## Agentic Mind Upgrades

To support high-fidelity autonomous execution, AaronClaw implements several core cognitive upgrades:

- **Substrate Isolation**: Each Hand executes within a dedicated, isolated KV/D1 prefix (`mountSubstrateSandbox`), preventing identity leakage and cross-contamination between autonomous agents.
- **Dynamic Semantic Expansion**: Bypassing brittle exact-match expansions, the `knowledge-vault` now uses `@cf/baai/bge-small` to perform continuous vector similarity lookups against a `semantic_ontology`, allowing for semantic understanding of terms.
- **Synthetic Reflection Loop**: An autonomic chaos-engineering process that synthesizes "failure edge cases" from successful trajectories. These generated global patterns are fed back into the `semantic_ontology` to proactively harden the system via RL-style improvement.

## Hands and skills runtime

- Bundled hands have evolved into specialized **Autonomous Engines**: `Economos`, `Sophia`, `Architectura`, and `Aeturnus` join the existing `scheduled-maintenance`, `improvement-hand`, and others.
- Hand lifecycle is operator-controlled through `/api/hands/:id/activate` and
  `/api/hands/:id/pause`, while Engines expose specialized optimization routes for deep architectural work.
- Bundled skills are manifest-driven and local-only. Each manifest declares its
  tool set, memory scope, prompt instructions, and required secrets.
- The session runtime applies that manifest on every chat turn: declared tools
  gate session recall, knowledge-vault access, and model-selection behavior,
  and blocked paths are recorded in audit history instead of silently expanding
  capability.
- The shipped self-improvement foundation has transitioned from review-first to **Autonomous-Ready**: while structured proposals are still persisted for review, the factory is now capable of high-confidence autonomous promotion when Governance Gates are passed.

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