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
