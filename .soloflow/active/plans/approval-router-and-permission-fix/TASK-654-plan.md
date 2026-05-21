---
id: TASK-654
idea: SPRINT-020
status: ready
created: "2026-05-19T00:00:00Z"
files_owned:
  - frontend/src/components/panels/cli/BaseCliPanel.tsx
  - frontend/src/components/Settings.tsx
  - main/src/services/sessionManager.ts
  - main/src/database/database.ts
  - main/src/database/migrations/legacy/add_permission_mode.sql
  - main/src/database/migrations/008_permission_mode_approve_default.sql
  - shared/types/permissionMode.ts
  - tests/permissions-ui-fixed.spec.ts
  - docs/CODE-PATTERNS.md
  - main/src/services/__tests__/sessionManager.mainRepoPermission.test.ts
files_readonly:
  - shared/types/aiPanelConfig.ts
  - shared/types/cliPanels.ts
  - shared/types/panels.ts
  - main/src/types/config.ts
  - main/src/types/session.ts
  - main/src/database/models.ts
  - main/src/services/panels/claude/claudeCodeManager.ts
  - main/src/services/configManager.ts
  - main/src/services/__tests__/configManager.permissionMode.test.ts
  - frontend/src/stores/sessionPreferencesStore.ts
  - frontend/src/components/dialog/ClaudeCodeConfig.tsx
  - .soloflow/archive/done/approval-router-and-permission-fix/TASK-569-done.md
  - .soloflow/active/plans/approval-router-and-permission-fix/EPIC-approval-router-and-permission-fix.md
acceptance_criteria:
  - criterion: "BaseCliPanel.tsx no longer renders the 'ignore' option in the Permission Mode dropdown."
    verification: "grep -nE 'value=\"ignore\"' frontend/src/components/panels/cli/BaseCliPanel.tsx returns 0 matches. grep -n 'Skip permissions' frontend/src/components/panels/cli/BaseCliPanel.tsx returns 0 matches."
  - criterion: "Settings.tsx no longer renders the 'ignore' radio in the Default Security Mode group; only the 'approve' option remains."
    verification: "grep -nE 'value=\"ignore\"' frontend/src/components/Settings.tsx returns 0 matches. grep -nE 'useState<.approve.>' frontend/src/components/Settings.tsx returns at least 1 match."
  - criterion: "All three snake_case / DB-layer fallbacks default to 'approve' (via the new DEFAULT_PERMISSION_MODE constant) instead of 'ignore'."
    verification: "grep -nE \"\\|\\| 'ignore'\" main/src/services/sessionManager.ts main/src/database/database.ts returns 0 matches. grep -nE 'DEFAULT_PERMISSION_MODE' main/src/services/sessionManager.ts main/src/database/database.ts returns at least 3 matches."
  - criterion: "A new shared constant `DEFAULT_PERMISSION_MODE = 'approve'` exists in `shared/types/permissionMode.ts` with a re-exported `PermissionMode` type alias."
    verification: "test -f shared/types/permissionMode.ts; grep -nE \"export const DEFAULT_PERMISSION_MODE = 'approve'\" shared/types/permissionMode.ts returns 1 match. grep -nE \"export type PermissionMode = 'approve' \\| 'ignore'\" shared/types/permissionMode.ts returns 1 match."
  - criterion: "All fresh-install / inline DEFAULT 'ignore' SQL clauses in `main/src/database/database.ts` are flipped to DEFAULT 'approve' (four sites: lines ~280, ~366, ~493, ~641)."
    verification: "grep -nE \"DEFAULT 'ignore'\" main/src/database/database.ts returns 0 matches. grep -nE \"DEFAULT 'approve'\" main/src/database/database.ts returns at least 4 matches."
  - criterion: "Legacy `add_permission_mode.sql` is updated to DEFAULT 'approve' for grep-sweep hygiene (file is not executed by the runner)."
    verification: "grep -nE \"DEFAULT 'ignore'\" main/src/database/migrations/legacy/add_permission_mode.sql returns 0 matches."
  - criterion: "New numbered migration `008_permission_mode_approve_default.sql` exists and backfills NULL rows to 'approve' for both `sessions.permission_mode` and `projects.default_permission_mode`."
    verification: "test -f main/src/database/migrations/008_permission_mode_approve_default.sql; grep -nE 'UPDATE sessions SET permission_mode = .approve. WHERE permission_mode IS NULL' main/src/database/migrations/008_permission_mode_approve_default.sql returns 1 match."
  - criterion: "Playwright spec `tests/permissions-ui-fixed.spec.ts` no longer asserts the 'ignore' radio; rewritten to assert ONLY the 'approve' radio is present and checked."
    verification: "grep -nE 'value=\"ignore\"' tests/permissions-ui-fixed.spec.ts returns 0 matches."
  - criterion: "The 'ignore' contract is documented in `docs/CODE-PATTERNS.md` under a new `## permissionMode contract` heading."
    verification: "grep -nE '^## permissionMode contract' docs/CODE-PATTERNS.md returns 1 match. grep -nE 'DEFAULT_PERMISSION_MODE' docs/CODE-PATTERNS.md returns at least 1 match (within the new section)."
  - criterion: "Regression test: getOrCreateMainRepoSession resolves new session's permission_mode to 'approve' when the parent project's default_permission_mode column is NULL."
    verification: test -f main/src/services/__tests__/sessionManager.mainRepoPermission.test.ts; `pnpm --filter main exec vitest run src/services/__tests__/sessionManager.mainRepoPermission.test.ts` exits 0.
  - criterion: "Repo-wide sweep — no defaults to 'ignore' in product code."
    verification: "grep -rnE \"\\|\\| 'ignore'\" main/src/ frontend/src/ shared/ returns 0 matches. grep -rnE 'value=\"ignore\"' frontend/src/ tests/ returns 0 matches."
  - criterion: "Type union `'approve' | 'ignore'` remains intact across shared/types — 'ignore' preserved as typed escape hatch."
    verification: "grep -rn \"'approve' | 'ignore'\" shared/types/ main/src/types/ returns at least 5 matches."
  - criterion: "`pnpm typecheck`, `pnpm lint`, `pnpm --filter main test`, `pnpm --filter frontend test` all exit 0."
    verification: Run each command — exit code 0.
