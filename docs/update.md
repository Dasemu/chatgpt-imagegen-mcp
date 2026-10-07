# Updating

## Script

`scripts/update.sh` updates the install it lives in. It is idempotent and logs timestamped lines to stdout.

1. Takes a lock (`flock` on `.update.lock`); fails if another update is running.
2. `git fetch` + `git pull --ff-only`.
3. `npm ci`, then `npx playwright install chromium` (system libraries need `npx playwright install-deps chromium` as root, see [deployment.md](deployment.md)).
4. Backs up `dist/`, runs `npm run build` and `npm test`. On failure the previous `dist/` is restored and the service is not restarted.
5. Prints `UPDATE_SUCCEEDED <iso timestamp>` and restarts the service with `sudo -n systemctl restart $SERVICE_NAME` (default `chatgpt-imagegen-mcp.service`).

On error the last line is `UPDATE_FAILED <iso timestamp> ...` and the exit code is non-zero. There are no database migrations: state is plain files on disk.

Run manually: `sudo -u mcp scripts/update.sh >> logs/update.log 2>&1`.

## Endpoint

Enabled only when `UPDATE_TOKEN` is set to a secret of at least 32 characters (otherwise both routes return `503 {"error":"update_not_configured"}`). Authenticate with `Authorization: Bearer $UPDATE_TOKEN`. These routes are not covered by the MCP bearer token.

```bash
curl -X POST -H "Authorization: Bearer $UPDATE_TOKEN" https://host/chatgptimagegen/admin/update
curl -H "Authorization: Bearer $UPDATE_TOKEN" https://host/chatgptimagegen/admin/update/status
```

| Request | Result |
| --- | --- |
| `POST /admin/update` | `202` update started, `409` already running |
| `GET /admin/update/status` | `{ state, startedAt, finishedAt, exitCode, logTail }` |
| missing/wrong token | `401` |
| token not configured | `503` |
| too many requests | `429` with `Retry-After` |

`state` is `idle`, `running`, `succeeded` or `failed`. `logTail` is the last 50 lines of the log.

The script restarts the service at the end, which kills the server process. After the restart the server reads the last log line: if it holds the `UPDATE_SUCCEEDED` (or `UPDATE_FAILED`) marker, status reports `succeeded` (or `failed`) with that timestamp (`startedAt` is null and `exitCode` is synthetic). Poll the status endpoint until it answers again.

## Rate limiting

In memory, per client IP (`req.ip`), reset on restart. Behind nginx set `TRUST_PROXY=1` (or the number of proxy hops) so the real client IP is used; otherwise every request appears to come from nginx.

- `UPDATE_RATE_LIMIT_MAX` (default 30) requests per window, any outcome.
- Failed authentication attempts are limited to 5 per window (or `UPDATE_RATE_LIMIT_MAX` if lower).
- `UPDATE_RATE_LIMIT_WINDOW_SECONDS` (default 900).

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `UPDATE_TOKEN` | unset (endpoint disabled) | Bearer secret, min 32 chars |
| `UPDATE_SCRIPT` | `<cwd>/scripts/update.sh` | Script run by the endpoint |
| `UPDATE_LOG_FILE` | `<cwd>/logs/update.log` | Appended stdout/stderr of the script |
| `UPDATE_RATE_LIMIT_MAX` | 30 | Requests per window per IP |
| `UPDATE_RATE_LIMIT_WINDOW_SECONDS` | 900 | Window length |
| `TRUST_PROXY` | unset | Express `trust proxy` value |
| `SERVICE_NAME` | `chatgpt-imagegen-mcp.service` | Service restarted by the script |
