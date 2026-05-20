---
id: TASK-677
idea: SPRINT-025-compounder
status: ready
created: 2026-05-20T00:00:00Z
files_owned:
  - shared/types/panels.ts
  - main/src/ipc/panels.ts
  - main/src/services/terminalPanelManager.ts
  - frontend/src/components/panels/TerminalPanel.tsx
files_readonly:
  - main/src/services/panelManager.ts
acceptance_criteria:
  - criterion: "A `hasCwdString` user-defined type guard is exported from `shared/types/panels.ts` with the signature `function hasCwdString(state: ToolPanelState['customState']): state is { cwd: string }`."
    verification: "grep -n 'export function hasCwdString' shared/types/panels.ts returns exactly 1 hit, and the function signature matches `state is { cwd: string }`."
  - criterion: "All 4 cwd-narrowing call sites are migrated to the shared guard. The local copy at `main/src/ipc/panels.ts:13-21` is deleted; the ad-hoc narrowings at `main/src/services/terminalPanelManager.ts:249` (saveTerminalState) and `main/src/services/terminalPanelManager.ts:286` (restoreTerminalState `state.cwd || process.cwd()`) use the guard; the unsafe `as TerminalPanelState | undefined` cast at `frontend/src/components/panels/TerminalPanel.tsx:271` is replaced with a guard-based narrowing."
    verification: "Run all 4 greps and confirm: (a) `grep -n 'function hasCwdString' main/src/ipc/panels.ts` returns 0 hits (local copy deleted); (b) `grep -n \"'cwd' in panel.state.customState\" main/src/services/terminalPanelManager.ts` returns 0 hits; (c) `grep -n 'as TerminalPanelState | undefined' frontend/src/components/panels/TerminalPanel.tsx` returns 0 hits; (d) `grep -rn 'hasCwdString' main/src frontend/src shared/` returns at least 4 hits (1 declaration + 3+ imports/usages)."
  - criterion: "TypeScript typecheck passes across all workspaces with the migrated code."
    verification: "Run `pnpm typecheck` from the repo root; exit code 0."
  - criterion: "Existing tests (terminal panel tests, panel IPC tests) continue to pass."
    verification: "Run `pnpm --filter @cyboflow/main test` and `pnpm --filter @cyboflow/frontend test`; both exit 0."
depends_on: []
estimated_complexity: medium
epic: standalone-terminal-panels
test_strategy:
  needed: true
  justification: "The shared guard touches 4 production sites including a frontend display path. New unit tests on the guard catch malformed customState shapes (null, missing cwd, non-string cwd, empty string) that any of the call sites might encounter. Sibling-test scan: `main/src/ipc/__tests__/` and `main/src/services/__tests__/` contain panel-IPC and terminal-manager tests; `frontend/src/components/panels/__tests__/` (if present) covers TerminalPanel."
  targets:
    - behavior: "hasCwdString returns true for `{ cwd: '/some/path' }`, false for `null`, undefined, `{}`, `{ cwd: '' }`, `{ cwd: 123 }`."
      test_file: "shared/types/__tests__/panels.test.ts"
      type: unit
    - behavior: "Existing terminal panel IPC handler tests (cwd resolution path) still pass after migration."
      test_file: "main/src/ipc/__tests__/panels.test.ts"
      type: integration
    - behavior: "TerminalPanel frontend still renders displayCwd from customState.cwd correctly after replacing the cast with a guard."
      test_file: "frontend/src/components/panels/__tests__/TerminalPanel.test.tsx"
      type: component
---

# Promote hasCwdString to shared/types/panels.ts and consolidate the 4 cwd-narrowing sites

## Objective

Eliminate one private type guard, two ad-hoc `'cwd' in ...` narrowings, and one unsafe `as TerminalPanelState | undefined` cast by promoting `hasCwdString` to `shared/types/panels.ts` and using it everywhere. The unsafe cast in `TerminalPanel.tsx:271` is the highest-value target: it bypasses runtime checks entirely and would happily read `cwd` from any malformed `customState` shape. A shared guard makes all 4 sites behave the same way and removes the cast's silent-failure mode.

## Implementation Steps

