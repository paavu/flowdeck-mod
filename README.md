# flowdeck

An orchestrated delivery flow for Claude Code with a live side panel. The session model plans, designs and reviews; five tiered worker subagents implement. The panel shows the context window, usage limits, task plans, the agents and past flows; a band above the prompt shows the flow and open plans.

## Commands
| Command | What it does |
|---|---|
| `/flowdeck <task>` | Starts a flow on a new task. |
| `/flowdeck` | With no task: takes over the work already underway in the session. Every later task joins the same flow and panel. |
| `/flowdeck-agents` | Shows or hides the side panel (titled `flowdeck`). |

## Tools (for the model)
| Tool | Used by | Purpose |
|---|---|---|
| `mcp__flowdeck__progress` | orchestrator in a flow | Flow title, planned worker tasks (each with `after`: the numbers, from 1, of the tasks it waits for), the accepted tasks (`done: [1, 3]`, task numbers that add to those accepted before; a plain count `done: 2` still works and means the first 2 tasks), phase (`plan`, `design`, `delegate`, `review`, `close`), `finished`, `restart`. Each task is delegated with the Agent description `#<number> <title>`. Waits on unknown tasks, on the task itself or closing a cycle are ignored. |
| `mcp__flowdeck__step` | workers | A worker's own steps on its agent row: the plan sent once as a `steps` list, then moved with `next`, `done`, `active`, `failed`. The older `total`, `done`, `note` counts still work. |
| `mcp__flowdeck__plan` | main session | A task plan for any work: stages of steps, or `kind: "todo"` for a flat list. Created once, then moved with short ops (`next`, `done`, `active`, `failed`, `state`, `note`); calls from subagents are ignored. |

A short rule in the system prompt (`flowdeck:plan-rule`) tells the model when to make a plan and how to move it. It never blocks an edit.

## How the flow works
1. The session model reads the code, breaks the task into self-contained tasks and picks a worker tier for each. It shows you the plan.
2. It delegates to the cheapest tier likely to get the task right: `flowdeck-light` (mechanical), `flowdeck-medium` (standard), `flowdeck-careful` (delicate), `flowdeck-heavy` (unfamiliar code, root causes), `flowdeck-fable` (hardest logic).
3. It reviews each result, accepting it or sending it back, and reports through `progress`; workers report through `step`.

## The panel
Top buttons: **Context · Usage**, each toggling its section and remembering the choice. Below Context and Usage, everything flowdeck has its own group: a tab row **Active (n) · Finished (n) · Plans (n) · Archive (n)** with the small dim `Band` button at its end, then the selected tab's one list. Only one list shows at a time. The selected tab is bold in the accent colour and underlined, the others dim; pressing a tab shows its list, pressing the selected one changes nothing. Active is selected at first; the choice holds for the session. Each count is live, from the same rows its list draws, and reads `(0)` when there is nothing; a count that cannot be read is left out (`Active`). The terminal shows the same tabs and counts as text.

| Tab | Count | Lists |
|---|---|---|
| Active | running runs + queued tasks of the open flow | The flow header (title, cost, tokens, time, `Finish flow`, `Collapse`), then one flat list: the running runs first (newest first), then the tasks not started yet in plan order (their waits and `ready`). Empty: `Nothing running or queued`. |
| Finished | finished rows of the open flow not archived yet | The same flow header, then the finished rows newest first (Done, Error, Incomplete), then the `Accepted · no worker run` rows; each Done or Error row has its archive icon (`⤓`). After an archive press a dim `M archived` line says how many left the list. Empty: `No finished items yet`. |
| Plans | the plans in this list (open and done, not cleared) | The Plans section (below). Empty: `No plans`. |
| Archive | saved sessions: the latest part's entries plus every archive volume's count from the volume index | The Archive (below), one group per saved session. |

