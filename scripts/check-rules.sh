#!/bin/sh
# The skill must carry every flow rule by itself: /flowdeck:flowdeck works with task tracking off, on a clean install with
# no CLAUDE.md and no memory. tests/rule.test.tsx checks the injected rule; a test cannot read SKILL.md (no file access),
# so this checks it. Exits 1 when a rule is missing.
cd "$(dirname "$0")/.." || exit 1
skill=skills/flowdeck/SKILL.md
missing=0
check() {
  if ! grep -qF -- "$2" "$skill"; then
    echo "SKILL.md misses $1: $2" >&2
    missing=1
  fi
}
check 'reporting through the progress tool' 'mcp__flowdeck__progress'
check 'after chaining of same-file tasks' 'Tasks that edit the same files must be chained with `after`'
check 'the #n worker description' '`#3 History module`'
check 'a goal on every task created' 'Send `goal` on every task you create or add'
check 'result and feedback on accept' 'send `result` (what it delivered) and `feedback`'
check 'no flow for trivial work' 'A question or a one-step edit needs no flow.'
check 'never leaving a task unreported' 'never leave a task unreported'
check 'the per-task model sent in the plan' 'Send the same value as the task'"'"'s `model` in the plan'
check 'the escalation order' 'Escalation order: a task that fails review on Sonnet goes to Opus careful'
check 'Fable only after the user approved' 'Use `flowdeck-fable` only after an explicit yes.'
check 'the failure reason atop the Fable brief' 'state at the top of the Fable brief which task failed on Opus heavy and why'
check 'the step-list line at the top of every brief' 'Update your step list after each finished step, before starting the next.'
check 'the batch-close review hint' 'closed in one batch call at the end'
agent() {
  f="agents/flowdeck-$1.md"
  if ! grep -qx "model: $2" "$f" || ! grep -qx "effort: $3" "$f"; then
    echo "$f is not model $2, effort $3" >&2
    missing=1
  fi
}
stepwording() {
  for phrase in 'Never batch' 'As soon as step 1 is finished, call step with `next: true`' 'after each finished step' 'leaves the progress bar empty and every step at 0s'; do
    grep -qF -- "$phrase" "agents/flowdeck-$1.md" || { echo "agents/flowdeck-$1.md misses the step wording: $phrase" >&2; missing=1; }
  done
}
for t in light medium careful heavy fable; do stepwording "$t"; done
agent light sonnet low
agent medium sonnet medium
agent careful opus high
agent heavy opus xhigh
agent fable fable high
grep -q 'only after the user approved it' agents/flowdeck-fable.md || { echo 'flowdeck-fable.md misses the approval line' >&2; missing=1; }
[ "$missing" = 0 ] && echo "SKILL.md carries every flow rule"
exit "$missing"
