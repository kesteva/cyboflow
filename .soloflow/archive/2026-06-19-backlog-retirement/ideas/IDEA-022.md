---
id: IDEA-022
type: FEATURE
status: approved
created: 2026-05-21T14:00:00Z
source: architecture_audit_2026-05-21
slices:
  - title: "Wire `cyboflow.runs.getStuckInspection` to a real handler"
    description: "Today `cyboflow.runs.getStuckInspection` (`main/src/orchestrator/trpc/routers/runs.ts:236-251`) throws `NOT_IMPLEMENTED`. The renderer's `StuckInspectorModal` (`frontend/src/components/ReviewQueue/StuckInspectorModal.tsx`) already calls it on mount, so any user clicking 'Why is this run stuck?' sees a visible tRPC error. The canonical synchronous handler `getStuckInspectionHandler(db, runId)` already exists in the legacy tree at `main/src/trpc/routers/runs.ts:88`, fully covered by `main/src/orchestrator/__tests__/inspectorQueries.test.ts`. Wire-up requires `ctx.db` access — which TASK-706 (approval-router epic) is landing for the approvals router. This slice rides TASK-706's Pattern A wiring, ports the handler out of the legacy tree (so the future tree deletion in EPIC-trpc-cutover-and-legacy-tree-cleanup is a clean directory rm), and maps `null` (run not found) to `TRPCError NOT_FOUND`."
    value_statement: "Unblocks the stuck-inspector modal UX — a load-bearing surface for users who hit the cross-workflow review queue and need to understand why an agent is stuck. Without this, opening the modal surfaces an unhelpful generic tRPC error."
  - title: "Wire `cyboflow.runs.list` to return workflow_runs for a project"
    description: "Today `cyboflow.runs.list` in `main/src/orchestrator/trpc/routers/runs.ts` throws `NOT_IMPLEMENTED`. The renderer reaches the same data through the raw-IPC channel `cyboflow:listRuns` (`main/src/ipc/cyboflow.ts:128`). This slice lights up the tRPC procedure with a `ctx.db`-backed `SELECT ... FROM workflow_runs WHERE project_id = ? ORDER BY created_at DESC` query, excluding the heavy `policy_json` column. It promotes `WorkflowRunListRow` from `frontend/src/utils/cyboflowApi.ts` to `shared/types/workflows.ts` so both transports share one shape, and leaves the raw-IPC handler in place (renderer cutover lives in EPIC-trpc-cutover-and-legacy-tree-cleanup)."
    value_statement: "Provides the typed counterpart needed before the renderer can migrate off the raw-IPC channel. Locks the read-side shape against drift between the two transports."
  - title: "Wire `cyboflow.workflows.list` and `.get` to WorkflowRegistry"
    description: "Today `cyboflow.workflows.list` and `cyboflow.workflows.get` throw `NOT_IMPLEMENTED` via `throwNotImplemented('workflow-runs')`. The renderer's `WorkflowPicker.tsx` reaches the same data through the raw-IPC `cyboflow:listWorkflows` channel which delegates to `services.cyboflow.workflowRegistry` and auto-seeds the 5 SoloFlow defaults via `buildDefaultSoloFlowWorkflows(resolveSoloFlowPluginRoot(os.homedir()).root)` if the project has none. This slice wires both procedures through a narrow `WorkflowRegistryLike` interface added to `ContextDeps`, preserves the auto-seed behavior, and maps unknown ids to `TRPCError NOT_FOUND`. The `cyboflow.workflows.get` procedure has zero current callers in the renderer but is implemented anyway since the contract is small and locked."
    value_statement: "Same value as the previous slice for the workflows side — typed read surface required before the renderer can cut over off raw IPC."
open_questions: []
assumptions:
  - "TASK-706 (approval-router epic) is in-flight and will land Pattern A (`ctx.db` on `ContextDeps`) before any of these three slices merge — see TASK-706's AC #1 which extends `ContextDeps` with `db?: DatabaseLike`."
  - "`WorkflowRegistry` lives at `main/src/orchestrator/workflowRegistry.ts` (inside the orchestrator subtree, not under `services/`). Its own imports respect the standalone-typecheck invariant (no electron / better-sqlite3 / services/* value imports)."
  - "The renderer cutover from raw IPC to typed tRPC happens in a separate epic (EPIC-trpc-cutover-and-legacy-tree-cleanup / IDEA-023). None of these three slices delete the raw-IPC handlers in `main/src/ipc/cyboflow.ts` — they only add the typed counterparts."
research_recommendation: not_needed
research_rationale: "All three slices wire existing handlers/SQL into existing tRPC stubs. The canonical handler already exists for slice 1; the SQL reference is right there in `cyboflow.ts` for slice 2; the WorkflowRegistry surface is already in use by the raw-IPC handler for slice 3. No external research needed."
---

# Workflow-runs read-side tRPC procedures

## Context

The 2026-05-21 ARCHITECTURE.md audit (see `docs/ARCHITECTURE.md` and the companion `docs/ARCHITECTURE-diagram.md`) identified three throwing tRPC stubs the renderer already calls in production but has no real implementation:

- `cyboflow.runs.getStuckInspection` (called by `StuckInspectorModal`)
- `cyboflow.runs.list` (typed counterpart of live raw IPC `cyboflow:listRuns`)
- `cyboflow.workflows.list` / `.get` (typed counterpart of live raw IPC `cyboflow:listWorkflows`)

All three are blocked on the same precondition: `ctx.db` is not yet wired into the tRPC context. TASK-706 (approval-router epic) is wiring it for `approvals.*`; once it lands, these three slices ride the same plumbing.

## Raw Input

Audit identified items #7-#8 in "Not scoped — needs task(s)" during the 2026-05-21 architecture review:

> 1. **`cyboflow.runs.getStuckInspection`** — throws `NOT_IMPLEMENTED`. `StuckInspectorModal` calls it in production. Zero matches anywhere under `.soloflow/active/`.
> 2. **`cyboflow.runs.list`** — throws `NOT_IMPLEMENTED`. Only mentioned in the epic doc as an end-to-end *smoke-test fixture*, not as a thing to implement.
> 3. **`cyboflow.workflows.list`** — same shape as #2.
>
> *(User during the same session: "go ahead and call the task-refiner for the three tasks")*

## Grounding

Each slice has a refined task plan under `.soloflow/active/plans/orchestrator-and-trpc-router/`:

- Slice 1 → TASK-709 (getStuckInspection)
- Slice 2 → TASK-710 (runs.list)
- Slice 3 → TASK-711 (workflows.list + .get)

All three are placed under the existing `orchestrator-and-trpc-router` epic rather than a new `workflow-runs-read-side` epic, to avoid epic fragmentation (the orchestrator-and-trpc-router epic already owns the tRPC router shape; filling its stubs naturally extends it).

All three use **Pattern A** (extend `ContextDeps` with the needed collaborator — `db` from TASK-706 for slices 1 & 2; `workflowRegistry?: WorkflowRegistryLike` added by slice 3) for consistency. No module-level `set*Deps()` setters are introduced.
