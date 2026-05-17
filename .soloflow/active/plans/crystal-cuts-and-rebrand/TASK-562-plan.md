---
id: TASK-562
idea: SPRINT-002-compound
status: in-flight
created: "2026-05-12T00:00:00Z"
files_owned:
  - main/src/utils/cyboflowDirectory.ts
  - main/src/utils/crystalDirectory.ts
  - main/src/utils/cyboflowDirectory.test.ts
  - main/src/utils/crystalDirectory.test.ts
  - main/src/services/database.ts
  - main/src/services/configManager.ts
  - main/src/services/permissionIpcServer.ts
  - main/src/services/panels/claude/claudeCodeManager.ts
  - main/src/utils/logger.ts
  - main/src/index.ts
  - main/src/ipc/updater.ts
  - main/src/ipc/session.ts
files_readonly:
  - .soloflow/active/plans/approval-router-and-permission-fix/TASK-301-plan.md
  - .soloflow/active/plans/crystal-cuts-and-rebrand/EPIC-crystal-cuts-and-rebrand.md
  - .soloflow/archive/done/crystal-cuts-and-rebrand/TASK-558-done.md
acceptance_criteria:
  - criterion: Canonical module file is main/src/utils/cyboflowDirectory.ts and exports getCyboflowDirectory / getCyboflowSubdirectory / setCyboflowDirectory
    verification: "test -f main/src/utils/cyboflowDirectory.ts && grep -nE 'export function (getCyboflowDirectory|getCyboflowSubdirectory|setCyboflowDirectory)' main/src/utils/cyboflowDirectory.ts returns exactly 3 matches"
  - criterion: "Legacy module main/src/utils/crystalDirectory.ts remains as a thin re-export shim with deprecation comment, exporting the legacy names AS aliases of the new canonical names"
    verification: "test -f main/src/utils/crystalDirectory.ts && grep -n '@deprecated' main/src/utils/crystalDirectory.ts returns at least 1 match AND grep -nE 'export (\\{|const|function) .*getCrystalDirectory|getCrystalSubdirectory|setCrystalDirectory' main/src/utils/crystalDirectory.ts returns at least 3 matches AND grep -nE 'cyboflowDirectory' main/src/utils/crystalDirectory.ts returns at least 1 match (proves it re-exports from the new module)"
  - criterion: All in-tree call sites import from the new module path (./cyboflowDirectory) and call the new function names
    verification: "grep -rnE \"from ['\\\"](.+/)?crystalDirectory['\\\"]\" main/src/ --include='*.ts' | grep -v 'main/src/utils/crystalDirectory' returns zero lines AND grep -rnE 'getCrystalDirectory|getCrystalSubdirectory|setCrystalDirectory' main/src/ --include='*.ts' | grep -v 'main/src/utils/crystalDirectory' returns zero lines"
  - criterion: "ipc/updater.ts response field is renamed: `crystalDirectory:` → `cyboflowDirectory:` in the IPC payload"
    verification: "grep -n 'crystalDirectory:' main/src/ipc/updater.ts returns 0 matches AND grep -n 'cyboflowDirectory:' main/src/ipc/updater.ts returns at least 1 match"
  - criterion: New unit test file main/src/utils/cyboflowDirectory.test.ts mirrors the 5 existing crystalDirectory test cases with renamed function names
    verification: "test -f main/src/utils/cyboflowDirectory.test.ts && grep -nE 'getCyboflowDirectory\\(\\)' main/src/utils/cyboflowDirectory.test.ts returns at least 4 matches"
  - criterion: Old test file main/src/utils/crystalDirectory.test.ts is deleted (or rewritten to only assert the deprecation shim re-exports work)
    verification: "test ! -e main/src/utils/crystalDirectory.test.ts OR (grep -n '@deprecated' main/src/utils/crystalDirectory.test.ts returns 1 match AND the file is < 30 lines)"
  - criterion: Main typecheck and main test suite pass
    verification: pnpm --filter main typecheck exits with status 0 AND pnpm --filter main test exits with status 0
  - criterion: "MCP server name and socket path renames are explicitly NOT in this task's diff (they are owned by TASK-301 in approval-router-and-permission-fix epic)"
    verification: "grep -rn 'crystal-permissions' main/src/services/mcpPermissionServer.ts main/src/services/mcpPermissionBridge.ts returns at least 2 matches (unchanged from baseline, proving this task did not touch them) AND TASK-562's diff does not modify mcpPermissionServer.ts or mcpPermissionBridge.ts"