1. **Add the shared guard at the bottom of `shared/types/panels.ts`** (after the `PANEL_CAPABILITIES` const so it sits with related panel-domain code):
   ```ts
   /**
    * Type guard: narrows ToolPanelState['customState'] to `{ cwd: string }` when
    * it is an object with a non-empty string `cwd` property.
    *
    * Use this guard at every site that needs to read `customState.cwd` to avoid
    * the unsafe `as TerminalPanelState | undefined` cast pattern. Returns false
    * for null, undefined, empty-string cwd, or non-string cwd values.
    */
   export function hasCwdString(
     state: ToolPanelState['customState']
   ): state is { cwd: string } {
     return (
       typeof state === 'object' &&
       state !== null &&
       'cwd' in state &&
       typeof (state as Record<string, unknown>).cwd === 'string' &&
       ((state as Record<string, unknown>).cwd as string).length > 0
     );
   }
   ```
   The implementation is copied verbatim from `main/src/ipc/panels.ts:13-21`. The JSDoc adds the rationale (avoiding the unsafe cast pattern) so future contributors understand which call sites need it.

2. **Delete the local copy in `main/src/ipc/panels.ts`** (lines 8-21) and import the shared guard at the top of the file:
   ```ts
   // Add to existing imports
   import { CreatePanelRequest, PanelEventType, ToolPanel, ToolPanelState, BaseAIPanelState, hasCwdString } from '../../../shared/types/panels';
   ```
   The `resolveTerminalCwd` helper at lines 29-37 continues to call `hasCwdString(panel.state.customState)` as it does today — no change. The second call site at line 162 (`if (!hasCwdString(panel.state.customState))`) also continues unchanged. Only the local function declaration is removed.

3. **Migrate `main/src/services/terminalPanelManager.ts:249`** (saveTerminalState). The current code reads:
   ```ts
   let cwd = (panel.state.customState && 'cwd' in panel.state.customState) ? panel.state.customState.cwd : undefined;
   cwd = cwd || process.cwd();
   ```
   Add the import at the top of the file:
   ```ts
   import { hasCwdString } from '../../../shared/types/panels';
   ```
   Replace lines 249-250 with:
   ```ts
   let cwd = hasCwdString(panel.state.customState) ? panel.state.customState.cwd : process.cwd();
   ```
   Note the simplification: the original two-line idiom (assign then fallback) collapses to one line because `hasCwdString` already rejects empty strings. The subsequent `try { ... cwd = await this.getProcessCwd(pid); ... }` block at lines 251-258 remains unchanged.

4. **Migrate `main/src/services/terminalPanelManager.ts:286`** (restoreTerminalState). The current code reads:
   ```ts
   await this.initializeTerminal(panel, state.cwd || process.cwd());
   ```
   This site narrows `state.cwd` (where `state: TerminalPanelState`), not `panel.state.customState`. The TerminalPanelState type already declares `cwd?: string`, so the narrowing is structurally safe. However, to consolidate behavior with the empty-string rejection that `hasCwdString` provides, change to:
   ```ts
   const restoreCwd =
     typeof state.cwd === 'string' && state.cwd.length > 0 ? state.cwd : process.cwd();
   await this.initializeTerminal(panel, restoreCwd);
   ```
   Inline rationale comment: `// Mirrors hasCwdString's non-empty-string check (shared/types/panels.ts) — state.cwd is already typed as string|undefined so the guard is structural here, but the empty-string handling matches.`

   This is intentionally NOT calling `hasCwdString` because the argument here is already typed as `string | undefined`, not `customState`. Calling the guard would mean wrapping the value: `hasCwdString({ cwd: state.cwd })` which is awkward and slower. Document the intentional non-use in the comment so future contributors don't try to "fix" it.

5. **Migrate `frontend/src/components/panels/TerminalPanel.tsx:271`** (the unsafe cast). The current code reads:
   ```ts
   const displayCwd =
     (panel.state?.customState as TerminalPanelState | undefined)?.cwd ??
     workingDirectory ??
     '';
   ```
   Add the import at the top of the file (line 10 currently imports `TerminalPanelState`):
   ```ts
   import type { TerminalPanelState } from '../../../../shared/types/panels';
   import { hasCwdString } from '../../../../shared/types/panels';
   ```
   Replace lines 270-273 with:
   ```ts
   // Derive the cwd to display in the header.
   // Priority: panel.state.customState.cwd → SessionContext.workingDirectory → ''
   const displayCwd = hasCwdString(panel.state?.customState)
     ? panel.state.customState.cwd
     : workingDirectory ?? '';
   ```
   This removes the unsafe `as TerminalPanelState | undefined` cast and replaces it with a runtime-checked narrowing. The `displayCwd`'s usage in the JSX below (lines 282-285 for the `title` and `<span>` text) is unchanged.

