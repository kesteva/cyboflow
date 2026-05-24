---
id: IDEA-024
type: FEATURE
status: draft
created: 2026-05-23T00:00:00Z
epics: [quick-session]
slices:
  - title: "Quick-session IPC + worktree scaffolding"
    description: "Add a sessions:create-quick IPC handler (or extend sessions:create with a quickSession flag) that auto-generates a worktree name, spins up an ephemeral worktree off the default branch via WorktreeManager.createWorktree, and creates a Session record. Resolve the WorkflowRun ownership question before this slice is written as tasks."
    value_statement: "Establishes the backend contract all entry points depend on; nothing else in this idea can ship without it."
  - title: "WorkflowPicker quick-start buttons"
    description: "Add 'Quick Chat' and 'Quick Terminal' buttons inside the WorkflowPicker modal alongside the existing 'Start Run' button. Each button calls the quick-session IPC handler with toolType='claude' or toolType='none' (terminal-only) respectively, then navigates to the new session."
    value_statement: "Surfaces the quick-session entry point at the natural workflow-selection moment, making it discoverable to users who already open the picker."
  - title: "Top-level app-shell entry point + keyboard shortcut"
    description: "Add a 'Quick Session' button or split-button to the CyboflowRoot header bar (next to 'Choose workflow') and register a keyboard shortcut. Clicking/invoking it opens a minimal mode-selection prompt (Chat / Terminal) and triggers the same quick-session IPC handler."
    value_statement: "Gives users a persistent, zero-click path to a quick session that is reachable without opening the workflow picker modal."
  - title: "Session list and navigation integration"
    description: "Ensure quick sessions appear in the existing session list (SessionListItem) with a visual marker (e.g. 'Quick' badge) distinguishing them from flow-owned sessions. Confirm archive / rename / favorite actions all work correctly on sessions that may have no WorkflowRun owner."
    value_statement: "Prevents quick sessions from appearing broken or invisible in the session list, which is the primary post-session navigation surface."
open_questions:
  - question: "Should each quick session create a synthetic WorkflowRun record (preserving the 'every session has a run owner' invariant) or skip the orchestrator entirely (requiring nullable run linkage throughout)?"
    context: "workflow_runs has a NOT NULL workflow_id FK; sessions table has no run_id column today. The orchestrator, run-list UIs, MCP query handler, and archive paths all assume every active session is traceable to a run. A synthetic 'quick-session' workflow could be seeded per project; alternatively the sessions table could get a nullable run_id column and every run-aware query audited. This is the highest-risk architectural decision and must be resolved before any backend task is written."
    candidates:
      - "Seed a synthetic 'Quick Session' workflow per project at project-creation time and create a WorkflowRun row for each quick session against that workflow."
      - "Add a nullable run_id column to sessions and audit all run-aware queries to tolerate NULL; skip WorkflowRun creation entirely for quick sessions."
      - "Create a single shared 'quick-sessions' WorkflowRun per project (reused across all quick sessions in that project) to avoid per-session run overhead."
    answer: "Nullable run_id on sessions; skip WorkflowRun. Refiner must include a query-audit task across run-list UIs, MCP query handler (main/src/orchestrator/mcpServer/mcpQueryHandler.ts), orchestrator state, archive paths, and the cyboflowStore.activeRunId path."
  - question: "What naming scheme should be used for auto-generated ephemeral worktree branches?"
    context: "WorktreeManager.createWorktree takes an explicit name parameter; the TaskQueue generates names from prompts. Quick sessions have no prompt at creation time. The branch name will be visible in git log and worktree listings."
    candidates:
      - "Timestamp-based: quick-YYYYMMDD-HHmmss (predictable, sortable, human-readable)"
      - "Short UUID suffix: quick-<8-char-uuid> (collision-proof, opaque)"
      - "Type-prefixed timestamp: chat-YYYYMMDD-HHmmss or terminal-YYYYMMDD-HHmmss (encodes panel type)"
    answer: "Timestamp-based: quick-YYYYMMDD-HHmmss. UTC timestamp; the type is not encoded in the branch name."
  - question: "Where exactly in the CyboflowRoot header should the quick-session entry point live — as a standalone button, a split-button combined with 'Choose workflow', or a dropdown?"
    context: "The header bar currently has a single 'Choose workflow' button. The synthesis specifies 'alongside' WorkflowPicker's Start Run AND a top-level button/shortcut. Choosing the wrong affordance may clutter the header or create two confusingly similar modal flows."
    candidates:
      - "Separate 'Quick Session' button next to 'Choose workflow' in the header bar"
      - "Split-button on 'Choose workflow': primary action stays 'Choose workflow', secondary dropdown adds 'Quick Chat' and 'Quick Terminal'"
      - "Collapse both into a single '+' icon-button that opens a unified session-start modal with workflow and quick-session options"
    answer: "Standalone 'Quick Session' button next to 'Choose workflow'. Clicking it opens a minimal inline mode picker (Chat / Terminal) before invoking the IPC."
  - question: "Should the quick-session entry points be visible when no project is selected?"
    context: "WorkflowPicker already guards on projectId !== null before rendering. Quick sessions require a project to create a worktree. If the user reaches the header before a project is active, the button must either be disabled or trigger project selection first."
    candidates:
      - "Disable the quick-session button and show a tooltip explaining a project must be selected first."
      - "Clicking quick-session when no project is selected redirects to the project selector, then proceeds."
    answer: "DEFERRED — not answered by user. Refiner should default to 'disable button with tooltip explaining a project must be selected first', matching WorkflowPicker's existing projectId-null guard pattern. Flag the deferral in the refinement checkpoint so the user can override."