depends_on: []
estimated_complexity: medium
epic: approval-router-and-permission-fix
test_strategy:
  needed: true
  justification: "sessionManager has no existing sibling test for the inline || fallback at line 453; the Playwright spec actively asserts the broken 'ignore' state and must be realigned in lockstep."
  targets:
    - behavior: "getOrCreateMainRepoSession returns a session with permission_mode === 'approve' when the parent project's default_permission_mode is NULL."
      test_file: main/src/services/__tests__/sessionManager.mainRepoPermission.test.ts
      type: unit
    - behavior: "Playwright spec asserts the 'approve' radio is the only one visible and is checked by default."
      test_file: tests/permissions-ui-fixed.spec.ts
      type: integration
prerequisites: []
---
# Complete the permissionMode='ignore' sweep — UI surfaces, DB layer, and contract documentation

## Objective

TASK-569 flipped 15 camelCase callsites of `permissionMode: 'ignore'` to `'approve'` but left residual surfaces that defeat the approve-by-default intent: two user-facing UI controls still expose `'ignore'`, three snake_case/DB-layer `|| 'ignore'` fallbacks re-seed it, four `DEFAULT 'ignore'` SQL clauses survive in `database.ts`, and a Playwright spec actively asserts the broken state. This task closes the surface, introduces a `DEFAULT_PERMISSION_MODE` constant in `shared/types/permissionMode.ts` so future grep-misses are structurally impossible, adds a file-based migration that backfills NULL rows on legacy installs, and documents the `'ignore'` contract (typed escape hatch only — no UI, no defaults).

## Implementation Steps

1. **Pre-flight sweep grep.** Establish baseline:
   ```bash
   grep -rnE "\|\| 'ignore'" main/src/ frontend/src/ shared/
   grep -rnE 'value="ignore"' frontend/src/ tests/
   grep -rnE "DEFAULT 'ignore'" main/src/
   ```
   Re-run as the final gate before COMPLETED — all three must return 0.

2. **Create `shared/types/permissionMode.ts`:**
   ```ts
   /**
    * Single source of truth for the Cyboflow permissionMode contract.
    * See docs/CODE-PATTERNS.md § "permissionMode contract".
    * 'ignore' remains a typed escape hatch consumed by claudeCodeManager.ts:389
    * (omits PreToolUse hook) and test fixtures. NO user-facing UI surface may
    * expose it as selectable; NO default/fallback may resolve to it.
    */
   export type PermissionMode = 'approve' | 'ignore';
   export const DEFAULT_PERMISSION_MODE: PermissionMode = 'approve';
   ```

