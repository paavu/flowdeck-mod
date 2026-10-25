# flowdeck: design

Date: 2026-10-24. Status: awaiting approval.

## Intent
One personal Claude Code mod that replaces three installed ones: **savvy-flow** (orchestrated delivery skill + 5 worker agents), **savvy-progress** (progress bar above the prompt, side panel of agents, `progress` and `step` tools) and **context-bar** (context-window breakdown). The owner wants a single set of their own, with their own command names, and the context view living inside the agents side panel instead of a separate bar above the prompt.

## Goals
- `/flowdeck <task>` starts the orchestrated flow (what `/savvy-flow <task>` does today): the session model plans and reviews, tiered worker subagents implement. The skill is renamed `flowdeck`.
- `/flowdeck` with no task takes over the work already underway in the session (the owner's current set of tasks): the orchestrator reads the conversation and the session's open task list, builds the plan from them and shows them as the flow in the panel, so running tasks appear under the flowdeck panel. Once `/flowdeck` has run, the flow stays linked for the rest of the session: every task that appears later (new requests, items the model adds to the session's task list) is added to the same flow and the panel, and none is dropped. This linking is the only new behaviour beyond a rename.
- `/flowdeck-agents` shows or hides the side panel (replaces `/agents-info`). The side panel is titled `flowdeck`.
- Progress bar above the prompt stays as savvy-progress draws it, including the crew-size button that opens the panel.
- The side panel gets a **context section** at the top: stacked bar by category, legend with tokens and shares, and the auto-compaction point. Desktop draws it as SVG, the terminal as text. It refreshes after each turn and after `/compact`.
- A **context button inside the panel**, next to the compact/expand button, shows or hides that section. The choice is remembered across sessions.
- The agents list, planned tasks, cost/tokens/time summary, the `progress` and `step` tools and the five tiers behave exactly as in savvy-progress/savvy-flow 1.2.0.

## Non-goals
- No context bar above the prompt, and no `/context-bar` command.
- No other new features in this first version beyond adopting running tasks.
- Not published; personal use only.

## Anti-goals (failure even if it works)
- Clashing with Claude Code's built-in `/context` command.
- Running together with the originals: duplicate tools and pane ids. The three originals are disabled before flowdeck is enabled.
- Any change that leaves `ANTHROPIC_BASE_URL` set or blocks Remote Control.

## Constraints
- Lives in `server-setup/claude-mods/flowdeck/`, registered in that marketplace (`paavu-mods`), same layout as the other mods there.
- Built from the sources in `~/.claude/plugins/cache/claude-kit/{savvy-flow,savvy-progress}/1.2.0` (MIT, johnnyvizz) and `claude-code-mods/context-bar/0.1.2` (hamzafer, MIT, checked 2026-10-24; keep both copyright notices in a LICENSE/NOTICE file).
- Context data comes from `$.session.usage({breakdown:'summary'})`, as context-bar does.

## Decided by the owner
- Name `flowdeck`; commands exactly `/flowdeck` (with a task: starts a flow; with no task: adopts the tasks already running in the session into the flowdeck panel) and `/flowdeck-agents` (toggles the panel).
- Context toggle is a button inside the side panel only.
- Old context bar is dropped once flowdeck works.

## Left to the builder
- Internal naming of tools and the pane id (suggested: tools `mcp__flowdeck__progress` / `mcp__flowdeck__step`, pane `flowdeck-agents`), plus the matching edits in the skill and agent files that call them.
- Agent names: keep `savvy-*` or rename to `flowdeck-*` (suggested: rename for consistency, since both sets cannot coexist anyway).
- Exact SVG look of the context section, matching the existing panel styling.
- Tests (reuse context-bar's pure-function tests for token and bar maths).
- Whether the context section is open or hidden by default (suggested: shown).

## Rollout
Build, run the mod tests, disable savvy-flow, savvy-progress and context-bar, enable flowdeck in a new session, check the panel and the button, then uninstall the three originals and log it in the mod ledger.

## Builder-check answers (builder's calls, 2026-10-24)
- Licence: context-bar is MIT; copying its logic is fine, keep attribution.
- Persistence: use the mod store (`$.store.get/set`), as context-bar does; global, key `contextShown`. Never share keys with the originals.
- Refresh: `turn.complete` plus `session.compact` events; data from `$.session.usage({breakdown:'summary'})`, which carries categories, `rawMaxTokens`, `autoCompactThreshold` and `isAutoCompactEnabled` (see context-bar's `toReading`).
- Rendering: both paths required, as savvy-progress already splits `e.surface === 'desktop'` (SVG) from terminal (text rows). Verify both at rollout.
- Outside references to old names: only the `enabledPlugins` entries in `~/.claude/settings.json` (savvy-progress, savvy-flow, context-bar). Replace them with flowdeck at rollout.

## Additions after the first version
- Usage: the five-hour and weekly limits with reset times, a draining bar, an even-pace mark and a burn forecast (recent ~30 min pace and window average); store key `usageShown`.
- Archive (formerly History): the last 50 flows across projects, newest first, saved on finish, on replacement and as open at session end; store key `history`, toggle `historyShown`, off by default.
- Plans (ported from plan-progress): the plan model in `hooks/plan.ts` (stages or `kind: "todo"`, short ops, at most 3 plans); the main-session tool `mcp__flowdeck__plan`; the Plans panel section with `Clear finished`; up to 2 open plan rows in the band. Saved per session under store key `plans`, last 20 sessions. A `prompt.compose` section `flowdeck:plan-rule` tells the model when and how to plan; no gate, no sounds, no Stop block, no nudges.
- Agent state colours and tool word: each agent row names its state (`Running · <tool>` blue-violet, `Needs approval` amber, `Done` green, `Error` red), the same colours as the plan states.
- Band layout: the flow row first, then the open plan rows, then whatever other mods draw; the row shrinks and clips instead of pushing neighbours; ✕ hides the band only, the Band button or a new flow brings it back.
- Load order: mods nest in the order of `enabledPlugins`, first outermost; flowdeck must come before next-steps, or next-steps squeezes the band.
- Child items per agent: done; a worker's `step` list shows as foldable items on its agent row.
- Per-project saved data: the archive and plans moved from the shared store to `<project>/.claude/flowdeck/history.json` (every flow, never cut: past 2,500,000 bytes the oldest move to archive volumes `history-<n>.json`) and `plans.json` (every session, none dropped), with a `*` `.gitignore` in that folder; each save re-reads the files, merges and writes them whole, so two projects never overwrite each other.
- Store fallback: with no working folder or a failed write, that save goes to the store keys `history`/`plans` as before; this project's entries in the store key `history` are merged into the latest view and back into `history.json` with the next save (the store itself is never changed by that); plans are not migrated.
- Data safety (1.0.0007): sizes are UTF-8 bytes; no write over 3,900,000 bytes is sent; a file that cannot be read, or whose existence stat, the listing and `exists` cannot tell, is never written over; every save writes the flow's own side file `history-extra-<startedAt>.json` first, and a load reads back every side file whose flow neither `history.json` (as finished) nor a volume holds, so two sessions saving at once can duplicate or delay a flow, never lose it.
- Archive (formerly History), 1.0.0008: the panel section, its button and keys (`archive`, `archive-more`, `archive-older`, `archive-seg-<file>`, `archive-latest`, `archive-<id>-…`) and the code say Archive; the old archive segments are archive volumes (`Older volumes (k files)`), indexed by the volume index. Saved data keeps its names, so nothing moves: `history.json`, `history-<n>.json`, `history-index.json` (its JSON field `segments`), `history-extra-*.json`, the store keys `history` and `historyShown`; `FLOWDECK_HISTORY_SEGMENT_MAX` still works beside the new `FLOWDECK_ARCHIVE_VOLUME_MAX`. The code moved out of `hooks/register.tsx`: `hooks/archive.ts` (pure), `hooks/archive-store.ts` (files and store, through an `Io` built in register.tsx, since `$` may not cross an import) and `hooks/archive-view.tsx` (the section and its groups).
