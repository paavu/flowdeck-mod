# flowdeck Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the personal mod `flowdeck`: savvy-flow + savvy-progress with a context section and button in the agents panel, a `/flowdeck` skill that adopts and keeps linking the session's tasks, and `/flowdeck-agents` to toggle the panel.

**Architecture:** Copy savvy-progress's single `hooks/register.tsx` and rename everything `savvy-*` to `flowdeck-*`. Add `hooks/context.ts` (pure functions from context-bar: reading, bar cells, legend, SVG and text rendering). Add a context section and button to the panel, a `session.compact`/`turn.complete` refresh, and a `link` mode in the flow state. Copy savvy-flow's skill and five agents with the same rename.

**Tech Stack:** Claude Code mod API (`claude-code`, TSX hook modules, `claude-code/testing`), Markdown skill and agents. Run tests with `claude plugin test`.

**Spec:** `docs/design.md` (same folder).

## Global Constraints

- Location: `/Users/user/www/paavu/claude/server-setup/claude-mods/flowdeck/`, listed in `claude-mods/.claude-plugin/marketplace.json` (marketplace `coooloz-mods`), row added to `claude-mods/README.md`.
- Commands exactly `/flowdeck` (skill, `argument-hint: [task]`) and `/flowdeck-agents` (command). No `/context-bar`, no `/agents-info`, never `/context`.
- Tools `mcp__flowdeck__progress` and `mcp__flowdeck__step`; pane id `flowdeck-agents`, pane title `flowdeck` (shown on the side panel's tab, in every language); atom plugin key `flowdeck`; store key `contextShown` (global, default shown).
- Agents renamed `flowdeck-fable|heavy|careful|medium|light` with unchanged models and efforts.
- No context bar above the prompt. The savvy-progress bar above the prompt stays, with its crew-size button.
- Context data only from `$.session.usage({breakdown:'summary'})`; refresh on `session.start`, `turn.complete` (ignore subagent turns: `e.agentId` set) and `session.compact`.
- Keep MIT notices for johnnyvizz (savvy) and Hamza Zafar (context-bar) in `NOTICE.md`.
- Commit messages are plain: no AI-attribution trailer or footer.
- Never delete files: unneeded files go to the Trash with `trash`.
- The three originals (savvy-flow, savvy-progress, context-bar) must be disabled before flowdeck is enabled.

## Review Focus

1. Context data not there yet (before the first turn) or `rawMaxTokens` 0: the section shows "no context data yet", no crash.
2. Narrow pane (bodyColumns under 20): no bar drawn, no crash.
3. `/flowdeck-agents` while a savvy original is still enabled: command registration is refused and the mod still starts.
4. Store read or write failing: toggle still works in memory, defaults to shown.
5. Linked session: a task added after the first plan appears in the panel and the `total` grows; an accepted task is never removed; a re-plan keeps accepted tasks.

---

### Task 1: Skeleton, rename and notices

**Files:**
- Create: `flowdeck/.claude-plugin/plugin.json`, `flowdeck/hooks/hooks.json`, `flowdeck/hooks/register.tsx` (copy of `~/.claude/plugins/cache/claude-kit/savvy-progress/1.2.0/hooks/register.tsx`), `flowdeck/types/index.d.ts` (copy, state key `'flowdeck'`), `flowdeck/tsconfig.json`, `flowdeck/agents/flowdeck-{fable,heavy,careful,medium,light}.md`, `flowdeck/skills/flowdeck/SKILL.md`, `flowdeck/NOTICE.md`, `flowdeck/README.md` (what flowdeck is, the two commands, how the flow works, the five tiers and their models, requirements: a Claude Code version with mods, access to the model in `flowdeck-fable.md` or change its `model:`; install from the marketplace on a fresh machine, uninstall of the three originals)
- Modify: `claude-mods/.claude-plugin/marketplace.json`, `claude-mods/README.md`
- Test: `flowdeck/tests/rename.test.tsx`

**Interfaces:**
- Produces: tools `mcp__flowdeck__progress` / `mcp__flowdeck__step`, pane id `flowdeck-agents`, `command flowdeck-agents`, worker type prefix `flowdeck-`.

- [ ] **Step 1: Write the failing test** in `tests/rename.test.tsx`: a `flowdeck-light` Agent spawn is tracked as a worker (appears in the agents state), a `savvy-light` spawn is not; calling the `progress` tool with `{title:'T', total:2, tasks:[...]}` sets the flow title `T`. Reuse the harness style of `safety-guard/guard.test.ts`.
- [ ] **Step 2: Run** `claude plugin test claude-mods/flowdeck` and see it fail (no mod yet).
- [ ] **Step 3: Copy and rename.** Copy the files above. In `register.tsx` change: atom `plugin` keys to `'flowdeck'`, `TOOL`/`STEP_TOOL` to the `mcp__flowdeck__*` names, `PANE` to `'flowdeck-agents'`, the `/^savvy-/` and `startsWith('savvy-')` checks (lines near 132, 333-334, 747, 785) to `flowdeck-`, command name `agents-info` to `flowdeck-agents` (both `command.register` and `command.run`), the default flow title and tool descriptions, and the `pane` string in the English and Russian text tables (`tr().pane`, currently "Agents") to `flowdeck`; the first test also checks that opening the pane uses the title `flowdeck`. `plugin.json`: name `flowdeck`, version `0.1.0`, `types` path, keep `userConfig.language`. In the agents change `name:`, descriptions and the `mcp__savvy-progress__step` mention to `flowdeck`. Copy `SKILL.md` renamed (`name: flowdeck`, `argument-hint: [task]`) with the tool name and `savvy-` tier prefixes changed; adoption comes in Task 4. Write `NOTICE.md` with both MIT notices (hamzafer text is at `~/.claude/plugins/cache/claude-code-mods/context-bar/`, upstream LICENSE at github.com/hamzafer/claude-code-mods).
- [ ] **Step 4: Register** `flowdeck` in `marketplace.json` (`"source": "./flowdeck"`) and add its row to the README table.
- [ ] **Step 5: Run** `claude plugin validate claude-mods/flowdeck` and `claude plugin test claude-mods/flowdeck`; both pass.
- [ ] **Step 6: Commit** `git -C claude-mods add flowdeck .claude-plugin README.md` then `git commit -m "Add flowdeck mod: renamed savvy-flow + savvy-progress"`.

### Task 2: Context module (pure functions)

**Files:**
- Create: `flowdeck/hooks/context.ts`, `flowdeck/tests/context.test.tsx`

**Interfaces:**
- Produces (exported from `context.ts`): `toReading(b: Breakdown): Reading`, `cells(r: Reading, width: number)`, `legend(r: Reading, width: number)`, `tokens(n: number): string`, `share(n: number, window: number): string`, `contextSvg(width: number, r: Reading): string`, `contextRows(r: Reading, columns: number): string[]`. `Reading`, `Slice` types in `types/index.d.ts` (copy from context-bar).

- [ ] **Step 1: Write the failing tests** by porting context-bar's pure-function tests (`~/.claude/plugins/cache/claude-code-mods/context-bar/0.1.2/tests/context-bar.test.tsx`: `toReading`, `cells`, `legend`, `tokens`, `share`, using its `BREAKDOWN` fixture) and add: `contextSvg(400, reading)` returns a string starting with `<svg` containing one `<rect` per non-zero slice; `contextRows(reading, 60)` returns lines that all have length at most 60; `contextRows` and `contextSvg` for a reading with `window` 0 are not called (callers guard, see Task 3).
- [ ] **Step 2: Run** the tests; they fail (module missing).
- [ ] **Step 3: Implement** `context.ts`: move `toReading`, `cells`, `legend`, `tokens`, `share` and the colour constants verbatim from context-bar's `register.tsx`. `contextSvg` draws a header line (`<used> of <window> · compacts at <n>` and the percent), one proportional bar of rects using `cells` widths scaled to `width`, and the legend using `legend` lines, in the panel's existing SVG style (reuse the font and text colours of `headerSvg` in `register.tsx`). `contextRows` builds the terminal text: head line, the bar from `cells` as plain characters, then the legend lines.
- [ ] **Step 4: Run** tests; pass.
- [ ] **Step 5: Commit** `git commit -m "flowdeck: context module"`.

### Task 3: Context section and button in the panel

**Files:**
- Modify: `flowdeck/hooks/register.tsx`, `flowdeck/types/index.d.ts`
- Test: `flowdeck/tests/panel-context.test.tsx`

**Interfaces:**
- Consumes: Task 2 exports.
- Produces: atom `reading` (`Reading | null`), `panel.isContextShown: boolean` (added to the `Panel` type), function `refreshContext($: EngineInterface): Promise<void>`.

- [ ] **Step 1: Write the failing tests** (`tests/panel-context.test.tsx`), rendering the pane with the harness `$.ui` helper the way context-bar's tests render `AbovePrompt`: with a reading in state and `isContextShown` true, the desktop pane output contains the context SVG; with `isContextShown` false it does not; with `reading` null it shows the text `no context data yet`; a button labelled `Context` exists and pressing it flips `isContextShown`; with `bodyColumns` 10 nothing throws.
- [ ] **Step 2: Run**; fail.
- [ ] **Step 3: Implement.** Add `isContextShown: true` to the `panel` atom default and the `Panel` type, and the `reading` atom. `refreshContext` calls `$.session.usage({ breakdown: 'summary' })`, returns without updating when the breakdown is missing or `rawMaxTokens` is not above 0, otherwise `update($, reading, () => toReading(b))`; hook it into `session.start`, `turn.complete` (skip when `e.agentId`) and `session.compact` (skip when `e.agentId`), wrapped so a failure never breaks the turn. Persist `isContextShown` with `$.store.set('contextShown', value)` and read it on `session.start` with `$.store.get`, both inside try/catch that fall back to shown. In the `Pane` render, put the context section first (above the header SVG on desktop, above the rows in the terminal) when `isContextShown`, and a `Button` labelled `Context` (plain, same style as the compact toggle) beside the compact/expand button that flips it. No `ui.render` for `AbovePrompt` for context.
- [ ] **Step 4: Run** tests; pass.
- [ ] **Step 5: Commit** `git commit -m "flowdeck: context section and toggle in the agents panel"`.

### Task 4: `/flowdeck` adoption and linked session

**Files:**
- Modify: `flowdeck/hooks/register.tsx`, `flowdeck/skills/flowdeck/SKILL.md`, `flowdeck/types/index.d.ts`
- Test: `flowdeck/tests/link.test.tsx`

**Interfaces:**
- Consumes: the `flow` atom and `progress` tool from Task 1.
- Produces: `progress` tool input gains `add?: { title: string; tier?: string; after?: number[] }[]` (append, raise `total`, never remove or reset `done`), and `flow.isLinked: boolean` (set true by the first `progress` call).

- [ ] **Step 1: Write the failing tests** (`tests/link.test.tsx`): after `progress {title, total:2, tasks:[a,b], done:1}`, a second call `progress {add:[{title:'c', tier:'light'}]}` leaves 3 tasks, `total` 3, `done` 1, `isLinked` true; a `progress {tasks:[a,b,c,d], total:4}` re-plan keeps `done`; an `add` whose title already exists is ignored; an `add` before any plan creates a flow titled `flowdeck`.
- [ ] **Step 2: Run**; fail.
- [ ] **Step 3: Implement** the `add` input and `isLinked` in the `progress` tool handler (schema entry too) and in the flow normaliser next to the existing task parsing (`ProgressInput`, near line 31 and the handler near line 716). Mirror the session's task list: on `tool.call` for the task-list tool the session uses (`TodoWrite`, and `TaskCreate` where present), when the flow `isLinked`, add any item whose title is not yet in the flow, as tier `medium`; do not remove items that disappear from the list.
- [ ] **Step 4: Update `SKILL.md`.** With `$ARGUMENTS` empty: read the conversation and the session's task list, build the plan from the tasks already underway, call `progress` with `title`, `total`, `tasks` and `done` for those already finished, then continue the normal flow. With a task: as savvy-flow does. In both cases, for the rest of the session: add each new task (new user request, new item in the task list) with `progress {add:[...]}` before starting it, and never drop or reset accepted tasks; close with `finished: true` only when the user ends the flow.
- [ ] **Step 5: Run** tests; pass.
- [ ] **Step 6: Commit** `git commit -m "flowdeck: adopt session tasks and keep the flow linked"`.

### Task 5: Rollout

**Files:**
- Modify: `~/.claude/settings.json` (`enabledPlugins`), `~/.claude/projects/-Users-user-www-paavu-claude-server-setup/memory/reference_claude_inventory.md`, `reference_claude_mods.md`

- [ ] **Step 1: Back up** `~/.claude/settings.json` to `settings.json.pre-flowdeck`.
- [ ] **Step 2: Install** `claude plugin marketplace add /Users/user/www/paavu/claude/server-setup/claude-mods` (if not already added) then `claude plugin disable savvy-flow@claude-kit savvy-progress@claude-kit context-bar@claude-code-mods` one at a time, then `claude plugin install flowdeck@coooloz-mods --scope user`.
- [ ] **Step 3: Verify** in a new session (user): `/flowdeck-agents` opens the panel with the context section at the top, the Context button hides and shows it and the choice survives a restart, `/flowdeck <task>` starts a flow, a bare `/flowdeck` adopts the running tasks, a task added afterwards appears in the panel, both desktop and terminal views, and `/remote-control` still connects.
- [ ] **Step 4: After the user's go-ahead**, uninstall the three originals (`claude plugin uninstall ...`) and log flowdeck as kept and the three as replaced in the mod ledger; add flowdeck to `reference_claude_mods.md`.