assumptions:
  - assumption: "The existing sessions:create IPC path (TaskQueue.createSession → WorktreeManager.createWorktree → SessionManager.createSession) can be reused or minimally extended for quick sessions without a new parallel code path."
    confidence: high
    validation: "sessions:create already accepts toolType='claude'|'none' and an empty prompt; a quick-session wrapper could call it with toolType set and an empty/sentinel prompt. Verify in main/src/ipc/session.ts lines 182-282 and main/src/services/taskQueue.ts."
  - assumption: "ToolPanelType 'terminal' (toolType='none' in CreateSessionRequest) already creates a terminal-only session with no Claude panel; no new panel type is needed."
    confidence: high
    validation: "Session.toolType: 'claude' | 'none' is defined in main/src/types/session.ts line 26. Confirm 'none' suppresses Claude panel creation in the TaskQueue processor (main/src/services/taskQueue.ts lines 196-215)."
  - assumption: "The existing useAddTerminalPanel and useEnsureClaudePanel hooks in the frontend can be called directly after quick-session creation to populate the initial panel, without new panel-creation logic."
    confidence: medium
    validation: "Both hooks accept a session with {id, worktreePath} and call panelApi.createPanel. Verify that a newly-created quick session has worktreePath populated before the hooks are invoked (SessionManager.createSession resolves the path synchronously before returning)."
  - assumption: "quick sessions will not interfere with CyboflowRoot's existing mainRepoSession resolution, which calls sessions:get-or-create-main-repo and is keyed on is_main_repo=true."
    confidence: high
    validation: "Quick sessions would be created with is_main_repo=false (same as flow sessions). Confirm database queries in main/src/database/database.ts filter on is_main_repo correctly."
  - assumption: "The sessions table does not currently have a run_id column, so no migration is required for the 'skip WorkflowRun' path and a single ALTER TABLE migration suffices for the 'nullable run_id' path."
    confidence: high
    validation: "Inspect main/src/database/schema.sql and all migration files in main/src/database/migrations/ — no run_id column found in sessions table per schema.sql lines 1-15."
research_recommendation: not_needed
research_rationale: "The idea is fully grounded in existing codebase patterns (TaskQueue, WorktreeManager, panelApi, WorkflowPicker); all open questions are architectural decisions resolvable from the code and user input, not from external documentation."
---

# Quick Session — Start Chat or Terminal Without a Flow

## Raw Input

> right now users can only start a session using one of the flows. They can access a terminal and a chat bot within those sessions, but not start one directly. Users should be able to start a chat or terminal only session without triggering a flow.

## Grounding

The following real files anchor every claim in this idea.

**Frontend entry points**

- `/Users/raimundoesteva/Developer/cyboflow/frontend/src/components/cyboflow/WorkflowPicker.tsx` — the workflow-selection modal that currently only offers "Start Run" against a selected workflow. This is the primary in-context insertion point for quick-session buttons.
- `/Users/raimundoesteva/Developer/cyboflow/frontend/src/components/cyboflow/CyboflowRoot.tsx` — top-level view. Contains the header bar with the single "Choose workflow" button; the empty-state CTA; and the panel surface below. Both named insertion points (header button + picker modal) live in this file and the component it hosts.
- `/Users/raimundoesteva/Developer/cyboflow/frontend/src/stores/cyboflowStore.ts` — Zustand store holding `activeRunId`. If quick sessions bypass WorkflowRun, a parallel `activeQuickSessionId` or a reworked store slice may be needed.

