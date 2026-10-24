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
