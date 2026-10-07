# Self-heal (codex)

chatgpt.com changes its frontend without notice. When the scraper breaks, the server can run **codex in yolo mode** to inspect the live site and patch the code. If the patch passes the tests **and generates a real image on chatgpt.com**, it is **merged automatically and deployed** to the running server with `scripts/update.sh`. Patches that fail the live check stay as open pull requests.

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
7. Runs the **live smoke test**: `src/smoke.ts` generates one real image with the patched code and the profile copy (it uses one image of quota).
8. Commits, pushes the branch and opens a PR with `tea`. Codex's summary and the smoke result go in the description.
9. If the smoke test passed, it squash-merges the PR (`tea pr merge`, `SELFHEAL_AUTO_MERGE`). It then hands over to `scripts/update.sh` (`SELFHEAL_AUTO_UPDATE`), which pulls, builds, tests and restarts the service; its output goes to `UPDATE_LOG_FILE`, so `/admin/update/status` shows it.
10. Always deletes the clone and the profile copy.

After the restart the server restores the last run from `SELFHEAL_LOG_FILE`. That covers its status and PR, and also its start time, so the cooldown survives the restart. If a merged patch still fails, there is no immediate retry: the next run waits at least `SELFHEAL_COOLDOWN_HOURS`. To roll back, revert the squash commit on `main` and call the update endpoint.

Exit codes and the `SELFHEAL_RESULT` log line:

| Code | Meaning |
|---|---|
| 0 | Merged and deployed, PR created (auto-merge off), or dry run ok |
| 3 | No changes |
| 4 | Forbidden paths changed |
| 5 | Verification failed |
| 6 | Codex failed or timed out |
| 7 | Merge failed; the PR is left open |
| 8 | Live smoke test failed; the PR is left open, or nothing is pushed in a dry run |

## Manual run

Stop the service first: the profile is copied from `CHATGPT_PROFILE_DIR`. Without a desktop, wrap the command in `xvfb-run -a`, because the smoke test runs a headed browser.

```bash
SELFHEAL_DRY_RUN=true xvfb-run -a npm run selfheal   # no push, no PR, no deploy
xvfb-run -a npm run selfheal
npm run smoke                                        # live check of the current code (service stopped)
```

## Server setup (once, as user `mcp`)

- **codex CLI:** install it and run `codex login`. Its config lives in `~/.codex`, which is `/opt/chatgpt-imagegen-mcp/.codex` with the default install.
- **Python:** `python3` and `python3-venv` (apt). The venv and the Python Playwright browser are installed on the first run.
- **git push:** needs a deploy key with **write** access to the repository, or credentials for the remote.
- **tea:** `tea login add` with a token that can open **and merge** PRs. Branch protection on `main` must allow that user to merge. Set `SELFHEAL_TEA_LOGIN` when there are several logins.
- **Update script:** the sudoers rule from [deployment.md](deployment.md), which lets the service restart itself.
- **Enable it:** set `SELFHEAL_ENABLED=true` in `.env`.

## Risks (accepted by design)

Yolo mode means codex runs with the full permissions of the `mcp` user and without a sandbox. It can read files the service can read, `.env` included, and it holds a copy of the ChatGPT session cookies while it runs. The limits in place:

- codex works on a throwaway clone and a profile copy, never the running checkout;
- the server's secrets are removed from its environment;
- a path allowlist is enforced;
- the full test suite must pass;
- a real image must be generated with the patched code before it is merged;
- `update.sh` restores the previous build and does not restart if the build or tests fail on the server;
- there is a cooldown between runs, and every change stays traceable as a squash commit plus a PR.

Merges are automatic, so nobody reviews the patch before production. Check the self-heal PRs afterwards.

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
| `SELFHEAL_AUTO_MERGE` | `true` | Merge the PR when the live smoke test passes |
| `SELFHEAL_AUTO_UPDATE` | `true` | Deploy with `scripts/update.sh` after merging |
| `SELFHEAL_SKIP_SMOKE` | `false` | Skip the live smoke test (tests only) |
| `SELFHEAL_SMOKE_TIMEOUT_SECONDS` | `900` | Limit for the live smoke test |
| `SELFHEAL_DRY_RUN` | `false` | Stop after verification: no push, PR or deploy |
