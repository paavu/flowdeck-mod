# Changelog

Versions are `M.m.xxxx`; every build bumps the 4-digit build number. Details and rulings: `docs/ledger.md`, `docs/design.md`.

## 1.0.0069 (2026-11-03)
- The plan reminder repeats: with task tracking on and no flow open, the main session's 1st work call of a turn and then every 3rd (1, 4, 7, ...) gets the line (`PLAN_NUDGE_EVERY` in `hooks/nudge.ts`). The count starts over at a new turn, at any `progress` call and while a flow is open. The line no longer excuses multi-file edits, scripted rewrites, builds, renders, trials or bumps; only a pure question or a single edit to one file needs no flow.
- Turn-end check: a main turn that made 2 or more work calls with tracking on and no flow open is sent back once (`PLAN_SEND_BACK`), telling Claude to open a flow with the tasks it carried out, mark them done and give a result note for each. Never for a worker, never with tracking off.
- Untracked-work log: each such main turn (1 or more work calls) adds `{day, time, calls, tools, sentBack}` to `.claude/flowdeck/untracked-work.json` (time in 24-hour `HH:MM`, the newest 200 kept, the file rewritten in place). Under the tab row the panel shows a muted `N turns without a flow today`; nothing at zero.
- The reminder and the send-back follow the stored tracking choice (`/flowdeck-rule` and the `Track tasks` switch), no longer a session that ran `/flowdeck:flowdeck`, so they stop at once when tracking is off.
- The flow rule says "No flow only for a pure question or a single edit to one file".
- README: the demo clip is a 38-second tour of the progress bar, one task's steps, the tabs, the warm cache and handoff notes.

## 1.0.0068 (2026-11-02)
- The Finished tab keeps the whole day: the rows of every flow finished today stay in it as one list, with the current flow's rows, and `Finished (n)` counts all of them. They leave it at the date change.
- The band's `Tasks X/Y`, bar and percent count that same list, so Y is Active plus Finished until the rows go to the Archive.
- At the date change, the flows of each past day are merged into one Archive session named after the date (`Nov 2, 2026`); a day with a single flow keeps that flow's own title. Today's flows are not listed in the Archive meanwhile. The merge writes the day's session first, then marks the flows it holds (their files stay in `archive/`, hidden). Archive records from before this version are not touched.

## 1.0.0067 (2026-11-02)
- FlowDeck keeps its data only in the project root's `.claude/flowdeck`. After a reload the mod finds the root from the session's transcript file, so a working folder that moved into a child folder no longer gets a `.claude/flowdeck` of its own, and the Archive no longer shows only part of the records.
- The folder remembered per session (store key `projectOf`) is gone; nothing about folders is stored any more.

