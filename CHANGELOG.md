# Changelog

Versions are `M.m.xxxx`; every build bumps the 4-digit build number. Details and rulings: `docs/ledger.md`, `docs/design.md`.

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
