---
sprints: [SPRINT-034]
span_label: SPRINT-034
created: "2026-05-23T22:00:00.000Z"
counters_start:
  ideas: 0
summary:
  cleanups: 7
  backlog_tasks: 3
  claude_md: 3
  soloflow_improvements: 0
---

# Compound Proposal — SPRINT-034

## A. Clean-up items (execute now)

### A1. Fix stale `GATE_SCHEMA` reference in mcpQueryHandler test header docstring
- **Summary:** Line 19 of `mcpQueryHandler.test.ts` still says "initialised with the imported GATE_SCHEMA fixture" after TASK-617 replaced that import with an inline `MINIMAL_SCHEMA` const.
- **Source-Sprint:** SPRINT-034
- **Rationale:** The stale sentence actively misleads readers who grep for `GATE_SCHEMA` — they find a line claiming an import that no longer exists. The fix is a one-line comment edit with zero behavioral impact.
- **Blast radius:** `main/src/orchestrator/mcpServer/__tests__/mcpQueryHandler.test.ts` line 19 only. Risk: trivial.
- **Source:** FIND-SPRINT-034-1 (TASK-617 code-reviewer).
- **Proposed change:**
  ```diff
  - * All tests use an in-memory better-sqlite3 instance initialised with the
  - * imported GATE_SCHEMA fixture (no real migration runner — tests are hermetic). A writes-capturing
  + * All tests use an in-memory better-sqlite3 instance initialised with the
  + * inline `MINIMAL_SCHEMA` const declared below (no real migration runner — tests are hermetic). A writes-capturing
  ```

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** high
- **Reasoning:** Confirmed at `mcpQueryHandler.test.ts:19` — the docstring still says "imported GATE_SCHEMA fixture" while line 38 declares the actual `MINIMAL_SCHEMA` inline const; one-line comment fix with zero blast radius.

---

### A2. Annotate `HEALTH_STARTING` as `Readonly<McpServerHealth>` and freeze it
- **Summary:** `shared/types/mcpHealth.ts:36` exports `HEALTH_STARTING` as a mutable `McpServerHealth` reference returned by value by two call sites, creating a latent shared-singleton mutation risk.
- **Source-Sprint:** SPRINT-034
- **Rationale:** Both consumers (`main/src/ipc/cyboflow.ts:211` and `main/src/orchestrator/trpc/routers/health.ts:46`) return the shared object reference today. Adding `Readonly<McpServerHealth>` and `Object.freeze` is a one-line change that eliminates the mutation risk at compile and runtime with no cost.
- **Blast radius:** `shared/types/mcpHealth.ts` line 36 only. Risk: trivial.
- **Source:** FIND-SPRINT-034-2 (TASK-620 verifier).
- **Proposed change:**
  ```diff
  - export const HEALTH_STARTING: McpServerHealth = {
  + export const HEALTH_STARTING: Readonly<McpServerHealth> = Object.freeze({
       status: 'starting',
       restartAttempts: 0,
  - };
  + });
  ```

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** high
- **Reasoning:** Verified `shared/types/mcpHealth.ts:36` exports a mutable const and both call sites (`main/src/ipc/cyboflow.ts:211`, `main/src/orchestrator/trpc/routers/health.ts:46`) return the shared reference directly — freezing is a one-line zero-cost defense aligned with the new C2 pattern.

---

### A3. Remove stale `/ ProjectTreeView` from `electron.d.ts` comment
- **Summary:** `frontend/src/types/electron.d.ts:76` still names `ProjectTreeView` as a local-type definer for `getAllWithProjects`, but TASK-689 deleted `ProjectTreeView.tsx` entirely.
- **Source-Sprint:** SPRINT-034
- **Rationale:** The comment now points at a nonexistent file and will confuse the next reader trying to locate the canonical `ProjectWithSessions` shape definition.
- **Blast radius:** `frontend/src/types/electron.d.ts` line 76. Risk: trivial.
- **Source:** FIND-SPRINT-034-7 (TASK-689 code-reviewer).
- **Proposed change:**
  ```diff
  -     // but that type is locally defined in DraggableProjectTreeView / ProjectTreeView.
  +     // but that type is locally defined in DraggableProjectTreeView.
  ```

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** high
- **Reasoning:** Confirmed `frontend/src/components/ProjectTreeView.tsx` no longer exists while the comment at `electron.d.ts:76` still names it — one-word edit, zero risk.

---

