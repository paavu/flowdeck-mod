# flowdeck

An orchestrated delivery flow for Claude Code with a live side panel. The session model plans, designs and reviews; five tiered worker subagents implement. The panel shows the agents, the plan's progress and the context window.

## Commands
- `/flowdeck <task>` starts a flow on a new task.
- `/flowdeck` (no task) takes over the work already underway in the session. From then on every new task is added to the same flow and panel.
- `/flowdeck-agents` shows or hides the side panel (titled `flowdeck`).

## How the flow works
1. The session model reads the code, breaks the task into self-contained tasks and picks a worker tier for each. It shows you the plan.
2. It delegates to the cheapest tier likely to get the task right: `flowdeck-light` (mechanical), `flowdeck-medium` (standard), `flowdeck-careful` (delicate), `flowdeck-heavy` (unfamiliar code, root causes), `flowdeck-fable` (hardest logic).
3. It reviews each result, accepting it or sending it back, and reports to the panel through the `progress` and `step` tools.

## The panel
- Buttons on top: `Context`, `Usage` and `Band` (the progress bar above the prompt; its ✕ hides only the band, the flow stays in the panel, and a new flow brings it back).
- Plans in the band: up to two open plans (running, needing input or in error), newest first, as one-line rows with their title, track, state and percent below the flow row, or alone when no flow runs; `Band` and ✕ hide them with the rest.
- Context section: the context window as a stacked bar with tokens per category and where auto-compaction runs. The Context button collapses it to its head line and the bar (and expands it again); the choice is remembered.
- Usage section: the current session (five-hour) and the week, each with its reset time, a bar that drains as you use up the limit (full = 100% left) and the percent left, plus a burn forecast under each bar: an even-pace mark, and two projections to the reset (recent pace over the last ~30 minutes, and the average since the window started) with a verdict such as `recent: 100% at 1:36 PM, 1h 3m early` or `on pace`. The Usage button hides the whole section and shows it again; the choice is remembered. Needs a subscription with rate-limit readings.
- Plans section: the task plans made with the `plan` tool, each as a progress track with its state and percent; the Plans button hides the section and shows it again (remembered), and `Clear finished` removes the done plans.
- Agents: running, finished and planned, with model, task progress, context, estimated cost and time.
- Agent state: each row's progress line names its state in its colour, with the tool a running agent is using right now (`Running · Bash`, blue-violet), `Needs approval` (amber) while a permission dialog for its call is up, `Done` (green) or `Error` (red); the tier colour stays on the tier name.
- History (the `History` button on top, off by default; the choice is remembered): past flows from every project, newest first, the last 50. Each row shows the title, tasks done of planned, estimated cost and date; press it to see the project, time, tokens, how it ended and the task list. A flow is saved when it finishes, when a new flow replaces it, and as open when the session ends with it still running.

## Requirements
- A Claude Code version with mods.
- `flowdeck-fable` runs on the Fable model; without access to it, change `model:` in `agents/flowdeck-fable.md`.

## Install (fresh machine)
```
claude plugin marketplace add <owner>/<repo>      # the paavu-mods marketplace
claude plugin install flowdeck@paavu-mods
```
Disable or uninstall savvy-flow, savvy-progress and context-bar first: flowdeck replaces all three.

Built from savvy-flow/savvy-progress and context-bar; see NOTICE.md.