6. **Write unit tests for the shared guard** at `shared/types/__tests__/panels.test.ts` (new file — confirm via Glob that no existing test file for `shared/types/panels.ts` exists). Cover at minimum:
   - `hasCwdString({ cwd: '/some/path' })` → true
   - `hasCwdString(null)` → false
   - `hasCwdString(undefined)` → false
   - `hasCwdString({})` → false
   - `hasCwdString({ cwd: '' })` → false
   - `hasCwdString({ cwd: 123 as any })` → false (cast required for the malformed-input case; this is a guard test, not a typecheck test)
   - `hasCwdString({ cwd: '/path', other: 'data' })` → true (extra properties don't disqualify)

   If `shared/` does not currently have a `__tests__/` directory, check `shared/package.json` (or root `vitest.config.ts`) to confirm vitest picks up `shared/**/*.test.ts`. If not, place the test at `main/src/__tests__/panels-guard.test.ts` (or similar workspace-resolvable location) and import the guard via the same relative path the production code uses.

7. **Run typecheck and tests:**
   ```bash
   pnpm typecheck
   pnpm --filter @cyboflow/main test
   pnpm --filter @cyboflow/frontend test
   ```
   Expected: all exit 0.

## Acceptance Criteria

See frontmatter. One shared declaration, no local copies, no unsafe cast, all sites use the shared guard or document why not.

## Test Strategy

A new `shared/types/__tests__/panels.test.ts` (or equivalently-scoped) file covers the guard with the 7 cases listed above. The 3 production call sites are exercised by existing tests; the typecheck and test-suite runs serve as integration coverage. No mocking required — the guard is pure.

## Hardest Decision

**Whether to also migrate `terminalPanelManager.ts:286` (the `state.cwd ||` narrowing on an already-typed `string | undefined` field) to call `hasCwdString`.** The site is structurally different from the other 3: the input is `TerminalPanelState`'s `cwd?: string`, not `customState: ...|Record<string, unknown>`. Calling `hasCwdString({ cwd: state.cwd })` would technically work but is awkward and adds an object allocation per call. Chosen approach: don't force the guard here; instead mirror its empty-string check inline with a comment explaining the intentional non-use. This keeps the guard's call sites focused on the genuine `customState` narrowing problem while still propagating the empty-string-rejection behavior. The IDEA's count of "4 cwd-narrowing sites" is preserved, but the 4th site uses an inline pattern that matches the guard's semantics without calling it.

## Rejected Alternatives

- **Migrate site 4 with `hasCwdString({ cwd: state.cwd })` wrapper.** Rejected — adds a 1-property object allocation per terminal restore for no behavioral gain. The narrowing was already structurally safe (TS knows `state.cwd` is `string | undefined`); only the empty-string edge case needed harmonizing.
- **Add `hasCwdString` to a new file `shared/types/customState.ts`.** Rejected because the guard is intrinsically about `ToolPanelState['customState']` and lives naturally next to `ToolPanelState`'s declaration. Splitting it across files for "purity" adds an import hop with no clarity benefit.
- **Leave the unsafe cast in `TerminalPanel.tsx:271` and only consolidate the backend sites.** Rejected — the frontend cast is the highest-severity site (renderer crashes if customState is malformed from a future migration); leaving it would defeat the IDEA's core motivation.

## Lowest Confidence Area

The placement of the new test file under `shared/types/__tests__/`. The `shared/` directory may not currently be configured as a vitest target; if so, the test won't run on `pnpm test`. Mitigation: check the project's vitest configuration before authoring the test path. If `shared/` is not a test target, place the test inside the `main/` workspace's test tree (e.g. `main/src/__tests__/hasCwdString.test.ts`) and use the same relative import the production code uses (`../../../shared/types/panels`). Either way, the guard's logic is trivially testable.