### A4. Fix stale line-number pointer in `CODE-PATTERNS.md` for `@cyboflow-hidden` canonical example
- **Summary:** `docs/CODE-PATTERNS.md:319` points to `main/src/services/worktreeManager.ts:472` as the canonical `@cyboflow-hidden` method-group example, but post-TASK-691 that comment lives at line 502.
- **Source-Sprint:** SPRINT-034
- **Rationale:** Readers using the docs reference to navigate to the canonical example land mid-loop inside `getRebaseInfo` at line 472, not on the annotation. One-number edit.
- **Blast radius:** `docs/CODE-PATTERNS.md` line 319. Risk: trivial.
- **Source:** FIND-SPRINT-034-9 (TASK-691 code-reviewer).
- **Proposed change:**
  ```diff
  - - **Canonical example (Crystal-preserved):** `main/src/services/worktreeManager.ts:472`
  + - **Canonical example (Crystal-preserved):** `main/src/services/worktreeManager.ts:502`
  ```

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** high
- **Reasoning:** Grep confirms `@cyboflow-hidden` now lives at `worktreeManager.ts:502`, not :472 as the doc says — one-number edit on a navigation pointer.

---

### A5. Add consumer comment to `SetupTasksPanel.tsx` resolving deletion-candidate ambiguity
- **Summary:** TASK-691 removed the `TODO(TASK-691): SetupTasksPanel will be deleted` note without replacing it with a pointer to the active consumer, leaving the file looking like an orphan when it is actually auto-created by `usePanelSurface` in `ProjectView` mode.
- **Source-Sprint:** SPRINT-034
- **Rationale:** `usePanelSurface.ts:102,119` creates a `setup-tasks` panel when `autoCreatePermanentPanels: true`, which is the `ProjectView` path. Without the comment the next reader will spend time auditing reachability that was already done here. A one-line comment at the top of the file closes the concern.
- **Blast radius:** `frontend/src/components/panels/SetupTasksPanel.tsx` — add one comment line. Risk: trivial.
- **Source:** FIND-SPRINT-034-10 (TASK-691 code-reviewer); confirmed via `usePanelSurface.ts:102,119` and `PanelContainer.tsx:64-65`.
- **Proposed change:**
  ```diff
  // @file SetupTasksPanel.tsx
  + // Active consumer: usePanelSurface (autoCreatePermanentPanels=true, ProjectView path) via PanelContainer case 'setup-tasks'.
  + // Not a deletion candidate — re-evaluate only if ProjectView is retired or setup-tasks panel type is removed.
  ```
  Insert after the existing import block, above the `interface SetupTasksPanelProps` declaration.

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** medium
- **Reasoning:** `usePanelSurface.ts:102,119` confirms `setup-tasks` is auto-created on the `autoCreatePermanentPanels=true` path, so the panel is reachable and the deletion-candidate ambiguity is real — a 2-line header comment is proportionate to a trivial future "is this dead?" audit.

---

### A6. Tighten `asarUnpack` glob to the single script that needs unpacking
- **Summary:** `package.json` `build.asarUnpack` currently unpacks four compiled files under `mcpServer/`, but only `cyboflowMcpServer.js` is a subprocess script that must live outside ASAR; the other three are in-graph imports that are already bundled.
- **Source-Sprint:** SPRINT-034
- **Rationale:** The directory glob causes three in-ASAR-imported modules (`mcpQueryHandler.js`, `mcpServerLifecycle.js`, `scriptPath.js`) to also appear as unpacked copies on a writable filesystem path, producing unnecessary disk duplication. The in-ASAR copy is what the bundled `require` graph resolves, so the unpacked duplicates are inert but wasteful.
- **Blast radius:** `package.json` `build.asarUnpack` field. Requires a packaged-build smoke (`pnpm run build:mac:arm64`, then `find dist-electron -path *app.asar.unpacked/main/dist/main/src/orchestrator/mcpServer/*.js`) to confirm before merging — the existing TASK-618 review-queue action already requests this. Risk: low (packaging config only, no runtime path changes to `scriptPath.ts`).
- **Source:** FIND-SPRINT-034-14 (SPRINT-034 sprint-code-reviewer); TASK-618.
- **Proposed change:**
  ```diff
  - "asarUnpack": "main/dist/main/src/orchestrator/mcpServer/**/*.js"
  + "asarUnpack": "main/dist/main/src/orchestrator/mcpServer/cyboflowMcpServer.js"
  ```
  Note: gate this on the packaged-build smoke already queued under TASK-618 in the human review queue. If future sibling subprocess scripts are added, widen to `cyboflowMcpServer*.js`.

