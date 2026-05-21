---
sprint: SPRINT-028
pending_count: 10
last_updated: "2026-05-21T16:14:52.820Z"
---
# Findings Queue

- SPRINT-028 started with missing infra: playwright, peekaboo; tests deferred. Sprint-initiator infra_check reports "shadow agents stale" but Step 0.45 shadow-agents.js --mode check returned drifted:false (recorded_version 0.11.0 across all four). Probe disagreement looks like a SoloFlow inconsistency between scripts/sprint/initiator infra probe and scripts/init/shadow-agents.js drift check — worth investigating during /compound (FIND-SPRINT-028-1).

## FIND-SPRINT-028-2
- **source:** TASK-685 (code-reviewer)
- **type:** cleanup
- **severity:** low
- **status:** open
- **location:** main/src/ipc/app.ts:28-33
- **description:** The `track-welcome-dismissed` IPC handler retains an inline comment "Our Discord popup logic handles this differently" — this comment is now stale after TASK-685 removed all Discord popup plumbing. Additionally, grep confirms the `track-welcome-dismissed` channel has no callers anywhere in `main/src/` or `frontend/src/`, so the handler itself appears to be dead code from the Crystal baseline. Out of scope for TASK-685's diff but adjacent to it.
- **suggested_action:** Either delete the `track-welcome-dismissed` handler entirely (verify no remaining callers in the renderer-facing surface) or, if intentionally preserved as a compatibility surface, refresh the comment to remove the stale Discord reference and explain what's actually being preserved.
- **resolved_by:** 

## FIND-SPRINT-028-3
- **source:** TASK-685 (code-reviewer)
- **type:** cleanup
- **severity:** low
- **status:** open
- **location:** main/src/ipc/app.ts:46-54 + main/src/database/database.ts:2834-2849
- **description:** After TASK-685, `app:record-open` and `app:get-last-open` IPC handlers (and the matching `recordAppOpen` / `getLastAppOpen` / `getLastAppVersion` database methods) have no preload-typed surface and zero frontend callers — grep across `frontend/src/` and `main/src/preload.ts` finds nothing. The only live caller is the internal `databaseService.recordAppOpen(false, currentVersion)` from `main/src/index.ts:741`. The IPC channels themselves are dead. Discovered while verifying signature-narrow propagation; out of TASK-685 scope but worth a follow-up.
- **suggested_action:** Consider deleting the two IPC handlers in `main/src/ipc/app.ts` and inlining `recordAppOpen` as a private DB call from `index.ts` (or keeping the DB methods and dropping just the IPC handlers). If retained for future analytics/diagnostics, document the rationale in `docs/ARCHITECTURE.md` so the next review pass doesn't flag it again.
- **resolved_by:** 

## FIND-SPRINT-028-5
- **source:** TASK-687 (verifier)
- **type:** cleanup
- **severity:** low
- **status:** open
- **location:** frontend/src/utils/cyboflowApi.ts:33-45 + shared/types/cyboflow.ts:41-54
- **description:** TASK-687 introduces a local `WorkflowRunRow` interface in `frontend/src/utils/cyboflowApi.ts` (the listRuns return shape, intentionally excluding `policy_json`) while a heavier `WorkflowRunRow` already exists in `shared/types/cyboflow.ts` (includes `policy_json` and `stuck_at`). The two shapes have identical names but different members, which creates an ambient ambiguity risk: a future caller importing `WorkflowRunRow` from `shared/types/cyboflow` and passing it to `listRuns({})` (or vice versa) would type-check but mismatch at runtime. The CLAUDE.md "IPC handler ↔ declared T parity" rule warns about this class of bug (FIND-SPRINT-024-4 / TASK-637).
- **suggested_action:** Rename the listRuns return shape to something distinguishing (e.g. `WorkflowRunListRow` or `WorkflowRunRowLite`) so the two co-exist without collision; or alternatively move the lite shape into `shared/types/cyboflow.ts` as a typed `Omit<WorkflowRunRow, 'policy_json'>` derivation. The current duplication is benign today (no caller imports both) but is the kind of latent shape-drift the IPC parity rule is meant to catch.
- **resolved_by:** 

