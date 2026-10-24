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
- Context section at the top: the context window as a stacked bar with tokens per category and where auto-compaction runs. The Context button in the panel shows or hides it; the choice is remembered.
- Usage section: the current session (five-hour) and the week, each with its reset time, a bar and the percent used, plus a burn forecast under each bar: an even-pace mark, and two projections to the reset (recent pace over the last ~30 minutes, and the average since the window started) with a verdict such as `recent: 100% at 1:36 PM, 1h 3m early` or `on pace`. The Usage button shows or hides it; the choice is remembered. Needs a subscription with rate-limit readings.
- Agents: running, finished and planned, with model, task progress, context, estimated cost and time.

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