### Skeptic Verdict
- **Verdict:** DONT_IMPLEMENT
- **Confidence:** medium
- **Reasoning:** This is packaging config that requires a `pnpm build:mac:arm64` smoke + `find` invariant to verify before merge — moving it from the human review queue (where TASK-618 already gates it) into an unverified compound apply trades a safe queue for a riskier path; the only harm of waiting is minor disk duplication of three small files.
- **Counterfactual:** If the packaged-build smoke had already been run and the unpacked duplicates confirmed inert at runtime, IMPLEMENT would be straightforward.

---

### A7. Add `TODO(epic-7)` comment on `setOrchSocketPath` noting its first production caller is pending
- **Summary:** `claudeCodeManager.ts:94`'s `setOrchSocketPath` method has no production call site outside tests; adding a brief TODO prevents the next reader from wondering why the eager-resolve logic in `composeMcpServers` never fires.
- **Source-Sprint:** SPRINT-034
- **Rationale:** FIND-SPRINT-034-15 documents that `OrchSocketProvider.getSocketPath()` throws `"cyboflow: orchSocketProvider not yet wired (epic 7)"` and every `composeMcpServers()` call takes the `if (this.orchSocketPath) → false` branch. The infrastructure is correct preemptive plumbing, but without a comment the gap is invisible. One-line TODO, zero behavior change.
- **Blast radius:** `main/src/services/panels/claude/claudeCodeManager.ts` — add one comment. Risk: trivial.
- **Source:** FIND-SPRINT-034-15 (SPRINT-034 sprint-code-reviewer); TASK-619, TASK-620, TASK-621.
- **Proposed change:**
  ```diff
   setOrchSocketPath(path: string): void {
  +  // TODO(epic-7): first production caller is the OrchSocketProvider wiring task.
  +  // Until that task lands, composeMcpServers() always takes the orchSocketPath=null branch
  +  // and no cyboflow_* tools are surfaced to Claude sessions.
     this.orchSocketPath = path;
  ```

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** high
- **Reasoning:** Grep confirms `setOrchSocketPath` has zero production callers (only test files invoke it) — a 3-line comment that tells future readers the eager-resolve path is dormant is proportional to ~400 LOC of unwired infrastructure flagged in FIND-SPRINT-034-15.

---

## B. Backlog tasks (refine into execution-ready plans)

### B1. Delete dead `frontend/src/utils/toolFormatter.ts`, its test, and the orphaned `formatJsonForWeb` export
- **Summary:** The entire 541-LOC `frontend/src/utils/toolFormatter.ts` and its 189-line test file have zero production callers in `frontend/src/` — only the test file imports from the dead copy, while the live path goes through `main/src/utils/toolFormatter.ts`.
- **Source-Sprint:** SPRINT-034
- **Source:** FIND-SPRINT-034-12 (SPRINT-034 sprint-code-reviewer); TASK-655 (added `toolFormatter.test.ts` against the dead surface), TASK-691 (deleted the only legitimate consumers of `formatJsonForOutputEnhanced`/`formatJsonForWeb`).
- **Problem:** `frontend/src/utils/toolFormatter.ts` (541 LOC) and `frontend/src/utils/toolFormatter.test.ts` (189 LOC) have no production importers in `frontend/src/`. `frontend/src/utils/formatters.ts:11`'s `formatJsonForWeb` export is similarly orphaned. The active path is `main/src/utils/toolFormatter.ts` called from `main/src/ipc/session.ts:809`. TASK-655 spent effort hardening both copies in lockstep (commits `5a148da` + `a58fa0d`), and future refactors touching `ToolResultBlock` semantics will continue to pay the dual-maintenance tax. The two copies already diverge structurally (frontend omits `gitRepoPath`, uses a different `formatJsonForOutput` body).
- **Proposed direction:** Delete `frontend/src/utils/toolFormatter.ts`, `frontend/src/utils/toolFormatter.test.ts`, and the `formatJsonForWeb` named export from `frontend/src/utils/formatters.ts`. Confirm `pnpm typecheck` and `pnpm lint` stay clean and the frontend test count drops by 15 (the `toolFormatter.test.ts` cases). The executor should grep for any new importers introduced after this finding was filed (`grep -rn "from.*toolFormatter" frontend/src`), then delete confirmed-dead files. If a future frontend-side raw formatter is needed, it should live in `shared/utils/` and be imported by both workspaces rather than duplicated.
- **Scope:** small

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** high
- **Reasoning:** Confirmed only `toolFormatter.test.ts` imports from `frontend/src/utils/toolFormatter.ts`, and `formatJsonForWeb` (`frontend/src/utils/formatters.ts:11`) has zero importers across `frontend/src` — 730 LOC of dead-code dual-maintenance with active drift (TASK-655 paid the tax in lockstep commits), well above the deletion bar.

