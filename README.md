# ChatGPT Image MCP (unofficial)

Remote, stateless Streamable HTTP MCP server that generates images with **ChatGPT in the cloud**. It drives the chatgpt.com web UI with Playwright and a persistent, logged-in Chromium profile. Images come from the account's own ChatGPT image quota; no OpenAI API key is involved.

It uses the same submit + poll contract as media-mcp: `generate_image` returns a `generationId` immediately and `query_tasks` returns the result, including an expiring signed `publicUrl`.

## Tools

| Tool | Purpose |
|---|---|
| `who_am_i` | Model, accepted arguments, delivery options, queue/session state |
| `generate_image` | Queue a generation (`model: "chatgpt-web"`, `arguments: [{name, value}]`) |
| `query_tasks` | Poll status; `COMPLETED` returns `outputs[]` with `publicUrl`, `downloadUrl`, optional `base64` |
| `check_session` | Verify that the browser profile is logged in |
| `get_usage` | Counters, queue length, circuit-breaker state |

Arguments for `generate_image`: `prompt` (required), `aspect_ratio` (`auto`, `1:1`, `16:9`, `9:16`, ...), `image_count` (1-4), and `reference_images`, an array of `{generation_id, index?}` or `{base64, mime_type}`.

```json
{
  "model": "chatgpt-web",
  "arguments": [
    { "name": "prompt", "value": "A cozy bakery storefront in Seville at dawn, photorealistic" },
    { "name": "aspect_ratio", "value": "4:5" }
  ]
}
```

## Quick start (development)

```bash
npm ci
npx playwright install chromium
cp .env.example .env        # set MCP_SERVER_TOKEN and PUBLIC_MEDIA_SIGNING_SECRET
npm run login               # log in to chatgpt.com once in the opened window
npm run dev                 # http://127.0.0.1:8088/mcp
npm test
```

## Docs

- [docs/chatgpt-session.md](docs/chatgpt-session.md): logging in, expired sessions, usage limits, UI changes
- [docs/architecture.md](docs/architecture.md): generation flow and lineage
- [docs/deployment.md](docs/deployment.md): install on Debian/Ubuntu with systemd
- [docs/update.md](docs/update.md): update script and authenticated update endpoint
- [docs/selfheal.md](docs/selfheal.md): automatic scraper repair with codex, verified live, then auto-merged and deployed

> This automates a consumer web UI. It is unofficial, can break whenever chatgpt.com changes, and must comply with OpenAI's terms for the account used.
