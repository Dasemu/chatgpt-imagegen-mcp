#!/usr/bin/env bash
# Idempotent update for the install living in the parent directory of this script.
# Output goes to stdout with timestamps; the caller redirects it to a log file.
# There are no database migrations: all state is plain files on disk (media, profile, jobs).
set -Eeuo pipefail

SERVICE_NAME="${SERVICE_NAME:-chatgpt-imagegen-mcp.service}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

log() { printf '[%s] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }

BACKUP=""
BUILD_STARTED=0
on_error() {
  local code=$?
  trap - ERR
  if [[ "$BUILD_STARTED" == 1 && -n "$BACKUP" && -d "$BACKUP" ]]; then
    log "restoring previous dist"
    rm -rf "$ROOT/dist"
    cp -a "$BACKUP" "$ROOT/dist"
  fi
  log "UPDATE_FAILED $(date -u +%Y-%m-%dT%H:%M:%SZ) (exit $code, service not restarted)"
  exit "$code"
}
trap on_error ERR

exec 9>"$ROOT/.update.lock"
if ! flock -n 9; then
  log "another update is already running"
  trap - ERR
  exit 1
fi

log "update started in $ROOT"
log "git fetch + pull --ff-only"
git fetch --prune
git pull --ff-only

log "npm ci"
npm ci

log "installing Playwright Chromium (system libraries are not installed here; see docs/deployment.md)"
npx playwright install chromium

if [[ -d dist ]]; then
  BACKUP="$(mktemp -d "$ROOT/.dist-backup.XXXXXX")"
  cp -a dist/. "$BACKUP/"
fi
BUILD_STARTED=1
log "npm run build"
npm run build

log "npm test"
npm test

rm -rf "$BACKUP"
BACKUP=""
BUILD_STARTED=0

log "restarting $SERVICE_NAME"
echo "UPDATE_SUCCEEDED $(date -u +%Y-%m-%dT%H:%M:%SZ)"
trap - ERR
sudo -n systemctl restart "$SERVICE_NAME" || { log "UPDATE_FAILED $(date -u +%Y-%m-%dT%H:%M:%SZ) (restart failed)"; exit 1; }