---

### B2. Re-wire or delete `navigateToPrompt` CustomEvent dispatch now that its only listener (SessionView) is gone
- **Summary:** `PromptHistory.tsx` and `PromptHistoryModal.tsx` each dispatch a `navigateToPrompt` CustomEvent that has zero listeners since TASK-691 deleted `SessionView`, silently breaking prompt-history navigation on every Recent-Prompts click.
- **Source-Sprint:** SPRINT-034
- **Source:** FIND-SPRINT-034-13 (SPRINT-034 sprint-code-reviewer); TASK-691.
- **Problem:** `frontend/src/components/PromptHistory.tsx:82` and `frontend/src/components/PromptHistoryModal.tsx:96` each call `window.dispatchEvent(new CustomEvent('navigateToPrompt', { detail: { sessionId, promptIndex, ... } }))`. Grep confirms zero `addEventListener('navigateToPrompt', ...)` calls in `frontend/src/` or `main/src/` — `SessionView` was the only listener and TASK-691 deleted it. TASK-691's diff removed the explanatory comment (`// Dispatch an event that SessionView can listen for`) without removing the dispatch body, making the no-op dispatch appear intentional. Additionally, the standalone `PromptHistory.tsx` (152 LOC) has zero importers other than `PromptHistoryModal` — it appears orphaned alongside the dead event.
- **Proposed direction:** Two sub-decisions to make before execution: (1) Is prompt-history navigation a v1 feature in the CyboflowRoot shell? If no, delete the dispatch block from both files (the modal closes via the existing `onClose()` call), delete the standalone `PromptHistory.tsx`, and remove the `frontend/src/types/electron.d.ts:205` comment that references it. If yes, add a `navigateToPrompt` effect to `CyboflowRoot` (or a future `RunView`) that routes to the matching run/panel when the event fires. Either path should be captured in a plan with an AC that confirms the dispatch either has a listener or is removed entirely.
- **Scope:** small

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** high
- **Reasoning:** Grep confirms zero `addEventListener('navigateToPrompt', ...)` across `frontend/src` and `main/src` while two dispatchers fire on every Recent-Prompts click — a silent UX break in a v1-shipping surface, with the standalone `PromptHistory.tsx` (152 LOC) also orphaned per App.tsx evidence.

---

### B3. Retire `sessionManager.ts` Crystal-session method calls as prerequisite for dropping legacy session tables
- **Summary:** `sessionManager.ts` still actively calls Crystal-era session methods on `DatabaseService` (`getSessionOutputs`, `addSessionOutput`, `addConversationMessage`, etc.), which prevents TASK-692 from dropping those methods or their backing tables without breaking typecheck.
- **Source-Sprint:** SPRINT-034
- **Source:** FIND-SPRINT-034-11 (TASK-692 executor); noted in SPRINT-034 findings as a `bug` / `high` severity blocker.
- **Problem:** `main/src/services/sessionManager.ts:7` imports and actively calls `getSessionOutputs`, `addSessionOutput`, `addPromptMarker`, `getPromptMarkers`, `addConversationMessage`, `getConversationMessages`, `createExecutionDiff` from `DatabaseService`, and imports session/conversation/prompt/diff types from `database/models.ts`. These bindings prevent removing the methods from `database.ts` or the types from `models.ts` without typecheck failures. Additionally, `session_outputs`, `conversation_messages`, `prompt_markers`, and `execution_diffs` tables cannot be dropped while panel-era methods still write to them, and the `sessions` table cannot be dropped because `schema.sql` recreates it on every boot and `tool_panels` has a FK dependency. TASK-692 (the drop-migration task) is blocked until `sessionManager.ts` is cleaned up. This is the unblocking predecessor for TASK-692's original scope.
- **Proposed direction:** Create a focused task to (a) audit what `sessionManager.ts` actually needs vs. what it calls for Crystal-era compat, (b) remove or stub the calls to Crystal-era `DatabaseService` methods that have no equivalent cyboflow-shell consumer, (c) update `schema.sql` to drop the now-unused tables or add a migration that drops them, (d) then re-run TASK-692 as a pure drop-migration. The plan should include grep ACs confirming zero callers of each removed `DatabaseService` method and a vitest run confirming no main-process test regresses.
- **Scope:** medium

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** high
- **Reasoning:** TASK-692-plan.md is in-flight and explicitly blocked on this — its `panelmanager-vs-tool-panels` escalation (Option B) names "insert sibling task that retires backend consumers" as the resolution path, and sessionManager.ts grep confirms ~20 live Crystal-era DatabaseService call sites preventing the drop migration.

