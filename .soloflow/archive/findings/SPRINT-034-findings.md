---
sprint: SPRINT-034
pending_count: 11
last_updated: "2026-05-23T21:32:18.281Z"
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

## FIND-SPRINT-034-12
- **source:** SPRINT-034 (sprint-code-reviewer)
- **type:** improvement
- **severity:** medium
- **status:** open
- **location:** frontend/src/utils/toolFormatter.ts, frontend/src/utils/formatters.ts:11, frontend/src/utils/toolFormatter.test.ts
- **description:** Cross-task dead code surfaced after TASK-691 deletion sweep — the entire frontend `toolFormatter.ts` (541 LOC) plus the `formatJsonForWeb` export in `frontend/src/utils/formatters.ts` have ZERO production callers in `frontend/src/`. Grep confirms: only `toolFormatter.test.ts` (new in this sprint) imports `formatToolInteraction` from the frontend copy; nothing imports `formatJsonForOutputEnhanced` or `formatJsonForWeb`. The active path is `main/src/utils/toolFormatter.ts`, invoked by `main/src/ipc/session.ts:809`.
- **suggested_action:** Delete `frontend/src/utils/toolFormatter.ts`, the `formatJsonForWeb` export in `frontend/src/utils/formatters.ts`, and `frontend/src/utils/toolFormatter.test.ts`. The frontend never displays raw Claude stream content directly — the live rendering surface (`frontend/src/components/panels/claude/RichOutputView.tsx` and siblings) consumes structured `UnifiedMessage`/`ToolResultBlock` payloads from `main/src/ipc/session.ts`. If a frontend-side raw formatter is ever needed later, it should re-import from a shared `shared/utils/` module, not be a hand-maintained copy of the main-process formatter.
- **resolved_by:** 




This became a cross-task waste in SPRINT-034 because TASK-655 (TypedStreamEventSchema epic) spent effort hardening BOTH copies in lockstep — commits 5a148da (frontend) + a58fa0d (main) made symmetric edits — and also added the 189-line `toolFormatter.test.ts` against the dead frontend copy. The hardening of the dead frontend copy is wasted work that future refactors will continue to pay tax on (any change to ToolResultBlock semantics must keep two near-identical 600-line files in sync). The two copies already drift slightly (the frontend one omits `gitRepoPath` and uses a different `formatJsonForOutput` body), so the diff between them is structural, not just import paths.

Suspected tasks: TASK-655 (added test against dead surface and hardened dead copy), TASK-691 (deleted SessionView/useSessionView, the only legitimate consumers of formatJsonForOutputEnhanced/formatJsonForWeb — leaving the utilities orphaned).

## FIND-SPRINT-034-13
- **source:** SPRINT-034 (sprint-code-reviewer)
- **type:** improvement
- **severity:** medium
- **status:** open
- **location:** frontend/src/components/PromptHistory.tsx:82, frontend/src/components/PromptHistoryModal.tsx:96
- **description:** Dead `navigateToPrompt` CustomEvent dispatch in two locations. Both files `window.dispatchEvent(new CustomEvent(navigateToPrompt, { detail: { sessionId, promptIndex, ... } }))` but grep across `frontend/src` and `main/src` finds ZERO listeners. SessionView was the original listener; TASK-691 deleted it.
- **suggested_action:** Two options: (1) Re-wire prompt navigation to the new shell — add an effect inside `CyboflowRoot` (or a future RunView) that listens for `navigateToPrompt` and routes the user to the matching run/panel. (2) If prompt-history-navigation is not a v1 feature, delete the dispatch block in both files (the modal will still close on click via the existing `onClose()` call) and consider deleting the standalone `PromptHistory.tsx` along with its `frontend/src/types/electron.d.ts:205` comment reference. Recommend option (2) unless a UX requirement says otherwise.
- **resolved_by:** 



Cross-task signature: TASK-691 explicitly stripped the comment `// Dispatch an event that SessionView can listen for` from BOTH files (visible in diff) without deleting the dispatch body. The comment-only edit makes the dispatch appear scoped/intentional while it is now a no-op — every Recent-Prompts click in the modal fires an event that no consumer hears, silently breaking the prompt-navigation UX.