depends_on: []
estimated_complexity: medium
epic: crystal-cuts-and-rebrand
test_strategy:
  needed: true
  justification: "The crystalDirectory module is the data-directory abstraction used by 8 production files (database, configManager, permissionIpcServer, claudeCodeManager, logger, index.ts, ipc/updater.ts, ipc/session.ts). It already has a vitest spec (crystalDirectory.test.ts) with 5 cases — moving the module without an equivalent test file at the new path would silently regress coverage. The shim file also needs at least one test to assert the re-exports work."
  targets:
    - behavior: getCyboflowDirectory() returns ~/.cyboflow by default; respects CYBOFLOW_DIR env var; respects programmatic override; getCyboflowSubdirectory appends subpaths
      test_file: main/src/utils/cyboflowDirectory.test.ts
      type: unit
    - behavior: "Legacy crystalDirectory.ts re-exports resolve to the same function as the new module (import { getCrystalDirectory } from './crystalDirectory' returns the same value as getCyboflowDirectory)"
      test_file: main/src/utils/crystalDirectory.test.ts
      type: unit
prerequisites:
  - check: "grep -q 'crystal-permissions' main/src/services/panels/claude/claudeCodeManager.ts"
    fix: "If this check FAILS (returns exit 1), TASK-301 has already shipped and the MCP server name is now 'cyboflow-permissions'. Re-read the conflict-handling note in 'Hardest Decision' and skip steps that touch panel-claude paths assuming they still say 'crystal-permissions'."
    description: "Confirms baseline state: TASK-301 (which renames MCP server name to cyboflow-permissions) has not yet shipped. This task explicitly does NOT rename MCP server names; if TASK-301 lands first, no harm — but the executor should be aware which task touched what."
    blocking: false
---
# Rename crystalDirectory module to cyboflowDirectory with backward-compat alias shim

## Objective

