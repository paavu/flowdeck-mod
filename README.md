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
| `mcp__flowdeck__progress` | orchestrator in a flow | Flow title, planned worker tasks, accepted count, phase (`plan`, `design`, `delegate`, `review`, `close`), `finished`. |
| `mcp__flowdeck__step` | workers | A worker's own step bar on its agent row (`total`, `done`, `note`). |
| `mcp__flowdeck__plan` | main session | A task plan for any work: stages of steps, or `kind: "todo"` for a flat list. Created once, then moved with short ops (`next`, `done`, `active`, `failed`, `state`, `note`); calls from subagents are ignored. |

A short rule in the system prompt (`flowdeck:plan-rule`) tells the model when to make a plan and how to move it. It never blocks an edit.

## How the flow works
1. The session model reads the code, breaks the task into self-contained tasks and picks a worker tier for each. It shows you the plan.
2. It delegates to the cheapest tier likely to get the task right: `flowdeck-light` (mechanical), `flowdeck-medium` (standard), `flowdeck-careful` (delicate), `flowdeck-heavy` (unfamiliar code, root causes), `flowdeck-fable` (hardest logic).
3. It reviews each result, accepting it or sending it back, and reports through `progress`; workers report through `step`.

## The panel
Top buttons, in order: **Context · Usage · Plans · Band · History**. Each toggles its part; Context, Usage, Plans and History remember their choice.

| Section | Shows |
|---|---|
| Context | The context window as a stacked bar with tokens per category and where auto-compaction runs. Collapsed, it keeps the head line and the bar. |
| Usage | The five-hour session and the week: reset time, a bar that drains as the limit is used (full = 100% left), percent left, an even-pace mark, and a forecast to the reset (recent pace over ~30 min and the window average), e.g. `recent: 100% at 1:36 PM, 1h 3m early` or `on pace`. Needs a subscription with rate-limit readings. |
| Plans | Plans made with the `plan` tool, each as a track with its state and percent. `Clear finished` removes the done ones. |
| Agents | Running, finished and planned agents, with model, task progress, context, estimated cost and time. |
| History | Off by default. Past flows from every project, newest first. Each row shows title, tasks done of planned, estimated cost and date; press it for project, time, tokens, how it ended and the task list. |

Agent rows: the progress line names the state in its colour, with the live tool word while running (`Running · Bash`), `Needs approval` while a permission dialog for its call is up, then `Done` or `Error`. The tier colour stays on the tier name.

- Foldable steps: a worker that sends its plan as the `step` tool's `steps` list (then `next`, `done`, `active`, `failed`) gets a `▸` chevron on its row; open, it lists each step with its state mark, colour and time (planned grey, running blue-violet, done green, error red). The row's `3/6 · step` line counts from the list; open rows are kept for the session only.

## The band above the prompt
- The flow row (title, track, state, percent, `×N` agents button that opens the panel) plus up to 2 open plan rows (running, needing input or in error), newest first. With no flow, the plan rows show alone.
- ✕ hides the band only; the flow stays in the panel. The `Band` button brings it back, and so does a new flow.

## State colours
| State | Colour |
|---|---|
| Running | blue-violet |
| Needs input / Needs approval | amber |
| Done | green |
| Error | red |

## Saved data (mod store)
| Key | Holds |
|---|---|
| `history` | The last 50 flows across projects. A flow is saved when it finishes, when a new flow replaces it, and as open when the session ends with it running. |
| `plans` | Task plans per session, the last 20 sessions; a resumed session gets its plans back. Up to 3 plans are kept per session. |
| `contextShown`, `usageShown`, `plansShown`, `historyShown` | The section toggles. |

## Requirements
- A Claude Code version with mods.
- `flowdeck-fable` runs on the Fable model; without access to it, change `model:` in `agents/flowdeck-fable.md`.
- Load order: mods nest in the order of `enabledPlugins`, first outermost. Put flowdeck before next-steps, or the band is squeezed.

## Install (fresh machine)
```
claude plugin marketplace add gitea@paavu.com:paavu/claude-mods.git   # the paavu-mods marketplace
claude plugin install flowdeck@paavu-mods
```
flowdeck replaces savvy-flow, savvy-progress, context-bar, plan-progress and flightdeck: disable or uninstall them first.

## Known limits
- Terminal text is English only.
- plan-progress's hover and clock overlays are not ported.
- No sounds.
- No edit gate: work is never blocked for lack of a plan.

Built from savvy-flow/savvy-progress, context-bar and plan-progress; see NOTICE.md.
