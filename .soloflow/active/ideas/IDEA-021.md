---
id: IDEA-021
type: DEFECT
status: draft
created: 2026-05-20T23:10:00Z
source: user_discovery_during_sdk_migration_smokes
slices:
  - title: "ApprovalRouter does not insert approval row when PreToolUse hook fires"
    description: "The PreToolUse hook in ClaudeCodeManager.makePreToolUseHook now fires correctly (confirmed via DIAG-hook logging after the settingSources: ['project'] fix landed in commit e5ecef9). The hook calls routePreToolUseThroughApprovalRouter → ApprovalRouter.getInstance().requestApproval(runId, toolName, ...). requestApproval's documented contract is: atomic UPDATE workflow_runs SET status='awaiting_review' + INSERT INTO approvals, both in a single db.transaction(), then return a Promise<ApprovalDecision> that resolves when respond() is called. Observed behavior: hook fires, but no approval row appears in the approvals table, workflow_runs.status stays at 'running' (not 'awaiting_review'), and the [ClaudeCodeManager] PreToolUse hook failed for {tool} error log line in routePreToolUseThroughApprovalRouter's catch never appears either. The SDK retries the same tool call every ~10 minutes (default hook timeout) indefinitely. Either the txn is hanging mid-flight, the per-run p-queue is deadlocking, or the catch's logger?.error is silently swallowed because loggerLike is undefined."
    value_statement: "Without this, no workflow run can ever execute tool calls end-to-end. Every tool the agent wants to use will time out, the agent will stall, and the run will eventually hit some larger timeout or sit forever. This is the gating issue between 'SDK substrate works' and 'cyboflow workflow runs are actually usable.'"
  - title: "Frontend tRPC subscription onApprovalCreated dies on Symbol.asyncDispose polyfill clash"
    description: "On every dev launch the renderer logs '[reviewQueueStore] onApprovalCreated subscription error: TRPCClientError: Symbol.asyncDispose already exists (reviewQueueStore.ts:61)'. The subscription is the only delivery channel from the backend's ApprovalRouter emit('approvalCreated') to the review queue UI. With this dead, even if slice 1 above is fixed and approval rows land in the DB correctly, the UI never receives the event and the user has no way to approve from the queue. Root cause is a polyfill clash on Symbol.asyncDispose — newer Node versions define it natively while some tRPC/superjson/etc. dependency tries to install it. The file frontend/src/stores/reviewQueueStore.ts is from SPRINT-010 (unchanged in SPRINT-026), so this is pre-existing — but it became a hard blocker once smoke testing surfaced the workflow-run end-to-end requirement. Sibling subscription onStuckDetected also dies with 'No subscription-procedure on path cyboflow.events.onStuckDetected' — implies the tRPC subscription router is incomplete or stale."
    value_statement: "Pairs with slice 1 — fixing the backend half without the renderer half leaves approvals invisible. Until this is fixed, headless workflow runs are the only practical mode; interactive approval is broken."
  - title: "Extend StreamEvent union to cover additional synthetic + SDK event shapes"
    description: "FIND-SPRINT-026-16 / TASK-685 (B2 in the SPRINT-026 compound) already covers extending the StreamEvent.type union and adding a row component for the synthetic run_started event. Smoke 5 testing surfaced four more event shapes that currently render as the orange 'Unrecognized event' card: (a) session_info — orchestrator-side synthetic emitted by ClaudeCodeManager.spawnCliProcess at claudeCodeManager.ts:251 with the resolved initial_prompt + worktree metadata; (b) rate_limit_event — real SDK event with status/resetsAt/overageStatus payload; (c) system/hook_started — real SDK subtype not currently in the schema (only init + compact_boundary are modeled); (d) system/hook_response — same; (e) system/status — same. TASK-685's plan should be expanded to cover all five, or a sibling task TASK-686 (per the existing testing-infrastructure epic numbering) created."
    value_statement: "Every Unknown card in RunView is a missed opportunity to surface useful context to the user. session_info in particular contains the worktree path + model + permission mode and should render as a 'Run started' summary header. The five-shape gap means roughly 5 of the first ~15 events in any workflow run currently render as visual noise."