| Section | Shows |
|---|---|
| Context | The context window as a stacked bar with tokens per category and where auto-compaction runs. Collapsed, it keeps the head line and the bar. |
| Usage | The five-hour session and the week: the reset, by default as the time left (`Resets in 2d 13h 20m`, `Resets in 20m`); the small `◷` beside it switches both windows to the exact time (`Resets at 14:40`, `Resets Thursday 11:30`) and back, remembered for all projects. A bar that drains as the limit is used (full = 100% left), percent left, an even-pace mark, and a forecast to the reset (recent pace over ~30 min and the window average), e.g. `recent: 100% at 13:36, 1h 3m early` or `on pace`. All times of day in the panel (Usage and the Archive dates) are 24-hour `HH:MM`. Needs a subscription with rate-limit readings. |
| Plans (tab) | Plans made with the `plan` tool, each as a track with its state and percent. A plan is saved to the Archive the moment it is done, as its own group; `Clear finished` only clears the done plans from this list (the Archive keeps them; a plan whose archive save failed stays in the list). |
| Agents (Active and Finished tabs) | Running, finished and planned agents, with model, task progress, context, estimated cost and time. A run is linked to its planned task by the mod itself, in this order: its Agent description is the task's title (case and punctuation aside); it begins with the task number (`#3 …`, `[3] …`, `task 3 …`); its description is close to one task's title (one holds the other whole, or at least 60% of the shorter one's words are shared; a tie goes to the worker's own tier, a tie that stays links nothing; only tasks with no run yet); or, as a last guess for a flowdeck worker, exactly one task of the worker's tier had no run when it started. A task gets at most one run by the last two rules; a return round reuses the title or number. A run that matches nothing keeps its own row without a number. A linked row leads with its task number (`3. History module`, the `#3` not repeated) and its model line names what that task waits for after the effort (`Opus 5.5 · medium · after 1, 2`; dropped first when the line is short, never at the cost of the stats). A planned row shows `ready` (blue-violet) once everything it waits for is done, and at once for a task that waits for nothing: those can be started now, in parallel. |
| Archive (tab) | Formerly History. Past flows and finished plans of this project, newest first by when they ended, each flow as a group drawn like the running flow. Everything in the Archive is finished, so a group has no title or status: its fold button is one line, the session's name (when it ended) and how many items it holds in brackets (`▾ Oct 26, 2026 · 10:42 (17)`, or `Oct 25 → Oct 26, 2026 · 10:42 (17)` when it started on an earlier day; a flow saved without runs counts its tasks), with ` · running` added for an entry archived while its flow runs; a narrow panel drops the time of day, then ` · running`. The cost, tokens and time tiles come right under it. The newest group shown is open and the others are folded; pressing a group's fold button opens or folds it, and that choice holds for the session until another volume or `Back to latest` is chosen, which shows the default again. Opened, it shows the flow's agents as they ended in one flat list, newest first, with no `Finished · N` fold (a run still going when the flow was saved is in the same list and reads `Running at finish`), with their chevrons and steps (a chevron folds that group's row only, never the live one); tasks never started are not shown. Flows saved before agents were kept show their task list instead. A finished plan is a group of its own, `▾ Oct 26, 2026 · 10:42 (3)` counting its steps, narrowing the same way; opened, it shows the plan as the Plans section draws it (title, `Done`, percent), with no tiles. The newest 10 groups show; `Show older (N)` reveals 10 more each press. One archive file shows at a time, the latest part (`history.json`) by default, under a `Showing Oct 20 – Oct 26, 2026 · N flows` line. When archive volumes exist, `▸ Older volumes (k files)` lists them newest first (date range, then `N flows · ≈$cost · tokens · time`); choosing one shows only its flows, the same way, with `Back to latest` at the top. Browsing never writes anything; the Archive tab's count stays the whole archive's while a volume is shown. |

The panel always draws: the top buttons, Context, Usage and the tab row draw on their own whatever the flow is doing (so the Archive can be reviewed with no flow running); the selected list, the tab row, each Archive group and each agent row draw in their own guard, and a part that cannot be drawn shows one dim `<part> could not be drawn` line (`Active could not be drawn`); values an older flowdeck left in the session after a reload are read with their missing fields filled in (a panel from before the tabs shows Active). Plans and Archive have no hide toggle any more; their old stored choices (`plansShown`, `historyShown`) are still read but change nothing.

Agent rows: the progress line names the state in its colour, with the live tool word while running (`Running · Bash`), `Needs approval` while a permission dialog for its call is up, then `Done` or `Error`. A run that ended OK but whose `step` list is not all done (e.g. `1/6`) reads `Incomplete` in amber: its bar is filled to its steps (never full), its mark is an amber half ring (`◐` in the terminal) instead of the green tick, and it has no archive icon. Only a run with no step list or with every step done is `Done` with the tick and a full green bar; the same holds in Archive groups, for runs saved before this rule too. Closing the list is the worker's job (its instructions require it); the mod never overrides Incomplete: a run of an accepted task that stays Incomplete reads `Incomplete · accepted`.

