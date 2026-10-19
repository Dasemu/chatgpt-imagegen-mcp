# Architecture

```
MCP client ──POST /mcp──▶ tools.ts ──▶ JobManager (serial queue, pacing, circuit breaker)
                                              │
                                              ▼
                                   ChatGptImageProvider ──▶ BrowserSession (persistent Chromium profile)
                                              │                         │
                                              ▼                         ▼
                                   media.ts (disk + manifests)     chatgpt.com
```

## Generation flow (one image)

1. Open `CHATGPT_URL` (a new empty chat). Fail with `SESSION_NOT_READY` if login markers are visible.
2. Record the image `src`s already on the page (baseline).
3. Upload reference images through the hidden file input and wait for the upload to finish.
4. Type the wrapped prompt (`src/chatgpt/prompts.ts`) into the composer and send it.
5. Wait for the turn: the stop button appears and then stays gone for two polls.
6. Wait for a new image outside the user message, at least 256 px per side, fully loaded, with a `src` that stays the same for 3 polls and no "creating image" text. ChatGPT shows blurred partial previews first, so the first image seen is not the final one.
7. Download it through the browser request context (it carries the session cookies), validate size and format, store it as `<generationId>-<index>.<ext>`.

Transient failures (`TURN_TIMED_OUT`, `UI_CHANGED`, `NO_IMAGE_RETURNED`, `BROWSER_ERROR`, generic ChatGPT errors) are retried up to `CHATGPT_RETRIES` times, each in a new chat with a growing pause (`CHATGPT_RETRY_DELAY_SECONDS × attempt`); a crashed browser is relaunched first. Usage limits, lost sessions and content-policy refusals fail immediately. The final error message says how many attempts were made.

Failures that survive the retries and look like frontend changes can trigger a codex self-heal run that opens a pull request ([selfheal.md](selfheal.md)).

`image_count > 1` repeats this in a new chat per image. Every job runs alone because the profile can only be used by one browser.

## Lineage

Ported from an earlier internal `imagegen` package (Python, branch `legacy/whatsapp-mockup`): selectors as ordered fallback lists, the persistent profile with a manual login, turn detection through the stop button, usage-limit detection by text, downloads through `page.request`, HTML diagnostics and random pacing. The MCP surface, media storage and signed URLs follow media-mcp so clients can switch backends.

Changes from Prospect:
- Limit and error texts are matched only against error banners and the assistant reply, never against the whole page. The user's prompt is on the page too.
- The final image is detected by `src` stability, and uploaded references are excluded.
- A circuit breaker rejects new jobs right away, instead of the queue sleeping for an hour.
