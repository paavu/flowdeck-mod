# flowdeck ledger — plan: flowdeck/docs/plan.md
Pre-flight: Task 3 consumes Task 2 exports; Task 4 consumes Task 1 names. No conflicts found.
Ruling: built on main in claude-mods (new directory only, local commits, no push) — the repo is the user's own mods repo, worktree adds nothing — cost if wrong: none, easy to revert.
Task 1: complete (tests: claude plugin test flowdeck → 3/3 pass; validate passed)
Ruling: contextSvg returns {height, body} (inner svg) instead of a full <svg> string — the panel's svg() wrapper supplies the theme classes — cost if wrong: one wrapper call.
Task 2: complete (tests: claude plugin test flowdeck → 8/8 pass)
Ruling: renamed marketplace + author coooloz → paavu-mods across the repo and reinstalled open-items, safety-guard, ssh-status, agents-autopen under it (user chose 'whole marketplace now'; backups *.pre-paavu-mods of settings.json, known_marketplaces.json, installed_plugins.json) — cost if wrong: restore backups. safety-guard working-tree changes (0.2.1) left uncommitted on purpose.
Ruling: terminal pane clamps width to 24 columns (savvy-progress's existing rule), so the plan's 'under 20 columns draws nothing' case cannot occur in the terminal — the narrow test checks no crash instead — cost if wrong: none.
Task 3: complete (tests: claude plugin test flowdeck → 16/16 pass)
Ruling: mirrored task-list items get tier medium (display only) and are added but never removed or marked done by the mirror — cost if wrong: a planned row shows the wrong model.
Ruling: once a flow exists (isLinked), a different title in a later progress call renames it instead of starting a new flow; only finished:true ends it — matches 'keep adding to it' — cost if wrong: two unrelated jobs share one flow until closed.
Task 4: complete (tests: claude plugin test flowdeck → 23/23 pass)
Final: fixed namespaced worker detection (flowdeck:flowdeck-x) — 'plugin-namespaced worker' + 'non-flowdeck agent' tests RED→GREEN, suite 31/31
Final: fixed worker TodoWrite/TaskCreate mirrored into the flow — 'a worker's own task list' test RED→GREEN
Final: fixed mirrored items never completing and dropped by a re-plan (mirrored/counted flags, completed items count once; linked re-plan unions tasks) — 3 tests RED→GREEN
Final: fixed re-plan/second /flowdeck <task> clamping done and dropping tasks (linked flows never lose a task) — 'remaining tasks' test RED→GREEN
Final: fixed contradictory finished:true rule (skill, tool description): phase "close" when work is done, finished only when the user ends the flow
Final: fixed refused command registration aborting session.start (.catch) — 'refused registration' test RED→GREEN
Final: also fixed minors: malformed todos, mirror runs after the tool, add-only call after a finished flow clears old agents, panel strings say flowdeck, desktop context section above the header
Final: minor (deferred): "Context" and "no context data yet" are English only
Final: minor (deferred): terminal context section sits under the title row, not above it
Final: minor (deferred): tsconfig.json extends a types path that does not exist (editor type-check only; same as safety-guard)
Final: Ruling: a linked flow cannot drop a task by re-plan (cancelled tasks stay in the list until finished:true) — keeps 'none dropped' — cost if wrong: a cancelled task shows as planned
Usage: built usage module + panel section (tests: claude plugin test flowdeck → 56/56 pass, validate passes). Note: usage.test.tsx was run after the module existed (tests were written first, but the first run was GREEN apart from the harness lacking toBeCloseTo) — cost if wrong: none.
Usage review: fixed expired window shown as current (live()) — test RED→GREEN, suite 63/63
Usage review: fixed week row turning red from a short burst — the week has no recent projection, only the average — test RED→GREEN
Usage review: fixed hit times without a day and spans in hours instead of days — tests RED→GREEN
Usage review: fixed terminal never red (rows carry kind/over; bar row coloured) and verdict cut off (split over two rows)
Usage review: fixed even-pace mark colour (#6b6b6b, readable on light and dark), mark at 0% off the bar, week reset date shown when a week away
Usage: Ruling: the week shows only the average projection (recent pace over days assumes round-the-clock work); the user asked for both paces mainly for the session — cost if wrong: no 'recent' line on the week row
Usage: minor (deferred): label and reset text can overlap in narrow desktop panels (under ~340px)
Usage: minor (deferred): recent pace stays frozen after a burst until the next reading; reset detection only by a falling percent (not resetsAt change)
Usage: minor (deferred): compact terminal mode still shows all usage rows; a third toggle crowds the title row at 40 columns; no-subscription users see "no usage data yet"
Usage: not verified in a real session: rateLimits shape/percent scale (0-100) and whether the engine returns stale resetsAt after expiry — check after first new session
Panel layout: Context\/Usage buttons moved to the top row; Context now collapses to head line + bar (stored contextShown=false means collapsed); Usage hides the whole section. suite 65/65
Usage bars now show remaining: full = 100% left, drains with use; label 'N% left'; projection drawn as the part that will be used up; even-pace mark at the remaining share. suite 69/69
Band above prompt: now calls next(e) and stacks above what other mods draw (it used to drop it), width capped at 420px, right edge kept clear (paddingRight 5) like skins' band. suite 73/73. Not seen in a live window yet.
Band: dismiss (✕) now only hides the band (panel flag isBandHidden, per session, not stored); Band button in the panel's top row toggles it; a new flow (first report, after finished, or a title change on an unlinked flow) un-hides it, updates inside the same flow do not. suite 76/76.
History (run through /flowdeck itself): Task 1 history module (flowdeck-medium) accepted after one correction by me — time is the span of the runs like the panel header, not the sum; Task 2 history in the panel (flowdeck-careful) accepted after reading saveHistory/recordFlow/session.end. suite 115/115.
History: Ruling: entry = summary per flow; all projects; last 50; saved in the engine store key `history`; shown at the bottom of the panel behind a History button, off by default (user's choice).
History: minor (deferred): a second finished:true while a costly worker still runs can create a separate blank-flow entry (unguarded, low likelihood)
History: minor (deferred): done tasks in an entry are shown as the first N in plan order (the flow counts done tasks, not which)
Band overlap: next-steps puts everything drawn below it in a no-shrink box to the right of its checkboxes, so flowdeck's 420px drawing squeezed the checklist. Band now max 300px, flexShrink 1, minWidth 0, overflow hidden. Not seen live.
Band overlap v2: root cause was LOAD ORDER (first in enabledPlugins = outermost); flowdeck moved before next-steps in ~/.claude/settings.json. Needs /reload-plugins or a new session; not seen live.
Band width: the 300px cap was only a workaround for the next-steps squeeze; with load order fixed the band fills the width again (cap 1600, slot = columns*8-150), shrink/clip wrapper kept as a safety net. suite 115/115 (test and code changed together).
Band width v3: dropped paddingRight 5 (copied from skins, whose band draws its own [-] mark; flowdeck has none) and the extra 54px reserve (150 -> 96, savvy-progress's original); the band now runs to the right edge like plan-progress's Agents bar. suite 115/115. Not seen live.
Band width v4: the host's column is ~9 CSS px (measured from screenshots: band stopped ~14% short at 8px/col); width = columns*9-110, cap 1600. suite green. Not seen live.
Task 7 requirement (user, 2026-10-26): agent rows show the live tool word AND a state colour for each state like plan-progress's strips (running, waiting/needs approval amber, done green, error red); same colours on planned task rows once running; desktop and terminal.
Task 7 requirement (user, refined): the tier/effort colour stays only on the row's bottom line; the row's progress BAR uses state colours with the state name on it (Running + live tool word, Needs approval amber, Done green, Error red) — do not repeat the tier colour on the bar. Same for planned task rows once running.
Decision (user, 2026-10-26): Running state colour = blue-violet (matches the band accent #8f8cf4). Waiting/Needs approval amber, Done green, Error red. For task 7 and the plan tracks.
Task 6 scope ruling: instead of drawing 'stages' on the flow row (low value, risks the calibrated band), task 6 puts RUNNING PLANS in the band above the prompt (compact 22px rows, state colour + state name, max 2), since removing plan-progress otherwise leaves plans with no band; the band toggle/dismiss covers them. Flow row unchanged. Cost if wrong: none (additive).
Task 9 (user, 2026-10-26): agent rows get a per-agent collapse chevron (NO ✕: flowdeck keeps the session's agents list, nothing is dismissed); line 2 shows `3/6 · <current step note>` + state/tool word; expanding lists CHILD ITEMS with state mark+colour (planned, running, done, error) and per-item time. Ruling: child items = steps the worker reports by extending the `step` tool (a `steps` list sent once, then ops like the plan tool) and the 5 worker files updated; workers that do not report show no chevron. A tool-call fallback is deferred (user did not choose; recommendation taken).
