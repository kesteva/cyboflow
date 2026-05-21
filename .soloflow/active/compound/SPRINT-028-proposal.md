---
sprints: [SPRINT-028]
span_label: SPRINT-028
created: 2026-05-21T00:00:00.000Z
counters_start:
  ideas: 16
summary:
  cleanups: 4
  backlog_tasks: 3
  claude_md: 2
  soloflow_improvements: 0
---

# Compound Proposal — SPRINT-028

## A. Clean-up items (execute now)

### A1. Remove `track-welcome-dismissed` dead IPC handler and its stale Discord comment
- **Summary:** The `track-welcome-dismissed` IPC handler in `main/src/ipc/app.ts` has no callers anywhere in `main/src/` or `frontend/src/` and carries a stale "Our Discord popup logic handles this differently" comment that refers to plumbing deleted in TASK-685.
- **Source-Sprint:** SPRINT-028
- **Rationale:** Dead code with a misleading comment is an active trap for the next reader. TASK-685's code-reviewer confirmed zero callers via grep; the handler is safe to delete outright. Matches the broader discord-cleanup arc of TASK-684/685.
- **Blast radius:** `main/src/ipc/app.ts` lines 28-33 only. Risk: trivial — no callers to update.
- **Source:** FIND-SPRINT-028-2 (TASK-685 code-reviewer). Confirmed no preload declaration and no frontend caller.
- **Proposed change:**
  Delete the `ipcMain.handle('track-welcome-dismissed', ...)` block at `main/src/ipc/app.ts:28-33` in its entirety. If a stale `track-welcome-dismissed` entry remains in `main/src/preload.ts`, remove that too. Verify with: `grep -rn "track-welcome-dismissed" main/src/ frontend/src/` returns zero hits after the edit.

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** high
- **Reasoning:** Grep across `main/src/` and `frontend/src/` returns only the handler definition at `main/src/ipc/app.ts:28` — no preload entry, no callers — confirming the handler is fully dead and the stale Discord comment is misleading.

---

### A2. Drop `discord_shown` column from the `app_opens` `CREATE TABLE` statement for fresh installs
- **Summary:** The `discord_shown BOOLEAN DEFAULT 0` column remains in the `CREATE TABLE app_opens` DDL in `main/src/database/database.ts`, meaning every fresh install still inherits the orphan column that TASK-685 intended to retire.
- **Source-Sprint:** SPRINT-028
- **Rationale:** TASK-685's comment "cheaper to leave than alter" was written for existing-install migration logic (a no-op `DELETE FROM user_preferences` is correct there). It does not apply to the fresh-install path. New users should not receive an orphan column on day one. The column is no longer read or written by `recordAppOpen` / `getLastAppOpen` after TASK-685.
- **Blast radius:** `main/src/database/database.ts` CREATE TABLE block (one line removed). Risk: low — the column is already unread; removing it from DDL only affects `CREATE TABLE IF NOT EXISTS`, which is a no-op on existing DBs.
- **Source:** FIND-SPRINT-028-7 (SPRINT-028 sprint-code-reviewer). Suspected task: TASK-685.
- **Proposed change:**
  ```diff
  # main/src/database/database.ts — app_opens CREATE TABLE block
  -  discord_shown BOOLEAN DEFAULT 0,  -- Orphaned column (IDEA-016): no migration written; cheaper to leave than alter
  ```
  Remove the line entirely. The `IDEA-016` comment is no longer meaningful on the create path once the column is dropped here; the surviving note in the migration `DELETE FROM user_preferences` section is sufficient.

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** high
- **Reasoning:** Grep across `main/src/`, `frontend/src/`, and `shared/` shows `discord_shown` only at `main/src/database/database.ts:750` (the DDL itself) — no reads, no writes — confirming TASK-685's "cheaper to leave than alter" rationale applies only to migrating existing schemas, not to provisioning fresh ones.

---