The TypeScript module `main/src/utils/crystalDirectory.ts` and its three exports (`getCrystalDirectory`, `getCrystalSubdirectory`, `setCrystalDirectory`) are the data-directory abstraction Cyboflow uses to resolve `~/.cyboflow`. The internal `Crystal`-prefixed names are stale and the file path itself is grep-visible (`crystalDirectory` shows up in any sweep). This task moves the canonical implementation to `main/src/utils/cyboflowDirectory.ts` with renamed exports (`getCyboflowDirectory` etc.), updates all 8 in-tree consumers to import from the new module, and leaves `crystalDirectory.ts` as a thin deprecated re-export shim — preserving any out-of-tree consumer that may have imported the old names (low risk in practice since this is a private main-process utility, but the shim is cheap insurance and TASK-558's task body documented it as the intended approach).

**Explicit scope boundary:** the MCP server name (`crystal-permissions` in `mcpPermissionServer.ts:18`, `mcpPermissionBridge.ts:94`, `claudeCodeManager.ts:148,806`) and the socket-path basename in `permissionIpcServer.ts:35` are **NOT** in scope. TASK-301 (`approval-router-and-permission-fix` epic) already owns those renames and uses a hard-rename approach (no alias). See "Hardest Decision" for the rationale.

## Implementation Steps

1. **Sweep gate (run as step 1 every time the executor returns).** Run:
   ```
   grep -rnE 'crystalDirectory|getCrystalDirectory|getCrystalSubdirectory|setCrystalDirectory|customCrystalDir' main/src/ --include='*.ts'
   ```
   At task start this lists every consumer to rewrite. At task end the only file containing these identifiers must be `main/src/utils/crystalDirectory.ts` itself (the shim) — every other file is rewritten to the new names.

2. **Create `main/src/utils/cyboflowDirectory.ts`** as a new file containing the renamed exports. Copy the body of `main/src/utils/crystalDirectory.ts` (lines 1-80) verbatim, then rename:
   - `let customCrystalDir` → `let customCyboflowDir`
   - `export function setCrystalDirectory(dir: string): void` → `export function setCyboflowDirectory(dir: string): void` (rename internal assignment too)
   - `export function getCrystalDirectory(): string` → `export function getCyboflowDirectory(): string` (rename the variable read inside)
   - `export function getCrystalSubdirectory(...subPaths: string[]): string` → `export function getCyboflowSubdirectory(...subPaths: string[]): string` (and rename its internal `getCrystalDirectory()` call to `getCyboflowDirectory()`)
   - JSDoc comments: rewrite `Crystal` references in inline comments to `Cyboflow` (e.g., `// Sets a custom Cyboflow directory path` already says Cyboflow — keep that; just confirm).

3. **Rewrite `main/src/utils/crystalDirectory.ts`** as a thin re-export shim:
   ```typescript
   /**
    * @deprecated Use main/src/utils/cyboflowDirectory.ts instead.
    * This file is a backward-compatibility shim that re-exports the renamed
    * functions under their legacy Crystal-prefixed names. New code should
    * import from './cyboflowDirectory' directly.
    *
    * Tracking: TASK-562 (crystal-cuts-and-rebrand epic). Removal target:
    * one major version after Cyboflow 1.0 ships.
    */
   export {
     getCyboflowDirectory as getCrystalDirectory,
     getCyboflowSubdirectory as getCrystalSubdirectory,
     setCyboflowDirectory as setCrystalDirectory,
   } from './cyboflowDirectory';
   ```
   The file must be < 30 lines and contain no logic — only the deprecation JSDoc and the `export {...} from './cyboflowDirectory'` statement.

4. **Update `main/src/services/database.ts:3,6`:** `import { getCrystalDirectory } from '../utils/crystalDirectory';` → `import { getCyboflowDirectory } from '../utils/cyboflowDirectory';`. L6: `getCrystalDirectory()` → `getCyboflowDirectory()`.

5. **Update `main/src/services/configManager.ts:6,16`:** identical rename pattern (import and call site).

6. **Update `main/src/services/permissionIpcServer.ts:7,19`:** `getCrystalSubdirectory` → `getCyboflowSubdirectory`, import from `'../utils/cyboflowDirectory'`. **Important coordination note:** TASK-301 also rewrites this file (and renames it to `cyboflowPermissionIpcServer.ts`). If TASK-301 lands first, this rename is already done (no-op for this step). If TASK-562 lands first (current sequencing assumption since this epic is the older one), TASK-301 will inherit the new import path. Either order works — both tasks just need the import line correct in the final state.

7. **Update `main/src/services/panels/claude/claudeCodeManager.ts:12,682,884`:** import from `'../../../utils/cyboflowDirectory'`, rename `getCrystalDirectory` calls to `getCyboflowDirectory`.

8. **Update `main/src/utils/logger.ts:4,31`:** import from `'./cyboflowDirectory'`, rename `getCrystalSubdirectory` call to `getCyboflowSubdirectory`.

9. **Update `main/src/index.ts:23,117,124`:** import `setCyboflowDirectory` from `'./utils/cyboflowDirectory'`. Rename both `setCrystalDirectory(dir)` calls to `setCyboflowDirectory(dir)`. **Do NOT** rename the `--crystal-dir` CLI flag or the `--cyboflow-dir` CLI flag — those are user-facing CLI flags governed by TASK-558's documented backward-compat policy (see comment block at lines 113-130 referencing `--crystal-dir` as deprecated alias). This step touches only the imported function name.

10. **Update `main/src/ipc/updater.ts:8,98`:** import from `'../utils/cyboflowDirectory'`, call `getCyboflowDirectory()`. **L98 also has an IPC response field rename:** `crystalDirectory: getCrystalDirectory()` → `cyboflowDirectory: getCyboflowDirectory()`. The frontend consumer of this IPC payload (if any) must be checked — run `grep -rn 'crystalDirectory:' frontend/src/` before changing; if any frontend consumer reads `.crystalDirectory`, update the frontend access path in the same commit. If no frontend consumer exists, just rewrite the main side.

11. **Update `main/src/ipc/session.ts:7,275,1526,1575`:** import `getCyboflowSubdirectory` from `'../utils/cyboflowDirectory'`, rename all three call sites.

12. **Create `main/src/utils/cyboflowDirectory.test.ts`** as the canonical test file. Copy the body of `main/src/utils/crystalDirectory.test.ts` (lines 1-58) and rename the imports and function references: `getCrystalDirectory` → `getCyboflowDirectory`, `setCrystalDirectory` → `setCyboflowDirectory`, `getCrystalSubdirectory` → `getCyboflowSubdirectory`, `crystalDirectory` (in `await import(...)` and `describe(...)` strings) → `cyboflowDirectory`. The 5 test cases keep identical assertions (ending in `.cyboflow`, respecting `CYBOFLOW_DIR`, etc.).

13. **Rewrite `main/src/utils/crystalDirectory.test.ts`** as a minimal shim assertion (or delete it). Recommended: delete it entirely — its purpose was to cover the function bodies, which now live in cyboflowDirectory.test.ts. If the executor prefers to keep a minimal shim test, it must:
    - have `@deprecated` in a top-of-file comment
    - be under 30 lines
    - contain exactly one `it()` block asserting that `import { getCrystalDirectory } from './crystalDirectory'` resolves to the same function reference as `getCyboflowDirectory` (i.e., the re-export aliasing works)
    **Default decision: delete the file.** Less code is better; the re-export shim is asserted via the typecheck (any consumer importing the legacy name compiles only if the re-export resolves).

14. **Re-run sweep grep from step 1.** Expected matches: only `main/src/utils/crystalDirectory.ts` (the shim) and possibly `main/src/utils/crystalDirectory.test.ts` (if kept). Every other file in `main/src/` must show zero matches.

15. **Run `pnpm --filter main typecheck` and `pnpm --filter main test`.** Both must exit 0.

## Acceptance Criteria

See frontmatter. Compound rule: every in-tree call site imports from `'./cyboflowDirectory'` (or relative equivalent), the shim file exists with `@deprecated` and re-exports, and the new test file covers the canonical functions.

## Test Strategy

See frontmatter `test_strategy.targets`. The new `cyboflowDirectory.test.ts` is a verbatim port of the existing 5 cases with renamed identifiers. If the executor keeps `crystalDirectory.test.ts` as a shim, it adds one case asserting the re-export aliases work (compile-level proof is also acceptable — the shim file's existence + the consumers' typecheck passing is itself a runtime assertion that aliasing works).

## Hardest Decision

Whether to also rename the MCP server name (`crystal-permissions`) and the socket-file basename in the same task. **Decision: no — explicitly out of scope.** Two reasons: (1) TASK-301 (in the `approval-router-and-permission-fix` epic) already plans both renames with a hard-rename approach (no alias); see `.soloflow/active/plans/approval-router-and-permission-fix/TASK-301-plan.md` lines 65-86. Doing the same renames here under a different approach (alias shim) creates a direct conflict. (2) The `crystal-cuts-and-rebrand` epic body explicitly puts "Renaming the permission bridge to `cyboflow-permissions`" **out of scope** (`EPIC-crystal-cuts-and-rebrand.md:25`). The compounder direction for B3 said "register cyboflow-permissions as canonical MCP server name and keep crystal-permissions as deprecated alias with warning log" — but that conflicts with both the epic boundary and TASK-301's existing plan. The conflict is surfaced as an ESCALATE TO HUMAN in Lowest Confidence Area. This task limits itself to the TypeScript module rename and explicitly does not touch any MCP server name, socket path, or permission bridge identifier.

## Rejected Alternatives

- **Hard-rename `crystalDirectory.ts` with no shim** (just delete the old file). Rejected: the compounder direction explicitly asked for "a re-export shim from the old path." Even though no out-of-tree consumer is known, the shim is ~10 lines and gives us a no-cost safety margin. The shim's deletion can be tracked as a one-line task in a future release.
- **Bundle MCP server alias into this task.** Rejected — see Hardest Decision. Conflicts with TASK-301 and the epic scope boundary.
- **Rename only the function exports inside `crystalDirectory.ts`, leaving the file path unchanged.** Rejected: half the value of B3's scope is removing `crystalDirectory` as a grep-visible identifier in any future sweep. Keeping the file path means every `grep -i crystal` continues to surface this file even after the function names change.

## Lowest Confidence Area

**ESCALATE TO HUMAN (sequencing conflict):** The B3 compounder direction explicitly described a Phase 1 alias-based approach to renaming the MCP server name (`crystal-permissions` → `cyboflow-permissions`) — but TASK-301 in `approval-router-and-permission-fix` already plans a hard-rename of the same MCP server name (status: ready, not yet executed). Two paths forward:

- **Option A (planner default):** Defer the MCP server name rename to TASK-301 (hard-rename approach), as scoped in TASK-562 above. This honors the epic boundary in `EPIC-crystal-cuts-and-rebrand.md:25`. The B3 direction's "Phase 1 alias" plan is dropped; the MCP server name gets a hard rename via TASK-301 when that epic ships.
- **Option B (B3 direction):** Change TASK-301's approach from hard-rename to alias-shim, doing the rename here in TASK-562 with `cyboflow-permissions` canonical and `crystal-permissions` as deprecated alias with warning log. This would mean editing TASK-301's plan to reflect "MCP server name was already aliased by TASK-562; this task swaps the canonical to the new name" — which is a much smaller change to TASK-301.

The user should choose. The planner defaulted to Option A because the cross-epic boundary is documented in the existing epic body and TASK-301 is fully fleshed-out. Secondary uncertainty: whether the frontend IPC payload `.crystalDirectory` field (step 10) is consumed anywhere in `frontend/src/`. The executor must grep before changing; if a consumer exists, it must be updated in the same commit to avoid a runtime "undefined" access.
