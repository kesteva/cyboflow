---
id: TASK-569
title: permissionMode 'ignore' callsite sweep — flip user-facing defaults to 'approve'
status: ready
epic: approval-router-and-permission-fix
source: compound/SPRINT-004-005
source_sprint: SPRINT-005
depends_on: []
files_owned:
  - frontend/src/stores/sessionPreferencesStore.ts
  - frontend/src/components/CreateSessionDialog.tsx
  - frontend/src/components/CreateSessionButton.tsx
  - frontend/src/components/DraggableProjectTreeView.tsx
  - frontend/src/components/Settings.tsx
  - frontend/src/components/dialog/ClaudeCodeConfig.tsx
  - frontend/src/components/panels/cli/BaseCliPanel.tsx
  - main/src/events.ts
  - main/src/services/configManager.ts
files_readonly:
  - main/src/services/panels/claude/claudeCodeManager.ts
  - main/src/services/__tests__/claudeCodeManagerPermissions.test.ts
  - main/src/types/config.ts
  - main/src/types/session.ts
  - main/src/database/database.ts
  - shared/types/cliPanels.ts
  - shared/types/panels.ts
  - shared/types/aiPanelConfig.ts
  - frontend/src/types/config.ts
  - frontend/src/types/session.ts
acceptance_criteria:
  - criterion: "Every user-facing default for `permissionMode` is `'approve'`, not `'ignore'`. Specifically: `sessionPreferencesStore.ts` defaultPreferences, `configManager.ts:getSessionCreationPreferences()` fallback, `configManager.ts:DEFAULT_CONFIG`, `events.ts` panel-creation fallback, `Settings.tsx` useState init and loader fallback, and the three `permissionMode: 'ignore'` literals in CreateSessionDialog/CreateSessionButton/DraggableProjectTreeView."
    verification: "grep -rEn \"permissionMode\\s*:\\s*['\\\"]ignore['\\\"]|permissionMode[^=]*\\|\\|\\s*['\\\"]ignore['\\\"]|useState<[^>]*>\\(['\\\"]ignore['\\\"]\\)|defaultPermissionMode\\s*\\|\\|\\s*['\\\"]ignore['\\\"]\" frontend/src main/src | grep -v __tests__ | grep -v test | grep -v node_modules | grep -v 'shared/types' | grep -v 'database.ts' | grep -v 'database/migrations' returns 0 matches."
  - criterion: "The `'ignore'` selectable option is removed from the user-facing `ClaudeCodeConfig.tsx` Permission Mode UI (the Skip card and its onChange path) so users cannot pick a mode that throws at spawn."
    verification: "grep -nE \"permissionMode: 'ignore'\" frontend/src/components/dialog/ClaudeCodeConfig.tsx returns 0 matches; the `'ignore' | 'approve'` literal union on line 11 is narrowed to `'approve'` only OR `ClaudeCodeConfigProps` no longer accepts a permissionMode toggle."
  - criterion: "Standard session creation through the UI completes without throwing the TASK-204 `Cyboflow runs require approve mode` error."
    verification: "Manual smoke: `pnpm dev`, click `+` to create a new session with a prompt, confirm the session starts and the Claude panel becomes interactive without an error toast or `[ClaudeCodeManager] Cyboflow runs require approve mode` log line in cyboflow-backend-debug.log."
  - criterion: "Type-only `'ignore' | 'approve'` declarations in `shared/types/cliPanels.ts`, `shared/types/panels.ts`, `shared/types/aiPanelConfig.ts`, `main/src/types/*.ts`, and `frontend/src/types/*.ts` are left intact (the `'ignore'` discriminant still exists as a type-level escape hatch for future debug builds), but no runtime code paths set `'ignore'` as the default."
    verification: "grep -nE \"'approve' \\| 'ignore'|'ignore' \\| 'approve'\" shared/types/cliPanels.ts shared/types/panels.ts shared/types/aiPanelConfig.ts returns >=3 matches (type unions untouched)."
  - criterion: "`pnpm typecheck` and `pnpm --filter main exec vitest run` pass; the existing `claudeCodeManagerPermissions.test.ts` continues to throw on explicit `permissionMode: 'ignore'`."
    verification: "Exit code 0 for both. `grep -n \"permissionMode: 'ignore'\" main/src/services/__tests__/claudeCodeManagerPermissions.test.ts` still returns >=1 match (the intentional throw-assertion stays)."
estimated_complexity: medium
test_strategy:
  needed: true
  justification: "The default-flip is observable in `sessionPreferencesStore` and `configManager` and warrants a regression test so a future re-introduction of `'ignore'` defaults is caught at CI time."
  targets:
    - behavior: "`useSessionPreferencesStore.getState().preferences.claudeConfig.permissionMode` equals `'approve'` on fresh mount."
      test_file: "frontend/src/stores/__tests__/sessionPreferencesStore.test.ts"
      type: unit
    - behavior: "`ConfigManager.getSessionCreationPreferences()` returns `permissionMode: 'approve'` when no user config is set."
      test_file: "main/src/services/__tests__/configManager.permissionMode.test.ts"
      type: unit
