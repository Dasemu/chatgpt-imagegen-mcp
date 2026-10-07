# ChatGPT session

The server drives chatgpt.com with a persistent Chromium profile (`CHATGPT_PROFILE_DIR`). That profile must be logged in once by a human; the server never handles passwords.

Chromium locks the profile directory, so **stop the service before** running any of the commands below.

## Log in on a machine with a display

```bash
npm run login            # dev (tsx)
npm run login:prod       # after npm run build
```

A visible browser opens chatgpt.com. Log in by hand (2FA included). The window closes by itself once the session is detected (up to 10 minutes).

Check the profile without opening a window:

```bash
npm run login -- --check
```

## Log in for a headless server

Pick one:

1. **Log in locally, copy the profile.** Run `npm run login` on your desktop with the same Playwright version, then copy the directory to the server (`rsync -a profiles/chatgpt/ server:/opt/chatgpt-imagegen-mcp/profiles/chatgpt/`) and `chown -R mcp:mcp` it. Playwright's Chromium stores cookies with the `basic` password store, so the profile works on another machine.
2. **Log in on the server through X forwarding.** `ssh -X` to the server and run `sudo -u mcp --preserve-env=DISPLAY,XAUTHORITY npm run login:prod`.

Then start the service and confirm with the `check_session` MCP tool or `GET /health` (`session.loggedIn`).

## When the session expires

Jobs fail with `SESSION_NOT_READY` and the circuit breaker rejects new jobs for `CHATGPT_SESSION_RECHECK_MINUTES`. Stop the service, log in again, start it.

## Usage limits

The account's own image quota applies. When chatgpt.com shows a limit notice the job fails with `USAGE_LIMIT_REACHED` (`retryable: true`, `retryAfter`) and new jobs are rejected for `CHATGPT_USAGE_LIMIT_COOLDOWN_MINUTES`. Random pacing between generations (`CHATGPT_MIN/MAX_INTERVAL_SECONDS`) keeps the traffic human-like.

## When chatgpt.com changes its markup

All DOM knowledge lives in `src/chatgpt/selectors.ts`: ordered lists of alternative selectors. On a UI failure the server writes an HTML dump and a screenshot to `DIAGNOSTICS_DIR` (newest `MAX_DIAGNOSTICS` kept). Inspect them, add the new selector **at the front** of the matching list, and update the fixtures in `test/fixtures/`. Diagnostics may contain conversation text: never commit them.

## Notes

- This automates a consumer web UI. It is unofficial, may break without notice, and must comply with OpenAI's terms for the account used.
- Never put the profile directory in git or logs: it holds the session cookies.