3. **Replace `|| 'ignore'` fallbacks with `DEFAULT_PERMISSION_MODE`** at:
   - `main/src/services/sessionManager.ts:453`
   - `main/src/database/database.ts:1523`
   - `main/src/database/database.ts:1960`
   Mirror the existing `shared/types/*` import style in each file.

4. **Flip the four `DEFAULT 'ignore'` clauses** in `main/src/database/database.ts` (~280, ~366, ~493, ~641) to `DEFAULT 'approve'`. The CHECK constraint stays `IN ('approve', 'ignore')` — only the DEFAULT changes.

5. **Update legacy `main/src/database/migrations/legacy/add_permission_mode.sql`** — flip both `DEFAULT 'ignore'` to `DEFAULT 'approve'`. Doc/grep hygiene only (file not executed by runner). Add note: `-- NOTE: superseded by inline ALTER in database.ts and migration 008.`

6. **Add `main/src/database/migrations/008_permission_mode_approve_default.sql`** — idempotent NULL backfill:
   ```sql
   UPDATE sessions SET permission_mode = 'approve' WHERE permission_mode IS NULL;
   UPDATE projects SET default_permission_mode = 'approve' WHERE default_permission_mode IS NULL;
   ```
   Do NOT mass-rewrite existing `'ignore'` rows — users who chose it via the legacy UI may have meant it.

7. **Remove `<option value="ignore">Skip permissions</option>`** from `frontend/src/components/panels/cli/BaseCliPanel.tsx:432`. Tighten the inline cast at line 428 to `'approve'`.

8. **Remove the `'ignore'` radio block** from `frontend/src/components/Settings.tsx:286-305`. Narrow line 39's `useState` union to `'approve'`. Drop the `<ShieldOff />` ternary branch (now unreachable); remove the unused import if it becomes dead.

9. **Update `tests/permissions-ui-fixed.spec.ts`** — rewrite the two `'ignore'`-asserting tests to assert single-option visibility and approve-checked-by-default.

10. **Add `docs/CODE-PATTERNS.md § permissionMode contract`** documenting (i) `'ignore'` is a typed escape hatch consumed only by `claudeCodeManager.ts:389` and test fixtures, (ii) no UI may expose `'ignore'`, (iii) no default/fallback may resolve to `'ignore'` (use `DEFAULT_PERMISSION_MODE`), (iv) the DB CHECK constraint preserves `'ignore'` for backward compatibility with legacy rows.

11. **Add regression test** `main/src/services/__tests__/sessionManager.mainRepoPermission.test.ts`. Use the no-initialize construction pattern from `configManager.permissionMode.test.ts`. Two cases: NULL `default_permission_mode` → `'approve'`; undefined `default_permission_mode` → `'approve'`.

12. **Final verification chain:**
    ```bash
    pnpm --filter main test && pnpm --filter frontend test
    pnpm typecheck && pnpm lint
    # then re-run the step 1 greps and confirm 0 matches.
    ```

## Hardest Decision

**Shared constant vs flat `|| 'approve'` rewrite.** Chose the constant — TASK-569's failure mode was a grep-after-the-fact gate (camelCase only, missed snake_case). A `DEFAULT_PERMISSION_MODE: PermissionMode` import turns the rule into a compile-time fence, encodes the contract in the JSDoc at the import site, and lays a future home for the union itself once the inline declarations are consolidated.

## Rejected Alternatives

- **Flat `|| 'approve'` at three callsites, no shared constant** — repeats TASK-569's failure mode.
- **Delete `'ignore'` from the type union entirely** — breaks `claudeCodeManager.ts:389`'s legitimate debug bypass + several test fixtures.
- **Mass-rewrite existing `'ignore'` rows in migration 008** — destructive; users may have explicitly chosen it.

## Lowest Confidence Area

Import-path resolution for `shared/types/permissionMode.ts` from main-process files — some files use `../../../shared/...`, others may use a `@shared/*` alias if configured. Mirror an existing `shared/types/*` import in each touched file before adding the new import.
