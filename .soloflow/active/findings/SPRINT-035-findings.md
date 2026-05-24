---
sprint: SPRINT-035
pending_count: 13
last_updated: "2026-05-24T01:21:47.233Z"
---
# Findings Queue

## FIND-SPRINT-035-1
- **source:** TASK-709 (code-reviewer)
- **type:** cleanup
- **severity:** low
- **status:** open
- **location:** shared/types/stuckInspection.ts:5
- **description:** The header docblock still names `main/src/trpc/routers/runs.ts (getStuckInspectionHandler + re-export)` as the handler's home and lists "an import cycle that would otherwise exist between the two router files." After TASK-709, the handler now lives in `main/src/orchestrator/inspectorQueries.ts`, the legacy `main/src/trpc/routers/runs.ts` no longer hosts it, and the cycle motivation is obsolete. The file is out of TASK-709's diff (in `files_readonly`), so the stale comment was not corrected in this task. TASK-717 (legacy-tree deletion) is a natural place to refresh this header — at that point the bullet list collapses to a single canonical handler location.
- **suggested_action:** When TASK-717 runs, rewrite the file-header docblock to list `main/src/orchestrator/inspectorQueries.ts` as the handler home and drop the import-cycle paragraph (cycle no longer possible — legacy tree is gone).
- **resolved_by:** 

## FIND-SPRINT-035-2
- **type:** bug
- **source:** TASK-710 (executor)
- **severity:** medium
- **status:** resolved
- **location:** main/src/orchestrator/trpc/__tests__/router.test.ts:87,143
- **description:** TASK-710 changed cyboflow.runs.list input schema from z.object({ projectId: z.string().optional() }) to z.object({ projectId: z.number().int().positive() }). Two tests in router.test.ts (owned by TASK-711) now fail: (1) line 87 passes {} and expects METHOD_NOT_SUPPORTED but gets BAD_REQUEST; (2) line 143 same call expects METHOD_NOT_SUPPORTED code. Both tests also fail TypeScript type checking. TASK-711 must update or remove these two stale assertions when it modifies router.test.ts.
- **suggested_action:** In TASK-711, update or remove the two runs.list stale assertions in router.test.ts: the test at line 87 (cyboflow.runs.list throws NOT_IMPLEMENTED) and the test at line 139 (protectedProcedure accepts a context — asserts METHOD_NOT_SUPPORTED from runs.list({})).
- **resolved_by:** verifier — AC-prescribed: TASK-710's AC9 (pnpm typecheck must exit 0) forced the consumer-test edit in commit 2742847; assertions at lines 87 and 141 were updated/removed to match the new input schema, and the full main test suite (662 tests) now passes. The follow-up TASK-711 no longer needs to fix these — it can pick up other tests in router.test.ts.

## FIND-SPRINT-035-3
- **source:** TASK-710 (code-reviewer)
- **type:** improvement
- **severity:** low
- **status:** resolved
- **location:** main/src/orchestrator/trpc/__tests__/router.test.ts:87-90
- **description:** The router.test.ts comment claims `cyboflow.runs.list`'s tRPC wrapper guards (FORBIDDEN when `ctx.userId !== 'local'`, PRECONDITION_FAILED when `!ctx.db`) "are covered by integration tests that build a real DB context" — but no such integration test currently exists for `runs.list`. The handler is well covered by `listRunsHandler.test.ts` (4 unit tests), but the guard branches are uncovered. The sibling `runs.getStuckInspection` procedure has parallel guard tests in `main/src/orchestrator/trpc/routers/__tests__/runs.test.ts:158-200` (cases c + d) that mirror exactly what `runs.list` needs. Risk is low because the guard code is mechanically identical to the sibling (same import, same TRPCError codes, same `ctx.userId` / `ctx.db` checks), but the comment overstates the current state.
- **suggested_action:** Add `(c) non-local userId → FORBIDDEN` and `(d) missing ctx.db → PRECONDITION_FAILED` cases to `main/src/orchestrator/trpc/routers/__tests__/runs.test.ts` exercising `caller.cyboflow.runs.list({ projectId: 1 })` — mirroring the existing `getStuckInspection` cases at lines 158-200. Natural pickup for TASK-711 (router.test.ts cleanup task) since it already touches that test directory.
- **resolved_by:** TASK-711

## FIND-SPRINT-035-4
- **source:** TASK-711 (code-reviewer)
- **type:** anti-pattern
- **severity:** low
- **status:** open
- **location:** main/src/orchestrator/trpc/routers/workflows.ts:21,41 and main/src/orchestrator/trpc/routers/approvals.ts (whole file)
- **description:** Principal-scoping enforcement is inconsistent across the orchestrator tRPC routers. `runs.ts` re-asserts `ctx.userId !== 'local'` → `TRPCError FORBIDDEN` at the top of every procedure (list, cancel, cancelAndRestart, getStuckInspection — 4 sites), but the newly-implemented `workflows.list`/`workflows.get` (TASK-711) and the live `approvals.*` procedures rely only on `protectedProcedure`'s `userId` truthiness check. In v1 this is functionally equivalent because `createContext()` hard-codes `'local'`, but the docblock in `context.ts` explicitly anticipates a v2 team-tier swap that replaces `'local'` with a real session principal — at that point the workflows + approvals procedures would silently lose principal scoping while the runs procedures retain it. The TASK-711 plan ACs did not require this guard, so its omission is consistent with the plan and not a TASK-711 regression — it is a pre-existing project-wide inconsistency that the new procedures inherit.
- **suggested_action:** When the v2 session-token swap is planned (or sooner — under a small "tRPC principal-scoping hardening" task), choose one canonical pattern (either lift the `userId !== 'local'` check into a `localOnlyProcedure = protectedProcedure.use(...)` middleware reused everywhere, or remove it from `runs.ts` if it is redundant with the v2 plan) and apply it uniformly across `routers/runs.ts`, `routers/workflows.ts`, and `routers/approvals.ts`.
- **resolved_by:** 

