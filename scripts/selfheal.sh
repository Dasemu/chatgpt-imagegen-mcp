#!/usr/bin/env bash
# Self-heal the chatgpt.com scraper with codex in yolo mode, then open a pull request.
#
# Started by the server after SELFHEAL_FAILURE_THRESHOLD consecutive UI_CHANGED/TURN_TIMED_OUT
# failures (SELFHEAL_PROFILE_SNAPSHOT is then a fresh copy of the logged-in profile), or by hand:
# `npm run selfheal` with the service STOPPED (the profile is copied from CHATGPT_PROFILE_DIR).
#
# Safety barriers: codex works on a throwaway clone with a copy of the profile, may only change
# src/chatgpt/*.ts, test/fixtures/*.html and test/client.test.ts, the full test suite must pass,
# and the result is a pull request for human review. Nothing is merged or deployed here.
#
# Exit codes: 0 PR created (or dry run ok), 3 no changes, 4 forbidden paths changed,
# 5 verification failed, 6 codex failed or timed out, other = setup error.
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
# Manual runs: pick only the non-secret settings this script needs from .env.
env_value() { [[ -f .env ]] && sed -n "s/^$1=//p" .env | tail -1; }
: "${CHATGPT_PROFILE_DIR:=$(env_value CHATGPT_PROFILE_DIR)}"
: "${DIAGNOSTICS_DIR:=$(env_value DIAGNOSTICS_DIR)}"

REMOTE="${SELFHEAL_REMOTE:-origin}"
BASE_BRANCH="${SELFHEAL_BASE_BRANCH:-main}"
CODEX_BIN="${SELFHEAL_CODEX_BIN:-codex}"
CODEX_TIMEOUT="${SELFHEAL_CODEX_TIMEOUT_SECONDS:-2700}"
VENV="${SELFHEAL_VENV:-$ROOT/.selfheal-venv}"
DIAGNOSTICS_DIR="${SELFHEAL_DIAGNOSTICS_DIR:-${DIAGNOSTICS_DIR:-$ROOT/diagnostics}}"
REASON="${SELFHEAL_REASON:-manual run}"
ALLOWED='^(src/chatgpt/[^/]+\.ts|test/fixtures/[^/]+\.html|test/client\.test\.ts)$'

