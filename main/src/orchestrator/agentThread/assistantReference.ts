/**
 * assistantReference — the cyboflow assistant's on-demand product reference.
 *
 * Served VERBATIM by the global-agent `cyboflow_reference` MCP tool (see
 * `mcpServer/cyboflowMcpServer.ts`): no topic → the table of contents (each
 * key + its one-liner), a known topic key → that topic's full markdown body.
 * The assistant already carries a compact "What cyboflow is" overview in its
 * system prompt (`agentThreadPrompt.ts`); this module is the DEEPER layer it
 * pulls only when the user asks how a specific feature works.
 *
 * Content is a TypeScript const rather than a set of `.md` files on purpose:
 * the `copy:assets` build step (`main/scripts/copy-workflow-assets.js`) ships
 * ONLY `src/orchestrator/workflows/*.md` into `dist`, so a `.md` dropped under
 * this directory would never reach the packaged app. A `.ts` module is compiled
 * into `dist` by the normal `main` build with no build-script change — the same
 * reasoning that governs `agentThreadPrompt.ts`.
 *
 * Every body is USER-FACING truth distilled from the product docs (repo
 * `CLAUDE.md`, `docs/cyboflow_system_design.md`, `docs/ARCHITECTURE.md`, and the
 * four `workflows/*.md` prompt bodies) — what the feature is, how a user drives
 * it, the gates they will see, the artifacts it produces, and practical
 * caveats. It deliberately carries NO internal code structure (no file paths,
 * table names, or class names) — that belongs in the repo docs, not in the
 * assistant's mouth.
 */

export interface AssistantReferenceTopic {
  /** Human-readable section title. */
  title: string;
  /** One-line summary shown in the table of contents. */
  oneLiner: string;
  /** Full markdown reference body, served verbatim on a topic hit. */
  body: string;
}

