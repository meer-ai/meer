#!/bin/bash
#
# MeerAI release helper.
#
# Bumps ALL workspace packages lockstep, runs the full preflight locally, then
# commits + tags + pushes. Pushing the `v*` tag triggers .github/workflows/
# release.yml, which builds, tests, and publishes every package to npm with
# provenance and cuts a GitHub Release.
#
set -euo pipefail

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BLUE='\033[0;34m'; NC='\033[0m'
info()  { echo -e "${BLUE}[INFO]${NC} $1"; }
ok()    { echo -e "${GREEN}[OK]${NC} $1"; }
warn()  { echo -e "${YELLOW}[WARN]${NC} $1"; }
err()   { echo -e "${RED}[ERROR]${NC} $1"; }

cd "$(dirname "$0")/.."

git rev-parse --git-dir >/dev/null 2>&1 || { err "Not in a git repository"; exit 1; }
if ! git diff-index --quiet HEAD --; then
  err "Working directory is not clean. Commit or stash first."; exit 1
fi

CURRENT=$(node -p "require('./package.json').version")
info "Current version: $CURRENT"
echo ""
echo "Release types:"
echo "  1) patch   2) minor   3) major   4) custom"
read -r -p "Select (1-4): " choice
case "$choice" in
  1) BUMP="patch" ;;
  2) BUMP="minor" ;;
  3) BUMP="major" ;;
  4) read -r -p "Exact version (e.g. 1.0.0): " BUMP ;;
  *) err "Invalid selection"; exit 1 ;;
esac

# Lockstep-bump every package, then read back the new version.
node scripts/set-version.mjs "$BUMP"
NEW=$(node -p "require('./package.json').version")
info "New version: $NEW"

info "Running preflight (build + typecheck + test)…"
if ! pnpm run preflight; then
  err "Preflight failed — reverting version bump."
  git checkout -- package.json packages/*/package.json
  exit 1
fi
ok "Preflight passed"

PREV_TAG=$(git describe --tags --abbrev=0 2>/dev/null || echo "")
if [ -n "$PREV_TAG" ]; then
  NOTES="Release v$NEW

## Changes
$(git log --oneline "${PREV_TAG}..HEAD" | sed 's/^/- /')"
else
  NOTES="Release v$NEW"
fi

info "Committing and tagging…"
git add package.json packages/*/package.json
git commit -m "release: v$NEW"
git tag -a "v$NEW" -m "$NOTES"

info "Pushing main + tag…"
git push origin HEAD
git push origin "v$NEW"

ok "Release v$NEW pushed. GitHub Actions will publish to npm."
REMOTE=$(git config --get remote.origin.url | sed 's/.*github.com[:/]\(.*\)\.git/\1/')
info "Watch: https://github.com/${REMOTE}/actions"