Accepted tasks: the flow records which tasks the orchestrator accepted (`done: [numbers]`). An accepted task that no worker run belongs to (the orchestrator did it, or one run covered several tasks) is an `Accepted · no worker run` row at the end of the Finished tab's list (counted in `Finished (n)`): green tick, no step bar, no archive icon; it is no longer planned, and tasks waiting on it become `ready`. An accepted task with a complete run is its normal Done row. A flow or archive entry that only has a count (older callers, flows saved before 1.0.0022) counts its first N tasks as accepted, which is all a count can tell. In an archive group, a run that was still going when its flow was saved reads `Running at finish` (blue-violet), its time stopped at the save. The tier colour stays on the tier name.

- Foldable steps: a worker that sends its plan as the `step` tool's `steps` list (then `next`, `done`, `active`, `failed`) gets a `▸` chevron on its row; open, it lists each step with its state mark, colour and time (planned grey, running blue-violet, done green, error red). The row's `3/6 · step` line counts from the list; open rows are kept for the session only.
- Archiving finished items: while a flow is open, each row in its Finished tab that is Done or Error (not Incomplete, running or planned rows, not in Collapse mode, not inside archive groups) has a small dim archive icon (`⤓`) at the end of its task-name line: right after the task name on both surfaces, away from the row's chevron, which ends that line (on the desktop at its far right). Pressing it moves that row and every older Done or Error row not archived yet into the archive; newer rows stay, and so does an Incomplete row (it is listed and counted in `Finished (n)`, but the Archive collects only finished work). The flow's archive entry is saved at once with only the archived rows, marked partial (its group line ends in ` · running`), and grows with each press under the same id. When the flow finishes, restarts or the session ends, the flow's full entry (all its agents, archived ones included) replaces it. Archived rows leave the live list and the Finished count, and a dim `M archived` line heads the list; the header's cost, tokens and time still count them, and a planned task with an archived run stays started. If the entry cannot be saved anywhere (history.json, its side file or the mod store), the rows stay in the list. Nothing is deleted.