## FIND-SPRINT-028-4
- **source:** TASK-686 (verifier)
- **type:** cleanup
- **severity:** low
- **status:** open
- **location:** docs/SHELL-LAYOUT.md:33
- **description:** The new `docs/SHELL-LAYOUT.md` "Cross-references" section lists "Current mount site: `frontend/src/App.tsx` lines 374-432." This line range was lifted verbatim from the TASK-686 plan, which captured App.tsx layout *before* TASK-684 (DiscordPopup removal) and TASK-685 (Discord IPC removal) deleted ~57 lines earlier in the same sprint. The actual three-column mount site post-50f33d7 lives at `frontend/src/App.tsx` lines 317-375 (the `<div className="flex flex-1 overflow-hidden">` containing `ReviewQueueView` → `Sidebar` → `CyboflowRoot|SessionView`). The doc still satisfies every TASK-686 acceptance criterion (none required accurate line numbers), but the stale pointer will mislead the next reader.
- **suggested_action:** Update line 33 of `docs/SHELL-LAYOUT.md` to read "Current mount site: `frontend/src/App.tsx` lines 317-375." Or rewrite it without absolute line numbers — e.g. "Current mount site: the `<div className=\"flex flex-1 overflow-hidden\">` block in `frontend/src/App.tsx`, annotated with a `docs/SHELL-LAYOUT.md` comment." The latter survives future churn better than absolute line numbers.
- **resolved_by:** 







- SPRINT-028 closed early at user direction after TASK-688 completed. TASK-689 through TASK-693 left ready in backlog for the next sprint to pick up.

## FIND-SPRINT-028-6
- **source:** SPRINT-028 (sprint-code-reviewer)
- **type:** improvement
- **severity:** medium
- **status:** open
- **location:** frontend/src/stores/navigationStore.ts:27-30 + frontend/src/components/DraggableProjectTreeView.tsx:849-852 + frontend/src/App.tsx:338
- **description:** Cross-task contract drift: `navigateToSessions` is a multi-field reset that nulls `activeProjectId`, but the new App.tsx shell mounts `CyboflowRoot` ONLY when `activeProjectId !== null`. TASK-687 added Sidebar `handleRunClick` that calls `setActiveRun(run.id)` then `navigateToSessions()` — the second call un-mounts CyboflowRoot and discards the run that was just made active. This is the underlying convention issue behind REG-SPRINT-028-1: no documented contract on `navigateToSessions` side effects under the new shell.
- **suggested_action:** Two paths: (a) preserve activeProjectId across the run-click navigation — add a `selectRun(runId)` action that sets activeView=sessions and cyboflowStore.activeRunId without touching activeProjectId; or (b) audit every `navigateToSessions` call site (DraggableProjectTreeView, SessionListItem, ProjectDashboard) and decide whether the multi-field semantics still apply. Document the contract in `docs/SHELL-LAYOUT.md` once chosen.
- **resolved_by:** 






Suspected tasks: TASK-687, TASK-688

## FIND-SPRINT-028-7
- **source:** SPRINT-028 (sprint-code-reviewer)
- **type:** improvement
- **severity:** medium
- **status:** open
- **location:** main/src/database/database.ts:744-756
- **description:** TASK-685 added a `-- Orphaned column (IDEA-016): no migration written; cheaper to leave than alter` comment above `discord_shown` in the `app_opens` CREATE TABLE block, then a follow-up DELETE for the legacy `hide_discord` preference. The DELETE is correct for existing installs, but the CREATE TABLE still creates `discord_shown BOOLEAN DEFAULT 0` for every FRESH install — so new users now get an orphan column on day one. The comment claims it is cheaper to leave than alter; that argument only holds for migrations of existing schemas, not for new ones.
- **suggested_action:** Drop `discord_shown` from the `app_opens` CREATE TABLE statement (the column is also no longer read or written by `recordAppOpen` / `getLastAppOpen` after TASK-685). Existing installs still carry it — that is the case the comment was meant to handle. New installs should NOT inherit the orphan. Optionally, add a one-line note in `docs/ARCHITECTURE.md` documenting the asymmetry for the next reviewer.
- **resolved_by:** 





Suspected tasks: TASK-685

