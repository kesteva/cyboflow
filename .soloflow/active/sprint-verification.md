---
sprint: SPRINT-020
visual_mobile: skipped_user_preference
visual_web:    skipped_unable
visual_macos:  skipped_user_preference
visual_mobile_note: "verification.visual_mobile=false in config"
visual_web_note:    "Playwright MCP cannot drive the Electron renderer — http://localhost:4521 page reports 'Could not find electronTRPC global' because the preload-injected IPC bridge is absent under the Playwright headless browser. CLAUDE.md documents this limitation; queued as actions/visual_web_electron_unreachable (recurrence). pnpm dev was running so the underlying app IS up — gap is in the test driver, not the dev env."
visual_macos_note:  "verification.visual_macos=false in config"
regressions_count: 2
flows_tested: 0
flows_deferred: 3
---

## Visual Verification

- **visual_mobile**: skipped_user_preference — `verification.visual_mobile=false`.
- **visual_web**: skipped_unable — Playwright MCP tools error when driving the Electron renderer.
  - Navigated to http://localhost:4521; page snapshot is empty; console: `Could not find electronTRPC global. Check that exposeElectronTRPC has been called in your preload file.`
  - Matches the limitation CLAUDE.md calls out under "Visual verification of any frontend UI change requires `pnpm dev` (full Electron). The Vite renderer at http://localhost:4521 cannot bootstrap standalone…"
  - `pnpm dev` is currently running (PID 84916; Electron 85017 alive; Vite 85003 listening on 4521). The dev env is fine; only the headless-Playwright driver path is unsupported.
  - Recurrence of the existing review-queue entry (dedup_key=`visual_web_electron_unreachable`, first filed under SPRINT-015, re-filed under SPRINT-017, now also under SPRINT-020).
- **visual_macos**: skipped_user_preference — `verification.visual_macos=false`.

### Identified flows (deferred, queued)
- **TASK-569 create-session + Settings + CLI-panel flow** — permissionMode default flipped to `'approve'` in 6 frontend callsites; visual confirmation that the default radio/toggle now renders 'Approve' on a fresh dialog is unverified.
- **TASK-597 approval lifecycle on terminate** — `clearPendingForRun` resolves in-flight approvals with deny; visual confirmation that the ReviewQueueView empties when a run is killed mid-approval is unverified.
- **TASK-570 widened ToolResultContent** — stream rendering in the live Electron renderer (frontend/src/utils/formatters.ts + toolFormatter.ts) is unverified for the array-form `content` branch (see Regression #2 below).

## Regressions requiring attention

### Regression #1 — TASK-570 ripple to frontend tool-result rendering (medium)

The widen of `ToolResultContent.content` from `string` → `string | Array<{type, text}>` (shared/types/claudeStream.ts:46-51) was fixed at `main/src/utils/formatters.ts:47` with a type-guard, but the **two frontend consumers** were not updated and have no test coverage:

1. `frontend/src/utils/formatters.ts:38` — `Tool result: ${item.content}`. When `item.content` is an array, JS coercion produces `[object Object],[object Object]`.
2. `frontend/src/utils/toolFormatter.ts` — multiple sites:
   - `:281` `if (toolResult.content) {` (truthy; arrays pass)
   - `:287` `JSON.parse(toolResult.content)` — throws on array.
   - `:306` `makePathsRelative(toolResult.content)` — likely breaks.
   - `:310-315 and :418-423` — many `toolResult.content.includes('error:')` calls. `Array.prototype.includes` checks for element-equality, not substring, so all these calls **silently return false** on the array branch — the Bash error-tinting is dead code under the new wire shape.

TypeScript does not catch this because `Array<X>.includes(string)` is structurally valid. There are zero unit tests for either frontend file that exercise tool_result content.

Responsible task: **TASK-570**. Queued under `sprint_020_toolresult_widen_frontend_ripple` (bucket: testing, severity: medium).

### Regression #2 — TASK-569 residual `'ignore'` default in sessionManager.ts (medium)

`main/src/services/sessionManager.ts:453` falls back to `'ignore'` for main-repo session auto-creation: `project.default_permission_mode || 'ignore'`. TASK-569's sweep grep pattern (`defaultPermissionMode\s*\|\|\s*['"]ignore['"]`) is camelCase and does not match the snake_case attribute here. Legacy projects with NULL `default_permission_mode` (and any project created via `createProject` without an explicit override at database.ts:1523) will still spawn main-repo sessions with `permissionMode='ignore'`, defeating the approve-by-default intent.

This is a quiet miss: the unit tests added in TASK-569 (configManager.permissionMode.test.ts, sessionPreferencesStore.test.ts) cover the user-facing config and frontend store paths but not the main-repo auto-creation path.

Responsible task: **TASK-569**. Queued under `sprint_020_permission_mode_sessionmanager_fallback` (bucket: testing, severity: medium).

### Cross-task confirmations (no regressions)

- **TASK-596 × TASK-597 ordering** — Confirmed safe. `claudeCodeManager.killProcess` → `abortCurrentRun` (await) → SDK iterator's `finally` block runs `cleanupPipeline(panelId)` THEN `ApprovalRouter.getInstance().clearPendingForRun(panelId)`. The deny-shaped `ApprovalDecision` synthesized in `clearPendingForRun` flows correctly into the PreToolUse hook's deny path (lines 500-510 of claudeCodeManager.ts) without revealing the synthetic origin. Both task suites carry unit tests asserting the ordering invariants.
- **TASK-569 × TASK-597 interaction** — Safe. The flipped default to `'approve'` increases the rate at which `requestApproval` is called, which exercises the new `clearPendingForRun` cleanup path. The `requestApproval` transaction is guarded by `status='running'`, and `clearPendingForRun` is idempotent vs concurrent `respond()` calls. No new race surface introduced.
- **TASK-570 type-alias collapse** — `MessageContent = TextContent | ToolUseContent | ToolResultContent` is preserved; deprecation comments correctly direct consumers to `shared/types/claudeStream.ts`. Type-check passes across all workspaces.

## Tooling outcomes

- `pnpm typecheck`: **PASS** (all 3 TS workspaces clean).
- `pnpm lint`: **PASS** (0 errors, 306 pre-existing warnings; sprint introduced no new lint errors).
- `pnpm test:unit`: **PASS** — 209/209 frontend, 423/423 main, 4/4 afterSign, 2/2 configure-build.
- `pnpm test` (Playwright E2E): **NOT RUN** — would conflict with the long-running `pnpm dev` (both want the renderer; running E2E would need a separate ephemeral session). Per the sprint regression-sweep request (which scopes to unit + lint + typecheck + visual), E2E is out of scope here.