## The band above the prompt
- The flow row (title, track, state, percent, `×N` agents button that opens the panel) plus up to 2 open plan rows (running, needing input or in error), newest first. With no flow, the plan rows show alone.
- ✕ hides the band only; the flow stays in the panel. The `Band` button brings it back, and so does a new flow.
- `Finish` (on the band, between `×N` and ✕) and `Finish flow` (in the panel, next to Collapse) end the open flow as `finished: true` does: it is saved to the archive and shows as Done.
- A new `/flowdeck <task>` while a flow is linked sends `progress` with `restart: true`: the open flow is saved as finished and the new one starts.
- A band that cannot be drawn (a throw, a timeout, a tree the surface refuses) gives way to what other mods draw there and says why, once per reason: a dim transcript line `flowdeck: the band above the prompt could not be drawn: <reason>` (the model does not read it; `claude --debug` logs it too) and a dim `band error: <reason>` line under the panel's Context and Usage buttons, cleared by `/reload-plugins` or a new session. When what is drawn below the band fails, the flow row is drawn without it.
- A mod listed before flowdeck in `enabledPlugins` that draws the band without passing it on hides flowdeck's band completely: flowdeck's hook never runs, so nothing is logged and the `Band` button cannot bring it back. replay-theater does this after every turn in which files were edited (its `▶ Replay: N edits (press r)` line takes the band's place) until the session's process restarts; `/reload-plugins` does not clear it. List flowdeck before such mods (see Install).

## State colours
| State | Colour |
|---|---|
| Running | blue-violet |
| Needs input / Needs approval | amber |
| Done | green |
| Incomplete (ended OK, steps left) | amber |
| Error | red |

## Saved data
The archive and plans are kept per project in `<project>/.claude/flowdeck/` (the session's working folder), so two projects never overwrite each other. The folder holds its own `.gitignore` (`*`), so nothing in it is committed; the project's own files are never touched. Nothing in it is ever deleted or truncated. All sizes are UTF-8 bytes (the engine reads and writes at most 4 MiB, 4,194,304 bytes, a file; Cyrillic takes 2 bytes a character, CJK 3, emoji 4). The archive's files keep their names from when it was called History (`history*.json`), so data saved before the rename loads as it is.

| File | Holds |
|---|---|
| `history.json` | The archive's latest part: this project's newest flows, newest first, with their agent runs as they ended (up to 60 runs per flow, 12 steps per run, titles and texts cut at 200 characters, 100 tasks). A flow is saved when it finishes, when a new flow replaces it, and as open when the session ends with it running. It stays under 2,500,000 bytes. |
| `history-<n>.json` | Archive volumes, `n` = 1, 2, 3 … in the order they were made (higher = newer flows). When a save takes `history.json` over the limit, its oldest flows move to a new volume and the newest flows up to half the limit stay; a volume also stays under the limit (a bigger overflow fills several). Volumes are written once and never changed. |
| `history-index.json` | The volume index, one summary per volume: file, count, first start, last end, cost, tokens, time, size in bytes, and each flow's start and end (`flows`); and which side files were merged into `history.json`. |
| `history-extra-<startedAt>.json` | One side file per flow, holding that flow alone: every save writes it first, before anything else (`-2`, `-3` … when the name holds another flow; a re-save of the same flow rewrites only its own file). |
| `plans.json` | Task plans per session, every session kept (none is dropped for age); a resumed session gets its plans back. Up to 3 plans are kept per session. |
| `plans-extra-<session id>.json` | This session's plans when `plans.json` cannot take them; from then on the session writes only this file, and a resumed session loads it first. |

- Save order: (1) the flow's own side file; (2) the folder is read again and merged: `history.json`, every side file whose flow `history.json` does not hold as finished and no volume holds, and this project's entries in the mod store; (3) over the limit, the new volume(s), then the index; (4) `history.json`; (5) the index marks the side files merged. A crash after (1) leaves the flow in its side file, read back by the next load; after (3) it leaves copies, never a gap; copies are hidden and cleaned out of `history.json` by the next rotation.
- Two sessions saving at once: the later write of `history.json` or the index may lack the other session's flow, but that flow's side file is read back on the next load and merged into the next save. Sessions at once can duplicate or delay a flow, never lose it. The index's merged list is not trusted on its own for this.
- A file that exists but cannot be read or parsed is never written over, and neither is one whose existence cannot be told (its stat, the folder listing and `exists` all fail); only a file known to be missing is created. While `history.json` cannot be read, the Archive section says `history.json could not be read; showing recovered entries (the file is untouched)` above the groups and shows the side files and store entries; new flows go to their side files and the mod store. An index that cannot be read stops rotation (history.json then grows past its limit, up to 3,900,000 bytes); a `plans.json` that cannot be used sends this session's plans to its side file.
- No write over 3,900,000 bytes is ever sent: such a write counts as failed, and the flow stays in its side file and the mod store.
- What a volume holds as it is or newer is not shown again in the latest view, whatever the size of `history.json`; a flow saved again after it went into a volume shows its newer snapshot.
- Mod store: with no working folder, or when the project files cannot take a save, that save goes to the mod store (keys `history`, `plans`) as before, so nothing is lost. This project's entries in the store key `history` are shown in the latest view and merged into `history.json` with the next save that works (their place in time kept); the store itself is never changed by that. Plans are not imported from the store.
- Mod store keys still in use: `contextShown`, `usageShown`, `usageRemaining`, `plansShown`, `historyShown` (the Context and Usage toggles and the Usage reset switch; `plansShown` and `historyShown`, the old Plans and Archive toggles, are still read but no longer used since the tabs).
- `FLOWDECK_ARCHIVE_VOLUME_MAX` (or its old name `FLOWDECK_HISTORY_SEGMENT_MAX`; the new one wins when both are set) can only lower the 2,500,000-byte limit of one archive file.

## Install on a new machine
Everything needed is in this repo: it is its own marketplace (`.claude-plugin/marketplace.json`, name `flowdeck-mod`, plugin `flowdeck` at `./`).

### Prerequisites
- Claude Code with mods and the `claude plugin` commands (`claude plugin --help` lists `marketplace`, `install`, `test`, `validate`). Built and tested with 2.1.312 (`claude --version`).
- git, and SSH access to `git.paavu.com` for the SSH clone (the HTTPS form asks for a Gitea login: the repo is private).
- `flowdeck-fable` runs on the Fable model; without access to it, change `model:` in `agents/flowdeck-fable.md`.

### Conflicts
flowdeck replaces savvy-flow, savvy-progress, context-bar, plan-progress and flightdeck. They share its tool names (`progress`, `step`, `plan`), pane ids and commands: disable or uninstall them first (`claude plugin disable <name>@<marketplace>`, or `/plugin` in a session).

### Install (from a local clone; recommended)
```
git clone gitea@git.paavu.com:paavu/flowdeck-mod.git ~/flowdeck-mod
#   or: git clone https://git.paavu.com/paavu/flowdeck-mod.git ~/flowdeck-mod
claude plugin validate ~/flowdeck-mod                  # ✔ Validation passed
claude plugin marketplace add ~/flowdeck-mod           # adds marketplace "flowdeck-mod" (user settings)
claude plugin install flowdeck@flowdeck-mod            # installs and enables it (scope: user)
claude plugin list                                     # flowdeck@flowdeck-mod, Version: <plugin.json version>, Read from: ~/flowdeck-mod
```
A marketplace added from a folder is read in place: Claude Code loads flowdeck straight from the clone, nothing is copied.

Optionally set the panel language (`auto`, `en`, `ru`; default `auto`): `claude plugin configure flowdeck@flowdeck-mod`, or `/plugin configure flowdeck@flowdeck-mod` in a session.

Then fix the load order in `~/.claude/settings.json`: mods nest in the order of `enabledPlugins`, the first outermost. `install` appends `"flowdeck@flowdeck-mod": true` at the end; move that line above other mods that draw above the prompt (next-steps and the like), or they squeeze the band, and above replay-theater, which otherwise takes the band's place after any turn that edited files. Then start a new session or run `/reload-plugins`, and open the panel with `/flowdeck-agents`.

Installing straight from the git URL (`claude plugin marketplace add gitea@git.paavu.com:paavu/flowdeck-mod.git`) should work the same way once the marketplace file is on the remote, but it was not tried: the local clone is the tested path.

### Update
```
git -C ~/flowdeck-mod pull
claude plugin marketplace update flowdeck-mod          # re-reads the catalog
claude plugin list                                     # shows the new version
```
then `/reload-plugins` in open sessions (or start new ones). With a folder marketplace, `claude plugin update flowdeck@flowdeck-mod` only says the plugin is read from its folder: the pull is the update. The running version is the `version` in `.claude-plugin/plugin.json`, as `claude plugin list` shows it; `CHANGELOG.md` lists what each version changed.

### Run the tests
```
claude plugin test ~/flowdeck-mod                      # the whole suite: every test passes
claude plugin validate ~/flowdeck-mod
```
(`claude plugin test` takes the plugin's folder.)

### Roll back, uninstall
- Roll back: `git -C ~/flowdeck-mod checkout v1.0.0021` (a release tag; from 1.0.0021 on each release is tagged `v<version>`; any commit from `git log` works too), then `/reload-plugins`. Back to the newest: `git -C ~/flowdeck-mod checkout main && git -C ~/flowdeck-mod pull`.
- Uninstall: `claude plugin uninstall flowdeck@flowdeck-mod`, then `claude plugin marketplace remove flowdeck-mod`. The clone and the saved data stay where they are; move them to the Trash yourself if you want them gone.

### What it keeps, and the defaults
- Per project: `<project>/.claude/flowdeck/` (archive and plans, see Saved data), with its own `.gitignore` (`*`), so nothing there is committed.
- Global mod store keys: `contextShown`, `usageShown`, `usageRemaining`, `plansShown`, `historyShown` (and `history`/`plans` only as a fallback when a project folder cannot be written).
- Defaults: all times are 24-hour `HH:MM`; the usage reset shows the time left (`Resets in 2d 13h 20m`) until `◷` switches it to the exact time, and that choice holds for all projects (`usageRemaining`); Context and Usage shown, Archive shown.

## Known limits
- Terminal text is English only.
- plan-progress's hover and clock overlays are not ported.
- No sounds.
- No edit gate: work is never blocked for lack of a plan.
- A worker still running when its flow is saved is kept as `Running at finish`; what it spends after that is not recorded in the flow.
- A flow is known by its start time in the project folder: two flows started in the same millisecond there count as one.
- `history-index.json` grows by about 70 bytes per flow (its side file's name, its start and end once in a volume); it is never rotated.
- While `history.json` cannot be read, or its index stops rotation and it reaches 3,900,000 bytes, new flows are kept only in their side files and the mod store (itself limited to 4 MiB in all).
- A button can ignore a click while workers run: the desktop app keeps a button's old handle until the next redraw and refuses a press on it; the panel redraws every 5 seconds while agents run, so elapsed times also advance in 5-second steps. After `/reload-plugins` the engine refuses every press on a button drawn before the reload until the desktop app draws the panel again; such a press never reaches the mod (the desktop app's log says `ui_press not handled`).
- A flow saved again while another session's save of the same folder runs can be overwritten in `history.json` by its earlier finished snapshot, or stay hidden as held by a volume; the newer snapshot stays in its side file, and the panel shows the earlier one.

Built from savvy-flow/savvy-progress, context-bar and plan-progress; see NOTICE.md.