Also: `PromptHistory.tsx` (the non-modal standalone export) has zero importers across `frontend/src` — only `PromptHistoryModal` is mounted (App.tsx:365). The standalone `PromptHistory.tsx` (152 LOC) appears to be orphaned alongside the dead event.

Suspected tasks: TASK-691 (deleted the only navigateToPrompt listener and removed the comment hint but not the dispatch).

## FIND-SPRINT-034-14
- **source:** SPRINT-034 (sprint-code-reviewer)
- **type:** improvement
- **severity:** low
- **status:** open
- **location:** package.json:108
- **description:** `build.asarUnpack` was widened from a single file to the directory glob `main/dist/main/src/orchestrator/mcpServer/**/*.js`. This now unpacks FOUR compiled files: `cyboflowMcpServer.js`, `mcpQueryHandler.js`, `mcpServerLifecycle.js`, `scriptPath.js`. Only `cyboflowMcpServer.js` needs unpacking — it is the subprocess script spawned via `child_process` (and ASAR cannot be executed directly). The other three are imported by the bundled main process (which already runs from inside ASAR), so they exist twice on disk in packaged builds: once inside `app.asar`, once unpacked. Minor disk waste plus a tiny attack surface (the unpacked copies live on a writable filesystem path) — the in-ASAR copy is what Node actually resolves via the bundled `require`/import graph, so swapping the unpacked copy has no effect, but the duplication is unnecessary.
- **suggested_action:** Tighten the glob to `main/dist/main/src/orchestrator/mcpServer/cyboflowMcpServer.js` (literal file, no glob) OR `main/dist/main/src/orchestrator/mcpServer/cyboflowMcpServer*.js` if a future task introduces sibling helper scripts that are also spawned. Verify before changing: this requires the packaged-build smoke that is already queued under TASK-618 deferred-actions (run `pnpm run build:mac:arm64` and `find dist-electron -path *app.asar.unpacked/main/dist/main/src/orchestrator/mcpServer/*.js`).
- **resolved_by:** 


Suspected tasks: TASK-618.

## FIND-SPRINT-034-15
- **source:** SPRINT-034 (sprint-code-reviewer)
- **type:** improvement
- **severity:** low
- **status:** open
- **location:** main/src/services/panels/claude/claudeCodeManager.ts:94, main/src/orchestrator/runLauncher.ts:131, main/src/index.ts:535
- **description:** The cyboflow MCP entry path (TASK-619 eager-resolve, TASK-621 helper extraction, TASK-620 health surface) is wired infrastructure with no production trigger today. Audit:

- `ClaudeCodeManager.setOrchSocketPath()` (line 94) is called only from tests — `grep -rn setOrchSocketPath main/src --exclude-dir=__tests__` returns zero hits outside the manager itself.
- `OrchSocketProvider.getSocketPath()` (referenced at runLauncher.ts:131 and index.ts:535) is stubbed to `throw new Error(cyboflow: orchSocketProvider not yet wired (epic 7 owns permissionIpcServer))`.
- Therefore in v1 every `composeMcpServers()` call evaluates `if (this.orchSocketPath)` as false and returns base servers only. No session ever exercises the eager-resolve, the executeMcpQuery helper, or the cyboflow tool handlers.

This is not a bug — the work is correct preemptive plumbing for the epic-7 wiring task. Flagging because (a) the SPRINT-034 verifier reports 5 of 11 tasks as done against a code path with no end-to-end exercise; future regressions in this surface wont surface via the main app QA. (b) The infrastructure adds ~250 LOC of tests + ~150 LOC of production code that is purely contract-bound today.

Suspected tasks: TASK-619, TASK-620, TASK-621.
- **suggested_action:** No code change. Two recommended follow-ups: (1) When the epic-7 task lands that wires `OrchSocketProvider` and calls `setOrchSocketPath()` from `index.ts`, ensure it executes a manual smoke verifying a Claude session actually invokes a `cyboflow_*` tool — the unit-test coverage today exercises the contract but not the SDK integration. (2) Add a `TODO(epic-7)` comment in `claudeCodeManager.ts:94` noting that `setOrchSocketPath` is awaiting its first production caller, so the next contact knows the eager-resolve has not yet been exercised against real data.
- **resolved_by:** 
