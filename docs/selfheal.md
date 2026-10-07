# Self-heal (codex)

chatgpt.com changes its frontend without notice. When the scraper breaks, the server can run **codex in yolo mode** to inspect the live site and patch the code. The fix arrives as a **pull request** that a human reviews and merges. Nothing is merged or deployed automatically.

## Trigger

1. Transient failures are first retried in the server (`CHATGPT_RETRIES`, see [architecture.md](architecture.md)).
2. Jobs that still fail with `UI_CHANGED` or `TURN_TIMED_OUT` count as consecutive scraper failures. A successful job resets the counter.
   - Usage limits, lost sessions, refusals and text-only replies do not count, because no code change fixes them.
3. At `SELFHEAL_FAILURE_THRESHOLD` failures (default 3), and if no run happened in the last `SELFHEAL_COOLDOWN_HOURS` (default 6), the queue takes the next turn to close the browser and copy the logged-in profile to a temporary directory. It then starts `scripts/selfheal.sh` in the background.

The run's state and the PR URL appear in `get_usage`, `who_am_i` and `/health` (`selfHeal`). The output goes to `SELFHEAL_LOG_FILE`.

## What the script does

1. Clones `SELFHEAL_REMOTE/SELFHEAL_BASE_BRANCH` into a throwaway directory and creates the branch `selfheal/chatgpt-scraper-<timestamp>`.
2. Copies the newest diagnostics (HTML and screenshots of the failures) next to it.
3. Ensures a Python venv (`SELFHEAL_VENV`) with `playwright` and `playwright-stealth`, then runs `npm ci` in the clone.
4. Runs `codex exec --dangerously-bypass-approvals-and-sandbox` with the prompt in `scripts/selfheal/prompt.md`. Codex gets:
   - the diagnostics;
   - the profile copy;
   - `scripts/selfheal/browse.py`, an inspector built on Playwright and playwright-stealth. It opens chatgpt.com with the profile copy, can send a test image prompt, and saves HTML, screenshots and a JSON summary of `data-testid`, `aria-label`, roles, inputs and images over time.
5. Discards the attempt if anything outside `src/chatgpt/*.ts`, `test/fixtures/*.html` or `test/client.test.ts` changed.
6. Runs `npm run typecheck` and `npm test` in the clone.
7. Commits, pushes the branch and opens the PR with `tea`. Codex's summary becomes the description.
8. Always deletes the clone and the profile copy.

Exit codes and the `SELFHEAL_RESULT` log line:

| Code | Meaning |
|---|---|
| 0 | PR created, or a dry run succeeded |
| 3 | No changes |
| 4 | Forbidden paths changed |
| 5 | Verification failed |
| 6 | Codex failed or timed out |

## Manual run

Stop the service first: the profile is copied from `CHATGPT_PROFILE_DIR`.

```bash
SELFHEAL_DRY_RUN=true npm run selfheal   # no push, no PR
npm run selfheal
```

## Server setup (once, as user `mcp`)

- **codex CLI:** install it and run `codex login`. Its config lives in `~/.codex`, which is `/opt/chatgpt-imagegen-mcp/.codex` with the default install.
- **Python:** `python3` and `python3-venv` (apt). The venv and the Python Playwright browser are installed on the first run.
- **git push:** needs a deploy key with **write** access to the repository, or credentials for the remote.
- **tea:** `tea login add` with a token that can open PRs. Set `SELFHEAL_TEA_LOGIN` when there are several logins.
- **Enable it:** set `SELFHEAL_ENABLED=true` in `.env`.

## Risks (accepted by design)

Yolo mode means codex runs with the full permissions of the `mcp` user and without a sandbox. It can read files the service can read, `.env` included, and it holds a copy of the ChatGPT session cookies while it runs. The limits in place:

- codex works on a throwaway clone and a profile copy, never the running checkout;
- the server's secrets are removed from its environment;
- a path allowlist is enforced;
- the full test suite must pass;
- a human reviews every PR before merging.

The diagnostics and live page content are untrusted: the prompt tells codex to treat them as data. Review PRs with that in mind, and check that fixtures carry no conversation text.

## Settings

| Variable | Default | Purpose |
|---|---|---|
| `SELFHEAL_ENABLED` | `false` | Turn automatic runs on |
| `SELFHEAL_FAILURE_THRESHOLD` | `3` | Consecutive scraper failures before a run |
| `SELFHEAL_COOLDOWN_HOURS` | `6` | Minimum time between runs |
| `SELFHEAL_SCRIPT` / `SELFHEAL_LOG_FILE` | `scripts/selfheal.sh` / `logs/selfheal.log` | Script and log paths |
| `SELFHEAL_REMOTE` / `SELFHEAL_BASE_BRANCH` | `origin` / `main` | Where to clone from and target the PR |
| `SELFHEAL_CODEX_BIN` / `SELFHEAL_CODEX_MODEL` | `codex` / unset | codex binary and optional model |
| `SELFHEAL_CODEX_TIMEOUT_SECONDS` | `2700` | Hard limit for the codex run |
| `SELFHEAL_VENV` | `.selfheal-venv` | Python venv with playwright and playwright-stealth |
| `SELFHEAL_PR_ASSIGNEES` / `SELFHEAL_TEA_LOGIN` | unset | PR assignees and tea login |
| `SELFHEAL_GIT_NAME` / `SELFHEAL_GIT_EMAIL` | selfheal identity | Commit author |
| `SELFHEAL_DRY_RUN` | `false` | Stop after verification, no push or PR |
