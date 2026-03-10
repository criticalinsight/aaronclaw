# Local setup

This is the fastest path to a working local AaronClaw instance.

## What you need

- A current Node.js install that can run the checked-in npm + Wrangler toolchain.
- `npm` (the repo ships with `package-lock.json` and npm scripts).
- A Cloudflare login only if you plan to deploy or use remote D1 resources.

The repo does not pin a Node version with an `.nvmrc` or `engines` field, so use
a recent Node release that works with Wrangler 4.

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
3. Click **Create session**.
4. Send a prompt.
5. Click **Reload state** or refresh the page and reload the same session.
6. Visit `/health` to confirm the runtime mode.

The UI keeps the active session ID in the `?session=` query param, so once a
session exists you can reload or revisit the page and load that session again.

## What to expect locally

- If Workers AI is available, chat replies come from the configured model.
- If Workers AI is not bound locally, or the model call fails, AaronClaw returns
  a deterministic fallback reply and still persists the turn. That is expected
  behavior for first-run smoke testing.
- The UI remains usable either way because persistence and replay do not depend
  on Workers AI.

## Useful confidence checks

```sh
npm run typecheck
npm test
```

If you are moving from local work to a real Cloudflare deployment, continue with
[`docs/deployment.md`](deployment.md).