log() { printf '[%s] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }
finish() { log "SELFHEAL_RESULT $1"; exit "$2"; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/chatgpt-selfheal.XXXXXX")"
PROFILE_COPY="${SELFHEAL_PROFILE_SNAPSHOT:-}"
cleanup() {
  rm -rf "$WORK"
  # The snapshot holds session cookies: never leave it behind.
  if [[ "$(basename "$PROFILE_COPY")" == chatgpt-profile-* ]]; then rm -rf "$PROFILE_COPY"; fi
}
trap cleanup EXIT

exec 9>"$ROOT/.selfheal.lock"
flock -n 9 || finish "another self-heal run is in progress" 1

log "self-heal started: $REASON"
command -v "$CODEX_BIN" >/dev/null || finish "codex binary '$CODEX_BIN' not found" 1

if [[ -z "$PROFILE_COPY" ]]; then
  SOURCE_PROFILE="$(cd "$ROOT" && realpath -m "${CHATGPT_PROFILE_DIR:-profiles/chatgpt}")"
  [[ -d "$SOURCE_PROFILE" ]] || finish "profile $SOURCE_PROFILE not found" 1
  log "copying profile $SOURCE_PROFILE (the service must be stopped)"
  PROFILE_COPY="$WORK/profile"
  cp -a "$SOURCE_PROFILE" "$PROFILE_COPY"
  rm -f "$PROFILE_COPY"/Singleton*
fi

log "cloning $REMOTE/$BASE_BRANCH"
REMOTE_URL="$(git remote get-url "$REMOTE")"
git clone --quiet --branch "$BASE_BRANCH" "$REMOTE_URL" "$WORK/repo"
BRANCH="selfheal/chatgpt-scraper-$(date -u +%Y%m%d-%H%M%S)"
git -C "$WORK/repo" checkout --quiet -b "$BRANCH"

mkdir -p "$WORK/diagnostics" "$WORK/scratch"
if [[ -d "$DIAGNOSTICS_DIR" ]]; then
  # Newest 4 failures (HTML + screenshot each).
  find "$DIAGNOSTICS_DIR" -maxdepth 1 -name '*.html' -printf '%T@ %p\n' | sort -rn | head -4 | cut -d' ' -f2- |
    while read -r html; do cp "$html" "${html%.html}.png" "$WORK/diagnostics/" 2>/dev/null || cp "$html" "$WORK/diagnostics/"; done
fi
log "diagnostics provided: $(ls "$WORK/diagnostics" | wc -l) files"

if [[ ! -x "$VENV/bin/python" ]]; then
  log "creating Python venv $VENV"
  python3 -m venv "$VENV"
fi
"$VENV/bin/pip" install --quiet -r "$ROOT/scripts/selfheal/requirements.txt"
"$VENV/bin/python" -m playwright install chromium >/dev/null

log "npm ci in the clone"
(cd "$WORK/repo" && npm ci --no-audit --no-fund >/dev/null)

PROMPT="$WORK/prompt.md"
REASON="$REASON" REPO="$WORK/repo" DIAGNOSTICS="$WORK/diagnostics" PROFILE="$PROFILE_COPY" VENV="$VENV" \
BROWSE="$ROOT/scripts/selfheal/browse.py" SCRATCH="$WORK/scratch" python3 - "$ROOT/scripts/selfheal/prompt.md" "$PROMPT" <<'PY'
import os, sys
text = open(sys.argv[1], encoding="utf-8").read()
for key in ("REASON", "REPO", "DIAGNOSTICS", "PROFILE", "VENV", "BROWSE", "SCRATCH"):
    text = text.replace("{{%s}}" % key, os.environ[key])
open(sys.argv[2], "w", encoding="utf-8").write(text)
PY

log "running codex (yolo, timeout ${CODEX_TIMEOUT}s)"
CODEX_ARGS=(exec --dangerously-bypass-approvals-and-sandbox -C "$WORK/repo" -o "$WORK/summary.md")
[[ -n "${SELFHEAL_CODEX_MODEL:-}" ]] && CODEX_ARGS+=(-m "$SELFHEAL_CODEX_MODEL")
# Server secrets are not needed by codex; keep them out of its environment.
if ! env -u MCP_SERVER_TOKEN -u UPDATE_TOKEN -u PUBLIC_MEDIA_SIGNING_SECRET \
  timeout "$CODEX_TIMEOUT" "$CODEX_BIN" "${CODEX_ARGS[@]}" "$(cat "$PROMPT")"; then
  finish "codex failed or timed out" 6
fi

cd "$WORK/repo"
git add -A
CHANGED="$(git diff --cached --name-only)"
[[ -n "$CHANGED" ]] || finish "codex made no changes" 3
log "changed files:"; printf '  %s\n' $CHANGED
FORBIDDEN="$(grep -Ev "$ALLOWED" <<<"$CHANGED" || true)"
[[ -z "$FORBIDDEN" ]] || finish "forbidden paths changed, attempt discarded: $(tr '\n' ' ' <<<"$FORBIDDEN")" 4

log "verifying: typecheck + tests"
if ! npm run typecheck || ! npm test; then finish "verification failed" 5; fi

SUMMARY="$(head -c 6000 "$WORK/summary.md" 2>/dev/null || true)"
git -c user.name="${SELFHEAL_GIT_NAME:-chatgpt-imagegen selfheal}" -c user.email="${SELFHEAL_GIT_EMAIL:-selfheal@localhost}" \
  commit --quiet -m "fix: repair chatgpt.com scraper after frontend change" -m "Automatic self-heal ($REASON) by codex. Review before merging."

if [[ "${SELFHEAL_DRY_RUN:-false}" == "true" ]]; then
  git --no-pager show --stat HEAD
  finish "dry run ok, nothing pushed" 0
fi

log "pushing $BRANCH"
git push --quiet "$REMOTE" "$BRANCH"
TEA_ARGS=(pr create --head "$BRANCH" --base "$BASE_BRANCH" --title "fix: repair chatgpt.com scraper ($(date -u +%Y-%m-%d))"
  --description "Automatic self-heal triggered by: $REASON

$SUMMARY

Generated by scripts/selfheal.sh (codex). Verified with typecheck + npm test in a clean clone. **Review the diff and test against the live site before merging.**")
[[ -n "${SELFHEAL_PR_ASSIGNEES:-}" ]] && TEA_ARGS+=(--assignees "$SELFHEAL_PR_ASSIGNEES")
[[ -n "${SELFHEAL_TEA_LOGIN:-}" ]] && TEA_ARGS+=(--login "$SELFHEAL_TEA_LOGIN")
PR_OUTPUT="$(tea "${TEA_ARGS[@]}")"
printf '%s\n' "$PR_OUTPUT"
PR_URL="$(grep -Eo 'https?://[^[:space:]]+/pulls/[0-9]+' <<<"$PR_OUTPUT" | head -1 || true)"
echo "SELFHEAL_PR_CREATED ${PR_URL:-$BRANCH}"
finish "pull request created" 0
