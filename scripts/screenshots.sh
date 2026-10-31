#!/bin/sh
# Renders the README's screenshots from the mod's own drawing code with sample data:
#   1. copies the mod into a new temporary folder with scripts/screenshots/shots.tsx as its only test,
#   2. runs it with `claude plugin test`, which prints each drawn tree as an `@@SHOT <name> <json>` line,
#   3. lays the trees out as HTML (scripts/screenshots/render.mjs) and screenshots them, light and dark, as PNG.
# Needs: claude, node and agent-browser (https://github.com/vercel-labs/agent-browser, with its Chrome: `agent-browser install`).
# Writes docs/images/*.png and docs/images/src/ (the mod's own SVG drawings and the HTML pages). The temporary folder is left
# for the system to clean up.
set -e
cd "$(dirname "$0")/.."
root=$(pwd)
tmp=$(mktemp -d "${TMPDIR:-/tmp}/flowdeck-shots.XXXXXX")
mkdir -p "$tmp/mod/tests" "$tmp/mod/.claude-plugin"
cp .claude-plugin/plugin.json "$tmp/mod/.claude-plugin/"
cp -R hooks types tsconfig.json "$tmp/mod/"
cp tests/fake-fs.ts tests/archive-files.ts tests/tabs.ts "$tmp/mod/tests/"
cp scripts/screenshots/shots.tsx "$tmp/mod/tests/shots.test.tsx"
TZ=${TZ:-UTC} claude plugin test "$tmp/mod" > "$tmp/out.txt" 2>&1 || { tail -40 "$tmp/out.txt" >&2; exit 1; }
node scripts/screenshots/render.mjs "$tmp/out.txt" "$root/docs/images" "$tmp/html"
