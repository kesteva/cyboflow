---
sprint: SPRINT-035
visual_mobile: skipped_user_preference
visual_web: skipped_unable
visual_macos: skipped_unable
visual_mobile_note: "verification.visual_mobile = false (config)"
visual_web_note: "cyboflow visual_web is non-functional — Vite renderer cannot bootstrap without Electron preload (per CLAUDE.md)"
visual_macos_note: "Peekaboo MCP capture against running Electron (PID 80782) failed with 'Failed to start stream due to audio/video capture failure' on both background and auto focus modes; screen:0 returned 'No displays available for capture' — recurring config gap, same as SPRINT-024/034"
regressions_count: 0
flows_tested: 0
flows_deferred: 3
---

# SPRINT-035 — Sprint Verification

## Visual Verification (Pass 1)

### Settings
- `verification.visual_mobile` = `false` → `skipped_user_preference`
- `verification.visual_web` = `true` → attempted, classified `skipped_unable` (project-specific: Vite renderer cannot bootstrap without Electron `preload`; documented in CLAUDE.md and `docs/VISUAL-VERIFICATION-SETUP.md`)
- `verification.visual_macos` = `true` → attempted via Peekaboo MCP, classified `skipped_unable`
- `verification.visual_prefer_playwright` = `false` → no Playwright re-routing
- `verification.visual_auth_fixture` = `null` → no pre-flight auth fixture

### Sprint-affected user flows (deduplicated to 3)

1. **Flow A — Workflow listing + MCP health dot** (TASK-714 cutover of `listWorkflows` to tRPC, TASK-715 cutover of `mcp-health` to tRPC, TASK-716 deletion of raw-IPC handlers):
   - WorkflowPicker mounts, calls `trpc.cyboflow.workflows.list.query({projectId})`, renders 5 SoloFlow defaults
   - mcpHealthStore polls `trpc.cyboflow.health.mcpServer` every 5s, status dot reflects 'healthy'/'starting'/'error'
2. **Flow B — Run listing in sidebar tree** (TASK-714 cutover of `listRuns` to tRPC):
   - DraggableProjectTreeView calls `trpc.cyboflow.runs.list.query({projectId})` for each project, renders newest-first
3. **Flow C — Start Run + in-flight guard** (TASK-712 mutation wire, TASK-715 renderer cutover):
   - WorkflowPicker → "Start Run" button → `trpc.cyboflow.runs.start.mutate({workflowId, projectId})` → button is `disabled` while `isStarting === true`

### Peekaboo capture attempt
- Peekaboo MCP `server_status` reports both Screen Recording and Accessibility grants present
- `list application_windows app="Electron"` correctly identifies window "Cyboflow" [ID 1510, bounds 164,99 1400×900], PID 80782
- `image app_target="Electron"` with `capture_focus="background"`: **fails** — `Failed to start stream due to audio/video capture failure`
- `image app_target="Electron"` with `capture_focus="auto"`: **fails** — same error
- `image app_target="screen:0"` with `capture_focus="background"`: **fails** — `No displays available for capture`
- Per path-selection rule (skills/visual-verify/SKILL.md), chosen path was MCP at probe; not switching to CLI mid-run

### Out-of-band live-runtime evidence (debug logs, since visual capture blocked)
The `pnpm dev` Electron session has been running on the sprint branch since the cutover commits landed. The latest `cyboflow-frontend-debug.log` entries (timestamp 00:17:32 onward, gitCommit `3fd706d` which is TASK-715) show clean module loading after the final cutover HMR cycle — no `ReferenceError` against `listWorkflows`/`listRuns`/`startRun`/`mcp-health`. The earlier transient `ReferenceError: listWorkflows is not defined` / `ReferenceError: startRun is not defined` at 23:47 and 00:02 are stale HMR-mid-edit artifacts that resolved on the next hot-update — both followed immediately by successful `[vite] hot updated:` lines. Backend log shows orchestrator boot, tRPC IPC handler attachment, and ApprovalRouter boot recovery — all clean.

Caveat: the running renderer is at TASK-715 (`3fd706d (modified)`), not sprint HEAD (`cc196f0`). The four trailing tasks (TASK-716 handler deletion, TASK-717 legacy tRPC tree deletion, TASK-732/733 test fixture consolidation) are either deletion-only of code no longer called by the renderer after TASK-714/715, or test-only — so the running state is functionally equivalent to HEAD for the three UI surfaces.