### A3. Replace placeholder `SessionListItem` import with a comment-only marker
- **Summary:** `DraggableProjectTreeView.tsx` imports `SessionListItem as _SessionListItem` purely to satisfy a future task's grep contract, but the import still triggers a full module load of the non-trivial `SessionListItem` dependency tree at app start.
- **Source-Sprint:** SPRINT-028
- **Rationale:** The `_` prefix suppresses the ESLint unused-vars warning, but the module is still loaded. Replacing the import with a comment satisfies the grep contract for TASK-689 with zero runtime cost. This is a safe micro-optimization that also removes a misleading import from the file.
- **Blast radius:** `frontend/src/components/DraggableProjectTreeView.tsx` lines 6-7. Risk: trivial.
- **Source:** FIND-SPRINT-028-9 (SPRINT-028 sprint-code-reviewer). Suspected task: TASK-687.
- **Proposed change:**
  ```diff
  # frontend/src/components/DraggableProjectTreeView.tsx
  -import { SessionListItem as _SessionListItem } from './SessionListItem'; // SessionListItem import preserved — TASK-689 owns its removal
  +// @cyboflow-hidden: SessionListItem — TASK-689 owns its deletion. Grep anchor preserved.
  ```

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** medium
- **Reasoning:** Confirmed at `frontend/src/components/DraggableProjectTreeView.tsx:6-7` — the `_`-prefixed import still triggers a module load of `SessionListItem` at app start with no functional purpose, and TASK-689's grep contract is satisfied by a textual marker.

---

### A4. Fix self-referential JSDoc on `WorkflowRunListRow`
- **Summary:** The JSDoc comment on `WorkflowRunListRow` in `frontend/src/utils/cyboflowApi.ts` says "Subset of `WorkflowRunListRow`" — it refers to itself instead of the heavier `WorkflowRunRow` in `shared/types/cyboflow.ts` that it is actually derived from.
- **Source-Sprint:** SPRINT-028
- **Rationale:** Self-referential documentation is misleading. A reader trying to understand what fields were excluded has no pointer to the source type. The rename in commit 6beac49 updated the type name but missed the JSDoc target.
- **Blast radius:** `frontend/src/utils/cyboflowApi.ts` lines 29-32. Risk: trivial (comment only).
- **Source:** FIND-SPRINT-028-10 (SPRINT-028 sprint-code-reviewer). Suspected task: TASK-687.
- **Proposed change:**
  ```diff
  # frontend/src/utils/cyboflowApi.ts — WorkflowRunListRow JSDoc
  -/** Subset of WorkflowRunListRow returned by cyboflow:listRuns. */
  +/**
  + * Subset of `WorkflowRunRow` (shared/types/cyboflow.ts) returned by cyboflow:listRuns.
  + * Intentionally excludes `policy_json` (not needed by the sidebar list view).
  + */
  ```

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** high
- **Reasoning:** Verified at `frontend/src/utils/cyboflowApi.ts:30` — the JSDoc literally reads "Subset of WorkflowRunListRow" referring to itself, with no pointer to the actual source type `WorkflowRunRow` in `shared/types/cyboflow.ts`.

---

## B. Backlog tasks (refine into execution-ready plans)

