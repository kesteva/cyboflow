---
id: TASK-600
idea: SPRINT-009-compound
status: ready
created: 2026-05-15T00:00:00Z
files_owned:
  - main/src/ipc/cyboflow.ts
  - docs/ARCHITECTURE.md
  - main/src/orchestrator/trpc/routers/runs.ts
  - main/src/orchestrator/trpc/routers/approvals.ts
  - main/src/orchestrator/trpc/routers/workflows.ts
files_readonly:
  - main/src/orchestrator/trpc/router.ts
  - main/src/orchestrator/trpc/ipcAdapter.ts
  - main/src/orchestrator/trpc/routers/events.ts
  - main/src/index.ts
  - main/src/ipc/index.ts
  - main/src/ipc/__tests__/cyboflow.test.ts
  - frontend/src/utils/cyboflowApi.ts
  - .soloflow/active/findings/SPRINT-009-findings.md
acceptance_criteria:
  - criterion: "docs/ARCHITECTURE.md states explicitly which transport (tRPC vs raw IPC) owns the cyboflow.* surface and references the surviving file"
    verification: "grep -n 'cyboflow' docs/ARCHITECTURE.md returns at least one paragraph that names the chosen transport (the words 'tRPC' or 'raw IPC' must appear within 3 lines of the cyboflow paragraph)"
  - criterion: "Each cyboflow tRPC router file (runs.ts, approvals.ts, workflows.ts) either delegates to the raw-IPC handler set OR contains a non-placeholder implementation; no router proc remains as a NOT_IMPLEMENTED throw whose underlying logic now lives elsewhere"
    verification: "grep -rn 'NOT_IMPLEMENTED\\|throwNotImplemented' main/src/orchestrator/trpc/routers/runs.ts main/src/orchestrator/trpc/routers/approvals.ts main/src/orchestrator/trpc/routers/workflows.ts returns 0 matches OR every remaining match is annotated `// pending TASK-XXX (epic 7)` with a real future task ID"
  - criterion: "main/src/ipc/cyboflow.ts and the tRPC runs/approvals/workflows routers do not BOTH expose the same conceptual procedure (`startRun`, `listWorkflows`, `approveRun`) — exactly one transport owns each"
    verification: "manual: for each procedure (listWorkflows, startRun, approveRun) confirm exactly one of {ipc/cyboflow.ts handler block, trpc/routers/{runs,approvals,workflows}.ts proc body} is non-stub"
  - criterion: "All existing tests continue to pass after the transport decision lands"
    verification: "pnpm --filter main test exits 0 and pnpm --filter main typecheck exits 0"
depends_on: []
estimated_complexity: medium
epic: orchestrator-and-trpc-router
test_strategy:
  needed: false
  justification: "This is a documentation + architectural-decision task plus a redundancy-deletion sweep. The behavior surface is unchanged — the existing test suite (cyboflow.test.ts, router.test.ts) already exercises the surviving handlers; no new tests are needed because no new logic is added. If the decision is to keep raw IPC, the existing cyboflow.test.ts suite continues to be the contract; if the decision is to move to tRPC, that move belongs to a follow-up task with its own test_strategy. Sibling tests (router.test.ts, cyboflow.test.ts) must remain green; that is enforced by the final AC running pnpm --filter main test."
---

# Decide and document transport layer (tRPC vs raw IPC) for cyboflow.*

## Objective

The repo currently has TWO live surfaces for the `cyboflow.*` procedures: `main/src/ipc/cyboflow.ts` (raw `ipcMain.handle` for `cyboflow:listWorkflows`, `cyboflow:startRun`, `cyboflow:approveRun`) AND `main/src/orchestrator/trpc/routers/{runs,approvals,workflows}.ts` (tRPC procs that throw `NOT_IMPLEMENTED`). The orchestrator-and-trpc-router epic spec calls for tRPC, but the workflow-runs-and-day3-gate epic shipped raw IPC because tRPC bodies were placeholders. This task forces the decision, documents it in ARCHITECTURE.md, and removes the duplicate that is NOT chosen — leaving exactly one transport per procedure to prevent future-developer confusion.

## Implementation Steps