**Panel hooks (reusable)**

- `/Users/raimundoesteva/Developer/cyboflow/frontend/src/hooks/useAddTerminalPanel.ts` — creates a terminal panel for a session and activates it.
- `/Users/raimundoesteva/Developer/cyboflow/frontend/src/hooks/useEnsureClaudePanel.ts` — find-or-create a Claude panel for a session.
- `/Users/raimundoesteva/Developer/cyboflow/frontend/src/hooks/usePanelSurface.ts` — unified panel-surface hook used by CyboflowRoot; resolves `mainRepoSession` and manages panel tab state.

**Backend session creation**

- `/Users/raimundoesteva/Developer/cyboflow/main/src/ipc/session.ts` (lines 182–282) — `sessions:create` handler; accepts `CreateSessionRequest` and delegates to `taskQueue.createSession`.
- `/Users/raimundoesteva/Developer/cyboflow/main/src/types/session.ts` (lines 56–74) — `CreateSessionRequest` interface; `toolType: 'claude' | 'none'` already present; `prompt` is the only required field with no minimum length constraint enforced in the type.
- `/Users/raimundoesteva/Developer/cyboflow/main/src/services/taskQueue.ts` (lines 132–240) — `TaskQueue.createSession` processor: calls `WorktreeManager.createWorktree`, then `SessionManager.createSession`; skips prompt-related setup when prompt is empty.
- `/Users/raimundoesteva/Developer/cyboflow/main/src/services/worktreeManager.ts` — `WorktreeManager.createWorktree(projectPath, name, branch?, baseBranch?, worktreeFolder?)` creates the git worktree.

**Data model**

- `/Users/raimundoesteva/Developer/cyboflow/shared/types/panels.ts` — `ToolPanelType = 'terminal' | 'claude' | ...`; `ToolPanel`; `CreatePanelRequest`.
- `/Users/raimundoesteva/Developer/cyboflow/main/src/types/session.ts` (lines 1–32) — `Session` interface; `toolType?: 'claude' | 'none'`; `isMainRepo?`.
- `/Users/raimundoesteva/Developer/cyboflow/main/src/database/schema.sql` (lines 1–15, 56–74) — `sessions` table has no `run_id` column today; `workflow_runs` requires a `NOT NULL workflow_id` FK.
- `/Users/raimundoesteva/Developer/cyboflow/shared/types/cyboflow.ts` — `WorkflowRunRow`, `WorkflowRow`; confirms the run ownership schema.

**Session list UI**

- `/Users/raimundoesteva/Developer/cyboflow/frontend/src/components/SessionListItem.tsx` — renders each session in the sidebar; drives archive/rename/favorite actions. Quick sessions must integrate here without breakage.

## Slices

### Slice 1 — Quick-session IPC + worktree scaffolding

This is the backend prerequisite. A new `sessions:create-quick` IPC handler (or a `quickSession: true` flag added to `sessions:create`) auto-generates a worktree branch name (no user prompt required), calls `WorktreeManager.createWorktree` off the default branch, and creates a `Session` record with `toolType` set to the requested panel type. The architectural question of WorkflowRun ownership (open question 1) must be resolved before this slice is tasked — it determines whether a new migration and a synthetic workflow row are needed, or whether a nullable `run_id` is added to the sessions table.

### Slice 2 — WorkflowPicker quick-start buttons

Two buttons — "Quick Chat" and "Quick Terminal" — are added inside the `WorkflowPicker` modal body, rendered below the existing `<select>` + "Start Run" section. Each button invokes the quick-session IPC handler with `toolType='claude'` or `toolType='none'`, waits for the session to be created, and calls `useCyboflowStore.setActiveRun` (or its quick-session equivalent) to navigate to the new session. Because the `WorkflowPicker` is already surfaced in the picker modal inside `CyboflowRoot.tsx`, no new modal wiring is needed.

### Slice 3 — Top-level app-shell entry point + keyboard shortcut

A persistent quick-session affordance is added to the `CyboflowRoot` header bar (file `/Users/raimundoesteva/Developer/cyboflow/frontend/src/components/cyboflow/CyboflowRoot.tsx`). The exact affordance shape (standalone button, split-button, or combined modal) is an open question for refinement. A keyboard shortcut is registered via a new `useAddQuickSessionShortcut` hook following the same pattern as the existing `useAddTerminalShortcut` and `useAddClaudeShortcut` hooks in that file. When invoked, the shortcut/button opens a minimal inline mode picker (Chat or Terminal) and triggers slice 1's IPC call.

