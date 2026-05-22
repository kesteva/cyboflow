---
id: TASK-719
idea: SPRINT-029-compound
status: in-flight
created: "2026-05-21T00:00:00Z"
files_owned:
  - frontend/src/components/CreateSessionDialog.tsx
  - frontend/src/components/panels/cli/BaseCliPanel.tsx
  - main/src/events.ts
  - main/src/services/panels/claude/claudeCodeManager.ts
  - docs/CODE-PATTERNS.md
files_readonly:
  - shared/types/permissionMode.ts
  - main/src/services/sessionManager.ts
  - main/src/database/database.ts
  - main/src/services/__tests__/configManager.permissionMode.test.ts
  - .soloflow/active/findings/SPRINT-029-findings.md
acceptance_criteria:
  - criterion: "Zero `|| 'approve'` string-literal fallbacks remain in product code under main/src/ and frontend/src/."
    verification: "grep -rnE \"\\|\\| 'approve'\" main/src/ frontend/src/ shared/ --include='*.ts' --include='*.tsx' returns 0 matches (excluding comment lines)."
  - criterion: Each of the 5 cited product files imports DEFAULT_PERMISSION_MODE.
    verification: "grep -n 'DEFAULT_PERMISSION_MODE' on each of CreateSessionDialog.tsx, BaseCliPanel.tsx, events.ts, claudeCodeManager.ts returns at least one import and one usage line."
  - criterion: CODE-PATTERNS.md Rule 5 carries an enforcement grep matching the style of Rules 1 and 2.
    verification: "grep -n 'grep -rnE' docs/CODE-PATTERNS.md returns at least 3 matches, with the new Rule 5 entry referencing the `\\|\\| 'approve'` pattern."
  - criterion: pnpm typecheck and pnpm lint exit 0.
    verification: "pnpm typecheck && pnpm lint"
  - criterion: configManager.permissionMode regression test continues to pass.
    verification: pnpm --filter @cyboflow/main run test -- configManager.permissionMode exits 0.
depends_on: []
estimated_complexity: low
epic: approval-router-and-permission-fix
test_strategy:
  needed: false
  justification: "Pure source-representation refactor — substitutes the re-exported DEFAULT_PERMISSION_MODE constant for the inline literal 'approve'. Runtime value is byte-identical. Existing configManager.permissionMode.test.ts already covers the contract."
---
# Replace residual `|| 'approve'` literals with DEFAULT_PERMISSION_MODE constant

## Objective

Complete the permissionMode contract Rule 5 from docs/CODE-PATTERNS.md by replacing the 5 remaining `|| 'approve'` fallback string-literals in product code with imports of DEFAULT_PERMISSION_MODE from shared/types/permissionMode.ts.

## Implementation Steps

1. Sweep grep to confirm exactly these 5 hits in product code: CreateSessionDialog.tsx:91, :633; BaseCliPanel.tsx:425; main/src/events.ts:667; claudeCodeManager.ts:258. (The comment in configManager.permissionMode.test.ts:37 is acceptable.)

2. In each file: add `import { DEFAULT_PERMISSION_MODE } from '<relative-path>/shared/types/permissionMode'` and replace each `|| 'approve'` with `|| DEFAULT_PERMISSION_MODE`. Do NOT touch bare-literal initializers (e.g. CreateSessionDialog:100, :624) or JSX value="approve" attributes.

3. In docs/CODE-PATTERNS.md, extend Rule 5 with the enforcement grep `grep -rnE "\|\| 'approve'" main/src/ frontend/src/ shared/ --include='*.ts' --include='*.tsx'` and assertion `must return 0 matches in non-comment lines.`

4. Run `pnpm typecheck && pnpm lint && pnpm --filter @cyboflow/main run test -- configManager.permissionMode`.

5. Re-run the step-1 grep — must return 0 non-comment matches.

## Hardest Decision

Bare-literal initializers (line 100, 624) and JSX value="approve" attributes are out of scope. They're syntactically distinct from `|| 'approve'` fallbacks; replacing them would change typing semantics or violate Rule 1's UI-attribute mandate.

## Rejected Alternatives

- Broaden to all bare 'approve' literals: out of scope, risks typing/JSX conflicts.
- CI script instead of doc prose: Rules 1 and 2 live as prose; asymmetric to do only Rule 5.
- Local const APPROVE = 'approve': defeats the cross-module type linkage Rule 5 exists for.

## Lowest Confidence Area

The Rule 5 grep wording — "must return 0 matches in non-comment lines" is non-machine-parseable but consistent with Rules 1/2's existing prose pattern.