open_questions:
  - question: "Slice 1 — what is actually happening inside requestApproval that prevents the INSERT? Hypotheses: (a) the per-run PQueue.add never executes because the queue is somehow paused; (b) the better-sqlite3 transaction throws on a constraint we're not catching; (c) the loggerLike passed through routePreToolUseThroughApprovalRouter is undefined, so the catch's error log silently swallows a thrown error and returns deny."
    candidates:
      - "Probe with a console.error inside requestApproval before/after the txn.run() and before/after the queue.add to localize where the hang/silent-fail happens"
      - "Add explicit assertions: assert(this.db !== undefined) inside requestApproval; assert(loggerLike !== undefined) inside routePreToolUseThroughApprovalRouter"
      - "Run a unit test with a real db handle that exercises the full PreToolUse → requestApproval → INSERT path; existing tests at main/src/orchestrator/__tests__/approvalRouter.test.ts may need a fixture that mirrors the real workflow_runs row state"
  - question: "Slice 2 — is the Symbol.asyncDispose clash from tRPC itself, superjson, or another transitive dep? Pin the upstream and either pin/upgrade the version or add an explicit Symbol.dispose / Symbol.asyncDispose polyfill check."
    candidates:
      - "Run pnpm why @trpc/server @trpc/client superjson to find which dependency introduces the asyncDispose polyfill"
      - "Pin a known-working tRPC version that doesn't conflict with Node 22's native Symbol.asyncDispose"
      - "Add a defensive `if (!('asyncDispose' in Symbol)) { Object.defineProperty(Symbol, 'asyncDispose', { value: Symbol('asyncDispose') }) }` shim before the tRPC client initializes"
  - question: "Slice 3 — should session_info be promoted from a synthetic descriptor to a first-class StreamEvent variant with its own row component, OR should it be filtered at the orchestrator emission point so it never reaches the renderer as a stream event?"
    candidates:
      - "Promote — render as a 'Run started' header card with model/cwd/permission_mode summary"
      - "Filter at the orchestrator — emit only as a structured run metadata channel, not via the stream event firehose"
      - "Defer to IDEA-017 (shell layout) — depending on where run metadata surfaces in the final design, session_info may not need to be a stream event at all"
assumptions:
  - "The two SPRINT-026 fixes (await iteratorDone — commit eaca3de — and settingSources: ['project'] — commit e5ecef9) are correct and shipping. Workflow runs now reach the PreToolUse hook; this idea covers everything from that point forward."
  - "ApprovalRouter's contract (workflow_runs status='running' → UPDATE atomically to 'awaiting_review' on requestApproval; status='awaiting_review' → UPDATE atomically to 'running' on respond('allow'); workflow_runs.status returns to 'running' so transitionToCompleted's fromStatus='running' guard succeeds on iterator drain) is the intended design — the bug in slice 1 is an implementation gap, not a design flaw."
  - "Smoke 5 (AC#17) was technically satisfied during this session — workflow run be0a3d6d emitted real SDK events (system, assistant, stream_event, result, rate_limit_event), passing the '≥2 distinct event types beyond run_started' bar — but the workflow itself could not complete because of slice 1. Update the human-review-queue's TASK-683 entry to reflect 'AC#17 met-events, blocked-completion'."
research_recommendation: not_needed
research_rationale: "All three slices are debugging tasks against code we own. The hypotheses in open_questions can be validated by adding instrumented logs in the candidate code paths, running a single workflow, and reading the log output. No external research is needed."
---

# Complete workflow-run end-to-end after SPRINT-026 SDK migration

## Context

Surfaced 2026-05-20 while testing SPRINT-026 (Claude Agent SDK migration) Smoke 5 (AC#17, `docs/sdk-migration-smoke-results.md`). Two real fixes landed during the session — both are merged at the time of writing:

- **commit `eaca3de`** — `fix: await SDK iterator drain in ClaudeCodeManager.spawnCliProcess`. Without this, `runExecutor.execute()` raced ahead of the SDK iterator and called `transitionToCompleted` (running → completed) within 1 second of run start, so every subsequent PreToolUse hook fired against a `status='completed'` row and was rejected by ApprovalRouter with `RunNotRunningError`. Confirmed by DB inspection of run `a4f4534…` showing `started_at IS NULL` and status flipped to `completed` 1s after `created_at`.
- **commit `e5ecef9`** — `fix: scope SDK settingSources to project in ClaudeCodeManager`. Without this, `~/.claude/settings.json` (`defaultMode: 'auto'` + a long `Bash(...)` allow list) auto-approved tool calls server-side before the SDK could fire our PreToolUse hook, so ApprovalRouter never saw the request. The hook now fires for every Bash call as expected.

With those two in place, the workflow run reaches the PreToolUse hook. But three blockers remain before workflow runs are truly end-to-end usable:

1. The hook fires, but `ApprovalRouter.requestApproval` doesn't insert an approval row.
2. The renderer can't subscribe to `onApprovalCreated` (Symbol.asyncDispose polyfill clash).
3. Multiple event shapes (synthetic + real SDK) render as Unknown cards.

## Raw Input

> User during smoke testing 2026-05-20: "go ahead and kill the processes" / "It looks like there's a live dev build, but can you make sure it's current?" / "lets actually try to fix this right now. I really want to be able to test with a real workflow" / "No tool permission yet" / "I don't see a UI prompt to approve" / "C" (stop and file findings for the rest)

## Grounding

Not yet grounded — run `/soloflow:planner IDEA-021` to refine. Each slice can probably become its own task; slice 1 is the most blocking and should land first.

**Sequencing:**
- Slice 1 (approval insert) and slice 2 (renderer subscription) MUST both land before workflow runs can complete end-to-end with the interactive approval flow. They can be developed in parallel.
- Slice 3 (StreamEvent union extension) is a polish item that overlaps with TASK-685. Coordinate with whoever picks up TASK-685 to either fold these in or sequence a follow-up task.
- IDEA-020 (discoverable "+ Claude" button) is orthogonal — independent surface area, can ship anytime.

## Slices

See frontmatter.