### Slice 4 — Session list and navigation integration

Quick sessions are created with the existing `sessions` table schema, so they will appear in `SessionListItem` automatically. This slice ensures: (a) quick sessions are visually distinguished (e.g., a "Quick" badge or icon in `SessionListItem`); (b) archive, rename, and favorite context-menu actions work correctly regardless of WorkflowRun ownership; (c) the `sessions:get-all-with-projects` query that feeds the sidebar does not exclude or misrender sessions created via the quick path. If a nullable `run_id` column is chosen in slice 1, any query in `main/src/database/database.ts` that joins or filters on run ownership must be audited here.

## Open Questions

**1. WorkflowRun ownership for quick sessions** — **ANSWERED**

Every `workflow_runs` row today requires a non-null `workflow_id` FK. The `sessions` table has no `run_id` column. The run-list UIs, MCP query handler (`main/src/orchestrator/mcpServer/mcpQueryHandler.ts`), archive paths, and potentially the `cyboflowStore` all assume session → run traceability. Two clean options exist: (A) seed a synthetic "Quick Session" `workflows` row per project and create a `WorkflowRun` per quick session against it; or (B) add a nullable `run_id` to `sessions` and audit every run-aware query.

**Answer:** Nullable `run_id` on `sessions`; skip WorkflowRun creation for quick sessions entirely. The refiner MUST include a dedicated query-audit task that walks every run-aware surface — run-list UIs, MCP query handler, orchestrator state, archive paths, `cyboflowStore.activeRunId` consumers, and `database.ts` queries that join on `workflow_run_id` — and adds NULL tolerance where needed. The `ALTER TABLE sessions ADD COLUMN run_id TEXT` migration must run before slice 1's IPC handler.

**2. Auto-generated worktree branch naming scheme** — **ANSWERED**

`WorktreeManager.createWorktree` needs a name. Quick sessions have no user prompt at creation time.

**Answer:** Timestamp-based: `quick-YYYYMMDD-HHmmss` (UTC). The panel type is not encoded in the branch name.

**3. App-shell entry point affordance shape** — **ANSWERED**

The `CyboflowRoot` header currently has a single "Choose workflow" button.

**Answer:** Standalone "Quick Session" button rendered next to "Choose workflow". Clicking it opens a minimal inline mode picker (Chat / Terminal) before invoking the quick-session IPC. The keyboard shortcut from slice 3 invokes the same picker (or directly opens Chat — refiner decides; see slice 3 detailing).

**4. Behavior when no project is selected** — **DEFERRED**

`WorkflowPicker` already guards on `projectId !== null`. A quick session also requires a project (for the worktree path).

**Default for refinement (user did not pick — refiner may override at the planning checkpoint):** Disable the quick-session button when no project is selected and surface a tooltip explaining a project must be selected first. This mirrors `WorkflowPicker`'s existing `projectId !== null` guard pattern. Flag this default at the planning review so the user can switch to the redirect-to-project-selector behavior if preferred.

## Assumptions

1. **`sessions:create` can be reused or lightly extended.** `CreateSessionRequest.toolType` and `CreateSessionRequest.prompt` (empty string accepted) already exist; the `TaskQueue` processor skips prompt-display logic when prompt is empty (confirmed at `main/src/services/taskQueue.ts` lines 221–238). Confidence: high.

2. **`toolType='none'` produces a terminal-only session with no Claude panel.** `Session.toolType: 'claude' | 'none'` is defined in `main/src/types/session.ts` line 26. Confidence: high — validate that the TaskQueue processor respects `toolType='none'` to suppress Claude panel creation.

3. **`useAddTerminalPanel` and `useEnsureClaudePanel` are sufficient for post-creation panel initialisation.** Both hooks accept a minimal `{id, worktreePath}` session shape. Confidence: medium — depends on the quick session having `worktreePath` populated synchronously by the time the frontend callback fires.

4. **Quick sessions will not disrupt main-repo session resolution.** `getOrCreateMainRepoSession` is keyed on `is_main_repo=true`; quick sessions use `is_main_repo=false`. All `database.ts` queries filtering on `is_main_repo` should be unaffected. Confidence: high.

5. **No new DB migration is needed for the 'synthetic workflow' path; a single `ALTER TABLE sessions ADD COLUMN run_id TEXT` migration suffices for the nullable-run_id path.** The `sessions` table confirmed to have no `run_id` column in `main/src/database/schema.sql`. Confidence: high.
