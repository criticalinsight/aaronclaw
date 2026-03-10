# Local setup

This is the fastest path to a working local AaronClaw instance.

## What you need

- A current Node.js install that can run the checked-in npm + Wrangler toolchain.
- `npm` (the repo ships with `package-lock.json` and npm scripts).
- A Cloudflare login only if you plan to deploy or use remote D1 resources.

The repo does not pin a Node version with an `.nvmrc` or `engines` field, so usea recent Node release that works with Wrangler 4.

## One-time install

```sh
npm install
```

## Prepare the local D1 database

The checked-in `wrangler.jsonc` is intentionally local-first:

- `preview_database_id` is `aaronclaw-local`
- `database_id` stays as the all-zero placeholder in Git

Apply the local migration once before first use:

```sh
wrangler d1 migrations apply aaronclaw-aarondb --local
```

Optionally confirm the checked-in config still matches that setup:

```sh
npm run validate:config
```

## Start the Worker

```sh
npm run dev
```

Open the local Worker URL that Wrangler prints.

## First browser flow

The landing page is the main control surface.

1. Open `/`.
2. If a deployment token field is visible, paste `APP_AUTH_TOKEN` there.
3. Click **Refresh operator data** to inspect the bundled hands, skills, and
   improvement candidates.
4. Click **Create session**.
5. Send a prompt.
6. Click **Reload state** or refresh the page and reload the same session.
7. Visit `/health` to confirm the runtime mode.

The UI keeps the active session ID in the `?session=` query param, so once a
session exists you can reload or revisit the page and load that session again.

The operator section can inspect hands, skills, and improvement candidates
today. It can activate/pause hands and approve/reject/pause reviewable
improvement candidates. It does **not** currently choose a skill for chat from
the browser UI; skill selection is per-turn API input through `skillId` on the
chat route.

## What to expect locally

- The bundled hands currently shipped are `scheduled-maintenance`,
  `improvement-hand`, `user-correction-miner`, `regression-watch`,
  `provider-health-watchdog`, and `docs-drift`; each is visible in operator
  controls and starts paused until an operator activates it.
- The bundled skills currently shipped are `aarondb-research`,
  `gemini-review`, and `incident-triage`.
- `aarondb-research` is ready by default and can use session recall plus the
  knowledge-vault path.
- `gemini-review` stays unready until Gemini key material is configured; chat
  requests that opt into that skill return `409` until then.
- The shipped self-improvement foundation stays review-first:
  `improvement-hand`, `user-correction-miner`, and `regression-watch` write
  structured proposals/findings for operator review; bounded shadow evaluation
  runs in metadata-only mode, and live production mutation remains manual-only.
- `docs-drift` records bounded reviewable findings when the shipped runtime
  posture meaningfully diverges from this docs set; it never edits repo docs
  automatically.
- The protected `/api/key` operator flow validates Gemini keys on set or when
  re-checking them, but skill readiness itself is based on whether the required
  secret is present.
- If Gemini key validation has succeeded, chat defaults to Gemini first.
- If Gemini is unavailable, AaronClaw falls back to Workers AI when that binding
  is available.
- If neither runtime path is usable, AaronClaw returns a deterministic fallback
  reply and still persists the turn. That is expected behavior for first-run
  smoke testing.

## Useful confidence checks

```sh
npm run typecheck
npm test
```

If you are moving from local work to a real Cloudflare deployment, continue with`docs/deployment.md`.