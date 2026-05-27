---
id: IDEA-027
type: FEATURE
status: answered
created: 2026-05-27T16:45:00Z
epics:
  - session-lifecycle-unification
slices:
  - title: "Branch-bound session lifecycle"
    description: "Sessions stay open and interactive until the user merges/PRs or discards the branch. Workflow runs complete normally within a session but the session's panels (Claude + Terminal) remain live for ad-hoc chat or starting another run. The UI must not clear the interaction surface when a run completes."
    value_statement: "Today a completed run leaves the user staring at an empty 'Choose a workflow' screen even though the session's worktree is still active. Keeping the session interactive lets users iterate naturally — run a workflow, review the output, ask follow-up questions, run another workflow — all in the same branch."
  - title: "Quick sessions create a workflow_runs row for approval routing"
    description: "Rewrite sessions:create-quick to INSERT a workflow_runs row so quick sessions participate in the existing ApprovalRouter flow with the same review-queue UI. Remove the permissionMode:'ignore' workaround. Use a sentinel '__quick__' workflow row per project to satisfy the workflow_id NOT NULL FK."
    value_statement: "Without a workflow_runs row, ApprovalRouter's guarded UPDATE throws RunNotRunningError and quick sessions skip all permission review. Creating the row makes quick sessions first-class participants in the existing approval pipeline."
  - title: "Quick sessions always create both Claude and Terminal panels"
    description: "Remove the 'Chat vs Terminal' mode picker. Every quick session creates both a Claude panel and a Terminal panel against the same worktree. Claude panel is the default active panel."
    value_statement: "The mode picker forces an upfront choice that's wrong half the time. Both panels always available matches how workflow-run sessions work and removes a decision the user shouldn't have to make."
open_questions:
  - question: "Should 'ready' be a new workflow_runs.status value, or should runs stay in 'running' after Claude drains?"
    answer: "Neither — runs complete normally. The session stays open (branch-bound lifecycle). No new run status needed. The UI just needs to keep session panels alive between runs."
  - question: "What does 'dismiss' look like in the UI?"
    answer: "No dismiss concept for runs. Sessions close when the user merges/PRs the branch or discards it. These are existing sidebar actions."
  - question: "For the quick-session workflow_runs row: should it share the full workflow_runs state machine or use a lightweight surrogate?"
    answer: "Use the full workflow_runs table with a sentinel '__quick__' workflow row per project to satisfy the FK."
  - question: "When both Claude and Terminal panels are always created, what is the default active panel on open?"
    answer: "Claude panel active by default."
assumptions:
  - assumption: "A sentinel '__quick__' workflow row per project can satisfy the workflow_id NOT NULL FK without schema changes."
    confidence: high
    validation: "workflow_runs.workflow_id is TEXT NOT NULL FK to workflows(id). Creating a workflows row with id='__quick__' per project at project creation time satisfies the constraint."
  - assumption: "sessions.run_id column already exists (migration 009) and is nullable, so linking a quick session to a workflow_runs row requires only an UPDATE."
    confidence: high
    validation: "Confirmed from 009_sessions_run_id.sql."
  - assumption: "permissionMode:'ignore' in useQuickSession.ts is the only place that bypasses PreToolUse for quick sessions."
    confidence: medium
    validation: "claudeCodeManager.ts conditionally omits PreToolUse hook when permissionMode is 'ignore'."
  - assumption: "Retiring toolType:'none' will not break existing active sessions."
    confidence: medium
    validation: "Existing sessions with toolType='none' in the database need auditing before removal."
  - assumption: "RunBottomPane's Chat tab (RunChatView) already supports rendering after a run completes — the gap is only that CyboflowRoot hides it."
    confidence: high
    validation: "RunChatView has a branch for runId===null + activeQuickSessionId!==null. RunBottomPane renders Chat tab when activeRunId is set."
research_recommendation: not_needed
research_rationale: "All open questions are answered. Implementation is purely codebase-internal — no external libraries or APIs involved."
---

# Session Lifecycle Unification

## Core Model

**Session** = worktree + branch. Stays open until the user merges/PRs or discards the branch.

**Workflow run** = one execution within a session. Completes normally; the session stays open for more runs or ad-hoc chat.

**Quick session** = a session without a pre-defined workflow. Same branch-based lifecycle. Gets a workflow_runs row via a sentinel workflow so it participates in approval routing.

## Grounding

**Relevant files:**

- `main/src/orchestrator/approvalRouter.ts` — `requestApproval` makes guarded `UPDATE workflow_runs SET status='awaiting_review' WHERE id=? AND status='running'`. Quick sessions have no row → throws `RunNotRunningError`.
- `main/src/orchestrator/runExecutor.ts` — Calls `onLifecycleTransition(runId, 'completed')` when SDK drains. Run completes; but today CyboflowRoot clears the UI.
- `main/src/database/migrations/006_cyboflow_schema.sql` — `workflow_runs.workflow_id TEXT NOT NULL` FK to `workflows(id)`.
- `main/src/database/migrations/009_sessions_run_id.sql` — `sessions.run_id TEXT` (nullable).
- `frontend/src/hooks/useQuickSession.ts` — Hardcodes `permissionMode: 'ignore'`. Creates one panel type only.
- `frontend/src/components/cyboflow/CyboflowRoot.tsx` — Renders mode picker; shows empty state when `activeRunId` is null.
- `frontend/src/components/cyboflow/RunBottomPane.tsx` — Chat tab already wired to `RunChatView`.
- `main/src/ipc/session.ts` — `sessions:create-quick` handler, line 323. No workflow_runs row created.

## Slices

### Slice 1: Branch-bound session lifecycle

The UI must keep session panels alive between runs. When a workflow run completes, the session's Claude and Terminal panels stay interactive. The user can start another workflow run in the same session, or keep chatting ad-hoc. Session closes only when the branch is merged/PR'd or discarded (existing sidebar actions).

Key changes: CyboflowRoot must not fall back to empty state when `activeRunId` is null — if the session is still open, show its panels. RunBottomPane's Chat tab must remain interactive after run completion.

### Slice 2: Quick sessions create a workflow_runs row

Create a sentinel `__quick__` workflow row per project (at project creation time or lazily on first quick session). `sessions:create-quick` INSERTs a `workflow_runs` row using this sentinel workflow_id, then backfills `sessions.run_id`. Remove `permissionMode: 'ignore'` workaround from `useQuickSession.ts`.

Key changes: New `ensureQuickWorkflow(projectId)` helper. `sessions:create-quick` IPC handler creates workflow_runs row. `useQuickSession.ts` stops hardcoding permission mode. Quick sessions appear in review queue for approval routing.

### Slice 3: Quick sessions always create both panels

Remove the Chat/Terminal mode picker from CyboflowRoot. `useQuickSession.start()` takes no argument; always creates both a Claude panel and a Terminal panel. Claude panel is default active.

Key changes: `useQuickSession.ts` — remove `toolType` parameter, create both panels. `CyboflowRoot.tsx` — remove `isQuickModePickerOpen` state and inline picker UI. Replace Quick Session button with direct `quickSession.start()` call.

## Open Questions

All answered — see frontmatter.

## Assumptions

See frontmatter. Key risk: the sentinel workflow row approach needs validation against the `workflows` schema to ensure no required columns beyond `id` and `name` block the INSERT.
