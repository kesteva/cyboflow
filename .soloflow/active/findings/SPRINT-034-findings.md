---
sprint: SPRINT-034
pending_count: 7
last_updated: "2026-05-23T21:19:05.823Z"
---
# Findings Queue

TASK-555 gated: failing blocking prereq (notarytool credentials missing).

## FIND-SPRINT-034-2
- **source:** TASK-620 (verifier)
- **type:** improvement
- **severity:** low
- **status:** open
- **location:** shared/types/mcpHealth.ts:36
- **description:** `HEALTH_STARTING` is exported as a plain `McpServerHealth` const (not `Readonly<McpServerHealth>` or `Object.freeze`'d). Both call sites (`main/src/ipc/cyboflow.ts:211` and `main/src/orchestrator/trpc/routers/health.ts:46`) `return HEALTH_STARTING` directly — every caller receives the same object reference. A future consumer that mutates the response would corrupt the shared singleton globally, with no compile-time warning. Today both consumers are read-only, so this is latent; flagging now so the next contact gives it a `Readonly<McpServerHealth>` annotation or `Object.freeze`.
- **suggested_action:** Either annotate as `export const HEALTH_STARTING: Readonly<McpServerHealth> = Object.freeze({ status: 'starting', restartAttempts: 0 });` or wrap each call site to return a shallow clone (`return { ...HEALTH_STARTING };`). The frozen-readonly approach is preferred (cheaper, type-checked).
- **resolved_by:** 

## FIND-SPRINT-034-1
- **source:** TASK-617 (code-reviewer)
- **type:** cleanup
- **severity:** low
- **status:** open
- **location:** main/src/orchestrator/mcpServer/__tests__/mcpQueryHandler.test.ts:19
- **description:** Header docstring still says "use an in-memory better-sqlite3 instance initialised with the imported GATE_SCHEMA fixture", but TASK-617 replaced that import with an inline `MINIMAL_SCHEMA` const (see line 38). The docstring now misdescribes the fixture and references an import that is no longer present. Future readers grepping for `GATE_SCHEMA` will hit this stale comment plus the line-31 "Mirrors the relevant subset of REGISTRY_SCHEMA + GATE_SCHEMA" comment (which is still accurate-as-prose, but the line-19 sentence is not).
- **suggested_action:** Update line 19 to "All tests use an in-memory better-sqlite3 instance initialised with the inline `MINIMAL_SCHEMA` const declared below (no real migration runner — tests are hermetic)."
- **resolved_by:** 

## FIND-SPRINT-034-3
- **type:** claude-md
- **severity:** low
- **source:** TASK-655 (verifier)
- **description:** Peekaboo MCP reported both Screen Recording + Accessibility grants present, but live `image` capture against the running Cyboflow Electron window failed with "Failed to start stream due to audio/video capture failure" (both background and auto focus modes). This suggests the per-binary Screen Recording grant for the Electron host that runs `pnpm dev` (path: node_modules/.pnpm/electron@37.6.0/node_modules/electron/dist/Electron.app) may be missing or stale, even though the Peekaboo binary itself is granted. docs/VISUAL-VERIFICATION-SETUP.md should call out that BOTH the Peekaboo CLI AND the dev-mode Electron app need an explicit Screen Recording grant before the verifier can capture renderer output; otherwise probe-passes-but-capture-fails silently degrades visual_macos to skipped_unable.
- **suggested_action:** Add a troubleshooting note to docs/VISUAL-VERIFICATION-SETUP.md: if Peekaboo reports grants present but capture still errors with "audio/video capture failure", check System Settings → Privacy & Security → Screen Recording for the Electron.app under node_modules and toggle it on (then restart pnpm dev). Include the exact Electron path so users can find it quickly.

## FIND-SPRINT-034-4
- **source:** TASK-655 (code-reviewer)
- **type:** cleanup
- **severity:** low
- **status:** open
- **location:** frontend/src/utils/toolFormatter.ts:505-516, main/src/utils/toolFormatter.ts:647-658
- **description:** After TASK-655, the orphaned-tool-result branch passes `extractToolResultText(result.content)` (always returns `string`) into `filterBase64Data` (returns primitives unchanged), so `filteredContent` is now provably a `string`. The downstream `else if (filteredContent !== null && filteredContent !== undefined) { ... JSON.stringify(...) }` and trailing `else { contentStr = ''; }` branches are unreachable dead code, and `filterBase64Data` itself is a no-op on this path. Secondary behavioral note: orphan `tool_result` blocks whose content is an array of image blocks (`{type: 'image', source: {type: 'base64', data: ...}}`) now render as empty string instead of the previous JSON-stringified `{... "data": "[Base64 data filtered]" ...}` — because `extractToolResultText` drops every block without a `text` field. Acceptable per the plan's "Lowest Confidence Area" note; flagging so future support tickets about missing orphan-image-result rendering link back here.
- **suggested_action:** Collapse the orphan branch to `const contentStr = makePathsRelative(extractToolResultText(result.content));` (frontend) / `... (extractToolResultText(result.content), gitRepoPath);` (main), deleting `filterBase64Data` from this call chain and the unreachable conditional arms. If support reveals real users hitting orphan-image-result rendering, add an image-block branch to `extractToolResultText` (e.g. render `[Image: <size>KB]` placeholder).
- **resolved_by:** 

## FIND-SPRINT-034-5
- **type:** scope_deviation
- **source:** TASK-656 (executor)
- **severity:** low
- **status:** resolved
- **location:** main/src/services/streamParser/__tests__/schemas.test.ts
- **description:** Option 3 implementation requires updating the passthrough-preservation assertions in schemas.test.ts and typedEventNarrowing.test.ts. These files are listed as files_readonly in the plan but the plan body §Option 3 explicitly calls out these test updates as part of the change. Files claimed via claim-file.js (both granted without conflict) to make the changes.
- **resolved_by:** verifier — plan-prescribed: §Option 3 lines 67-69 explicitly call for updating `schemas.test.ts:357-375` and `typedEventNarrowing.test.ts:100-105` passthrough assertions; both files also appear in `files_owned` (lines 9-10), so the plan frontmatter is internally contradictory but the prescription is unambiguous. Also AC-prescribed: AC4 requires vitest to pass after dropping outer `.passthrough()`, which forces the assertion updates.

## FIND-SPRINT-034-6
- **type:** scope_deviation
- **source:** TASK-689 (executor)
- **severity:** low
- **status:** resolved
- **location:** frontend/src/components/__tests__/DraggableProjectTreeView.runs.test.tsx:115
- **description:** required to meet AC: completeness gate found this test file also references CreateSessionDialog via vi.mock. Removing the stale mock is required so grep -rn returns 0 matches for CreateSessionDialog across frontend/src/.
- **resolved_by:** verifier — not actually a scope deviation: frontend/src/components/__tests__/DraggableProjectTreeView.runs.test.tsx IS listed in the plan's files_owned (line 12 of TASK-689-plan.md frontmatter). Executor mislabeled an in-scope edit as a deviation. Also AC-prescribed: AC line 28 ("No source file under frontend/src/ references the identifier CreateSessionDialog") forces removal of the stale vi.mock.

## FIND-SPRINT-034-7
- **source:** TASK-689 (code-reviewer)
- **type:** cleanup
- **severity:** low
- **status:** open
- **location:** frontend/src/types/electron.d.ts:76
- **description:** Stale documentation comment references `ProjectTreeView` as one of the local-type definers for the `ProjectWithSessions[]` shape returned by `getAllWithProjects` / `getArchivedWithProjects`. TASK-689 deleted `frontend/src/components/ProjectTreeView.tsx` entirely (unused legacy duplicate), so the comment now points at a nonexistent file. The runtime contract is unchanged — `DraggableProjectTreeView.tsx` still locally defines its own shape and casts the `unknown[]` payload — but the comment misleads a future reader trying to locate the canonical type definition. Out of TASK-689's diff scope (electron.d.ts is not in files_owned).
- **suggested_action:** Update line 76 to read `// but that type is locally defined in DraggableProjectTreeView.` (drop the ` / ProjectTreeView` suffix). One-line edit, no behavior change.
- **resolved_by:** 

## FIND-SPRINT-034-9
- **source:** TASK-691 (code-reviewer)
- **type:** cleanup
- **severity:** low
- **status:** open
- **location:** docs/CODE-PATTERNS.md:319
- **description:** The canonical-example pointer `main/src/services/worktreeManager.ts:472` is line-stale — the actual `@cyboflow-hidden` method-group comment lives at line 502 in the current file (post-TASK-691). The stale line number predates TASK-691 (also pointed at non-hidden code at line 472 in the pre-commit revision), so this is pre-existing drift the executor had the opportunity to refresh but did not. Future readers grepping by line number will land mid-loop inside `getRebaseInfo`, not on the canonical example. Out of TASK-691's strict diff (executor edited CODE-PATTERNS.md but only to remove the second canonical-example bullet).
- **suggested_action:** Change `main/src/services/worktreeManager.ts:472` to `main/src/services/worktreeManager.ts:502` in docs/CODE-PATTERNS.md.
- **resolved_by:** 

## FIND-SPRINT-034-10
- **source:** TASK-691 (code-reviewer)
- **type:** cleanup
- **severity:** low
- **status:** open
- **location:** frontend/src/components/panels/SetupTasksPanel.tsx
- **description:** TASK-691 scrubbed the inline TODO `TODO(TASK-691): SetupTasksPanel will be deleted with the SessionView retirement` from SetupTasksPanel.tsx (line ~88 pre-commit), but the panel itself was *not* deleted in this task and is still mounted via `frontend/src/components/panels/PanelContainer.tsx:14,65`. The scrubbed TODO was a forward-looking deletion-candidate signal; removing it without filing a follow-up loses the hint that SetupTasksPanel should be re-examined for deletion now that SessionView is gone. Whether the panel is actually orphaned post-IDEA-017 is unclear without consulting the broader shell-architecture epic — RunView may or may not surface it.
- **suggested_action:** Audit whether SetupTasksPanel is still reachable from the post-IDEA-017 shell (Run/Setup tab in the cyboflow shell vs. residual Crystal panel-tab plumbing). If unreachable, file a deletion follow-up task. If reachable, drop a one-line comment at the top of the file naming the active consumer so the deletion-candidate concern is resolved on paper.
- **resolved_by:** 

## FIND-SPRINT-034-8
- **type:** scope_deviation
- **source:** TASK-691 (executor)
- **severity:** low
- **status:** resolved
- **location:** frontend/src/components/PromptHistory.tsx:82, frontend/src/components/PromptHistoryModal.tsx:96, frontend/src/hooks/useAddTerminalPanel.ts:15,26, frontend/src/components/panels/SetupTasksPanel.tsx:88
- **description:** These 4 files outside original files_owned contain stale comment references to SessionView that would cause the acceptance criteria grep-zero check to fail. Claimed to remove comments (no functional impact). Required to meet AC: grep -rn SessionView frontend/src/ returns 0 matches.
- **resolved_by:** verifier — not actually a scope deviation: all 5 edited files (PromptHistory.tsx, PromptHistoryModal.tsx, useAddTerminalPanel.ts, SetupTasksPanel.tsx, useAddTerminalPanel.test.tsx) ARE listed in TASK-691-plan.md files_owned (lines 19-23). Executor mislabeled in-scope edits as deviations. Also AC-prescribed: AC2 ("No SessionView references remain in frontend/src/") forces these stale-comment removals.

## FIND-SPRINT-034-11
- **type:** bug
- **source:** TASK-692 (executor)
- **severity:** high
- **status:** open
- **location:** main/src/services/sessionManager.ts:7
- **description:** TASK-691 was designed to retire frontend consumers of Crystal-era session data methods, but it did not retire the backend consumer: sessionManager.ts (files_readonly in TASK-692). sessionManager.ts actively imports and calls: getSessionOutputs, addSessionOutput, addPromptMarker, getPromptMarkers, addConversationMessage, getConversationMessages, createExecutionDiff on DatabaseService. It also imports Session, CreateSessionData, UpdateSessionData, ConversationMessage, PromptMarker, ExecutionDiff, CreateExecutionDiffData from database/models.ts. Additionally, session_outputs/conversation_messages/prompt_markers/execution_diffs tables cannot be safely dropped because panel-era methods (addPanelOutput, getPanelOutputs, etc.) still write to those same tables. The sessions table cannot be dropped because schema.sql (readonly) recreates it on every boot and tool_panels has a FK dependency. TASK-692 cannot remove these methods from database.ts or types from models.ts without failing typecheck, and cannot drop the tables without breaking panelManager at runtime.
- **suggested_action:** Create a sibling task (analogous to Option B from the escalation) to retire sessionManager.ts Crystal-session method calls and update schema.sql before re-running TASK-692 as a pure drop migration.