---

## C. CLAUDE.md / CODE-PATTERNS.md improvements (apply now)

### C1. Add Peekaboo capture-failure troubleshooting note to `docs/VISUAL-VERIFICATION-SETUP.md`
- **Summary:** When Peekaboo MCP reports both grants present but still fails with "audio/video capture failure", the Electron dev binary under `node_modules/.pnpm/electron@.../Electron.app` needs its own explicit Screen Recording grant — the setup doc doesn't mention this.
- **Source-Sprint:** SPRINT-034
- **Target file:** `docs/VISUAL-VERIFICATION-SETUP.md`
- **Status:** ready
- **source_item:** C1
- **Diff:**
  ```diff
  @@ existing line: After granting either permission, quit and relaunch the host process.
  +
  +### Troubleshooting: "audio/video capture failure" despite grants showing clean
  +
  +If `mcp__peekaboo__image` against the Cyboflow Electron window returns
  +`Failed to start stream due to audio/video capture failure` while
  +`mcp__peekaboo__probe` reports both grants granted, the **Electron dev
  +binary itself** needs its own Screen Recording entry — separate from the
  +Peekaboo CLI binary. Locate it with `find node_modules/.pnpm -name 'Electron.app' -maxdepth 6`,
  +grant Screen Recording in System Settings, and relaunch `pnpm dev`. Blocked
  +two consecutive sprints (FIND-SPRINT-034-3).
  ```

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** medium
- **Reasoning:** `docs/VISUAL-VERIFICATION-SETUP.md` has a Peekaboo permissions section but no "grants-present but capture fails" troubleshooting line; FIND-SPRINT-034-3 reports the same probe-passes-but-capture-fails symptom that wasted visual verification cycles, and the doc is a targeted reference for that exact lookup path.

---

### C2. Add shared frozen-constant rule to `docs/CODE-PATTERNS.md`
- **Summary:** `shared/types/mcpHealth.ts` introduces the first cross-workspace `Readonly` / frozen shared constant; brief mention so future agents export frozen singletons from `shared/` instead of duplicating per workspace.
- **Source-Sprint:** SPRINT-034
- **Target file:** `docs/CODE-PATTERNS.md`
- **Status:** ready
- **source_item:** C2
- **Diff:**
  ```diff
  @@ - `shared/types/cliPanels.ts` — CLI-specific panel types
  +
  +**Shared singleton constants** (status seeds, default configs returned by reference
  +from multiple workspaces) must be declared `Readonly<T>` AND `Object.freeze`'d at
  +the export site — never return a mutable shared constant by reference. Canonical
  +example: `HEALTH_STARTING` in `shared/types/mcpHealth.ts` (returned by both
  +`main/src/ipc/cyboflow.ts` and `main/src/orchestrator/trpc/routers/health.ts`).
  ```

### Skeptic Verdict
- **Verdict:** DONT_IMPLEMENT
- **Confidence:** medium
- **Reasoning:** The proposal anchors on `HEALTH_STARTING` as the first cross-workspace frozen constant, but that constant is currently NOT frozen (A2 hasn't been applied) and only one such pattern exists in the codebase — codifying a one-off as a CODE-PATTERNS rule fails the recurrence test, and `Object.freeze` on shared seeds is a well-understood JS idiom that doesn't need a project-specific rule entry.
- **Counterfactual:** If a second shared frozen-constant export (e.g., a default config or seed) lands in `shared/types/`, the rule clears the recurrence bar and IMPLEMENT becomes appropriate.

---

### C3. Document the `_reverseCheck` Zod-schema bridge rule in `CLAUDE.md` [dropped — redundant]
- **Source-Sprint:** SPRINT-034
- **source_item:** C3
- **Reason:** Already documented in `docs/CODE-PATTERNS.md:200-201` ("TS↔Zod drift bridge: `_typeCheck` catches required-field drift. Optional-field drift is a known gap") AND in a 22-line block comment directly above the `_reverseCheck` declaration at `main/src/services/streamParser/schemas.ts:388-408`. A CLAUDE.md addition would duplicate this and fail the every-agent test — only agents touching `schemas.ts` need the context, and they see the in-source comment immediately.

---

## Reconciled Findings (informational)

No stale-open findings found. All resolved findings (`FIND-SPRINT-034-5`, `FIND-SPRINT-034-6`, `FIND-SPRINT-034-8`) carry explicit `status: resolved` in the findings file. No open finding was claimed resolved by a `**Findings resolved:**` line in any done report.