prerequisites: []
---

# permissionMode 'ignore' callsite sweep

## Problem

TASK-204 (SPRINT-005) replaced the `--dangerously-skip-permissions` bypass in
`claudeCodeManager.buildCommandArgs()` with a hard throw whenever
`effectiveMode === 'ignore'`. That seals the bypass — but every UI callsite
that creates a session still defaults `permissionMode: 'ignore'`, so the
standard session-creation flow now hits the throw and fails at spawn.

Confirmed callsites (from FIND-SPRINT-005-6 / FIND-SPRINT-005-18 +
re-verification):

| File | Line | Pattern |
| --- | --- | --- |
| `frontend/src/stores/sessionPreferencesStore.ts` | 29 | `permissionMode: 'ignore'` (default state) |
| `frontend/src/components/CreateSessionDialog.tsx` | 91 | `initialClaudeConfig?.permissionMode \|\| 'ignore'` |
| `frontend/src/components/CreateSessionDialog.tsx` | 100 | `permissionMode: 'ignore'` (bare literal) |
| `frontend/src/components/CreateSessionDialog.tsx` | 624 | `let toolPermissionMode: 'ignore' \| 'approve' = 'ignore'` |
| `frontend/src/components/CreateSessionDialog.tsx` | 633 | `formData.permissionMode \|\| 'ignore'` |
| `frontend/src/components/CreateSessionButton.tsx` | 52 | `permissionMode: 'ignore'` |
| `frontend/src/components/DraggableProjectTreeView.tsx` | 1132 | `permissionMode: 'ignore'` |
| `frontend/src/components/Settings.tsx` | 39 | `useState<'approve' \| 'ignore'>('ignore')` |
| `frontend/src/components/Settings.tsx` | 76 | `setDefaultPermissionMode(data.defaultPermissionMode \|\| 'ignore')` |
| `frontend/src/components/Settings.tsx` | 292 | `checked={defaultPermissionMode === 'ignore'}` (radio default-selected) |
| `frontend/src/components/dialog/ClaudeCodeConfig.tsx` | 11, 298, etc. | UI exposes 'ignore' as a clickable card |
| `frontend/src/components/panels/cli/BaseCliPanel.tsx` | 425 | `settings.defaultPermissionMode \|\| 'ignore'` |
| `main/src/events.ts` | 644 | `claudeConfig.permissionMode \|\| 'ignore'` |
| `main/src/services/configManager.ts` | 43 | `permissionMode: 'ignore'` (DEFAULT_CONFIG) |
| `main/src/services/configManager.ts` | 171 | `permissionMode: 'ignore'` (getSessionCreationPreferences fallback) |

## Proposed Direction (Implementation Steps)

1. **Pre-flight grep** (completeness gate; encoded as step 1 per planner rule 5d/5g):
   ```
   grep -rEn "permissionMode\s*:\s*['\"]ignore['\"]|permissionMode[^=]*\|\|\s*['\"]ignore['\"]|useState<[^>]*>\(['\"]ignore['\"]\)|defaultPermissionMode\s*\|\|\s*['\"]ignore['\"]" frontend/src main/src | grep -v __tests__ | grep -v test | grep -v node_modules | grep -v 'shared/types' | grep -v 'database.ts' | grep -v 'database/migrations'
   ```
   Note every match for steps 2-5 below; this same grep must return 0 matches
   before reporting COMPLETED.

2. **Frontend default flips.** In each of these files, flip the runtime
   default from `'ignore'` to `'approve'` (keep the type union untouched):
   - `frontend/src/stores/sessionPreferencesStore.ts:29` — `permissionMode: 'approve'`
   - `frontend/src/components/CreateSessionDialog.tsx:91` — `initialClaudeConfig?.permissionMode || 'approve'`
   - `frontend/src/components/CreateSessionDialog.tsx:100` — `permissionMode: 'approve'`
   - `frontend/src/components/CreateSessionDialog.tsx:624` — `let toolPermissionMode: 'ignore' | 'approve' = 'approve'`
   - `frontend/src/components/CreateSessionDialog.tsx:633` — `formData.permissionMode || 'approve'`
   - `frontend/src/components/CreateSessionButton.tsx:52` — `permissionMode: 'approve'`
   - `frontend/src/components/DraggableProjectTreeView.tsx:1132` — `permissionMode: 'approve'`
   - `frontend/src/components/Settings.tsx:39` — `useState<'approve' | 'ignore'>('approve')`
   - `frontend/src/components/Settings.tsx:76` — `setDefaultPermissionMode(data.defaultPermissionMode || 'approve')`
   - `frontend/src/components/panels/cli/BaseCliPanel.tsx:425` — `settings.defaultPermissionMode || 'approve'`

3. **Main-process default flips.**
   - `main/src/events.ts:644` — `permissionMode: claudeConfig.permissionMode || 'approve'`
   - `main/src/services/configManager.ts:43` — `permissionMode: 'approve'` (DEFAULT_CONFIG)
   - `main/src/services/configManager.ts:171` — `permissionMode: 'approve'` (getSessionCreationPreferences fallback)