### B1. Fix REG-SPRINT-028-1: `handleRunClick` un-mounts `CyboflowRoot` by calling `navigateToSessions`
- **Summary:** Clicking a workflow-run row in the Sidebar calls `navigateToSessions()`, which nulls `activeProjectId`, causing `CyboflowRoot` to unmount — so the `RunView` the user navigated to never renders.
- **Source-Sprint:** SPRINT-028
- **Source:** REG-SPRINT-028-1 (human-review-queue, cross_task cross-task regression); FIND-SPRINT-028-6 (SPRINT-028 sprint-code-reviewer). Suspected tasks: TASK-687, TASK-688.
- **Problem:** `navigateToSessions` in `frontend/src/stores/navigationStore.ts:27-30` resets `activeProjectId` to `null`. App.tsx:338 gates `<CyboflowRoot>` on `activeProjectId !== null`. `handleRunClick` in `DraggableProjectTreeView.tsx:849-852` calls `setActiveRun(run.id)` then `navigateToSessions()` — the second call immediately un-mounts `CyboflowRoot` and the run that was just made active is lost. Per-task tests missed this because `DraggableProjectTreeView.runs.test.tsx:352` mocks the navigation store, and `CyboflowRoot.test.tsx` renders with an injected `projectId`, bypassing the App-shell gate. This is classified **high severity** in the human-review-queue and is a merge-blocker.
- **Proposed direction:** The most minimal fix (option 1 from the review queue action): replace `navigateToSessions()` in `handleRunClick` with a direct `setActiveProjectId(run.project_id)` call — run rows already carry `project_id` via the `ProjectWithRuns` data structure, so the project context is available. Alternatively introduce a new `selectRun(runId, projectId)` action in `navigationStore` that sets `activeView='sessions'` without nulling `activeProjectId`, giving a single clean call site. Whichever path is chosen: (a) add a test to `DraggableProjectTreeView.runs.test.tsx` that asserts `activeProjectId` remains non-null after the click, AND (b) document the `navigateToSessions` contract ("nulls activeProjectId; do not call when a run is being activated") in `docs/SHELL-LAYOUT.md`. Confirm App.tsx's `activeView==='sessions'` branch behavior is intentional vs Crystal carry-over.
- **Scope:** small

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** high
- **Reasoning:** Direct code verification confirms the bug: `navigationStore.ts:27-30` sets `activeProjectId: null`, `App.tsx:338` gates `<CyboflowRoot>` on `activeProjectId !== null`, and `DraggableProjectTreeView.tsx:849-852` calls both in sequence — un-mounting the run the user just activated; classified merge-blocker.

---

### B2. Remove dead `sessionSortAscending` backend plumbing across four files
- **Summary:** TASK-687 removed the Sidebar UI for `sessionSortAscending` but left the full backend plumbing intact — preload exposure, IPC handler, service methods, ui_state key, and a test mock — creating dead code across four files.
- **Source-Sprint:** SPRINT-028
- **Source:** FIND-SPRINT-028-8 (SPRINT-028 sprint-code-reviewer). Suspected task: TASK-687.
- **Problem:** The following are fully intact but unreachable: `saveSessionSortAscending` in `main/src/preload.ts:378`; `ui-state:save-session-sort-ascending` handler in `main/src/ipc/uiState.ts:68`; `uiStateManager.saveSessionSortAscending` and `getSessionSortAscending` methods in `main/src/services/uiStateManager.ts:56-77`; the `treeView.sessionSortAscending` ui_state key; and the `saveSessionSortAscending` channel declaration in `frontend/src/types/electron.d.ts:252,256`. `DraggableProjectTreeView.runs.test.tsx:182` also mocks `sessionSortAscending: false` in the `getExpanded` response — a stale field. Shipping dead IPC surface violates the principle of keeping preload narrow and is the category of drift the IPC parity rule (CLAUDE.md) is written to prevent.
- **Proposed direction:** Cut the dead layer in full: remove `saveSessionSortAscending` from preload, drop the `ui-state:save-session-sort-ascending` ipcMain handler, remove the two service methods plus the ui_state key, and remove the stale channel declaration from `electron.d.ts`. Update `DraggableProjectTreeView.runs.test.tsx` to drop `sessionSortAscending` from the mocked `getExpanded` response. If the feature is planned for re-enable in a future sprint, mark it with `@cyboflow-hidden` and a comment naming the re-enable task instead of leaving it as live-but-unreachable code.
- **Scope:** small

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** high
- **Reasoning:** Grep confirms zero frontend callers of `saveSessionSortAscending` while preload, ipcMain handler, two service methods, electron.d.ts declaration, and a test mock remain intact — exactly the kind of dead IPC surface the CLAUDE.md IPC parity rule is meant to prevent.

---

