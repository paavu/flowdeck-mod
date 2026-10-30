# Changelog

Versions are `M.m.xxxx`; every build bumps the 4-digit build number. Details and rulings: `docs/ledger.md`, `docs/design.md`.

## 1.0.0025 (2026-10-30)
- The archive is one file per saved session (`.claude/flowdeck/archive/<key>-<startedAt>.json`) plus a small index (`archive-index.json`, one record per session: title, dates, item and task counts, cost, tokens, time, size). The Archive tab draws its whole list from the index, collapsed rows newest first, each with its summary line (`≈$1.23 · 45k tokens · 12:03`), 50 at a time with `Show more (n)`; opening a row reads that session's file (`loading…`), folding it lets the file go, at most 10 held. Volumes, `Older volumes`, `Back to latest` and `Show older` are gone.
- The index heals itself: a session file it does not list is added, a record whose file is gone is kept and marked `file missing`, a damaged index is rebuilt from the files (the damaged one kept in `.trash/damaged/`). Every save writes the session's file first.
- The old archive (`history.json`, its volumes and side files) is imported once into session files; the old files are left untouched, and `archive-migrated.json` records what was imported. A file that cannot be read is said and tried again later.
- `✕` on an Archive row asks first (the session's date, title, summary and file), then moves the session to the trash: its file is copied to `.trash/` and it shows in the new `Trash (n)` tab, where `Restore` (also confirmed) brings it back to its place. Nothing is erased; the engine cannot move or remove files, so the session's file also stays in `archive/`.
- Every finished row shows when it finished (`14:07` today, `Oct 29 · 14:07` before), and every list is ordered by it, latest on top: the Finished tab (accepted rows among the runs, by when they were accepted), rows inside an Archive or Trash session, the Archive and Trash lists (by each session's end). The `⤓` press archives the row and every row that finished before it. `progress` records when each task was accepted.
- Fold chevrons come right before the name on every foldable row (agent rows, Archive and Trash rows), desktop and terminal; row actions (`⤓`, `✕`, `Restore`) come after it.
- `FLOWDECK_ARCHIVE_VOLUME_MAX` / `FLOWDECK_HISTORY_SEGMENT_MAX` are no longer read.

## 1.0.0024 (2026-10-30)
- The panel's flowdeck parts form their own group below Context and Usage: tabs `Active (n)`, `Finished (n)`, `Plans (n)`, `Archive (n)` with the dim `Band` button at the end of the row, and only the selected tab's list below them (no more stacked Flow, Plans and Archive sections). The selected tab is bold in the accent colour and underlined; Active is selected at first, and the choice holds for the session.
- Active: the flow header, then one flat list, running runs first and then the tasks not started in plan order (`Nothing running or queued` when empty). Finished: the flow header, then the open flow's finished rows not archived yet, newest first, with their archive icons, and the `Accepted · no worker run` rows (`No finished items yet`); the `Running · N`, `Planned · N` headings and the `Finished · N` fold are gone, and `M archived` is a dim line at the top of the Finished list. Plans: the plans and `Clear finished` (`No plans`). Archive: the saved sessions.
- Counts: Active = running runs + queued tasks; Finished = finished rows not archived + accepted rows without a run; Plans = plans in the list; Archive = the latest part's entries + every archive volume's count from the volume index (kept while a volume is shown).
- Archive group lines read `<date> · <HH:MM> (N)`: the item count in brackets, the word `items` (and `steps` for a plan) dropped; narrow panels still drop the time first.
- The Plans and Archive hide toggles are gone (their stored `plansShown`/`historyShown` are read but unused); the Context and Usage toggles are unchanged. The panel's fallback drawing shows the tabs too.

## 1.0.0023 (2026-10-29)
- A band that cannot be drawn says why: one dim transcript line per reason (`flowdeck: the band above the prompt could not be drawn: <reason>`, also in the debug log) and a `band error: <reason>` line under the panel's top buttons until the next reload. It still gives way to what other mods draw there.
- When what is drawn below the band fails, the flow row is drawn without it instead of disappearing.
- README: a mod listed before flowdeck that answers the band itself (replay-theater, after any turn that edited files) hides flowdeck's band; list flowdeck before it. Presses on buttons drawn before `/reload-plugins` are refused by the engine.

## 1.0.0022 (2026-10-29)
- `progress` `done` takes the accepted task numbers (`done: [1, 3]`); the flow stores which tasks were accepted. An accepted task without a worker run is an `Accepted · no worker run` row; an accepted task whose run is Incomplete reads `Incomplete · accepted`. A plain count still means the first N tasks.
- Workers must close their step list (every step `done` or `failed`, skipped ones with a note) before their final report; the orchestrator returns an Incomplete run instead of accepting it.

## 1.0.0021 (2026-10-29)
- Workers are linked to their planned task by the mod itself: the exact title first, then a leading task number in the Agent description (`#3 …`, `[3] …`, `task 3 …`), then the closest title, then the only open task of the worker's tier. A task is no longer shown as waiting while a worker started with other words runs it.
- The skill and the `progress` tool ask for descriptions that begin with the task number (`#3 History module`).
- The repo is its own marketplace (`.claude-plugin/marketplace.json`, name `flowdeck-mod`); README covers install, update, rollback and data on a new machine; this changelog; git tag `v1.0.0021`.

## 1.0.0020 (2026-10-29)
- Agent rows lead with their task number (`3. History module`) and show `after N, M` on the model line; planned rows read `ready` once every task they wait for is done. `progress` cleans `after` (unknown, self, cycles).

## 1.0.0019 (2026-10-29)
- A run that ended OK with steps left is `Incomplete` (amber bar at its steps, half-ring mark, no archive icon) instead of `Done`.

## 1.0.0018 (2026-10-29)
- 24-hour times everywhere; the usage reset shows the time left by default, with a `◷` switch to the exact time (remembered for all projects).

## 1.0.0017 (2026-10-25)
- Finished plans are saved to the Archive as their own groups; Archive groups no longer draw planned tasks.

## 1.0.0016 (2026-10-25)
- The panel always draws: values held from an older version are normalized, each section draws in its own guard, the Archive is shown by default.

## 1.0.0015 (2026-10-25)
- Agent row layout: the task name natively on line 1, the archive icon after it, the chevron at the far end.

## 1.0.0014 (2026-10-25)
- Calmer redraws (5 s tick) and path-free button keys, against stale button handles in the desktop app.

## 1.0.0013 (2026-10-25)
- The Archive group's fold line is the end date and the item count.

## 1.0.0012 (2026-10-25)
- Archive group title and date on two lines (superseded by 1.0.0013).

## 1.0.0011 (2026-10-25)
- The archive control became a small `⤓` icon.

## 1.0.0010 (2026-10-25)
- Archive groups draw their rows flat, the newest group open.

## 1.0.0009 (2026-10-25)
- Archive finished items of the open flow from the live list.

## 1.0.0008 (2026-10-25)
- History renamed to Archive (saved file names kept) and moved out of `register.tsx`.

## 1.0.0007 (2026-10-25)
- Archive data safety: UTF-8 byte sizes, no overwrite of unreadable or unknown files, side files first, store fallback merged back.

## 1.0.0006 (2026-10-25)
- Archive volumes (`history-<n>.json`) instead of ever deleting old flows.

## 1.0.0005 (2026-10-25)
- Archive groups show the whole flow as the live panel does.

## 1.0.0004 (2026-10-25)
- `Finish` / `Finish flow` buttons and `restart: true` for a new `/flowdeck <task>`.

## 1.0.0003 (2026-10-25)
- Agent row stats on the model line.

## 1.0.0002 (2026-10-25)
- Archive and plans saved per project in `<project>/.claude/flowdeck/`.

## 1.0.0001 (2026-10-25)
- First versioned build: plans (`plan` tool, Plans section, band rows), agent tool word and state colours, foldable worker steps, review fixes.

## 0.1.0 (2026-10-24)
- flowdeck built from savvy-flow, savvy-progress and context-bar: `/flowdeck`, `/flowdeck-agents`, the band, the agents panel with Context and Usage.
