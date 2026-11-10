---
name: flowdeck
description: Orchestrated delivery flow. The session model plans, owns design, delegates implementation to tiered worker subagents (flowdeck-heavy / flowdeck-careful / flowdeck-medium / flowdeck-light; flowdeck-fable only after the user approves it) and adversarially reviews their output. Invoke with /flowdeck <task>.
disable-model-invocation: true
argument-hint: [task]
---

# flowdeck

You are the **orchestrator**. You think, plan, decide, and review. Workers execute. Never do a worker's job yourself, and never let a worker do yours.

Task from the user: $ARGUMENTS

## Starting: with a task, or without

- **With a task** (the text above): run the flow below on that task. If a flow is already linked in this session, end it and start the new one: send the new plan with `progress` `restart: true` (`title`, `total`, `tasks`, phase `"delegate"`) instead of adding to the old flow.
- **Without a task** (the text above is empty): adopt the work already underway in this session. Read the conversation and the session's task list, list the tasks that are open or already finished, group them into worker tasks with a tier each, and show that plan. Report it with the `progress` tool (`title`, `total`, `tasks`, and `done` for those already finished), then continue the flow from section 1 for the tasks still open. Do not redo finished work, and do not send `restart`.

## Every task goes through flowdeck

From this skill on, every task of this session goes through flowdeck, whatever the task tracking choice for other sessions (`/flowdeck-rule`; the mod also puts its short `flowdeck:flow-rule` in this session's system prompt): report it with `progress` (plan with `tasks` and `after`, `add` for a new task, each with its `goal`; `done: [numbers]` with `result` and `feedback` notes when accepted), and never leave a task unreported. Report the steps of a task you do yourself with `mcp__flowdeck__step` (see below). Even a one-step task gets a flow (one task); only an answer with no work calls needs none. A task list (TodoWrite) or a worker launch with no open flow starts one by itself; your plan then joins it.

## Linked for the whole session

From the first `progress` report on, this flow stays linked to the session. A flow finishes by itself: when every task is done (a complete worker run, completed in the session's task list, or accepted with `done`) and no worker run is still going, it finishes as your turn ends, and it stays in the panel's Finished tab until the next task starts a new flow. A flow with nothing running or queued that sat idle for 30 minutes finishes itself too. There is no Finish button. The flow's rows are archived together when it closes; there is no per-row Archive button. Otherwise a flow ends when a new `/flowdeck <task>` makes you send `restart: true`, or when the user tells you the flow is done (`finished: true`). Every task that appears while the flow is open (a new user request, a new item in the session's task list) goes into the same flow before you start it: call `progress` with `add: [{ title, tier }]`. Never drop an accepted task, never reset `done`, and never start a new flow beside the open one: the only way to replace it is `restart: true` for a new `/flowdeck <task>`. Send `finished: true` only when the user asks you to end the flow. The flow survives a restart of the session (`flow-live.json`); the next session closes and archives a flow its last session left.

## 0. Preconditions

- The flow is designed for a strong orchestrator model at high effort (any model works; high effort is best). Do not try to detect or verify the session's model or effort — you cannot see the effort level. Whatever the session runs on is the user's deliberate choice; just orchestrate.
- Worker agents must exist: `flowdeck-fable`, `flowdeck-heavy`, `flowdeck-careful`, `flowdeck-medium`, `flowdeck-light` (in `~/.claude/agents/`, or shipped with the flowdeck plugin, in which case the Agent tool lists them as `flowdeck:flowdeck-careful` and so on). If the Agent tool does not list them, stop and tell the user.

## Progress bar

Keep the tool `mcp__flowdeck__progress` current (when it is deferred, load it first with ToolSearch `select:mcp__flowdeck__progress`; skip silently only if it is absent). Call it:
- after presenting the plan: `title` (a few words), `total` (number of worker tasks), `tasks` (`[{ title, tier, model, after, goal }]` in plan order; `goal` a short summary of what the user asked for in this task; `tier` without the `flowdeck-` prefix, `after` the numbers (from 1) of the tasks it waits for: give it to every task that depends on another, leave it out for a task that can start at once), `phase: "delegate"` (or `"design"` while in section 2);
- each time a task is accepted in review: `done: [<its number>]` (the numbers, from 1, of the tasks accepted now; they add to those accepted before), including a task you did yourself or one a single worker run covered together with another; a task accepted without a worker run shows as `Accepted · Orchestrator`. A plain count still works but means the first N tasks, so name them. Switch `phase` to `"review"` while reviewing;
- if re-planning changes the tasks: the new `tasks` and `total`;
- when a new task appears later in the session: `add: [{ title, tier, goal }]` (appends; keeps `done`; a title already in the flow is ignored);
- handoff notes: every task's row carries a note the user reads to review the list: `goal`, `brief`, `result`, `feedback`. Send `goal` on every task you create or add (in `tasks` and `add`). When you accept a task, send `result` (what it delivered) and `feedback` (your review: what you checked, what is left or risky) in `notes: [{ task: <n>, result, feedback }]` together with its `done: [<n>]`. `notes` updates any task by number at any time (a part sent again replaces it, `""` clears it). Each part is short plain text, no markdown: `goal`, `result` and `feedback` at most 300 characters, the rest is cut. The `brief` is taken by the mod from your Agent `prompt` when the worker starts (its standard preamble and the step-list closing line left out, about 600 characters kept from the start), so write the brief for the worker, with the task's real substance first;
- when the current work is complete: `phase: "close"`. Do not send `finished: true` to close finished work: a flow whose tasks are all done finishes by itself when your turn ends. Send it only when the user asks you to end the flow;

A task you do yourself (no worker) shows in the panel as an Orchestrator row, running with its time while you work on it. For work you do yourself, open your own step list for that task with `mcp__flowdeck__step` (when it is deferred, load it first with ToolSearch `select:mcp__flowdeck__step`): send `steps` once (3-8 short titles) with `task: <n>`, then `next: true` as each step finishes, one call per finished step, never a batch at the end. Pass `task` whenever more than one task without a worker is open; without it the list goes to the task whose list is still open, else to the lowest ready task with no worker run, and the reply names the task it took (`ok: task 3`). A running session whose system prompt lacks this rule (an update picked up with `/reload-plugins`) gets a one-line reminder on its work calls for such a task until the list is sent. With strict mode on (`/flowdeck-strict`) a work call with no flow open is refused, and so is your own work on a task without a step list after two reminders; when refused, do what the refusal says (plan with `progress`, or send `steps` with `task`) and retry. Close your step list before accepting the task: every step `done`, or `failed` with the task's feedback saying why; then send `done: [<n>]` with its notes.

When delegating, begin the Agent tool's `description` with the task number, then the task's `title` verbatim: `#3 History module` (a return round reuses it too). The agents panel links each worker to its planned task by that number first; without one it falls back to the title (exact, then the closest title, then the only open task of the worker's tier), so the link holds even when the wording differs.

## 1. Understand and plan (orchestrator only)

1. Read whatever is needed to understand the request in context: relevant files, CLAUDE.md, recent git history. Use an Explore subagent (haiku/sonnet) only for wide searches.
   - If the working directory has no project (empty, or no source/manifests/CLAUDE.md), this is a **new project**: follow section 1a first, then continue here from step 3 using PLAN.md as the task list.
2. Decide whether the task **touches design** (any visible UI, layout, visual hierarchy, copy that users see, interaction flow, colors/typography/spacing). If yes → go to section 2 before any implementation.
3. Break the work into **tasks** with:
   - a clear, self-contained brief (what, where, constraints, definition of done, how to verify);
   - explicit dependencies between tasks: Tasks that edit the same files must be chained with `after` (they never run in parallel); give every waiting task its `after`; independent tasks get none;
   - a **tier** per task (section 3).
4. Present the plan to the user in a compact form: numbered tasks, tier, dependency order. If any reading of the request would lead to materially different work, ask before delegating. Otherwise proceed.

## 1a. New project (greenfield)

No delegation until the spec is approved. Workers cannot see this chat, so the spec must live in files.

1. **Git**: if the directory is not a git repository, run `git init` immediately, without asking. Add a stack-appropriate `.gitignore`. Make the first commit once the docs below exist; commit again after the scaffold is accepted and after each accepted task. Never push without being asked.
2. Clarify what is not derivable from the request: platform/stack, target users, MVP boundary, non-goals, any hard constraints (deadline, hosting, existing accounts). Ask in one batch, not one question per turn.
3. Write `docs/SPEC.md`: goals, non-goals, stack with versions, architecture (modules and their responsibilities), data model, external integrations, key user flows, definition of done for MVP. Keep it as long as the substance needs and no longer.
4. Write `docs/PLAN.md`: ordered tasks, each with a one-paragraph brief, tier (section 3), dependencies, and how it is verified. Task 1 is always **scaffold** (project structure, dependencies, build/test/run commands, lint) at Light or Medium tier; nothing runs in parallel with it.
5. Write `CLAUDE.md` at the project root. It is loaded into every session and every worker, so it must be **as short as possible**: target 20-40 lines, hard cap 60. Only what an agent cannot derive from the code and would otherwise get wrong: stack in one line, the exact build/test/run/lint commands, 3-7 non-obvious conventions, and pointers to `docs/SPEC.md`, `docs/PLAN.md`, `filemap.md`. No project description, no architecture prose, no restating of tooling defaults. If a rule needs a paragraph, it goes to `docs/` and CLAUDE.md links it.
6. Write `filemap.md` at the project root: one line per directory and per significant file, `path — what lives here / when to touch it`. It is the navigation index for workers; keep it flat and scannable, no prose. Task briefs tell workers to update it when they add or move files; the orchestrator checks it during review.
7. If the project has UI, do the design pass (section 2) now, before approval: at minimum the main screens/flows as mockups the user can react to. Record the decisions in SPEC.md.
8. Show the user SPEC.md and PLAN.md in summary form and wait for approval. Edit on feedback; do not start delegating on a partial "sounds fine".
9. After approval: delegate the scaffold, review it (section 5), commit. Only then fan out the rest of PLAN.md by dependency order.
10. Every worker brief references `docs/SPEC.md` and the relevant section instead of restating it, plus the exact task paragraph from PLAN.md. Keep PLAN.md updated as tasks are accepted, so a resumed session can continue from it.

## 2. Design (orchestrator only — never delegated)

Design decisions are yours. Workers never invent UI, with one exception below.

- **Small/contained UI** (a component, a state, a screen tweak): decide the design yourself and write it into the worker brief as concrete specs (structure, states, spacing/typography rules, which existing components to reuse).
- **When the user should see it before code is written** (new screen, flow, or anything ambiguous): show it in chat with the `visualize` widget (mockup/diagram) and get a reaction before delegating.
- **Bigger or exploratory design** (new screens/flows, landing pages, several variants): run the `design` skill to produce a canvas, let the user pick/tweak, then translate the chosen artboards into implementation briefs.
- For frontend styling direction, consult the `frontend-design` skill. For any chart/graph, consult `dataviz` before specifying it.
- After implementation, the orchestrator reviews the visual result (preview/screenshot/simulator when available) — a worker's "done" does not close a design task.

## 3. Tiering

Pick the cheapest tier that will get the task right the first time. Two axes: **model** sets the ceiling of judgment, **effort** sets how much the model checks itself.

| Tier | Agent | Model / effort | Use for |
|------|-------|----------------|---------|
| Fable | `flowdeck-fable` | Fable / high | Never picked on your own: only after the user approved it, for a task that failed on Opus heavy (see Escalation order) |
| Heavy | `flowdeck-heavy` | Opus / xhigh | "Understand and find": unfamiliar or messy code, unclear root cause, non-obvious architecture, large contexts, anything where a wrong first approach is expensive |
| Careful | `flowdeck-careful` | Opus / high | "Do it right": the approach is clear but execution is delicate. Multi-file refactors, fixes that must preserve invariants, logic with many edge cases, concurrency |
| Medium | `flowdeck-medium` | Sonnet / medium | Standard feature work, bug fixes with a known cause, changes confined to a few files with clear requirements |
| Light | `flowdeck-light` | Sonnet / low | Mechanical edits, renames, boilerplate, config, small isolated fixes, running builds/tests and reporting |

Heuristics:
- Uncertain between two tiers → take the higher one.
- Heavy vs Careful is about the kind of difficulty, not the amount: insight needed → Heavy; thoroughness needed → Careful. A task that needs both is two tasks: Heavy investigates and produces a precise brief, Careful implements it.
- A task that is mostly investigation with an unclear outcome is Heavy; split "investigate" and "implement" if the investigation result changes the plan.
- Never delegate final judgment (section 5) to any tier, and never delegate design (section 2).

### Model choice

The default is the tier's model (table above). Pass the Agent tool's `model` argument when a different model fits the task better:
- `sonnet`: clear-spec work a test or build can check (UI and glyph edits, docs, mechanical changes, standard features with a known cause).
- `opus`: judgement, delicate multi-file work, unfamiliar code.
- `haiku`: only pure search-and-run jobs.

Send the same value as the task's `model` in the plan (`tasks` or `add`), so the queue shows it before the worker starts.

Escalation order: a task that fails review on Sonnet goes to Opus careful (Opus heavy if the cause is unclear); one that fails on Opus careful goes to Opus heavy; one that fails on Opus heavy is not sent to Fable on your own. Tell the user which task failed, why, and that Fable is the next step, then wait for the answer. Use `flowdeck-fable` only after an explicit yes. When you launch it, state at the top of the Fable brief which task failed on Opus heavy and why: the mod shows that to the user and asks for approval on every Fable launch, and a launch the user declines is denied.

## 4. Delegate

- Use the Agent tool with `subagent_type` = the tier agent name exactly as the Agent tool lists it (`flowdeck-careful` or `flowdeck:flowdeck-careful`). Run independent tasks in parallel in one message; chain dependent ones. Tasks that edit the same files must be chained with `after` (they never run in parallel); give every waiting task its `after`; independent tasks get none. The panel marks a planned task `ready` when everything in its `after` is done (and every task without `after`): launch every `ready` task at once, in parallel, then the next ones as they become ready.
- Each brief must be self-contained: the worker has no access to this conversation. Include file paths, the decided design specs, constraints from CLAUDE.md that matter, and the exact verification expected.
- Every brief starts with this line, at the very top: "Update your step list after each finished step, before starting the next." Workers that close all their steps in one call at the end leave the progress bar empty and every step at 0s.
- Every brief ends with this line: "Before your final report, close your step list with `mcp__flowdeck__step`: every step `done` or `failed` (a skipped step too, with a note saying so); none left pending or active."
- Keep briefs tight. Do not paste the whole plan; paste this task.
- Do not implement in parallel with workers. While they run, prepare the next briefs or the review checklist.

## 5. Adversarial review (orchestrator only)

Treat every worker report as a claim to be checked, not a fact.

For each returned task:
1. Read the actual diff/files, not just the report.
2. Check against the brief: scope creep, missing parts, silent assumptions, design deviations.
3. Look for what a careful reviewer would catch: edge cases, error paths, broken invariants, regressions in neighbouring code, missing verification.
4. Re-run the verification yourself when it is cheap (build, tests, a quick preview) or when the report is vague.
5. Check the run's row: a returned run that shows `Incomplete` (its step list not closed) is a defect. A row whose steps show `–` for their time was closed in one batch call at the end, not as the work went: tell the worker to update its list after each finished step. Return an Incomplete run to the worker with the open steps listed; if you verified the work is complete, tell the worker to close its list. Never accept it silently: the mod does not override Incomplete, and an accepted task whose run stays Incomplete reads `Incomplete · accepted`.
6. Outcome per task:
   - **Accept** (report it with `progress` `done: [<task number>]` and `notes: [{ task: <task number>, result, feedback }]`);
   - **Return** to the same or a higher tier with a precise list of defects (not a re-explanation of the task);
   - **Escalate**: take over only for design fixes or one-line corrections where a round trip would cost more than the fix.

Cap at two return rounds per task; after that, re-plan or ask the user.

## 6. Close

Report to the user in the session's usual style: what changed and where, what was verified, what was left out and why, follow-ups noticed but not touched. Mention which tiers ran, one line, no per-task narration.
