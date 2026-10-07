# CLAUDE.md

MCP server (TypeScript, ESM, Express 5, `@modelcontextprotocol/sdk`) that generates images by driving chatgpt.com with Playwright. Mirrors the MCP contract of ZenvairoMediaGenerator-MCP (submit + poll, signed public URLs).

## Commands

- `npm run dev`: run with tsx
- `npm run build` / `npm start`: compile to `dist/` and run
- `npm run typecheck`
- `npm test`: unit tests plus fixture-based browser tests. The browser tests skip if Playwright Chromium is missing. When the default cache is read-only, set `PLAYWRIGHT_BROWSERS_PATH`.
- `npm run login` (`-- --check`): manual chatgpt.com login with the persistent profile. The server must be stopped first.

## Layout

- `src/index.ts`: HTTP app, auth, media routes, update routes
- `src/tools.ts`: MCP tools
- `src/jobs.ts`: serial queue, pacing, circuit breaker
- `src/chatgpt/`: `selectors.ts` (the only DOM knowledge), `client.ts` (page operations), `provider.ts` (one image per new chat), `browser.ts` (persistent context), `prompts.ts`
- `src/media.ts`, `src/public-media.ts`: disk storage, manifests, HMAC URLs
- `src/update.ts`, `scripts/update.sh`: authenticated self-update
- `test/fixtures/`: reduced chatgpt.com DOM used by `test/client.test.ts`

## Conventions

- When chatgpt.com changes, edit only `src/chatgpt/selectors.ts`, putting new selectors first, and update the fixtures.
- Never log prompts, reference images, tokens or profile contents.
- Never commit `profiles/`, `diagnostics/`, `media/` or `.env`.
- Read `LESSONS.md` before changing the browser automation.