### Static audit of cutover integrity (in lieu of visual)
- `main/src/trpc/` directory removed (TASK-717 confirmed)
- `main/src/ipc/cyboflow.ts` no longer registers the four migrated channels — only `cyboflow:approveRun` remains (intentional, out of scope this sprint)
- `setCyboflowHealth` carrier removed from `main/src/ipc/cyboflow.ts` (only appears in `main/dist/` compiled artifacts which will be regenerated on next build)
- Renderer references to `cyboflowApi` reduced to `subscribeToStreamEvents` + `StreamEvent` type — no callsites to the four removed raw-IPC methods
- `WorkflowPicker.tsx` correctly uses `trpc.cyboflow.workflows.list.query` + `trpc.cyboflow.runs.start.mutate`, with `isStarting` state gating the Start Run button (`disabled={selectedId === null || isLoading || isStarting}`)
- `DraggableProjectTreeView.tsx` correctly uses `trpc.cyboflow.runs.list.query` with per-project parallel fetch and `.catch(() => [])` failure isolation
- `mcpHealthStore.ts` correctly polls `trpc.cyboflow.health.mcpServer.query()` every 5s and maps four-value `McpServerHealth` → three-value `McpHealthUiStatus` via `toUiStatus`

### Outcome classification per platform
- `visual_mobile`: `skipped_user_preference` (config gate)
- `visual_web`: `skipped_unable` — project-known non-functional path (Vite renderer needs Electron preload). Per skills/visual-verify/SKILL.md, `skipped_unable` is the correct classification for tooling/environment that cannot serve the platform here.
- `visual_macos`: `skipped_unable` — recurring `visual_macos_unavailable` config gap (same exact failure mode as SPRINT-024 FIND and SPRINT-034 Pass 1)

### Deferred to human-review-queue
All three sprint-touched UI flows could not be exercised end-to-end. The existing entries already cover this surface:
- `dedup_key: visual_macos_unavailable` (TASK-655, now sprint-recurring through SPRINT-024 → SPRINT-034 → SPRINT-035)
- Sprint-level deferred entry to be added by orchestrator (`sprint_035_renderer_trpc_cutover_visual_flow`) covering the three flows above

### Failures
None observed in the static audit, debug logs, or test runs.

---

## Integration Tests (Pass 2)

Note: the Sprint Verifier does not have a Task/Agent spawn tool available, so the canonical integration sweep (typecheck + lint + main + frontend, which is the integration-tester's standard cyboflow protocol) was executed inline. Playwright E2E was NOT re-run — per the orchestrator's input it has pre-existing failures unrelated to this sprint and is out of scope for end-of-sprint regression sweep.

| Suite | Status | Notes |
|---|---|---|
| `pnpm typecheck` | PASS | shared/main/frontend all clean, no errors |
| `pnpm lint` | PASS | 0 errors, 203 pre-existing warnings (unchanged baseline; these warnings predate the sprint and are unrelated to cutover changes) |
| `pnpm --filter main test` | PASS | 68 test files, **653 / 653** tests passed in 2.82s |
| `pnpm --filter frontend test` | PASS | 25 test files, **337 / 337** tests passed in 4.40s |
| **Total unit/component** | **PASS** | **990 / 990** |

`pnpm rebuild better-sqlite3` was run before `pnpm --filter main test` per CLAUDE.md's documented host-Node ABI requirement (NMV 127 vs Electron NMV 136). No NODE_MODULE_VERSION errors observed.

### New tests added this sprint (all passing)
- `main/src/orchestrator/__tests__/listRunsHandler.test.ts` (TASK-710) — 4 tests
- `main/src/orchestrator/trpc/routers/__tests__/runs.test.ts` (TASK-710 + TASK-712) — wrapper-layer guards + happy path / NOT_FOUND / FORBIDDEN
- `main/src/orchestrator/trpc/routers/__tests__/workflows.test.ts` (TASK-711) — list/get
- `main/src/orchestrator/__test_fixtures__/__tests__/orchestratorTestDb.test.ts` (TASK-732) — fixture self-tests for `disableForeignKeys` + `includeStuckDetectedAt`

### Existing tests modified this sprint (all passing)
- `frontend/src/components/__tests__/DraggableProjectTreeView.runs.test.tsx` (TASK-714) — updated to mock tRPC instead of cyboflowApi
- `frontend/src/components/cyboflow/__tests__/CyboflowRoot.test.tsx` (TASK-714 + TASK-715)
- `frontend/src/stores/__tests__/mcpHealthStore.test.ts` (TASK-715) — tRPC-stub-based
- `frontend/src/test/setup.ts` (TASK-714) — global tRPC stub scaffold
- 10 test files consolidated onto canonical `createTestDb` fixture (TASK-733)

### Failures
None.

---

## Regressions requiring attention

**None observed.** The cutover is complete and consistent across the wire (handlers deleted, renderer rewired, types aligned, tests updated and passing).

The only outstanding cross-task observation is the recurring `visual_macos_unavailable` config gap that has now blocked visual verification at the end of SPRINT-024, SPRINT-033 (escalated), SPRINT-034, and now SPRINT-035. This is NOT a regression introduced by this sprint — it is a persistent environment/Peekaboo issue against the running Cyboflow Electron binary specifically. Suggested action remains as documented in the existing queue entry: confirm Cyboflow.app is granted Screen Recording explicitly (System Settings → Privacy & Security → Screen Recording), restart `pnpm dev`, and re-run.
