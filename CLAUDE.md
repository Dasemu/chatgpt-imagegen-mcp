# CLAUDE.md

## Overview

MCP server (TypeScript, ESM, Express 5, `@modelcontextprotocol/sdk`) that generates images by driving chatgpt.com with Playwright. Mirrors the MCP contract of media-mcp (submit + poll, signed public URLs).

## Commands

- `npm run dev`: run with tsx
- `npm run build` / `npm start`: compile to `dist/` and run
- `npm run typecheck`
- `npm test`: unit tests plus fixture-based browser tests. The browser tests skip if Playwright Chromium is missing. When the default cache is read-only, set `PLAYWRIGHT_BROWSERS_PATH`.
- `npm run login` (`-- --check`): manual chatgpt.com login with the persistent profile. The server must be stopped first.
- `npm run selfheal` (`SELFHEAL_DRY_RUN=true`): codex repair of the scraper in a throwaway clone; live smoke test, auto-merge and deploy (docs/selfheal.md)
- `npm run smoke`: generate one real image on chatgpt.com with the current code (uses quota; service stopped)

## Architecture

See [docs/architecture.md](docs/architecture.md) for the generation flow and lineage. Layout:

- `src/index.ts`: HTTP app, auth, media routes, update routes
- `src/tools.ts`: MCP tools
- `src/jobs.ts`: serial queue, pacing, circuit breaker
- `src/chatgpt/`: `selectors.ts` (the only DOM knowledge), `client.ts` (page operations), `provider.ts` (one image per new chat), `browser.ts` (persistent context), `prompts.ts`
- `src/media.ts`, `src/public-media.ts`: disk storage, manifests, HMAC URLs
- `src/update.ts`, `scripts/update.sh`: authenticated self-update
- `src/selfheal.ts`, `scripts/selfheal.sh`, `scripts/selfheal/` (prompt, Playwright + playwright-stealth inspector): codex self-heal
- `test/fixtures/`: reduced chatgpt.com DOM used by `test/client.test.ts`

## Conventions

- When chatgpt.com changes, edit only `src/chatgpt/selectors.ts`, putting new selectors first, and update the fixtures.
- Never log prompts, reference images, tokens or profile contents.
- Never commit `profiles/`, `diagnostics/`, `media/` or `.env`.
- Read `LESSONS.md` before changing the browser automation.

## Workflow quirks

- No linter or formatter is configured; `npm run typecheck` is the only static check. The `.claude/settings.json` hooks run it on edited `.ts` files and, together with `npm test`, on Stop.
- Edit `.env.example` whenever the code gains or loses an environment variable.

## Deployment

Standalone on Debian/Ubuntu under systemd (no Docker), with an authenticated self-update endpoint. See [docs/deployment.md](docs/deployment.md) and [docs/update.md](docs/update.md). Unit and nginx files live in `deploy/`.

## Gotchas

- `scripts/update.sh` restarts the service via `sudo -n systemctl restart`; the systemd unit deliberately omits `NoNewPrivileges=true` to keep that working (see `deploy/sudoers.chatgpt-imagegen-mcp`).
- `npm run selfheal` needs a `codex` binary and pushes/merges/deploys on success when `SELFHEAL_AUTO_MERGE`/`SELFHEAL_AUTO_UPDATE` are enabled — never run it casually against `main`.
