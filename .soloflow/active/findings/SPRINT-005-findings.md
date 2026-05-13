---
sprint: SPRINT-005
pending_count: 7
last_updated: "2026-05-13T21:30:00Z"
---

# Findings Queue

## FIND-SPRINT-005-1
- **source:** TASK-151 (code-reviewer)
- **type:** cleanup
- **severity:** low
- **status:** open
- **location:** main/src/database/migrations/
- **description:** With the new file-based migration runner from TASK-151, every app boot now emits ~18 `console.warn` lines for legacy non-prefixed `.sql` files (`add_archived_field.sql`, `add_build_commands.sql`, `add_claude_session_id.sql`, etc.) that live in `main/src/database/migrations/` as historical documentation but are never executed (they predate the inline-migration era and have no corresponding hook). The warns are spec'd by the plan (AC #2 says "files without a matching numeric prefix are skipped (logged at WARN)") and the runner behaves correctly, but the resulting log noise is permanent and risks masking legitimate warnings about typos in real future cyboflow migrations.
- **suggested_action:** Either (a) move the 18 legacy non-prefixed `.sql` files into `main/src/database/migrations/legacy/` (a subdir the runner does not scan), or (b) demote the per-file warn to a single aggregated `console.debug` ("Skipped N non-numeric migration files: …") at the end of the directory scan. Option (a) is cleaner and matches the `@cyboflow-hidden` convention's intent (preserve but quarantine). Verify `copy:assets` still ships these files (or stop shipping them) before merging the move.
- **resolved_by:**

## FIND-SPRINT-005-2
- **source:** TASK-155 (verifier)
- **type:** improvement
- **severity:** low
- **status:** open
- **location:** main/src/database/__tests__/cyboflowSchema.test.ts:392-481
- **description:** The "existing-install path" test (AC-2) simulates a pre-TASK-151 upgrade by first running `initialize()` against a brand-new DB (which both executes the inline migrations AND writes the `file_migration_applied:003/004/005` backfill markers via `runFileBasedMigrations`), THEN deleting the 006 marker + dropping the 5 Cyboflow tables, THEN running `initialize()` a second time. By the time the second `initialize()` runs, the `file_migration_applied:003/004/005` markers already exist on disk from the first call, so the test's assertions (a) that the markers are present only verify they persist across reboots — they do NOT verify the auto-backfill behaviour the AC describes (i.e. a DB that has the legacy inline-migration markers like `unified_panel_settings_migrated` but zero `file_migration_applied:*` entries gets its 003/004/005 backfill flags written by `runFileBasedMigrations` on first encounter). The test passes and the end-state is correct, but the failure-mode coverage diverges from the spec.
- **suggested_action:** Refactor the existing-install test to (a) manually pre-seed `user_preferences` with only the legacy markers (`auto_commit_migrated`, `claude_panels_migrated`, `diff_panels_migrated`, `unified_panel_settings_migrated` = 'true') AND pre-create the inline-migration-era tables (tool_panels, claude_panel_state, etc.) on a raw SQLite DB without calling `initialize()`, (b) then for the first time call `DatabaseService.initialize()` and assert that the `file_migration_applied:003/004/005` markers appear AND no errors occur. This isolates the auto-backfill path from the normal first-init path that incidentally also writes those markers.
- **resolved_by:**

## FIND-SPRINT-005-3
- **source:** TASK-155 (verifier)
- **type:** cleanup
- **severity:** low
- **status:** open
- **location:** main/src/database/__tests__/cyboflowSchema.test.ts:25
- **description:** Two unused imports added: `writeFileSync` and `mkdirSync` from `node:fs`. ESLint reports them as `no-unused-vars` warnings. Doesn't fail lint (project has 230 pre-existing warnings, 0 errors) but adds noise.
- **suggested_action:** Remove `writeFileSync, mkdirSync` from the import list on line 25 of `main/src/database/__tests__/cyboflowSchema.test.ts`.
- **resolved_by:**

## FIND-SPRINT-005-4
- **source:** TASK-154 (code-reviewer)
- **type:** cleanup
- **severity:** low
- **status:** open
- **location:** main/src/services/cyboflow/stateMachine.ts:39
- **description:** `isTransitionAllowed` contains a no-op type assertion: `(ALLOWED_TRANSITIONS[from] as readonly WorkflowRunStatus[]).includes(to)`. The indexed access `ALLOWED_TRANSITIONS[from]` already has type `readonly WorkflowRunStatus[]` (the value type of `Record<WorkflowRunStatus, readonly WorkflowRunStatus[]>`), and `Array.prototype.includes` accepts a `WorkflowRunStatus` argument without complaint under the project's TS target (ES2022, strict). The cast neither widens nor narrows the type. ESLint does not enable `@typescript-eslint/no-unnecessary-type-assertion`, so the rule does not fire; this is purely visual noise. Removing it does not affect behaviour or type safety.
- **suggested_action:** Replace `return (ALLOWED_TRANSITIONS[from] as readonly WorkflowRunStatus[]).includes(to);` with `return ALLOWED_TRANSITIONS[from].includes(to);` and re-run `pnpm typecheck` to confirm.
- **resolved_by:**

