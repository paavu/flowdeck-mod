#!/bin/sh
# Draws the README's "How it works" diagram: the SVGs (python3) and their PNGs (rsvg-convert).
set -e
cd "$(dirname "$0")/../.."
python3 scripts/diagrams/how-it-works.py
for t in light dark; do
  rsvg-convert -w 1100 "docs/images/src/how-it-works-$t.svg" -o "docs/images/how-it-works-$t.png"
done
ls -l docs/images/how-it-works-*.png