1. **Pick the surviving transport.** Recommended decision: KEEP raw IPC (`ipc/cyboflow.ts`) for now; DOCUMENT tRPC routers as planned but currently non-functional placeholders annotated `// pending epic-7` (or whichever epic actually wires them). Rationale: the orchestrator substrate epic shipped the tRPC SHAPE and bridge but every proc body is a placeholder, while raw IPC is what the renderer (`cyboflowApi.ts`) actually calls today. Reversing direction is a multi-task migration, not a code-review fix. Document this decision explicitly.
2. Update `docs/ARCHITECTURE.md`: in the IPC Layer section (around line 52), add a paragraph titled "cyboflow.* transport status" that says: (a) raw IPC handlers in `main/src/ipc/cyboflow.ts` own the cyboflow.* surface today; (b) the tRPC routers under `main/src/orchestrator/trpc/routers/` carry the SHAPE of the v2 contract but every proc body is a placeholder; (c) the migration from raw IPC to tRPC is owned by a future epic — name a placeholder TASK ID like `TBD-tRPC-cutover` if no real one exists; (d) until then, the `cyboflowApi.ts` renderer wrapper routes via `electron.invoke`, not via the tRPC client.
3. Open each of `main/src/orchestrator/trpc/routers/runs.ts`, `approvals.ts`, `workflows.ts`. For each procedure body that throws `NOT_IMPLEMENTED`, add an inline comment `// PLACEHOLDER — raw-IPC equivalent in main/src/ipc/cyboflow.ts is the live surface. Migration owner: TBD.` Annotate but do NOT delete; the tRPC SHAPE is contract documentation that downstream epic 7 needs.
4. In `main/src/ipc/cyboflow.ts`, update the file's top-of-file comment block to remove or correct the language "When epic 6 (orchestrator-and-trpc-router) lands, replace the lazy-init blocks with proper singletons" since epic 6 has landed and the lazy-init refactor is its own task (TASK-608, B11). Replace with: "Lazy-init singletons remain pending TASK-608 (B11). tRPC routers under main/src/orchestrator/trpc/routers/ are placeholders; this raw-IPC surface is the live transport for cyboflow.* procedures."
5. Run `pnpm --filter main typecheck` and `pnpm --filter main test` to confirm no regression. The change is comment-only in the tRPC routers and ipc/cyboflow.ts; no behavior changes.
6. Cross-link this decision: in `frontend/src/utils/cyboflowApi.ts` find the comment `When tRPC lands in epic 6, swap the internals` and rewrite it to `Currently routes through the raw-IPC bridge; tRPC migration is a separate future task (see docs/ARCHITECTURE.md cyboflow.* transport status).`

## Acceptance Criteria

See frontmatter. Critically, the post-task state is unambiguous: a developer reading either side of the dual surface (raw IPC or tRPC routers) finds a comment pointing at ARCHITECTURE.md and at the surviving live transport. No procedure has TWO live implementations.

## Test Strategy

`needed: false` — comment-only and doc-only changes. The existing `cyboflow.test.ts` and `router.test.ts` suites remain the contract for the chosen transport; both must stay green per the final AC.

## Hardest Decision

Picking raw IPC over tRPC. The orchestrator epic spec called for tRPC and the AppRouter shape is already in place. But raw IPC is what the renderer actually calls today, and the day-3 gate test passes against raw IPC. Reversing direction would mean (a) writing real tRPC proc bodies that delegate to `WorkflowRegistry`/`RunLauncher`, (b) updating `cyboflowApi.ts` to use the tRPC client, (c) coordinating the wrapper-storage fix with the tRPC subscription mechanism, (d) re-running the day-3 gate. That is a multi-task migration, not a 1-day fix. Better to LOCK the current state and let a follow-up sprint own the cutover, with the placeholder comments preventing silent drift in the meantime.

## Rejected Alternatives

- **Delete the tRPC routers entirely.** Rejected because the AppRouter type is exported and consumed (or will be) by the renderer for future tRPC subscriptions; deleting them means losing the documented v2 shape. Would change my mind if no downstream code imported `AppRouter`.
- **Implement the tRPC procs now and delete the raw IPC handlers.** Rejected as out of scope — that is a 5+ task migration deserving its own sprint, not a code-review followup. If the next sprint picks it up, the placeholder comments make the migration target obvious.

## Lowest Confidence Area

Whether the day-3 gate test or the events.ts subscription pattern needs tRPC to land first. The events router uses a `makePlaceholderAsyncIterator` that yields nothing — once a real publisher exists (TASK-602), the renderer needs to subscribe through SOMETHING. If the renderer ends up using `electron.on('cyboflow:stream:<runId>', ...)` per TASK-599, the tRPC events router is effectively dead until v2; if instead the renderer migrates to `trpc.cyboflow.events.onStreamEvent.subscribe(...)`, the events router is the transport. TASK-602 should resolve which side is canonical for stream events; this decision task locks only the request/response procs, not the subscriptions.