## 1.0.0066 (2026-11-02)
- The band's progress bar fills the row up to the cache card, so the percent label ends about 3 px before it and the large empty gap is gone (desktop; the terminal band is unchanged).
- The cache card and the agents card are sized from their content with equal padding at both ends, with a one-cell (9 px) gap between them.
- Inside the cards, the minutes left and the chevron, the chevron and the worker icon (plus the cards' 9 px gap), and the icon and the `×N` count are now as far apart as the WARM/COLD chip and its text (7 px). The chevron and the count sit one cell over the drawing before them, since the desktop's own Button padding (about 11 px) is wider than the gap, and the minutes text is measured with the desktop's font widths.
- The data folder is Claude Code's project folder, so a session working in a child folder, or one resumed after a restart from another folder, keeps using the project's archive. The folder is remembered per session.

## 1.0.0065 (2026-11-02)
- Task tracking is on by default for every install. Opt out with `/flowdeck-rule off` or the `● Track tasks` switch. The first-run question (`Track every task in flowdeck?` with `Not now`) is gone, and an install that stored `unset` in an older release now tracks. The strip shows only while tracking is off.
- Turning tracking on reaches the running session at once: the plan reminder carries the full flow rule until a prompt compose has put it in the system prompt. Turning it off applies at the next compose, and the reminder stops at once.
- The band's cache block (chip, minutes left, chevron) and agents block (worker icon and `×N`) sit on cards, the gaps are tighter and the close `✕` is at the right edge (desktop; the terminal band is unchanged).

## 1.0.0064 (2026-11-02)
- Task tracking is now checked, not only requested. With tracking on and no flow open, the main session's first work call of a turn (edit, write, shell, worker launch) gets one line in its result telling Claude to plan a multi-step task with `progress` first (`PLAN_NUDGE` in `hooks/nudge.ts`). It came at most once a turn (since 1.0.0069 it repeats every third work call), stops once a flow is open, never reaches a worker and never blocks a call.
- The flow rule gains one sentence: plan with `progress` before a multi-step task's first edit, build or Agent call; a trial counts. Seen in a real session: a Kotlin bump and build ran inline although tracking was on, because the rule's "one-step edit" exception was the only guidance.

## 1.0.0063 (2026-10-31)
- Keep warm renews up to 8 times between two of your messages (was 2), so an idle session stays warm for about 7 h 40 min instead of 2 h 40 min. Eight renewals of a 770k-token Opus context cost about $1.20, against about $6.16 to write the cache again; renewals still count against the plan's usage limits. After the eighth the card says `kept warm ×8 · limit reached`. The cold-cache screenshot is redrawn to match.

## 1.0.0062 (2026-10-31)
- README: a framed screen recording (sample data) sits at the top, as a GIF with a link to the full-resolution MP4 in `docs/media/`. Since 1.0.0069 the clip is a 38-second tour of the progress bar, one task's steps, the tabs, the warm cache and handoff notes.

## 1.0.0061 (2026-10-31)
- README: the "How it works" diagram is now a vertical image with larger text (light and dark), drawn by `scripts/diagrams/how-it-works.py`, instead of a small left-to-right Mermaid chart.

## 1.0.0060 (2026-10-31)
- The selected tab is marked in its label (`● Active (3)`), so the desktop shows it too; the terminal keeps the bold, accent and underline as well.
- The Keep warm dot is drawn apart from its button, in the cache's colour while on (warm, cold, or the plain text colour before any request) and a hollow grey ring when off: a tiny drawing on the desktop, a coloured `Text` in the terminal. The button's label is `Keep warm`.
- GitHub issue forms (bug report, feature request), a contact link for security reports and a pull request checklist in `.github/`.

## 1.0.0059 (2026-10-31)
- README: the bold top line now names the category: "A Claude mod for Claude Code: orchestrate the work, keep the record."

## 1.0.0058 (2026-10-31)
- README: a `/reload-plugins` typed while a turn is still running is queued and runs only when that turn ends, so the old code keeps showing until then (Troubleshooting and Install). The code is unchanged; every version from 1.0.0051 on loads in Claude Code 2.1.309, 2.1.312 and 2.1.316.

## 1.0.0057 (2026-10-31)
- The panel tab's title reads `FlowDeck` (it read `flowdeck`).

## 1.0.0056 (2026-10-31)
- Handoff-note brief filter: the tool-specific `Use <named tool>` rule is now a generic one (a sentence starting `Use … tools`), plus `Before your final report…`; no private tool names remain in code, tests or docs. SECURITY.md points to private vulnerability reporting. "Claude mod" wording made consistent in the README intro, plugin and marketplace descriptions, CONTRIBUTING and SECURITY.

## 1.0.0055 (2026-10-31)
- The worker sprite is now an original pixel "card buddy" (a violet card with eyes and a smile, a green card behind it, a hat in the tier colour) in place of the old sprite: on agent rows, planned and accepted rows and the band's crew icon. It steps, waves and bobs while a worker runs and rests still, both legs level, on idle, queued and finished rows; the reduced-motion setting keeps the rest pose. The sprite's markup is under 1 KB per row. Screenshots regenerated; NOTICE no longer credits a sprite source.

## 1.0.0054 (2026-10-31)
- README: every screenshot regenerated for the current panel; a new `note-view` image (one task row with its handoff note open) and a short handoff-note block in The idea. No change to the mod's behaviour.

## 1.0.0053 (2026-10-31)
- The version label at the right of the panel's top row uses the same small size as the `Resets in` text (11, `SMALL_SIZE`). On the desktop it is a small right-aligned drawing (muted colour, tabular numerals); the terminal keeps its dim text.

## 1.0.0052 (2026-10-31)
- README: a new top (centred logo, tagline, badges and links, The problem, The idea, Install, Your first two minutes) with Requirements and Known limits moved near the end; a new logo (`docs/images/logo.svg`, `logo.png`) and plugin icon. `scripts/check-readme.sh` also checks that every in-page README link resolves to a heading. No change to the mod's behaviour.

## 1.0.0051 (2026-10-31)
- Context and Usage type: the Context title reads `Context`; `Current session` and `This week` use the same size and weight as it (12, semibold), and the reset text and the `% left` figures the same small size as the Context head figures (11). The sizes are shared constants in `hooks/sizes.ts`. On the desktop the Usage titles and reset lines are now drawn (one header drawing per window, the reset switch beside it) so their size can match.

## 1.0.0050 (2026-10-31)
- The `Track tasks` switch moved from the panel's top row to a new `FlowDeck` title row above the tabs (title, then the button beside it). Same key, label, press and stored choice. README, design notes and the panel screenshots follow.

## 1.0.0049 (2026-10-31)
- README: a features-at-a-glance table, and one section per feature with an annotated screenshot (numbered callouts), a numbered "What you see" legend and a short "How to use". The screenshot pipeline draws the callouts from data (`scripts/screenshots/callouts.tsv`) and renders the new images (band, context, usage, cache card, keep warm states, top-row switches, flow row, handoff note, Empty Trash confirmation, task tracking strip). `scripts/check-readme.sh` checks that every README image exists and has alt text, and that each legend matches the callout data. No change to the mod's behaviour.

## 1.0.0048 (2026-10-31)
- Desktop panel no longer freezes or reopens blank with a big flow: the panel's tree for a 19-task flow had grown to about 270,000 characters (each row's drawing about 12,000), past what the desktop app takes, so it kept the old panel (presses answered `ui_press not handled`) and a reopened panel stayed blank. Each sprite is now drawn as a few paths (a row's run of one colour as one shape) and its motion CSS goes only into drawings where a worker runs: the same pixels, and a row's drawing is about 2,500 characters, so the same flow draws in about 80,000. A desktop tab still past 200,000 characters draws its text rows, with a dim line saying so, instead of a panel the app will not show.

## 1.0.0047 (2026-10-31)
- Step reporting that workers follow: the Progress reporting paragraph of all five worker agents is now a numbered procedure (plan once, do step 1, call `step` with `next: true` as soon as it is finished, only then start step 2) with an explicit "never batch" rule, and SKILL.md has every brief start with the line "Update your step list after each finished step, before starting the next." (the mod leaves that line out of the handoff-note brief). `scripts/check-rules.sh` checks the wording in SKILL.md and in each agent file.
- Step nudge (`hooks/nudge.ts`): a worker whose step list has an active step and that makes 8 tool calls without a `step` call gets one line added to that call's result (the `context` a `tool.call` result carries, which the model reads and the user does not): "update your step list now"; again only after 8 more calls without a step call. A step call resets the count. Never for the orchestrator, never for a worker without a step list; any error leaves the result as it was.
- Batch-closed steps show `–`: when one `step` call closes two or more steps that had no start time, the mod does not invent times for them; they are marked `batch` and draw `–` instead of `0s` (desktop, terminal and alt text). Steps closed one at a time keep their times.

## 1.0.0046 (2026-10-31)
- Band crew control: the worker icon moved out of the title row's drawing to sit right before the crew button, and the button reads `×N` with N = the workers running now (it used to count every run plus queued tasks). The icon walks while a worker runs and stands still at `×0`. The panel's counts and `Tasks X/Y` are unchanged.

## 1.0.0045 (2026-10-31)
- Archive and Trash: an opened session's content (tiles, task rows, notes and steps) sits one level in under its row, by `GROUP_INDENT` (2 columns, the fold glyph and a space) on the desktop and in the terminal; the drawings are that much narrower so nothing overflows. Folded rows are unchanged.

## 1.0.0044 (2026-10-31)
- Quiet auto-start: with task tracking `unset` or `off`, a flow that starts by itself (from the session's task list or a flowdeck worker) no longer opens the panel; it still shows in Active, Finished and on the band, and `/flowdeck-panel` opens the panel. With tracking `on`, and for a flow started by `/flowdeck:flowdeck`, nothing changes.
- The replies of `/flowdeck-rule on|off|status`, the strip on Active and Finished, and the README now say when a switch applies: when the prompt is next composed (a new session, `/clear` or a compaction); running and queued tasks are not affected.

## 1.0.0043 (2026-10-31)
- The move-to-Trash button on Archive rows is now a text-style trash can instead of `✕`, and the Restore button on Trash rows is `↩` instead of the word, on the desktop and in the terminal. Behaviour and confirmations are unchanged.

## 1.0.0042 (2026-10-31)
- The per-row archive button (`⤓`) is gone from the Finished list, on the desktop and in the terminal. A flow's rows are archived together when the flow closes (at the next session start, or on idle or auto finish); the Archive tab keeps its move-to-Trash and Restore buttons.

## 1.0.0041 (2026-10-31)
- Archive and Trash: an opened session draws its cost, tokens and time as the same three tiles as the Active and Finished tabs (desktop); the folded row and the terminal keep the one dim text line.

## 1.0.0040 (2026-10-31)
- The handoff note button is now `ⓘ` (was `✎`), and an opened note appears directly under the task's title, before the worker line, the progress bar and the steps, on running, queued, Accepted, finished and archived rows, on the desktop and in the terminal.

## 1.0.0039 (2026-10-31)
- Fable approval guard (`hooks/fable-guard.ts`): a `tool.call` hook on the Agent tool holds every Fable launch (`subagent_type` ending in `flowdeck-fable`, or `model: fable`) and asks the user through `$.ui.ask`, showing the task and the start of the brief as the reason. Approve allows that one launch; decline, dismissal, a run with nobody to ask, or a failing guard denies it, with a message telling the orchestrator to keep the task on Opus heavy or report to the user. Other Agent calls are untouched. Always on, no setting.
- SKILL.md (Escalation order) and the flow rule tell the orchestrator to state at the top of the Fable brief which task failed on Opus heavy and why; `scripts/check-rules.sh` checks it.

## 1.0.0038 (2026-10-31)
- Model routing: `flowdeck-light` and `flowdeck-medium` run on Sonnet (low and medium effort); careful and heavy stay on Opus. Queued rows read `Sonnet · low` and `Sonnet · medium` for those tiers.
- The orchestrator can pick a model per task: `progress` `tasks[]` and `add[]` take an optional `model` (`sonnet`, `opus`, `haiku`), kept across restarts and in the archive, shown on the queued row as `<tier> · <Model> · <effort>`.
- Fable is never used automatically: only after the user approves, when a task failed on Opus heavy. SKILL.md gains Model choice and Escalation order; the flow rule gains one sentence; `scripts/check-rules.sh` checks both and the agents' models.

## 1.0.0037 (2026-10-31)
- Task tracking is a choice: the flow rule (`flowdeck:flow-rule`) goes into the system prompt only while tracking is `on`, or in a session that ran `/flowdeck:flowdeck`. A fresh install is `unset` and adds nothing until the user chooses. The choice is one for every project, kept in the mod store under `rule`.
- Migration: when the store has no `rule` yet, an install that ran flowdeck before (its earlier store keys, or `flow-live.json`, `archive-index.json`, `archive/` or `history*.json` in the project's `.claude/flowdeck/`) is saved as `on` and keeps working as before; any other is saved as `unset`.
- The Active and Finished tabs show a strip until tracking is on: `Track every task in flowdeck?` with `Track all tasks` and `Not now`, or `Task tracking is off` with `Track all tasks`, and what tracking does and costs (about 1,760 tokens per session). The top row has a `● Track tasks` / `○ Track tasks` switch after Keep warm.
- Commands: `/flowdeck-rule on | off | status`; the panel command is now `/flowdeck-panel`, and `/flowdeck-agents` still works for this release. The pane id is unchanged, so a placed pane and the held panel state keep working.
- Smaller footprint: the flow rule went from 896 to 476 characters (about 250 to 130 tokens); the `progress` tool schema from 4,689 to 3,246 characters (`/context` 2.3k to 1.6k tokens) and the `step` schema from 1,516 to 1,274 (758 to 638), every field and cap kept. One `progress` call still carries `add`, `done` and `notes` together. SKILL.md (16,828 characters, about 4,670 tokens) now says a question or a one-step edit needs no flow and no longer relies on the injected rule.
- `scripts/check-rules.sh` checks SKILL.md carries every flow rule; a new screenshot shows the strip (`docs/images/panel-tracking-off-*.png`).

## 1.0.0036 (2026-10-31)
- Toggle and collapse icons: every fold chevron is a solid triangle, `▼` open and `▶︎` folded (the folded one carries a text-style selector so it never renders as an emoji), all from `foldGlyph` in hooks/fold.ts, including the cache card's chevron. In the top row Context and Usage use them; Band and Keep warm are dot switches (`●` on or shown, `○` off or hidden) and Keep warm no longer says `(on)` / `(off)`. Behaviour is unchanged.

## 1.0.0035 (2026-10-31)
- Plans removed: the flow's task list (Active, Finished, Archive, Trash) is the only task list. The `mcp__flowdeck__plan` tool, the Plans tab and its `Clear finished`, the plan rows in the band, the `flowdeck:plan-rule` prompt section and the plan-mode (`ExitPlanMode`) and question (`AskUserQuestion`) hooks are gone; the tab row reads `Active`, `Finished`, `Archive`, `Trash`.
- An existing `.claude/flowdeck/plans.json` or `plans-extra-<session>.json`, and plans kept in the mod store, are no longer read or written and are never deleted; done plans other sessions left are no longer archived at the start. Plans an older version saved to the Archive still show there, drawn as before.
- A panel held from an older version with the Plans tab selected opens on Active; its `isPlansShown` field is dropped.
- SKILL.md no longer points to the plan tool; README, the design notes and the screenshots follow.

## 1.0.0034 (2026-10-31)
- Public release on GitHub (https://github.com/paavu/flowdeck-mod) under the MIT license: LICENSE, SECURITY.md, CONTRIBUTING.md and a `.gitignore`; NOTICE.md lists each source mod's license and adds Cache Bell (keep warm's renewal method).
- README.md rewritten for new users: requirements (Claude Code 2.1.295 or later), install from GitHub, update, uninstall, every feature, configuration and data, privacy (what the mod reads, writes and runs), known limits, troubleshooting, development.
- Screenshots in `docs/images/`, light and dark, rendered from the mod's own drawings with sample data by `scripts/screenshots.sh`.
- `plugin.json` and `marketplace.json` carry the author, homepage, repository, license, keywords, an icon (`.claude-plugin/icon.png`) and the directory listing links. No change to the mod's behaviour.
- Design notes, build ledger and first plan in `docs/` marked as history, with private paths and other private references taken out; test data paths made generic.

## 1.0.0033 (2026-10-31)
- Handoff notes on every task row: up to four plain-text parts, `Goal` (300 characters), `Brief` (about 600), `Result` (300) and `Feedback` (300), cleaned and capped by the mod. The orchestrator sends `goal` with each task in `progress` `tasks` and `add`, and `result` and `feedback` through the new `notes: [{task, goal?, result?, feedback?}]` with the `done` that accepts the task; `notes` updates any task by number at any time (a part sent again replaces it, `""` clears it); unknown numbers are ignored with a reply line, and a finished flow takes no notes.
- The brief is taken by the mod from the worker's Agent `prompt` when it starts (`agent.spawn`'s `prompt`): headings, code fences, blank runs and the standard preamble (the step-list closing line, `Repo:`, `Read README…`, `Use … tools`, no-delete, no-commit, comments and 24-hour sentences) left out, the start of the real task kept, `…` when cut. A return round replaces it until the task is accepted; without a prompt the description stands in when it says more than the title; a run linked to no task keeps its own brief.
- A small dim `✎` right after the name on every row with a note (queued, running, finished, Accepted, and in Archive groups) opens the note under the row: dim labels, the text wrapped to the panel's width; the open state survives `/reload-plugins`, Archive rows keep their own. On the desktop a queued or Accepted row with a note draws its title natively beside the `✎`, over a shorter drawing; rows without notes are unchanged.
- Notes are saved with the flow's tasks in the session file (a run's own brief with the run) and read back from the Archive; older flows and sessions read as no note. The archive index holds no notes.
- The flow rule, the `progress` tool's description and schema, SKILL.md and README say when to send each part.
- The `Keep warm` button's label says its state: `▾ Keep warm (on)` / `▸ Keep warm (off)`; the top row still never wraps.

## 1.0.0032 (2026-10-31)
- The prompt-cache card is shorter: on a wide band (up to 760 px) it draws two columns of about three rows instead of eight stacked ones. Left: the chip with the idle time and the tokens, the TTL line with the hour's bar, keep warm's state with `renewal ≈ … · cold ≈ …` on the same line. Right, past a faint divider: the caption with a dim `prices are estimates` at its end, then the four models side by side (name above price, `YOU` on the session's model). About 82 px high (98-100 px when a line has to drop to a fourth row), down from about 210 px.
- Every text is measured: a line that does not fit moves to a fourth row (the costs below keep warm's state, the footer below the models), and a band too narrow for two columns (below 520 px, or where the texts need more room) stacks the card in one column with every line wrapped to the width, four models a row (two, or one, when four do not fit). Nothing overlaps or leaves the card at any width.
- The terminal card is three lines: `idle … · … tokens cached · <TTL>`, `keep warm: … · renewal ≈ … · cold ≈ …`, and `<caption>: Fable $… · Opus $… · …` with ` · prices are estimates` after it when the row has the columns (else on a fourth line). The chip, the band row and the chevron are unchanged.

## 1.0.0031 (2026-10-30)
- `Empty Trash (n)` at the top of the Trash tab, shown only while the Trash holds sessions (never on the Archive tab). It asks first: `Erase n sessions for good? This cannot be undone.` with `Erase` / `Cancel` in its place (held through redraws; Cancel or switching tab closes it).
- `Erase` permanently erases every trashed session everywhere (no Mac Trash, no undo): its original in `archive/` and its copies in `.trash/`, then writes `.trash/trash-index.json` empty. The one place flowdeck erases a file, a deliberate one-off exception for this button. Restore still moves a session back; Empty Trash erases for good. Nothing was erased before.
- A session back in the Archive whose restored copy is still in `.trash/` loses only that copy; its archive file stays. A file of a session the Archive lists is never erased.
- Each file is erased only when its name is the one the store gives its own session in that folder, it lies directly in the resolved `.trash/` or `archive/` folder and is a plain file (no link): `unlink <file>` on macOS and Linux, PowerShell `Remove-Item -LiteralPath` on Windows, one file at a time, no shell, no wildcards, no recursion, through the archive's queue so it never races a save, move or restore. A file already gone counts as erased. A session that cannot be erased whole stays in the Trash (an original that fails leaves its copies as they are) and the tab says `n sessions erased, m failed`; pressing again retries it. `archive-index.json`, `.trash/damaged/`, plans and `flow-live.json` are never touched; an erased session's small record stays in `archive-index.json`, hidden.

## 1.0.0030 (2026-10-30)
- Keep warm: an idle session's prompt cache is renewed before it goes cold, by one side request over the main thread's transcript (`$.model.fork`, Claude Code 2.1.288 or later; Cache Bell's renewal method, built in) that adds nothing to the transcript. It renews at minute 50 of the cache's hour (`RENEW_AT_MS`), only for a context of at least 80,000 tokens (`KEEP_WARM_MIN_TOKENS`), while no main turn runs, at most twice between two of the user's messages (`KEEP_WARM_MAX_RENEWALS`); only the user's own message starts the count again. Never while cold (a machine that slept past the hour, a resume after it), never in the hour's last minute, never twice in a minute, never after the session ended. A failure backs off 2 minutes and stops after the second in an idle period (`KEEP_WARM_MAX_FAILURES`); it never shows as an error.
- `Keep warm` in the panel's top row, after `Band`, in its style (`▾` on, `▸` off): on by default, saved per project (mod store key `keepWarm`). A panel held by an older version reads as on.
- The cache card: a keep warm line (`keep warm: renews at 14:32`, `kept warm ×1 · renews at 15:22`, `kept warm ×2 · limit reached`, `keep warm: failed`, `keep warm: off`, …) and what a renewal costs beside a cold restart (`renewal ≈ $0.15 · cold ≈ $6.16`). The band row and the chip keep their width; after a renewal the chip counts the hour from it, while the card's idle time stays since the main thread's last request. Renewals count against plan usage limits like any request.

## 1.0.0029 (2026-10-30)
- No more `Collapse` / `Expand` in the panel: the Active and Finished lists always show in full. A panel held collapsed by an older version reads as a full one. The per-row fold chevrons stay.
- The band's prompt cache: the `Show` / `Hide` button is gone; a small dim chevron right after the `WARM` / `COLD` chip (`▸` / `▾`) opens or folds the card, on the desktop and in the terminal. The chip looks as before (the kit cannot make an Svg or coloured text pressable, so the chevron is the press).
- The band's title says where the flow is, never the flow's own title (named after the first request, it says little about the session): the running task's title (the lowest-numbered one and ` +N` when several run), else the next ready task, else `FlowDeck` (every task done, or no title at all). Same ink as before, up to 40% of the desktop row with `…`. The panel's flow header shows only the cost, tokens and time: no flow title in the Active or Finished tab. Archive session names are unchanged.
- The `Band` button moved from the tab row to the top row, beside Context and Usage, in their style (plain, not dim); that row stays on one line. The tab row holds only the five tabs, two spaces apart (2 columns in the terminal; on the desktop the native buttons' own padding, no gap added).
- A running worker's row names its active step: 5 of 7 steps done with the 6th active reads `6/7`, not `5/7`. Ended runs keep the done count (`7/7`; an Incomplete run its real count); the bar stays the done fraction.
- The band's `Tasks X/Y` says where the flow is: while a task runs, X is the running task's number (done + 1, at most Y), so the first task running reads `1/2`; with nothing running, the done count. The bar, percent and colour are unchanged.

## 1.0.0028 (2026-10-30)
- No more Finish buttons: the band's `Finish` and the panel's `Finish flow` are gone. A flow finishes by itself when the main turn ends with every task done (a complete run, completed in the task list, or accepted; Incomplete and failed runs do not count) and no worker run going; a flow with nothing running or queued finishes itself after 30 minutes idle, dated by its last activity. A finished flow is archived at once and stays in the Finished tab and on the band (Done) until the next task starts a new flow. `finished: true` and `restart: true` still work; a late `done` or phase on a finished flow changes nothing.
- Every task goes through flowdeck: a task list (TodoWrite, TaskCreate) with an open item, or a flowdeck worker launched, with no open flow starts one by itself (named after the first item or the worker's description), its items mirrored as tasks; a later plan joins it. A new system-prompt rule, `flowdeck:flow-rule`, tells the model so in every session; SKILL.md, the five worker files and README say the same. The mod needs no CLAUDE.md, memory or setting for any of it.
- The flow survives a restart: `.claude/flowdeck/flow-live.json` keeps each session's shown flow (runs, accepted tasks, record start, last activity, a once-a-minute heartbeat, the session's end). The next session restores its own record (same session id or transcript; runs that were going read `Running at finish`), and closes another session's record once that session ended or went quiet for 3 minutes: finished at its last activity, its running runs ended then, saved as an Archive session under its own id, then taken out of the file. `/clear`, `/resume` and a fork close the flow the panel held. A file that cannot be read or holds no flowdeck state is never written over and is said once. Done plans other sessions left are archived at the start.
- The panel's top row ends with a dim `v1.0.0028`, the version of the code running (hooks/version.ts); the `band error` line and the band's transcript line name it too. `tests/version.test.tsx` holds hooks/version.ts to plugin.json; `scripts/check-version.sh` adds CHANGELOG.md.
- Desktop agent rows: the task name starts at the drawing's text column again, flush with the model line, with the chevron at the far left. 1.0.0025 sized the chevron's slot with a Box `width` of 18, which counts character cells, not pixels, and pushed every name about 160 px in.

## 1.0.0027 (2026-10-30)
- The band shows the prompt cache: a `WARM` chip (red) for an hour after the main thread's last request, with the minutes left (`42m left`, `<1m left`, never hours), then a `COLD` chip (blue) with the idle time and the next message's cost on the session's model (`12h 45m · $4.78`). It sits on the flow row between the progress and the buttons, desktop and terminal, and shows on its own when there is no flow, once the session has made a request. Subagent requests do not count.
- `Show` / `Hide` at the end of the chip opens a card below the row: idle time, tokens in the cache, `cold in 12m` (or `cold for …`), the next message's cost on each model with the session's model marked `YOU`, and `prices are estimates`. Warm starts folded, cold starts open; a choice holds until the cache flips. The terminal shows the same facts as four lines.
- `/clear` and `/compact` drop the cache facts until the next request; a resumed or forked session starts from how long ago its last response was and how big it was. The facts are held per session and survive `/reload-plugins`; nothing is written to project files.
- Prices are estimates, in one table (`MODELS` in hooks/cache.ts). Idea and cost method from ribbon (MIT, see NOTICE.md).
- The orchestrator's rule, in SKILL.md and the `progress` tool: tasks that edit the same files are chained with `after` and never run in parallel; every waiting task gets its `after`, independent ones none.

## 1.0.0026 (2026-10-30)
- The band's `Tasks X/Y`, bar and percent count the rows the tabs count, on the desktop and in the terminal: Y = Active rows + Finished rows (+ archived runs), X = the complete finished rows (Done runs and `Accepted · no worker run` rows; Incomplete and Error rows are not). A run linked to no task counts as its own row. A flow with no rows keeps the orchestrator's total and accepted count. One function (`flowProgress`) feeds the band and the tab counts.
- The terminal band draws its text row again: the terminal's kit has an `Svg` too (drawn as an empty box), so the flow row had shown only its buttons there.
- Every agent row has its fold chevron in the slot before its name, running rows without a step list included; it is dim on a row with no step list, and opening such a row shows its model and effort, start time (`HH:MM`), tokens and cost, then a dim `No steps reported yet`.
- Every done or failed step shows a time. A step's first move to done or failed dates it (an existing end is never overwritten; a resent list keeps the start); a step without a start begins where the nearest earlier step ended, else at the run's start; one without an end (saved without a clock, or by an older version) ends where the next step started, else when the run ended. Batch-closed steps may read `0s`.

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