4. **Hide the 'Skip' card in ClaudeCodeConfig.tsx.** The simplest in-scope
   fix is to delete the `'ignore'`-side Card block (lines ~289-308) and
   change the surrounding grid to one column or replace it with a single
   informational read-only badge ("Approve mode — required"). Concretely:
   - Remove the `<Card variant={config.permissionMode === 'ignore' ...>`
     block (lines 290-309).
   - Update the parent grid `<div className="grid grid-cols-2 gap-2">`
     (line 289) to `grid-cols-1` OR replace the whole block with a
     read-only label.
   - The `permissionMode: 'ignore' | 'approve'` type union on line 11 may
     stay (still valid at the type level — `'ignore'` is the disallowed
     escape-hatch the throw catches) but the UI no longer surfaces it.

5. **Settings.tsx radio update.** Line 292's radio still defaults
   `defaultPermissionMode === 'ignore'` as the "checked" state. After
   step 2 flips line 39 to `'approve'`, line 292 will naturally render
   the `'approve'` radio as checked, but verify there are no other paths
   that ship `'ignore'` to the radio group.

6. **Author the two tests.**
   - `frontend/src/stores/__tests__/sessionPreferencesStore.test.ts`:
     fresh-mount snapshot asserting `permissionMode === 'approve'`.
   - `main/src/services/__tests__/configManager.permissionMode.test.ts`:
     instantiate ConfigManager with empty disk state, call
     `getSessionCreationPreferences()`, assert `permissionMode === 'approve'`.

7. **Sanity-check the type unions stay intact.** `shared/types/cliPanels.ts`,
   `shared/types/panels.ts`, `shared/types/aiPanelConfig.ts`,
   `main/src/types/{config,session}.ts`, `frontend/src/types/{config,session}.ts`,
   and `main/src/database/database.ts` (which uses the SQL literal `'ignore'`
   inside `CHECK(permission_mode IN ('approve', 'ignore'))` and is a SCHEMA
   contract — not a runtime default) all keep their existing type-level
   `'ignore' | 'approve'` unions. Do NOT touch those files.

8. **Re-run the pre-flight grep from step 1.** Confirm 0 matches before
   reporting COMPLETED. Then run `pnpm typecheck` and
   `pnpm --filter main exec vitest run`.

## Acceptance Criteria

(See frontmatter.)

## Test Strategy

- New: `frontend/src/stores/__tests__/sessionPreferencesStore.test.ts` —
  unit test asserting the default. Mock `API.config.getSessionPreferences`
  to return `null` and read the store's initial `preferences.claudeConfig.permissionMode`.
- New: `main/src/services/__tests__/configManager.permissionMode.test.ts` —
  unit test using a tmpdir-backed ConfigManager that has never written
  preferences; expect `'approve'`.
- Existing: `main/src/services/__tests__/claudeCodeManagerPermissions.test.ts`
  continues to assert that explicit `permissionMode: 'ignore'` throws.

## Hardest Decision

**Atomic single-PR sweep vs. per-file PRs.** The compounder explicitly
recommends "the sweep should be atomic (single task, single PR) so a partial
flip doesn't leave the app in a mixed state". Picked: atomic sweep — every
default flipped together in one task. Partial flips are worse than the
current broken state because they let some entry points work while others
silently break with cryptic messages.

## Rejected Alternatives

- **Translate `'ignore'` to `'approve'` at the boundary (e.g. inside
  `claudeCodeManager` or `claudePanelManager`).** Considered then rejected.
  The TASK-204 done report specifically called the loud-throw a design
  choice: "any stale Crystal-era callsite still passing `permissionMode:
  'ignore'` will surface immediately rather than invisibly disabling the
  queue." Silently coercing would re-introduce exactly the silent surface
  TASK-204 sealed. Would flip back to this approach only if a downstream
  consumer surfaced that *requires* a true escape hatch (currently none
  exists).
- **Delete the `'ignore'` type union entirely from all 8+ type files.**
  Rejected as out-of-scope churn for this task — the type-level union is
  the future debug surface (e.g. a `CYBOFLOW_DEBUG=1` env-guarded path
  could re-expose ignore later). Sweep-flip the runtime defaults; let the
  type-union deletion be a follow-up if/when product confirms it's never
  coming back.
- **Hide the `'ignore'` UI card behind `CYBOFLOW_DEBUG=1` instead of
  deleting it.** Slightly more flexible but more code and an
  env-conditional render path that nothing tests — chosen the simpler
  delete-the-card path for now.

## Lowest Confidence Area

`CreateSessionDialog.tsx:624` (`let toolPermissionMode: 'ignore' | 'approve' = 'ignore'`)
and line 633's branching logic: this local variable feeds into multi-tool
session creation. After the flip, the early-return path at line 624 will
default to `'approve'`. The dialog has a complex submit handler and the
executor must read the full submit-flow context (lines ~620-680) before
flipping line 624 — there's a small chance line 624 is intentionally
`'ignore'` because the tool isn't Claude (i.e. it gets overwritten in the
Claude branch). If so, leave 624 as `'ignore'` and document why in a
code comment; the throw only fires when Claude is the active tool.