### B3. Add runtime input validation to `cyboflow:listRuns` (and audit sibling handlers for the same gap)
- **Summary:** `cyboflow:listRuns` in `main/src/ipc/cyboflow.ts` destructures `projectId` from `args` without runtime type-checking, silently producing wrong query results or a SQLite throw when the renderer passes `undefined`; the same pattern exists in `cyboflow:listWorkflows` and `cyboflow:startRun`.
- **Source-Sprint:** SPRINT-028
- **Source:** FIND-SPRINT-028-11 (SPRINT-028 sprint-code-reviewer). Suspected task: TASK-687. Cross-referenced to CLAUDE.md "IPC handler ↔ declared T parity" rule (FIND-SPRINT-024-4).
- **Problem:** `main/src/ipc/cyboflow.ts:144-167` — `const { projectId } = args as { projectId: number }` provides no runtime guard. If a renderer accidentally omits or mis-types `projectId`, better-sqlite3 either throws on a `WHERE project_id = undefined` binding or silently returns all rows (depending on driver behaviour). `cyboflow:listWorkflows` and `cyboflow:startRun` follow the same destructure-without-validation pattern. The CLAUDE.md IPC parity rule flags this class of silent shape-drift; the finding is that the rule needs a runtime enforcement point, not just a TypeScript declaration.
- **Proposed direction:** Add a guard at the top of each affected handler: for `listRuns`, `if (typeof args?.projectId !== 'number') return { success: false, error: 'listRuns: projectId must be a number' };`. Extract a small `validateNumberArg(args, key)` helper in `main/src/ipc/cyboflow.ts` (or in a new `main/src/ipc/validate.ts`) that all cyboflow:* handlers share. Write a unit test covering the invalid-arg path for at least `listRuns`. This keeps the validation rule co-located and easy to audit during future handler additions.
- **Scope:** small

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** medium
- **Reasoning:** Verified at `main/src/ipc/cyboflow.ts:144-167` — `listRuns` destructures `projectId` from `args: { projectId: number }` with no runtime guard, and sibling handlers (`listWorkflows`, `startRun`) share the same pattern, which the existing CLAUDE.md IPC parity rule flags only at the TypeScript level.

---

## C. CLAUDE.md / CODE-PATTERNS.md improvements (apply now)

### C1. Document the `navigateToSessions` side-effect contract in `docs/SHELL-LAYOUT.md`
- **Summary:** `navigateToSessions` nulls `activeProjectId`, which un-mounts `CyboflowRoot` under the current App.tsx gate — this contract is undocumented and caused REG-SPRINT-028-1 without any per-task test catching it.
- **Source-Sprint:** SPRINT-028
- **Target file:** `docs/SHELL-LAYOUT.md`
- **Rationale:** FIND-SPRINT-028-6 and REG-SPRINT-028-1 both trace back to an undocumented side effect of `navigateToSessions`. `docs/SHELL-LAYOUT.md` owns the shell's render conditions and is the correct home for the navigation-store contract that every future shell task must respect. Without this note, the next task that adds a navigation action risks the same regression.
- **Proposed change:**
  Add a new section after "## Cross-references" in `docs/SHELL-LAYOUT.md`:

  ```diff
  +## Navigation store contract
  +
  +`CyboflowRoot` is mounted **only when `activeProjectId !== null`** (App.tsx gate at the
  +`<div className="flex flex-1 overflow-hidden">` block).
  +
  +`navigateToSessions()` (`frontend/src/stores/navigationStore.ts`) is a **multi-field reset**:
  +it sets `{ activeView: 'sessions', activeProjectId: null }`. Calling it while activating
  +a run un-mounts `CyboflowRoot` immediately (REG-SPRINT-028-1). Rules:
  +
  +- Do NOT call `navigateToSessions()` in a click handler that also calls `setActiveRun()`.
  +  Use `setActiveProjectId(run.project_id)` or a dedicated `selectRun(runId, projectId)`
  +  action instead.
  +- Other `navigateToSessions` call sites (`DraggableProjectTreeView`, `SessionListItem`,
  +  `ProjectDashboard`) should be audited before TASK-690 retires `useLegacyCrystalView`.
  +- When adding a new App-level mount condition, document it in this section.
  ```

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** high
- **Reasoning:** Grep across `docs/SHELL-LAYOUT.md` confirms zero existing references to `navigateToSessions`, `activeProjectId`, or the App.tsx:338 gate — and REG-SPRINT-028-1 was caused precisely by this undocumented contract, so the rule will guard future shell tasks against the same regression.

---