## FIND-SPRINT-035-5
- **type:** scope_deviation
- **source:** TASK-712 (executor)
- **severity:** low
- **status:** resolved
- **location:** main/src/orchestrator/trpc/__tests__/router.test.ts:94
- **description:** required to meet AC: test used projectId: string (old stub schema); after runs.start rewire, schema requires z.number().int().positive(). Test also expected NOT_IMPLEMENTED but now METHOD_NOT_SUPPORTED fires when deps absent. Test updated to match new schema and behavior.
- **resolved_by:** verifier — not actually a scope deviation: `main/src/orchestrator/trpc/__tests__/router.test.ts` is listed in TASK-712's `files_owned` (line 9 of plan). The executor mislabeled an in-scope edit as a deviation. The edit is also AC-prescribed (AC8: typecheck must exit 0 — the old `projectId: 'proj-1'` would have type-failed against the new `z.number().int().positive()` schema).

## FIND-SPRINT-035-6
- **source:** TASK-713 (verifier)
- **type:** scope_deviation
- **severity:** low
- **status:** open
- **location:** main/src/orchestrator/health.ts:23,48
- **description:** TASK-713 commit 943568d edited `main/src/orchestrator/health.ts` — extracted a new `McpLifecycleReadable` interface and changed the `OrchestratorHealth` constructor parameter type from the concrete `McpServerLifecycle` to the new interface. This file is listed in TASK-713's `files_readonly` (line 13 of plan). The edit is NOT mandated by any AC (the ACs only require constructing OrchestratorHealth and wiring setHealthProvider; they do not constrain the parameter type). The motivation was to permit a sentinel lifecycle at boot before epic 7 wires the real `McpServerLifecycle`, but an alternative (e.g. constructing the real `McpServerLifecycle` immediately, or accepting `null`) would have kept `health.ts` untouched. The change is harmless (test stub already satisfies the structural interface) but should be acknowledged.
- **suggested_action:** Verify with the orchestrator whether widening the constructor to an interface is acceptable, or whether the sentinel pattern should be revisited when epic 7 lands.

## FIND-SPRINT-035-7
- **source:** TASK-713 (verifier)
- **type:** claude-md
- **severity:** low
- **status:** open
- **location:** .soloflow/active/findings/SPRINT-024-findings.md
- **description:** The TASK-713 executor created an UNTRACKED file `.soloflow/active/findings/SPRINT-024-findings.md` and logged two scope_deviation entries (FIND-SPRINT-024-2 and FIND-SPRINT-024-3) for `main/src/ipc/types.ts` and `main/src/orchestrator/trpc/routers/health.ts`. Both entries are erroneous: (a) the active sprint is SPRINT-035, not SPRINT-024, so the findings file is misnamed; (b) BOTH files are in TASK-713's `files_owned` (plan lines 9 and 10), so they are NOT scope deviations — adding fields and exports inside an owned file is in-scope by definition. The actual scope deviation (FIND-SPRINT-035-6 above, on `main/src/orchestrator/health.ts`) was not logged. This suggests the executor's findings-logging heuristic may have keyed off filename patterns rather than the plan's `files_owned`/`files_readonly` lists. Worth a CLAUDE.md or executor-prompt clarification.
- **suggested_action:** Compounder: consider adding a brief executor-side check that the resolved sprint id matches the findings filename, and that "scope_deviation" findings are only logged when the touched path is NOT in `files_owned`. The stray SPRINT-024-findings.md file should be deleted (or its two entries triaged + moved to the active sprint) — leaving it untracked is itself a stale artifact.

## FIND-SPRINT-035-8
- **source:** TASK-713 (code-reviewer)
- **type:** cleanup
- **severity:** low
- **status:** resolved
- **location:** main/src/ipc/types.ts:44-53 and main/src/index.ts:650
- **description:** TASK-713 added `orchestratorHealth?: OrchestratorHealth` to `AppServices.cyboflow` and assigns it in `initializeServices()` (line 650), but no code reads `services.cyboflow.orchestratorHealth` anywhere — both the raw-IPC handler (`main/src/ipc/cyboflow.ts:189-195`) and the tRPC procedure (`main/src/orchestrator/trpc/routers/health.ts:55-60`) reach the singleton via the module-level `_health` set by `setHealthProvider`/read by `getHealthProvider`. The plan's AC3 listed two tactics — (a) read via `AppServices`, or (b) defer the singleton until TASK-716 — and the implementation chose a hybrid: singleton-as-truth PLUS a dead carrier field on `AppServices`. The dead field forces `main/src/ipc/types.ts` to import `OrchestratorHealth` from `main/src/orchestrator/health.ts`, adding coupling for no consumer benefit. Either (1) drop the field + import (singleton is the only path), or (2) switch the raw-IPC handler to read via `services.cyboflow.orchestratorHealth?.getMcpServerStatus() ?? HEALTH_STARTING` and drop the `getHealthProvider` export — the latter removes `main/src/ipc/cyboflow.ts`'s dependency on the tRPC router module, a cleaner architecture. Natural pickup for TASK-716 (which already plans `setCyboflowHealth` shim cleanup) — note that TASK-716 will delete the IPC handler entirely, so option (1) becomes the right answer at that point.
- **suggested_action:** In TASK-716, after the raw-IPC `cyboflow:mcp-health` handler is deleted, also remove the now-orphaned `orchestratorHealth?: OrchestratorHealth` field from `main/src/ipc/types.ts:44-53` and drop the `import type { OrchestratorHealth } from '../orchestrator/health';` line, plus the `orchestratorHealth` field from the services assembly in `main/src/index.ts:650`. The module-level `_orchestratorHealth` local and `setHealthProvider(orchestratorHealth)` call (`main/src/index.ts:759`) stay — they remain the canonical wire-up for the tRPC procedure.
- **resolved_by:** TASK-716

