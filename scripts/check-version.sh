#!/bin/sh
# Every release names one version in three places: .claude-plugin/plugin.json (what Claude Code installs),
# hooks/version.ts (what the panel shows as running) and the newest heading of CHANGELOG.md. Exits 1 when they differ.
# tests/version.test.tsx holds the first two together; a test cannot read CHANGELOG.md (no file access), so this adds it.
cd "$(dirname "$0")/.." || exit 1
manifest=$(sed -n 's/^[[:space:]]*"version":[[:space:]]*"\([^"]*\)".*/\1/p' .claude-plugin/plugin.json | head -n 1)
code=$(sed -n "s/^export const VERSION = '\([^']*\)'.*/\1/p" hooks/version.ts | head -n 1)
log=$(sed -n 's/^## \([0-9][0-9.]*\) .*/\1/p' CHANGELOG.md | head -n 1)
echo "plugin.json $manifest · hooks/version.ts $code · CHANGELOG.md $log"
if [ -z "$manifest" ] || [ "$manifest" != "$code" ] || [ "$manifest" != "$log" ]; then
  echo "version mismatch: bump all three together" >&2
  exit 1
fi
echo "versions agree"