## FIND-SPRINT-005-5
- **source:** TASK-201 (code-reviewer)
- **type:** anti-pattern
- **severity:** low
- **status:** open
- **location:** main/src/services/streamParser/schemas.ts:279-299 and main/src/services/streamParser/typedEventNarrowing.ts:35-53
- **description:** `parseClaudeStreamEvent` (in schemas.ts, from IDEA-003's earlier task family) and `TypedEventNarrowing.narrow` (added by TASK-201) implement the same safeParse-and-fallback-to-__unknown__ logic. The legacy function logs via `console.warn` directly; the new class logs via an injected `IDebugLogger`. Both call sites are reachable: schemas.test.ts exercises `parseClaudeStreamEvent`; the pipeline orchestrator wires `TypedEventNarrowing` through `streamParser.ts`. This is not a bug — the executor followed the plan, which prescribed the new class — but it leaves two parallel implementations of the same contract, with two different log channels, and risks divergence in future schema patches.
- **suggested_action:** After TASK-202/203/205 wire the pipeline into actual callers, evaluate whether `parseClaudeStreamEvent` can be deleted (no production code paths use it; only schemas.test.ts). If it must stay, refactor it to delegate to `TypedEventNarrowing.narrow(parsed)` with a console-shaped IDebugLogger, so there is exactly one implementation of the safeParse contract.
- **resolved_by:**

## FIND-SPRINT-005-6
- **source:** TASK-204 (verifier)
- **type:** bug
- **severity:** high
- **status:** open
- **location:** frontend/src/components/CreateSessionDialog.tsx:91,100; frontend/src/components/CreateSessionButton.tsx:52; frontend/src/components/DraggableProjectTreeView.tsx:1132; frontend/src/stores/sessionPreferencesStore.ts:13,29; frontend/src/components/dialog/ClaudeCodeConfig.tsx:11,298; main/src/events.ts:644; main/src/services/configManager.ts:43,171
- **description:** TASK-204 promoted any session spawn with `permissionMode === 'ignore'` to a hard error inside `claudeCodeManager.buildCommandArgs` (the plan's intentional "loud failure" trap). However, every existing user-initiated session-creation callsite still hardcodes `permissionMode: 'ignore'` as the form default, including the `sessionPreferencesStore` initial state, two callsites in `CreateSessionDialog`, `CreateSessionButton`, `DraggableProjectTreeView`, the `events.ts` quick-create path, and the `claudeConfig.permissionMode` defaults in `configManager.ts` (lines 43 and 171, distinct from the now-fixed top-level `defaultPermissionMode`). Result: when a user creates a session through the standard UI flow without explicitly toggling the permission mode, the spawn will now throw `[ClaudeCodeManager] Cyboflow runs require approve mode; --dangerously-skip-permissions is not allowed.` This is consistent with the plan's "Hardest Decision" (preferred a loud throw over silent coercion to surface stale callsites) and the plan's "Lowest Confidence Area" (anticipated downstream callsites passing 'ignore'). Not a regression in TASK-204's narrow security contract — but production sessions WILL fail until a follow-up callsite sweep flips these defaults to 'approve'.
- **suggested_action:** Open a follow-up task (or attach to the crystal-cuts-and-rebrand epic, which already owns the rebrand sweep) to flip every UI-facing `permissionMode: 'ignore'` default to `'approve'`. Specific edits: (1) `frontend/src/stores/sessionPreferencesStore.ts:29` — change default `permissionMode: 'ignore'` → `'approve'`. (2) `frontend/src/components/CreateSessionDialog.tsx:91,100` and `:241,278` — flip both `initialClaudeConfig?.permissionMode || 'ignore'` and the bare `permissionMode: 'ignore'` literal to `'approve'`. (3) `frontend/src/components/CreateSessionButton.tsx:52` and `DraggableProjectTreeView.tsx:1132` — flip `permissionMode: 'ignore', // Use default permission mode` to `'approve'`. (4) `main/src/events.ts:644` — change `permissionMode: claudeConfig.permissionMode || 'ignore'` to `|| 'approve'`. (5) `main/src/services/configManager.ts:43,171` — flip the two `sessionCreationPreferences.claudeConfig.permissionMode: 'ignore'` defaults to `'approve'`. (6) `frontend/src/components/dialog/ClaudeCodeConfig.tsx` toggle UI may still expose the `'ignore'` choice; consider hiding it behind a debug-only escape hatch per the plan's rejected alternative ("CYBOFLOW_ALLOW_BYPASS=1"). Until this sweep lands, end-to-end session creation through the UI is broken.
- **resolved_by:**

## FIND-SPRINT-005-7
- **source:** TASK-203 (code-reviewer)
- **type:** cleanup
- **severity:** low
- **status:** open
- **location:** main/src/services/streamParser/index.ts
- **description:** The streamParser barrel (`main/src/services/streamParser/index.ts`) is documented in its own header as the "Single import point for downstream consumers (TASK-202, TASK-203, TASK-205). Import individual classes from this file, not from their implementation modules." It re-exports `LineBufferer`, `JSONParser`, `TypedEventNarrowing`, `EventRouter`, `ClaudeStreamParser` and their logger types — but TASK-203's new `RawEventsSink` class and `IRawEventsSinkLogger` interface are NOT exported through the barrel. Downstream callers in upcoming tasks (TASK-205+) will either import from the implementation module directly (violating the documented convention) or hit a "no exported member" error when following the convention. This is out-of-diff for TASK-203 (the barrel is in `files_readonly`), so it stays a queued finding rather than blocking the review.
- **suggested_action:** Add `export { RawEventsSink } from './rawEventsSink';` and `export type { IRawEventsSinkLogger } from './rawEventsSink';` to `main/src/services/streamParser/index.ts` alongside the existing exports. One-line follow-up; can be folded into the next streamParser task or a tiny TASK-204-prep cleanup.
- **resolved_by:**