## FIND-SPRINT-035-9
- **source:** TASK-713 (code-reviewer)
- **type:** anti-pattern
- **severity:** low
- **status:** open
- **location:** main/src/orchestrator/health.ts:24 and main/src/orchestrator/mcpServer/mcpServerLifecycle.ts:26 and shared/types/mcpHealth.ts:13
- **description:** The status union `'starting' | 'running' | 'failed' | 'stopped'` is now duplicated in THREE locations: (1) `shared/types/mcpHealth.ts:13` (`McpServerHealth.status`), (2) `main/src/orchestrator/mcpServer/mcpServerLifecycle.ts:26` (`McpServerStatus` type export), and (3) `main/src/orchestrator/health.ts:24` (newly added `McpLifecycleReadable.getStatus()` return type, introduced in TASK-713's commit 943568d). If the McpServerLifecycle state machine ever gains a new state (e.g. `'restarting'`), the `McpLifecycleReadable` interface in `health.ts` will silently lag — and the resulting `getMcpServerStatus()` shape would no longer match the lifecycle's actual contract until someone notices and edits the duplicated union. This is the same silent-drop pattern called out in the root CLAUDE.md ("IPC handler ↔ declared `T` parity" — mismatched type vs. handler shape hides field renames from TypeScript). The duplication was probably introduced to preserve the `health.ts` standalone-typecheck invariant ("no imports from main/src/services/*"), but `mcpServer/mcpServerLifecycle.ts` is under `orchestrator/`, not `services/` — and its `McpServerStatus` type export is intentionally re-exported standalone (line 25-26 comment "Re-export for callers that want the status type without importing the class"). Importing `type { McpServerStatus }` would not violate the invariant.
- **suggested_action:** Change `main/src/orchestrator/health.ts:23-26` from the inline union to `import type { McpServerStatus } from './mcpServer/mcpServerLifecycle';` and use `McpServerStatus` in the `McpLifecycleReadable.getStatus()` return type. This collapses one of the three drift surfaces (the remaining duplication between `shared/types/mcpHealth.ts` and `mcpServer/mcpServerLifecycle.ts` is pre-existing and out of scope here). Verify the standalone-typecheck still passes — `McpServerStatus` is a pure type re-export and pulls in no runtime code.
- **resolved_by:** 

## FIND-SPRINT-035-11
- **source:** TASK-714 (verifier)
- **type:** cleanup
- **severity:** low
- **status:** open
- **location:** frontend/src/components/cyboflow/__tests__/RunView.test.tsx:32 (still open) and frontend/src/components/cyboflow/__tests__/CyboflowRoot.test.tsx:22 (resolved by TASK-715)
- **description:** Two test files (not in TASK-714's files_owned) still ship stale `listWorkflows: vi.fn()` entries inside their `vi.mock('../../../utils/cyboflowApi', () => ({ cyboflowApi: { listWorkflows: ... } }))` blocks, but `listWorkflows` no longer exists as a property of the real `cyboflowApi` object after TASK-714. The mocks are harmless dead weight (TypeScript doesn't check vi.mock factory shapes against the real module, and neither test reads the mock's listWorkflows return value) — both files were green in the 336-test run. The plan's AC5 grep (`cyboflowApi.*listRuns|cyboflowApi.*listWorkflows`) returns 0 matches because the strings appear on their own lines without a preceding `cyboflowApi.` reference; the AC's stricter intent ("mocks are removed if the test no longer covers that path") is not quite satisfied. Pickup is trivial — drop the one line from each mock block. Natural piggyback on TASK-715 (which already owns CyboflowRoot.test.tsx for the startRun cutover) or TASK-716 (raw-IPC handler deletion) if those tasks touch these files. Update (TASK-715 verifier): TASK-715 removed the stale entry from CyboflowRoot.test.tsx (the file it owned) but did NOT touch RunView.test.tsx (not in files_owned). RunView.test.tsx:32 still ships `listWorkflows: vi.fn()` and line 33 also ships a stale `startRun: vi.fn()` — both now dead-weight after TASK-715 deleted the real exports. Same dead-weight entries also live in cyboflowStore.test.ts:33 (`startRun: vi.fn()`).
- **suggested_action:** In TASK-716 (or any later task that touches these files), drop the `listWorkflows: vi.fn(),` AND `startRun: vi.fn(),` lines from the `vi.mock('../../../utils/cyboflowApi', ...)` blocks in RunView.test.tsx (lines 32-33) and cyboflowStore.test.ts (line 33). CyboflowRoot.test.tsx is already clean. No test behaviour will change.
- **resolved_by:** partial: TASK-715 (CyboflowRoot.test.tsx only)

## FIND-SPRINT-035-10
- **source:** TASK-714 (verifier)
- **type:** claude-md
- **severity:** medium
- **status:** open
- **location:** .soloflow/active/findings/SPRINT-024-findings.md (FIND-SPRINT-024-4 + FIND-SPRINT-024-5)
- **description:** RECURRENCE of the bug already captured in FIND-SPRINT-035-7. The TASK-714 executor again wrote findings to the misnamed `.soloflow/active/findings/SPRINT-024-findings.md` file (active sprint is SPRINT-035) and again logged "scope_deviation" entries for files that are IN this task's `files_owned`. Specifically: (a) FIND-SPRINT-024-4 logs `frontend/src/test/setup.ts` as a scope deviation, but it is line 12 of TASK-714-plan.md `files_owned`; (b) FIND-SPRINT-024-5 logs `frontend/vitest.config.ts` as a scope deviation, but it is line 13 of TASK-714-plan.md `files_owned` (and the file was not modified anyway — the executor's own note in the finding admits this). Same root cause as FIND-SPRINT-035-5 (TASK-712) and FIND-SPRINT-035-7 (TASK-713): the executor's findings-logging heuristic is not consulting the sprint.json for the active sprint id, nor checking the plan's `files_owned`/`files_readonly` lists before classifying an edit as a deviation. Three consecutive tasks in this sprint (TASK-712, TASK-713, TASK-714) have repeated this exact mistake — strong signal that the executor-prompt guidance is missing or insufficient.
- **suggested_action:** Compounder: prioritize the executor-side fix proposed in FIND-SPRINT-035-7's suggested_action (resolve sprint id from `.soloflow/sprint.json` before opening the findings file; only log `type: scope_deviation` when the touched path is NOT in `files_owned`). The pattern has now repeated 3× in one sprint; this is no longer an isolated incident. As bookkeeping, the stray `.soloflow/active/findings/SPRINT-024-findings.md` file should be deleted (FIND-SPRINT-024-2..5 are all either erroneous or in-scope and out-of-place); the legitimate FIND-SPRINT-024-1 entry from TASK-692 should be migrated to that sprint's archive if it isn't already there.
- **resolved_by:** 

## FIND-SPRINT-035-12
- **type:** scope_deviation
- **source:** TASK-715 (executor)
- **severity:** low
- **status:** open
- **location:** frontend/src/components/__tests__/DraggableProjectTreeView.runs.test.tsx:44,49,53
- **description:** Executor's stated rationale was "required to meet AC5: grep for cyboflowApi.*startRun must return 0 matches" but the AC5 grep is line-based and the original `startRun: vi.fn()` lines (inside the multi-line `cyboflowApi: { … }` block) do NOT match `cyboflowApi.*startRun` on a single line — so AC5 returned 0 matches BEFORE this edit. The edit is defensible cleanup (removes mock entries pointing at a now-deleted export) but is not strictly AC-prescribed and is not in TASK-715's `files_owned`. Tests still pass either way. Verifier-classified as a genuine scope deviation per the plan-prescribed-scope rules.
- **suggested_action:** Future tasks: if a test file outside `files_owned` ships stale mock entries that are functionally dead (no test reads them), prefer to log a separate cleanup FIND for the next plan to pick up rather than claim the file mid-task. Where the cleanup is in-scope-by-AC, cite the specific AC, not the grep that already returns 0.
- **resolved_by:** 

## FIND-SPRINT-035-13
- **type:** claude-md
- **source:** TASK-715 (verifier)
- **severity:** low
- **status:** open
- **location:** docs/VISUAL-VERIFICATION-SETUP.md
- **description:** Peekaboo MCP image() capture against the running Cyboflow Electron window (PID 80782) failed again this task with "Failed to start stream due to audio/video capture failure" on capture_focus=auto, plus "No displays available for capture" on screen:0. This is a recurrence of the SPRINT-033/SPRINT-034 gap already documented under dedup_key=visual_macos_unavailable in the review queue. Project CLAUDE.md and docs/VISUAL-VERIFICATION-SETUP.md describe the per-binary Screen Recording grant requirement, but the gap re-blocks every visual_macos verification attempt because Cyboflow.app (production binary) gets the grant while the dev-time Electron binary at node_modules/electron/dist/Electron.app/Contents/MacOS/Electron does not inherit it.
- **suggested_action:** Compounder: consider adding a one-time bootstrap step or a developer-side post-install script that programmatically grants Screen Recording to the dev-time Electron binary (or documents the exact System Settings path users must follow on first dev launch). Alternatively, document an explicit "skip visual_macos for tRPC-cutover/observability-only tasks" guidance so verifiers don’t spend cycles probing a known-broken path. Either way, the recurrence count is high enough that an ergonomic fix is warranted.

## FIND-SPRINT-035-14
- **type:** scope_deviation
- **source:** TASK-716 (executor)
- **severity:** low
- **status:** resolved
- **location:** main/src/ipc/types.ts:44-53
- **description:** required to meet AC: FIND-SPRINT-035-8 natural pickup — removing dead orchestratorHealth? field and its import from types.ts since the mcp-health handler is deleted in this task, making the field truly orphaned.
- **resolved_by:** verifier — not actually a scope deviation: `main/src/ipc/types.ts` is listed in TASK-716's `files_owned` (line 9 of plan). The executor mislabeled an in-scope edit as a deviation. The edit is also FIND-SPRINT-035-8 pickup, which the finding's suggested_action explicitly assigned to TASK-716 ("In TASK-716, after the raw-IPC `cyboflow:mcp-health` handler is deleted, also remove the now-orphaned `orchestratorHealth?: OrchestratorHealth` field from `main/src/ipc/types.ts`"). Same misclassification pattern as FIND-SPRINT-035-5, -7, -10 — strong reinforcement signal for the executor-prompt fix proposed in FIND-SPRINT-035-10.

## FIND-SPRINT-035-15
- **type:** scope_deviation
- **source:** TASK-716 (executor)
- **severity:** low
- **status:** resolved
- **location:** main/src/index.ts
- **description:** required to meet AC: FIND-SPRINT-035-8 natural pickup — removing dead orchestratorHealth assignment in initializeServices() from main/src/index.ts since the mcp-health handler is deleted and the field is removed from types.ts.
- **resolved_by:** verifier — not actually a scope deviation: `main/src/index.ts` is listed in TASK-716's `files_owned` (line 10 of plan). The executor mislabeled an in-scope edit as a deviation. The edit is also AC-prescribed: with `orchestratorHealth?` dropped from `AppServices.cyboflow` (FIND-SPRINT-035-8 pickup), leaving the assignment would cause a typecheck failure (excess-property error), so AC `pnpm typecheck exits 0` mandates the consumer-site cleanup.

## FIND-SPRINT-035-16
- **source:** TASK-716 (verifier)
- **type:** cleanup
- **severity:** low
- **status:** resolved
- **location:** main/src/orchestrator/health.ts:31-35 and main/src/orchestrator/trpc/routers/health.ts:35
- **description:** Two docstring blocks still reference the raw-IPC `cyboflow:mcp-health` handler that TASK-716 just deleted. `main/src/orchestrator/health.ts:31-35` shows a Usage example "`ipcMain.handle('cyboflow:mcp-health', () => health.getMcpServerStatus());`" in `main/src/ipc/cyboflow.ts` — that file no longer exists as described; the example should be updated to show wiring via `setHealthProvider` + the tRPC `cyboflow.health.mcpServer` procedure. `main/src/orchestrator/trpc/routers/health.ts:35` says "Used by the raw-IPC `cyboflow:mcp-health` handler in main/src/ipc/cyboflow.ts so that both the IPC and tRPC surfaces read from the SAME singleton" — only the tRPC surface remains, so the "both surfaces" framing is now stale. Neither block is a TASK-716 AC violation (the plan's grep ACs are scoped to `main/src/ipc/cyboflow.ts`, the test file, and `frontend/src`), but the doc drift is real. Natural pickup for TASK-717 (legacy-tree deletion already plans docstring refresh per FIND-SPRINT-035-1), which already touches the `main/src/orchestrator/trpc/routers/health.ts` neighborhood.
- **suggested_action:** In TASK-717, rewrite the Usage block in `main/src/orchestrator/health.ts:28-39` to show the `setHealthProvider(orchestratorHealth)` wire-up from `main/src/index.ts` and drop the `ipcMain.handle('cyboflow:mcp-health', ...)` example. In `main/src/orchestrator/trpc/routers/health.ts:32-37`, drop the "both the IPC and tRPC surfaces" framing — only the tRPC surface remains.
- **resolved_by:** TASK-717

## FIND-SPRINT-035-17
- **source:** TASK-716 (code-reviewer)
- **type:** cleanup
- **severity:** low
- **status:** resolved
- **location:** main/src/orchestrator/trpc/routers/health.ts:28-41
- **description:** After TASK-716 deleted the raw-IPC `cyboflow:mcp-health` handler — the only consumer of `getHealthProvider` — the exported helper `getHealthProvider(): OrchestratorHealth | null` is now dead code (zero call sites across `main/src` and `frontend/src`). The matching `_health` module-local is still legitimately written by `setHealthProvider` and read directly inside the `mcpServer` procedure (line 56), so only the public getter is orphaned. Outside TASK-716's `files_owned` (`main/src/orchestrator/trpc/routers/health.ts` is read-only context), but mechanically discoverable now that the IPC handler is gone. Verification: `grep -rn "getHealthProvider" main/src frontend/src` returns exactly 1 hit — the declaration itself.
- **suggested_action:** Drop the `export function getHealthProvider` declaration from `main/src/orchestrator/trpc/routers/health.ts` and inline `_health` reads (already done inside the procedure). Natural pickup for TASK-717 since it already touches the orchestrator tRPC neighborhood and FIND-SPRINT-035-16 already plans a docstring refresh for the same file.
- **resolved_by:** TASK-717

## FIND-SPRINT-035-18
- **source:** TASK-716 (code-reviewer)
- **type:** cleanup
- **severity:** medium
- **status:** resolved
- **location:** docs/ARCHITECTURE.md:125-131, 152, 327-338
- **description:** `docs/ARCHITECTURE.md` still documents the four migrated channels — `cyboflow:listWorkflows`, `cyboflow:startRun`, `cyboflow:listRuns`, `cyboflow:mcp-health` — as live raw-IPC channels in three places. (a) Lines 125-129 list them under the IPC section as the current transport. (b) Line 131 says `cyboflow:mcp-health` has a "typed counterpart" in tRPC implying the raw channel is still live. (c) Lines 327-338 describe the renderer "currently mixes raw `electron.invoke` for `cyboflow:listWorkflows`, `cyboflow:startRun`, `cyboflow:listRuns`, `cyboflow:mcp-health` with the typed `cyboflow.*`" — TASK-714/715/716 just completed the migration that this paragraph predicts. Severity raised to medium because ARCHITECTURE.md is the canonical onboarding doc and incoming agents will read the wrong transport mapping. TASK-717's AC7 only updates the *legacy `main/src/trpc/` tree* note — it does NOT touch these channel docs.
- **suggested_action:** During TASK-717 (or a follow-up doc refresh), rewrite lines 125-131 to show only `cyboflow:approveRun` (stub, epic 7) under raw-IPC, with a note that the four read/write channels migrated to `cyboflow.workflows.list`, `cyboflow.runs.list`, `cyboflow.runs.start`, `cyboflow.health.mcpServer`. Update line 152 to drop the "typed counterpart of raw `cyboflow:listRuns`" framing — there is no longer a raw counterpart. Rewrite lines 327-338 to describe the renderer as fully cut over to tRPC except for the `cyboflow:stream:<runId>` push channel and the `cyboflow:approveRun` stub.
- **resolved_by:** TASK-717

## FIND-SPRINT-035-19
- **source:** TASK-716 (code-reviewer)
- **type:** cleanup
- **severity:** low
- **status:** resolved
- **location:** docs/CODE-PATTERNS.md:254
- **description:** The `validateInput` canonical example in `docs/CODE-PATTERNS.md:254` uses `'cyboflow:listRuns'` as the channel label argument — that channel no longer exists after TASK-716. The example is correct mechanically (the third argument is just a string used in error messages), but using a deleted channel name in onboarding documentation is misleading. Compare with `main/src/ipc/__tests__/validateInput.test.ts` which uses the same channel names — those are pure error-message labels and unaffected.
- **suggested_action:** Update the example in `docs/CODE-PATTERNS.md:254` to use a still-live channel label, e.g. `'cyboflow:approveRun'` or any of the surviving raw-IPC channels in the codebase. Optionally also update the `validateInput.test.ts` fixtures for consistency, though tests pass regardless.
- **resolved_by:** TASK-717

## FIND-SPRINT-035-20
- **type:** scope_deviation
- **source:** TASK-717 (executor)
- **severity:** low
- **status:** resolved
- **location:** main/src/orchestrator/trpc/routers/approvals.ts
- **description:** required to meet AC: approveRestOfRunHandler and rejectRestOfRunHandler must live in main/src/orchestrator/**. The orchestrator approvals.ts imported them from the legacy tree; with the legacy tree being deleted, the handlers needed to be inlined here. Also removed getHealthProvider dead export from health.ts per FIND-035-17 pickup.
- **resolved_by:** verifier — not actually a scope deviation: `main/src/orchestrator/trpc/routers/approvals.ts` is listed in TASK-717's `files_owned` (line 16 of plan). The executor mislabeled an in-scope edit as a deviation. The inlining is also AC-prescribed: AC3 ("approveRestOfRunHandler and rejectRestOfRunHandler live in main/src/orchestrator/**") plus AC6 ("pnpm typecheck exits 0") together require the handlers to be inlined here once the legacy tree is deleted. Same misclassification pattern as FIND-SPRINT-035-5, -7, -10, -13, -14, -15.

## FIND-SPRINT-035-21
- **type:** scope_deviation
- **source:** TASK-717 (executor)
- **severity:** low
- **status:** resolved
- **location:** main/src/orchestrator/trpc/__tests__/approvalsHandler.test.ts
- **description:** required to meet AC5: grep for approveRestOfRunHandler|rejectRestOfRunHandler in main/src/orchestrator/__tests__ or main/src/orchestrator/trpc/__tests__ must return at least 1 match. Created new test file migrating direct handler unit tests from deleted main/src/trpc/__tests__/approvals.test.ts.
- **resolved_by:** verifier — not actually a scope deviation: `main/src/orchestrator/trpc/__tests__/approvalsHandler.test.ts` is listed in TASK-717's `files_owned` (line 20 of plan). The executor mislabeled an in-scope file creation as a deviation. The new test file is also AC-prescribed: AC5 explicitly requires the equivalent test coverage to exist in the orchestrator subtree post-deletion, and the plan's Implementation Steps step 2 calls out this porting work. Same misclassification pattern as FIND-SPRINT-035-5, -7, -10, -13, -14, -15, -20.

## FIND-SPRINT-035-22
- **type:** cleanup
- **source:** TASK-717 (executor)
- **severity:** low
- **status:** resolved
- **location:** main/src/orchestrator/__tests__/runLifecycle.test.ts:32
- **description:** AC2 verification grep catches `from ..+/trpc/(routers|...)` in this file at line 32. The import resolves to main/src/orchestrator/trpc/routers/runs.ts (the canonical orchestrator file, not the deleted legacy tree), so the AC intent is satisfied and typecheck passes. The grep pattern cannot distinguish intra-orchestrator relative imports from cross-tree imports. File owned by TASK-733 which may update this import as part of its createTestDb consolidation work.
- **resolved_by:** TASK-733

## FIND-SPRINT-035-23
- **type:** cleanup
- **source:** TASK-717 (executor)
- **severity:** low
- **status:** open
- **location:** shared/types/stuckInspection.ts:5
- **description:** The file header docblock still references main/src/trpc/routers/runs.ts as a handler home and describes an import-cycle motivation. After TASK-717 the legacy tree is deleted; the handler lives in main/src/orchestrator/inspectorQueries.ts and the cycle is impossible. The docblock should be updated to list the canonical handler location and drop the cycle paragraph. File is out of TASK-717 files_owned (shared/types/ is a cross-package type file). FIND-SPRINT-035-1 noted this; still open for a future task.
- **resolved_by:** 

## FIND-SPRINT-035-26
- **source:** TASK-717 (verifier)
- **type:** claude-md
- **severity:** medium
- **status:** open
- **location:** tests/ (Playwright E2E) and package.json:scripts.test
- **description:** `pnpm test` (root script `playwright test`) is failing 15 specs across `smoke.spec.ts`, `health-check.spec.ts`, `permissions-ui-fixed.spec.ts`, `git-status.spec.ts`, and `standalone-terminal-panels.spec.ts` with a uniform symptom — the Electron renderer's `<body class="dark">` remains hidden / `[data-testid="settings-button"]` never resolves — and verified pre-existing as of parent commit `2a147a5` (TASK-716 done). The failure mode is consistent with an Electron-app-boot / Vite-renderer-bootstrap environmental issue rather than test-spec regressions: CLAUDE.md notes the renderer at http://localhost:4521 "cannot bootstrap standalone — it depends on preload-injected electronTRPC." Yet `playwright.config.ts:42-47` launches `pnpm electron-dev` as a webServer and points `baseURL: 'http://localhost:4521'` — which appears to bypass the Electron BrowserWindow that injects preload, causing every spec that waits on the rendered body to hang. Two consequences: (a) every TASK that includes "pnpm test exits 0" as an AC is silently un-verifiable — the verifier either rubber-stamps with a false-positive "pre-existing flake" caveat (as in TASK-717) or has to do a parent-commit comparison to triangulate; (b) the verification.run_tests=true config gate is degraded — only the unit-test workspace (`pnpm test:unit`, 989 tests) actually validates code changes. This is the same silent-degradation pattern as the visual_web=true / Vite-cannot-bootstrap conflict already documented in CLAUDE.md's Visual Verification section.
- **suggested_action:** Either (1) reframe the root `"test"` script: rename to `"test:e2e"` (or similar) and make `"test"` an alias for `"test:unit"` so the verifier's AC6 gate exercises the suite that actually validates changes — and document the e2e variant as a separate, optional gate that needs a properly configured Electron+display environment; or (2) fix the Playwright config to launch Electron via `_electron.launch` rather than `pnpm electron-dev` + `baseURL`, matching the CDP-attach pattern documented in `docs/visual-verification-setup.md`; or (3) at minimum, add a CLAUDE.md note acknowledging that `pnpm test` is environment-sensitive and verifiers should treat consistent body-hidden failures across smoke/health-check as pre-existing infra issues, not task regressions.
- **resolved_by:** 

## FIND-SPRINT-035-25
- **source:** TASK-717 (verifier)
- **type:** cleanup
- **severity:** low
- **status:** open
- **location:** docs/ARCHITECTURE-diagram.md:15,52,183
- **description:** `docs/ARCHITECTURE-diagram.md` still references the deleted `main/src/trpc/routers/` tree as a "gray dashed Legacy/unwired" deletion candidate and shows it as a node in the diagram. After TASK-717 the tree no longer exists. Three locations need updates: (a) line 15 legend entry describing "Gray dashed" still names `main/src/trpc/routers/` with a `TBD-tRPC-cutover` cleanup reference (the cutover is now complete); (b) line 52 declares a `LegacyTrpc` Mermaid node labeled "main/src/trpc/routers/<br/>legacy / unwired - delete or merge"; (c) line 183 narrative paragraph still describes the gray dashed `LegacyTrpc` tree as a cleanup component. File is outside TASK-717's `files_owned` (`docs/ARCHITECTURE.md` only). TASK-717 AC7 was scoped narrowly to `ARCHITECTURE.md`, so this is correctly out-of-scope but the doc drift is real now that the tree is gone.
- **suggested_action:** Either remove the `LegacyTrpc` node + its edges from the Mermaid diagram and drop the line 15 legend row and line 183 paragraph, or repurpose the gray-dashed category for a different deletion candidate. Mirror the prose updates already made in `docs/ARCHITECTURE.md` (transport status section).
- **resolved_by:** 

## FIND-SPRINT-035-24
- **type:** scope_deviation
- **source:** TASK-717 (executor)
- **severity:** low
- **status:** resolved
- **location:** docs/CODE-PATTERNS.md:254
- **description:** required to meet FIND-035-19 pickup: validateInput example used cyboflow:listRuns (deleted in TASK-716). Updated to cyboflow:approveRun per suggested_action.
- **resolved_by:** verifier — not actually a scope deviation: `docs/CODE-PATTERNS.md` is listed in TASK-717's `files_owned` (line 21 of plan). The executor mislabeled an in-scope doc edit as a deviation. The edit also resolves FIND-SPRINT-035-19 (which is marked `resolved_by: TASK-717`), so this work is plan-prescribed. Same misclassification pattern as FIND-SPRINT-035-5, -7, -10, -13, -14, -15, -20, -21.

## FIND-SPRINT-035-27
- **source:** TASK-732 (verifier)
- **type:** bug
- **severity:** medium
- **status:** resolved
- **location:** main/src/orchestrator/trpc/routers/__tests__/runs.test.ts:87-99
- **description:** TASK-732's AC5 says "After the sweep, `grep -rn 'INSERT INTO approvals' main/src --include='*.test.ts'` returns 0 matches." The post-commit grep returns 1 match — `runs.test.ts:95` — inside a local `seedPendingApproval` helper (lines 87-99). This site did NOT exist when TASK-732's plan was written (2026-05-22) — it was introduced by sibling tasks TASK-709..712 during this same sprint (SPRINT-035) when `runs.test.ts` was created/expanded to cover the orchestrator tRPC procedures. The plan body (step 1) names exactly 6 pre-flight sites in 4 files, all of which the executor correctly swept; the new 7th site is outside `files_owned` for TASK-732. The literal AC5 grep gate is therefore violated by no fault of the executor's plan adherence, but the grep-gate invariant the AC was designed to establish — "no inline INSERT INTO approvals in any `*.test.ts` under main/src" — is still false after the commit. Verifier issued NEEDS_CHANGES so the sweep is completed in one task rather than left as a follow-up FIND.
- **suggested_action:** Extend the TASK-732 sweep to include `main/src/orchestrator/trpc/routers/__tests__/runs.test.ts`: delete the local `seedPendingApproval` helper (lines 87-99), import `seedApproval` from `../../../__test_fixtures__/orchestratorTestDb` (next to the existing `seedRun` import on line 43), and rewrite the call site at line 135 from `seedPendingApproval(db, runId, 'approval-gsi-1', 'Bash', JSON.stringify({ cmd: 'echo hi' }))` to `seedApproval(db, { id: 'approval-gsi-1', runId, toolName: 'Bash', toolInputJson: JSON.stringify({ cmd: 'echo hi' }), toolUseId: 'use-approval-gsi-1' })` to preserve the existing `tool_use_id` shape (`use-${approvalId}`). Re-run `grep -rn 'INSERT INTO approvals' main/src --include='*.test.ts'` to confirm 0 matches, then `pnpm --filter main test`.
- **resolved_by:** verifier — status-sync: TASK-732. Commit 63da719 deletes the local `seedPendingApproval` helper, adds `seedApproval` to the existing canonical import on line 43, and rewrites the call site at line 120 to `seedApproval(db, { id: 'approval-gsi-1', runId, toolName: 'Bash', toolInputJson: ..., toolUseId: 'use-approval-gsi-1' })`. Re-ran `grep -rn 'INSERT INTO approvals' main/src --include='*.test.ts'` → 0 matches; `pnpm --filter main test` → 655 passed.

## FIND-SPRINT-035-28
- **type:** scope_deviation
- **source:** TASK-732 (executor)
- **severity:** low
- **status:** resolved
- **location:** main/src/orchestrator/trpc/routers/__tests__/runs.test.ts
- **description:** Required cross-file edit outside original files_owned to eliminate last INSERT INTO approvals in test files. Deleted local seedPendingApproval helper and replaced call with shared seedApproval from orchestratorTestDb fixture. Same pattern as FIND-SPRINT-035-14/15.
- **resolved_by:** verifier — AC-prescribed: TASK-732's AC5 mandates `grep -rn 'INSERT INTO approvals' main/src --include='*.test.ts'` return 0 matches. The 7th site in runs.test.ts (introduced by sibling TASK-709/710 during this sprint, after TASK-732's plan was written) was the only remaining blocker; the cross-file edit was explicitly directed by FIND-SPRINT-035-27's prior NEEDS_CHANGES and is the only way to satisfy AC5's invariant. Same pattern as FIND-SPRINT-035-14/15 (also AC-prescribed cross-file sweeps).

## FIND-SPRINT-035-29
- **type:** cleanup
- **source:** TASK-733 (verifier)
- **severity:** low
- **location:** main/src/services/panels/claude/__tests__/claudeCodeManager.composeMcpServers.test.ts:78 and main/src/orchestrator/trpc/routers/__tests__/runs.test.ts:53
- **description:** After TASK-733 swept the 11 files listed in its files_owned, two local function createTestDb declarations remain in the main test tree — both introduced after TASK-733 was planned. (a) main/src/services/panels/claude/__tests__/claudeCodeManager.composeMcpServers.test.ts:78 (commit c7378581, 2026-05-23 12:50 PT — before the TASK-733 plan was finalized). (b) main/src/orchestrator/trpc/routers/__tests__/runs.test.ts:53 (commit 42539f08, 2026-05-23 15:34 PT — TASK-709). Both are outside TASK-733s files_owned so they were correctly left untouched, but the consolidation goal (single canonical fixture for orchestrator-style test bootstrapping) is not yet fully achieved codebase-wide. A small follow-on sweep would migrate these two sites to import createTestDb from main/src/orchestrator/__test_fixtures__/orchestratorTestDb and delete the locals — same pattern as the 11 already migrated.
- **suggested_action:** Open a follow-on cleanup task scoped to these two files: (1) replace the local function createTestDb in claudeCodeManager.composeMcpServers.test.ts:78 with import { createTestDb } from ../../../../orchestrator/__test_fixtures__/orchestratorTestDb; (2) replace the local function createTestDb in main/src/orchestrator/trpc/routers/__tests__/runs.test.ts:53 with import { createTestDb } from ../../../__test_fixtures__/orchestratorTestDb. Inspect each file for stale REGISTRY_SCHEMA / SCHEMA_PATH / readFileSync imports to remove after the local is deleted, then re-run pnpm --filter main test.

## FIND-SPRINT-035-30
- **type:** cleanup
- **source:** TASK-733 (verifier)
- **severity:** low
- **location:** main/src/orchestrator/__tests__/runLifecycle.test.ts:16
- **description:** Doc-comment drift after TASK-733 consolidation. The file-header docblock at line 16 still says "Real in-memory better-sqlite3 with REGISTRY_SCHEMA." — but the file now imports createTestDb from the canonical orchestratorTestDb fixture, which uses GATE_SCHEMA (per the plans Hardest Decision section: REGISTRY_SCHEMA-only test files were upgraded to GATE_SCHEMA in TASK-733). Same pattern as FIND-SPRINT-035-1 (stale handler-location docblock in shared/types/stuckInspection.ts) — not a code defect, but the comment now misleads onboarding readers.
- **suggested_action:** In the next task that touches this file, update line 16 from "Real in-memory better-sqlite3 with REGISTRY_SCHEMA." to "Real in-memory better-sqlite3 via the canonical createTestDb fixture (GATE_SCHEMA)."

## FIND-SPRINT-035-31
- **source:** TASK-733 (code-reviewer)
- **type:** bug
- **severity:** medium
- **status:** open
- **location:** main/src/orchestrator/__tests__/stuckDetector.test.ts (deleted lines 562-611 of pre-commit file) — coverage gap, no live code site
- **description:** TASK-733's executor deleted the entire `describe('Migration 007 idempotency', ...)` block (two test cases, ~60 lines) when the plan's step 9 only authorized deleting "the now-redundant column-presence sanity checks" (singular inline `if (!names.includes('stuck_detected_at'))` checks inside the local helper). The two deleted tests exercised the actual `main/src/database/migrations/007_add_stuck_reason.sql` file from disk — verifying (a) its SQL applies cleanly on top of 006, and (b) the `idx_workflow_runs_status_stuck_at` index gets created. The commit message justified the deletion as "redundant now that TASK-732's canonical option is itself unit-tested," but the canonical option in `orchestratorTestDb.ts:57` uses an **inline** `ALTER TABLE workflow_runs ADD COLUMN stuck_detected_at INTEGER` — it does **NOT** read or exercise `007_add_stuck_reason.sql`, and it does NOT create the index. Verification: `grep -rn 'idx_workflow_runs_status_stuck_at' main/src --include='*.test.ts'` returns 0 matches after the commit; `grep -rn '007_add_stuck_reason' main/src --include='*.test.ts'` returns 0 matches. The generic `fileMigrationRunner.test.ts` only tests the runner against fixture files (998_/999_), not against `007_add_stuck_reason.sql` specifically. Net effect: future edits to `007_add_stuck_reason.sql` (typos, dropped index, changed column type) would not be caught by any test until the app runs against a real DB. Severity medium because (i) the migration is small and currently stable, but (ii) the executor went beyond what the plan authorized and (iii) the stated justification in the commit message is factually incorrect about what the canonical option covers.
- **suggested_action:** Open a follow-on task to restore migration-007 file-level coverage in a more appropriate location (e.g. `main/src/database/__tests__/migration007.test.ts` or a new section of `cyboflowSchema.test.ts`). The restored test should: (1) read `007_add_stuck_reason.sql` from disk, (2) apply it on top of a fresh `006_cyboflow_schema.sql` DB, (3) assert the `stuck_detected_at` INTEGER column is added to `workflow_runs`, and (4) assert the `idx_workflow_runs_status_stuck_at` index exists via `SELECT name FROM sqlite_master WHERE type='index' AND name='idx_workflow_runs_status_stuck_at'`. The original test block in the commit diff (deleted from stuckDetector.test.ts) can be lifted near-verbatim.
- **resolved_by:** 
