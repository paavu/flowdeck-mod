#!/bin/sh
# Checks README.md against docs/images/ and the callout data: every image path exists, every <img> has alt text, and each
# annotated image's numbered legend (the "1. ..." list after its <img>) has the same count, numbered 1..N, as the callouts in
# scripts/screenshots/callouts.tsv for that image, and that every in-page #link names a heading. Exits 1 on the first kind of failure found, listing every problem.
cd "$(dirname "$0")/.." || exit 1
status=0

for path in $(grep -o 'docs/images/[A-Za-z0-9._/-]*\.png' README.md | sort -u); do
  if [ ! -f "$path" ]; then
    echo "README.md names $path, which does not exist" >&2
    status=1
  fi
done

if grep -n '<img' README.md | grep -v 'alt="[^"][^"]*"' >&2; then
  echo "README.md: an <img> above has no alt text" >&2
  status=1
fi

awk -F'\t' '
  function flush() {
    if (shot == "") return
    used[shot] = 1
    want = callouts[shot] + 0
    if (want > 0 && legend != want) {
      printf "README.md: %s has %d callouts but its legend has %d items\n", shot, want, legend > "/dev/stderr"
      bad = 1
    }
    shot = ""
  }
  FILENAME ~ /callouts\.tsv$/ {
    if ($0 ~ /^#/ || $0 == "") next
    callouts[$1]++
    next
  }
  /^#/ { flush() }
  /<img / && /docs\/images\/[A-Za-z0-9-]*-dark\.png/ {
    flush(); legend = 0
    if (match($0, /docs\/images\/[A-Za-z0-9-]*-dark\.png/)) {
      shot = substr($0, RSTART + 12, RLENGTH - 21)
    }
  }
  shot != "" && /^[0-9]+\. / {
    legend++
    n = $0
    sub(/\..*/, "", n)
    if (n + 0 != legend) {
      printf "README.md: %s legend item %d is numbered %s\n", shot, legend, n > "/dev/stderr"
      bad = 1
    }
  }
  END {
    flush()
    for (s in callouts) if (!(s in used)) {
      printf "callouts.tsv: %s has callouts but no <img> of it in README.md\n", s > "/dev/stderr"
      bad = 1
    }
    exit bad
  }
' scripts/screenshots/callouts.tsv README.md || status=1

awk '
  /^```/ { fence = !fence; next }
  fence { next }
  /^#+ / {
    h = $0
    sub(/^#+ /, "", h)
    h = tolower(h)
    gsub(/[^a-z0-9 _-]/, "", h)
    gsub(/ /, "-", h)
    heading[h] = 1
  }
  {
    line = $0
    while (match(line, /(\]\(|href=")#[A-Za-z0-9_-]+/)) {
      a = substr(line, RSTART, RLENGTH)
      sub(/^.*#/, "", a)
      link[a] = 1
      line = substr(line, RSTART + RLENGTH)
    }
  }
  END {
    for (a in link) if (!(a in heading)) {
      printf "README.md: the link #%s matches no heading\n", a > "/dev/stderr"
      bad = 1
    }
    exit bad
  }
' README.md || status=1

if [ "$status" -eq 0 ]; then
  echo "README images, alt text and legends agree with the callouts"
fi
exit "$status"