export const ASSISTANT_REFERENCE: Record<string, AssistantReferenceTopic> = {
  'workflows-overview': {
    title: 'Workflows overview',
    oneLiner: 'The four built-in flows — Planner, Sprint, Compound, Ship — and how they relate.',
    body: `# Workflows overview

cyboflow ships **four built-in flows**. A flow is a scripted sequence of steps
that drives Claude Code through a piece of work, pausing at **human gates** where
you approve, revise, or reject before it continues. Each flow runs against a real
repo in its own isolated git worktree.

## The four flows

- **Planner** — turns a raw idea into a reviewed backlog. It sharpens the idea
  into a short stub you approve, expands it into a full spec, then decomposes it
  into execution-ready tasks. It does **not** write code — its output is planned
  tasks sitting on the board, ready for a Sprint.
- **Sprint** — executes tasks that are already planned. You seed it with N tasks;
  it runs them in parallel lanes in one shared worktree, with per-task tests,
  code review, and verification, then one human sign-off over the whole sprint.
- **Compound** — mines recently merged work for durable learnings and turns the
  approved ones into concrete improvements (quick fixes, doc edits, or follow-up
  tasks). Launched from the Insights view.
- **Ship** — Planner and Sprint fused into one continuous run: idea → spec →
  tasks → executed code, with a single approve-plan gate that also picks which
  tasks execute now. Use it when you want one idea taken all the way to
  integrated code without a hand-off.

## Choosing one

- Have a fuzzy idea and want a reviewed plan, but not code yet → **Planner**.
- Have approved tasks ready to build → **Sprint**.
- Want an idea taken end to end in one run → **Ship**.
- Just merged a batch of work and want to capture what you learned → **Compound**.

## Editing flows and models

Every built-in flow is editable in the **workflow editor** — you can change its
steps, the per-task execution chain, concurrency caps, and per-agent model
choices. Editing a built-in flow changes it for every project (it is a shared
global definition); custom flows and A/B variants are safer to experiment with.
See the *experiments-and-variants* topic for A/B testing flows.

Every gate you hit is a real pause: the flow will not proceed until you answer.
Nothing merges to your main branch automatically — you always merge the finished
session yourself from the UI.`,
  },

  'planner-flow': {
    title: 'Planner flow',
    oneLiner: 'Idea → approved stub → full spec → decomposed tasks, with human gates at each decision.',
    body: `# Planner flow

Planner turns a raw idea into a backlog of execution-ready tasks. It writes no
code — everything it produces lands as backlog entities you review. It can plan a
**single idea** or a **small batch of up to 4** ideas in one run.

## What happens, step by step

1. **Context / stub.** Planner probes your intent first. Unless the idea is
   obviously unambiguous, it asks you a round or two of clarifying questions
   (each with proposed options), then produces a short **idea stub** — a tight
   problem definition and proposed solution.
2. **Approve idea (gate).** You Approve, Revise, or Reject the stub. Nothing
   expands until you approve.
3. **Expand spec.** The approved stub is expanded into a full spec — evidence,
   risks, code touchpoints, constraints, and testable acceptance criteria. This
   step is ungated and only *adds* detail; it never silently changes what you
   approved. If a genuine material change is needed, the approve-idea gate
   reopens.
4. **Design steps (optional).** When the idea has a UI surface, Planner builds a
   **UI prototype** (a static mockup you can view in its own tab). For a large
   idea it may also produce an **architecture design** folded into the idea. When
   either ran, an adversarial reviewer stress-tests it, and an **Approve design**
   gate follows.
5. **Epics & tasks.** A large idea is broken into epics; every idea is broken
   into concrete tasks with acceptance criteria. These land as **hidden drafts**
   — invisible on the board until you approve the plan.
6. **Approve plan (gate).** You Approve, Revise, or Reject the whole task set.
   Approving reveals every task at **Ready for development** and takes the
   originating idea off the board (it is now decomposed — reachable through its
   tasks). Rejecting deletes the drafts.
7. **Decompose (final gate).** A short finish gate — archive the planned idea or
   keep it — that ends the run.

## Batch runs (up to 4 ideas)

A batch is a lightweight lane for **small** ideas. Planner sizes each seed first:
anything large enough to need a schema or architecture change is **guarded out**
(parked for its own focused Planner run) rather than half-planned. Surviving
small ideas are gated together — one Approve-ideas decision, then one combined
design gate (if any has a UI), then one Approve-plan gate over all of them.

## What you get

Reviewed tasks on the board at **Ready for development**, plus artifact tabs (idea
spec, decomposed stories, and any UI prototype). Feed those tasks to a **Sprint**
to build them — or use **Ship** to plan and build in one run.`,
  },

  'sprint-flow': {
    title: 'Sprint flow',
    oneLiner: 'Runs N seeded tasks in parallel lanes with tests, review, and verify, then one sign-off.',
    body: `# Sprint flow

Sprint executes tasks that are already planned. You seed it with N tasks (a
sprint of one task is just a sprint with one lane) and it drives all of them to
completion in **one shared worktree**.

## Lanes

Each seeded task gets a **lane** — a per-task progress row rendered alongside the
run. A lane moves through a chain of steps (implement, write-tests, code-review,
task-verify, and optionally visual-verify) and ends at **integrated**, meaning
the task is complete and committed in the session's worktree. Lanes are your live
window into per-task progress; a swimlane canvas shows them side by side.

## What happens

1. **Analyze dependencies.** Sprint works out which tasks depend on which, so
   independent tasks run in parallel and dependents run in order.
2. **Execute.** Tasks are dispatched in dependency waves, bounded by a
   concurrency cap, holding same-file tasks out of the same wave to avoid
   collisions. Each task is implemented, tested, code-reviewed, and verified
   against its acceptance criteria in a subagent; on success it is committed once
   and its lane goes to **integrated**. A failing task retries up to a few times,
   then its lane is marked **failed** — a failed lane never stops the sprint, the
   others keep running.
3. **Sprint verify & review.** Once every lane is terminal, the full test suite
   runs once over the combined result, and a cross-task review looks for
   coherence issues. (If any lane failed, these are skipped and the partial
   sprint goes straight to the gate.)
4. **Approve sprint (gate).** A final taste-level sign-off over the whole sprint —
   Approve or Reject. On Approve you get a per-lane outcome summary and the branch
   is ready; **you merge the session yourself from the UI** — Sprint never merges
   to main.

## Board behavior

A task pulled into a sprint sits at the derived **In development** state for the
run, advances to **Done** when you actually merge the session, and reverts to its
entry stage if the run ends without merging. You never move task stages by hand.

## Artifacts

Sprint surfaces deliverables as tabs — a running app/dev-server preview, generated
reports, and (when visual verification is on) captured screenshots with the
verifier's verdict.`,
  },

  'compound-flow': {
    title: 'Compound flow',
    oneLiner: 'Mines merged work for durable learnings and applies the approved ones, ending on a merge gate.',
    body: `# Compound flow

Compound looks back at recently merged / completed work and extracts **durable
learnings** — the patterns worth keeping, not one-off fixes. It turns the
approved ones into concrete improvements. It is launched from the **Insights**
view.

Every learning lands as exactly one of three actionable buckets:

- **quick** — a small fix applied in-place in the worktree right now.
- **doc** — an edit to the project's guidance docs (e.g. CLAUDE.md /
  CODE-PATTERNS.md), applied in-place once approved.
- **task** — a follow-up backlog task that queues for a future Sprint.

Compound's *output* is always one of those three — it never files new findings
(a finding is Compound's *input*, so re-filing would be circular).

## Two ways to run it

- **Unseeded (discovery).** Compound mines the git diff and run history itself,
  drafts a **recommendations doc** (an "act on / discarded" summary in its own
  artifact tab), and presents an **Approve learnings** gate where you approve all,
  pick a subset, or reject.
- **Seeded (from the triage tray).** You hand-pick the exact findings to compound
  in the Insights triage tray. Because you already triaged, the approve-learnings
  gate is **skipped** — Compound applies your curated set directly.

## The two gates

Compound only interrupts you at **two** points, both workflow steps (never a
per-item review-queue spam):

1. **Approve learnings** — approve the plan (unseeded runs only).
2. **Human review** — the terminal "merge in changes" gate over the applied diff,
   Approve or Reject, exactly like a Sprint or Ship sign-off.

Between them, Compound applies every approved change and commits — it emits no
review-queue items. On Approve the branch is mergeable and **you merge it
yourself**; on Reject the committed changes are left as they stand.`,
  },

  'ship-flow': {
    title: 'Ship flow',
    oneLiner: 'Planner + Sprint in one continuous run: idea → spec → tasks → integrated code.',
    body: `# Ship flow

Ship takes a raw idea all the way to integrated code in **one continuous run**.
It is the **Planner** flow (idea → spec → tasks) concatenated with the **Sprint**
flow (execute every approved task to integration), with no break in the middle.

## What happens

1. **Plan** (like Planner): a context/stub round, an **Approve idea** gate, a full
   spec expansion, optional UI prototype / architecture design with an **Approve
   design** gate, then decomposition into tasks.
2. **Approve plan (gate) — doubles as the pre-execution gate.** This single gate
   is where you approve the plan **and choose which tasks execute now**. You can
   Approve, Revise (which keeps your drafts and lets you adjust them), or Reject
   (the only thing that tears the drafts down). Approving takes the idea off the
   board and promotes the chosen tasks to Ready for development.
   - There is a cap on how many tasks a single sprint runs (15 on the default
     substrate, 10 on the interactive one); if your subset exceeds it, Ship asks
     you to trim.
3. **Materialize & execute** (like Sprint): the approved tasks become a sprint
   batch with one lane each, dependencies are analyzed, and the tasks run in
   parallel waves with tests, review, and verification — ending at **integrated**.
4. **Human review (gate).** The final taste-level sign-off over the executed
   sprint — Approve or Reject. On Approve you get a per-lane outcome summary; the
   run rests ready-to-merge and **you merge the session yourself from the UI**.
   Ship never merges to main.

## When to use it

Reach for Ship when you have one idea you want built now and don't need a separate
planning-review checkpoint before execution starts. Use **Planner** instead when
you want a reviewed plan you'll schedule into sprints later, and **Sprint** when
the tasks already exist.`,
  },

  'sessions-and-worktrees': {
    title: 'Sessions, runs, and worktrees',
    oneLiner: 'How runs live inside sessions on isolated git worktrees, plus quick sessions and substrates.',
    body: `# Sessions, runs, and worktrees

## Sessions and runs

A **session** owns a git worktree; **runs** nest inside it. Every flow run
executes in its own isolated worktree branched off your main branch, so multiple
flows can run against the same project in parallel without stepping on each
other. Work stays on the worktree branch until **you merge it yourself** — nothing
auto-merges to main, and worktrees are not auto-cleaned in v1.

The left rail lists your **active / open sessions** (it is a live view of what's
running, not a historical log). The Sessions / Runs view is where per-run status
lives.

## Quick sessions

Alongside the scripted flows, cyboflow has **quick sessions** — ad-hoc chat / PTY
sessions for exploratory work that doesn't warrant a full flow. A quick session
can run **in place** (opting out of a separate worktree) when you just want to
poke at the current tree. Quick sessions surface artifact tabs too, even though no
flow is driving them.

## Substrates

A run executes under one of two **substrates**, resolved once at launch:

- **sdk** (the default) — drives Claude Code through the Agent SDK.
- **interactive** — drives a real interactive Claude session in a terminal.

The substrate is fixed for the life of a run (there is no switch mid-run); to
change it, start a new run. Both substrates surface the same workflow progress,
lanes, and artifacts — the choice is about how the underlying Claude process is
driven, not what you see.

## Permission modes

Each run carries a **permission mode** that governs how tool use is gated. The
conservative default prompts you for approvals; other modes auto-allow file edits
or run against an explicit allowlist. Approvals surface in the **review queue**
(see the *review-queue* topic) — the run genuinely pauses until you decide, it is
not asked after the fact.`,
  },

  'backlog-and-board': {
    title: 'Backlog and the board',
    oneLiner: 'The ideas → epics → tasks entity model and the shared 4-stage board.',
    body: `# Backlog and the board

cyboflow's backlog is a three-level entity model — **ideas**, **epics**, and
**tasks** — that all share **one board**. An idea is raw captured intent; a large
idea decomposes into epics; epics (and small ideas) decompose into tasks, the
concrete units a Sprint executes.

## The board

All three entity types live on a single board with four canonical stages:

- **Idea** — raw input captured. A decomposed idea leaves the board (it becomes
  reachable through its tasks via an "open root idea" back-link on the cards).
- **Ready for development** — approved and queued. Tasks are created here the
  moment a plan is approved.
- **Done** — merged and archived; terminal. An epic rolls up to Done once all its
  children are Done.
- **Won't do** — terminal, hidden by default.

There is also a derived **In development** column: a task pulled into a live
session or sprint shows there automatically for the life of the run. It is
derived state, not a stage you can drag a card into — the task advances to
**Done** when the work actually merges, and falls back to its entry stage if the
run ends without merging.

## How entities get there

- **Planner / Ship** create ideas, epics, and tasks as they run. Tasks decomposed
  during planning are **hidden drafts** — invisible until you approve the plan,
  at which point they appear at Ready for development.
- You can also add ideas and tasks directly to the backlog, and attach files /
  images to an idea for context.

## Lineage

Tasks and epics remember the idea they came from, so you can always trace a task
back to its originating idea (and open that idea from the task card). Approving a
plan retires the originating idea from the board — its tasks now carry the work
forward.`,
  },

  'review-queue': {
    title: 'Review queue',
    oneLiner: 'The unified human-attention inbox — approvals, decisions, findings, and human tasks.',
    body: `# Review queue

The review queue is cyboflow's headline feature: **one workspace-scoped inbox**
that concentrates everything needing your attention across every running flow, so
you clear it in one place instead of chasing each run. The app's dock badge shows
the pending count.

## What lands in it

The queue holds four kinds of item, each with a **blocking** flag:

- **Permission** — a tool-use approval. When a flow wants to run a tool that its
  permission mode gates, the run genuinely **pauses** and the request appears
  here with the command / edit preview and Claude's rationale. It resumes only
  when you approve (or is denied on timeout). This is an enforced pause, not a
  notification after the fact.
- **Decision** — a human gate from a flow (e.g. approve-idea, approve-plan).
  Resolving one auto-resumes the run.
- **Finding** — a non-blocking observation an agent surfaced (a code smell, an
  out-of-scope issue). Findings live in a **separate section** so blocking items
  stay prominent. You can resolve, dismiss, or **promote** a finding into a real
  backlog task.
- **Human task** — a manual to-do for you.

## Aggregate unblock

A run that has multiple blocking items stays paused until **all** of them are
resolved — clearing one of several does not resume the run prematurely.

## Working the queue

Blocking items are pinned to the top, sorted oldest-first. Each card opens the
related idea / epic / task detail through a dedicated **Edit** affordance (not a
full-card click). Note that an empty overview does not mean an empty queue —
findings and pending gates can be waiting even when nothing looks "stuck," so the
queue is the authoritative place to check whether anything needs you.`,
  },

  'experiments-and-variants': {
    title: 'Experiments and A/B variants',
    oneLiner: 'A/B test flow variants via rotation or side-by-side experiments, graded in Insights.',
    body: `# Experiments and A/B variants

cyboflow lets you A/B test **how a flow runs** — different prompts, models, or
step configs — so you can tell which version produces better work.

## Variants

A **variant** is a named, frozen snapshot of a workflow's definition plus
per-variant tweaks (agent prompt/model deltas, execution-model and rotation
settings). A variant has a status:

- **draft** — pinnable and usable in an experiment, but never auto-rotated.
- **active** — competes in the rotation.
- **paused** / **retired** — out of rotation (retired keeps its stats).

## Rotation

Rotation is **explicit opt-in**. Once a flow has at least one active variant with
weight (optionally including its baseline), each new launch of that flow gets a
weighted-random assignment to one of the arms — unless you pin a specific variant
or the baseline for that launch. A running rotation over two or more arms is
itself tracked as an experiment.

## Side-by-side experiments

You can also run a **head-to-head** experiment: the same idea/spec is run down two
arms against a fixed base commit, sandboxed so their entities don't collide. When
both finish, cyboflow can **pairwise-grade** them and mint a decision asking you
to pick the winner. Deciding folds the winning arm's work in and dismisses the
loser; you can also rerun a fresh head-to-head or promote both variants into the
rotation.

## Insights

Per-variant rotation stats and experiment results live in the **Insights** view
(the "Experiments" section), where you compare arms side by side. The **Compound**
flow is also launched from Insights, to mine merged work for learnings.`,
  },
};