### C2. Add IPC handler runtime validation pattern to `docs/CODE-PATTERNS.md`
- **Summary:** The existing CLAUDE.md "IPC handler ↔ declared T parity" rule covers TypeScript-level type matching but does not address runtime input validation — leaving cyboflow:* handlers silently misbehaving on unexpected args.
- **Source-Sprint:** SPRINT-028
- **Target file:** `docs/CODE-PATTERNS.md`
- **Rationale:** FIND-SPRINT-028-11 shows that `cyboflow:listRuns`, `cyboflow:listWorkflows`, and `cyboflow:startRun` all destructure `args` without runtime checks, in contradiction to the spirit of the IPC parity rule. Adding a pattern entry makes the expected guard pattern concrete and discoverable, preventing the same drift in future handler additions. The existing CLAUDE.md rule already references `docs/CODE-PATTERNS.md` for patterns; this extends it to the runtime dimension.
- **Proposed change:**
  Add to the "IPC handler structure (main process)" section in `docs/CODE-PATTERNS.md`:

  ```diff
   ### IPC handler structure (main process)
   
   Each domain has its own IPC file in `main/src/ipc/` that registers `ipcMain.handle` calls.
   All handlers are registered in `main/src/ipc/index.ts`. Keep business logic in `services/`,
   not in IPC handlers — handlers should be thin: validate input, delegate to service, return result.
   
   - **Canonical example:** `main/src/ipc/session.ts`
  +
  +**Runtime input validation:** Every handler that reads from `args` MUST type-guard the
  +expected fields before use. A bare `const { projectId } = args as { projectId: number }`
  +cast is insufficient — if the renderer passes `undefined`, better-sqlite3 throws or
  +returns wrong rows silently. Required pattern:
  +
  +```typescript
  +ipcMain.handle('cyboflow:listRuns', (_event, args: unknown) => {
  +  if (typeof (args as Record<string, unknown>)?.projectId !== 'number') {
  +    return { success: false, error: 'listRuns: projectId must be a number' };
  +  }
  +  const { projectId } = args as { projectId: number };
  +  // ... delegate to service
  +});
  +```
  +
  +For domains with multiple handlers sharing the same arg shapes, extract a `validateArg`
  +helper in the domain's IPC file (see `main/src/ipc/cyboflow.ts` after B3 lands). This
  +keeps the guard co-located with the handler and easy to audit during handler additions.
  +Canonical drift: FIND-SPRINT-028-11 — three cyboflow:* handlers without guards.
  ```

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** medium
- **Reasoning:** The existing CLAUDE.md IPC parity rule (line 55) covers return-shape type matching only; `docs/CODE-PATTERNS.md:205-211` says "validate input" but provides no concrete pattern, leaving the gap that produced FIND-SPRINT-028-11 across three sibling handlers.

---

## Reconciled Findings (informational)

The following findings appeared with `status: open` in the SPRINT-028 findings file but were already claimed as resolved by executor commits during the sprint:

- **FIND-SPRINT-028-4** — stale line range in `docs/SHELL-LAYOUT.md` — claimed resolved by TASK-686 in `.soloflow/archive/done/cyboflow-shell-architecture/TASK-686-done.md` (commit bff39b5 updated line 33 from 374-432 to 317-375).
- **FIND-SPRINT-028-5** — duplicate `WorkflowRunRow` name across frontend and shared types — claimed resolved by TASK-687 in `.soloflow/archive/done/cyboflow-shell-architecture/TASK-687-done.md` (commit 6beac49 renamed frontend lite shape to `WorkflowRunListRow`).

Additionally, the following finding was not eligible for triage because it lacks a formal FIND entry and no status field — treated per the process below:

- **FIND-SPRINT-028-1** (infra probe disagreement between sprint-initiator and shadow-agents drift check) — see "Suppressed — SoloFlow Defects" below.

---

## Suppressed — SoloFlow Defects

The following item was a candidate for Bucket C but failed the self-defect check — it describes SoloFlow agent behavior, not a project codebase convention, and would evaporate if the user switched to a different workflow tool.

- **SPRINT-028 infra probe disagreement** — The sprint-initiator infra_check reported "shadow agents stale" while `scripts/init/shadow-agents.js --mode check` returned `drifted: false` with `recorded_version 0.11.0` across all four agents. This is a discrepancy between two SoloFlow internal scripts, not a cyboflow project convention. Consider opening an issue or running `/soloflow:compound --tester` against this sprint in a SoloFlow-tester setup to surface it as a maintainer recommendation.