## FIND-SPRINT-028-8
- **source:** SPRINT-028 (sprint-code-reviewer)
- **type:** improvement
- **severity:** medium
- **status:** open
- **location:** main/src/preload.ts:378 + main/src/ipc/uiState.ts:68 + main/src/services/uiStateManager.ts:56-77 + frontend/src/types/electron.d.ts:252,256
- **description:** TASK-687 removed the UI binding for `sessionSortAscending` (Sidebar.tsx no longer renders the sort toggle and DraggableProjectTreeView no longer accepts the prop). But the backend plumbing is fully intact: preload exposes `saveSessionSortAscending`, IPC handler `ui-state:save-session-sort-ascending` is still registered, `uiStateManager.saveSessionSortAscending` and `getSessionSortAscending` still read/write the `treeView.sessionSortAscending` ui_state key, and `frontend/src/types/electron.d.ts` still declares the channel. Even the new test `DraggableProjectTreeView.runs.test.tsx:182` mocks `sessionSortAscending: false` in the getExpanded response. The Crystal-era backend layer is dead code across 4 files.
- **suggested_action:** Either (a) finish the cut: remove `saveSessionSortAscending` from preload, drop the `ui-state:save-session-sort-ascending` handler, remove the service methods + the ui_state key, and update `getExpanded` to no longer return `sessionSortAscending`; or (b) explicitly mark the backend with `@cyboflow-hidden` and a comment naming the future re-enable task. Update `DraggableProjectTreeView.runs.test.tsx` to drop the stale field from the mocked getExpanded response either way.
- **resolved_by:** 




Suspected tasks: TASK-687

## FIND-SPRINT-028-9
- **source:** SPRINT-028 (sprint-code-reviewer)
- **type:** improvement
- **severity:** low
- **status:** open
- **location:** frontend/src/components/DraggableProjectTreeView.tsx:6-7
- **description:** TASK-687 left the placeholder import `import { SessionListItem as _SessionListItem } from ./SessionListItem;` with a comment `// SessionListItem import preserved — TASK-689 owns its removal`. The comment explains the *why*, but the import still triggers a real module load at app start (SessionListItem pulls a non-trivial tree of session helpers). The lint exception is `argsIgnorePattern: ^_`, applied via the `_` prefix.
- **suggested_action:** Replace with either `// @cyboflow-hidden: TASK-689 owns SessionListItem deletion` (just the comment, no import) if the grep contract only needs a textual marker, or `// eslint-disable-next-line @typescript-eslint/no-unused-vars\nconst _SessionListItem = null;` if a code symbol is required. Saves a module load while satisfying TASK-689 grep semantics.
- **resolved_by:** 



Suspected tasks: TASK-687

## FIND-SPRINT-028-10
- **source:** SPRINT-028 (sprint-code-reviewer)
- **type:** improvement
- **severity:** low
- **status:** open
- **location:** frontend/src/utils/cyboflowApi.ts:29-32
- **description:** JSDoc on the new `WorkflowRunListRow` interface reads `Subset of WorkflowRunListRow returned by cyboflow:listRuns.` — that is the type itself; the intended reference is the heavier `WorkflowRunRow` in `shared/types/cyboflow.ts` (which includes `policy_json`). The rename in TASK-687 commit 6beac49 (WorkflowRunRow → WorkflowRunListRow) updated the type name but not the JSDoc target, so the doc is now self-referential.
- **suggested_action:** Change line 30 to `Subset of `WorkflowRunRow` (shared/types/cyboflow.ts) returned by cyboflow:listRuns.` and explicitly call out that `policy_json` is intentionally excluded. Optional: replace the duplicated field list with `Omit<WorkflowRunRow, policy_json>` to make the relationship type-enforced (also addresses the residual concern from FIND-SPRINT-028-5).
- **resolved_by:** 


Suspected tasks: TASK-687

## FIND-SPRINT-028-11
- **source:** SPRINT-028 (sprint-code-reviewer)
- **type:** improvement
- **severity:** low
- **status:** open
- **location:** main/src/ipc/cyboflow.ts:144-167
- **description:** The new `cyboflow:listRuns` handler destructures `projectId` from `args: { projectId: number }` without runtime validation. If a renderer accidentally passes `undefined` or a non-number, the better-sqlite3 prepared statement throws or returns rows for `project_id IS NULL`. Other handlers in the same file (`cyboflow:listWorkflows`, `cyboflow:startRun`) follow the same destructure-without-validation pattern, so this is a consistency choice — but the CLAUDE.md `IPC handler ↔ declared T parity` rule explicitly flags this class of silent-shape-drift risk (FIND-SPRINT-024-4).

Suspected tasks: TASK-687
- **suggested_action:** Add a guard: `if (typeof args?.projectId !== number) return { success: false, error: listRuns: projectId must be a number };`. For consistency, consider extracting a small `validateArgs` helper that the other cyboflow:* handlers can share — keeps the validation rule documented in one place rather than spread across 4 handlers.
- **resolved_by:** 
