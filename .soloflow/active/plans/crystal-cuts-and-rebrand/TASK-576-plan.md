---
id: TASK-576
idea: SPRINT-006-compound
status: ready
created: 2026-05-14T00:00:00Z
files_owned:
  - main/src/test/setup.ts
  - main/src/services/cyboflowPermissionBridge.ts
  - main/src/preload.ts
  - main/src/orchestrator/trpc/ipcAdapter.ts
  - main/src/services/cliToolRegistry.ts
  - main/src/services/panels/cli/AbstractCliManager.ts
  - main/src/services/panels/claude/claudeCodeManager.ts
  - main/src/services/taskQueue.ts
  - main/src/database/database.ts
  - main/src/database/migrations/006_cyboflow_schema.sql
  - main/src/services/cyboflow/__tests__/transitions.test.ts
  - main/src/utils/logger.ts
  - main/src/ipc/session.ts
  - main/src/polyfills/README.md
  - scripts/README.md
  - tests/smoke.spec.ts
  - tests/permissions-ui-fixed.spec.ts
files_readonly:
  - .soloflow/active/plans/crystal-cuts-and-rebrand/EPIC-crystal-cuts-and-rebrand.md
  - .soloflow/active/plans/crystal-cuts-and-rebrand/TASK-560-plan.md
  - .soloflow/active/plans/crystal-cuts-and-rebrand/TASK-561-plan.md
  - .soloflow/active/plans/crystal-cuts-and-rebrand/TASK-562-plan.md
  - .soloflow/active/plans/crystal-cuts-and-rebrand/TASK-565-plan.md
  - .soloflow/active/plans/crystal-cuts-and-rebrand/TASK-566-plan.md
acceptance_criteria:
  - criterion: "main/src/test/setup.ts no longer hard-codes app.getName() as 'Crystal'"
    verification: "grep -n \"getName.*'Crystal'\" main/src/test/setup.ts returns 0 matches AND grep -n \"getName.*'Cyboflow'\" main/src/test/setup.ts returns 1 match"
  - criterion: "Playwright smoke test asserts the window title is 'Cyboflow' (matches package.json productName)"
    verification: "grep -n \"toBe\\('Crystal'\\)\" tests/smoke.spec.ts returns 0 matches AND grep -n \"toBe\\('Cyboflow'\\)\" tests/smoke.spec.ts returns 1 match"
  - criterion: "Backend code comments and JSDoc no longer use the bare word 'Crystal' outside the explicit allowlist"
    verification: "grep -rn --include='*.ts' --include='*.sql' --include='*.md' -E '\\bCrystal\\b' main/src/ scripts/README.md tests/ | grep -vE '(crystalDirectory|getCrystal|setCrystal|enableCrystalFooter|disableCrystalFooter|--crystal-dir|streamParser/(__fixtures__/README\\.md|schemas\\.ts|__tests__/schemas\\.test\\.ts))' returns 0 lines"
  - criterion: "User-facing error message in AbstractCliManager no longer says 'Crystal Settings'"
    verification: "grep -n \"path in Crystal Settings\" main/src/services/panels/cli/AbstractCliManager.ts returns 0 matches AND grep -n \"path in Cyboflow Settings\" main/src/services/panels/cli/AbstractCliManager.ts returns 1 match"
  - criterion: "Claude session log strings no longer say 'Crystal session'"
    verification: "grep -nE 'Crystal session' main/src/services/panels/claude/claudeCodeManager.ts returns 0 matches"
  - criterion: "Stream-parser upstream-attribution comments are preserved verbatim (intentional historical reference, mirrors TASK-560's AboutDialog allowlist)"
    verification: "grep -nE \"Crystal's ClaudeMessageTransformer\\.ts\" shared/types/claudeStream.ts main/src/services/streamParser/schemas.ts main/src/services/streamParser/__fixtures__/README.md main/src/services/streamParser/__tests__/schemas.test.ts returns at least 4 matches"
  - criterion: "Deprecated --crystal-dir CLI alias in main/src/index.ts is preserved (intentional backward compat)"
    verification: "grep -n \"'--crystal-dir'\" main/src/index.ts returns at least 2 matches"
  - criterion: "Main typecheck and unit tests pass"
    verification: "pnpm --filter main typecheck exits with status 0 AND pnpm --filter main test exits with status 0"
  - criterion: "Frontend typecheck and lint pass (no incidental breakage)"
    verification: "pnpm --filter frontend typecheck exits with status 0 AND pnpm --filter frontend lint exits with status 0"
depends_on: []
estimated_complexity: medium
epic: crystal-cuts-and-rebrand
test_strategy:
  needed: false
  justification: "Pure string/comment sweep with no behavior change. The verification surface is the AC grep (zero residual bare-word 'Crystal' outside the allowlist) plus typecheck/lint/test exit codes. The two test files in `files_owned` (main/src/test/setup.ts, tests/smoke.spec.ts) are themselves the test surface — running them with the updated string assertion IS the verification. The sibling-test scan: `find main/src -name '*.test.ts' -path '*__tests__*'` returns the existing vitest specs in `__tests__/` dirs; none of them assert anything about the 'Crystal' string this task is removing, so no incidental breakage is expected."
prerequisites:
  - check: "grep -q \"productName.*Cyboflow\" package.json"
    fix: "package.json must already have productName: 'Cyboflow' (set by TASK-558). If this check fails, TASK-558 has regressed — investigate before proceeding. Without the productName flip, the smoke test assertion change in this task would fail at runtime."
    description: "Confirms the actual window title is 'Cyboflow' (so the rewritten smoke test will pass)."
    blocking: true
---

# Backend Crystal-reference sweep across main/, shared/, scripts/, and tests/

## Objective

TASK-560 swept bare-word `Crystal` from user-facing frontend strings. The backend (main process, shared types, test mocks, E2E specs, build scripts) still has ~30 stragglers: code comments, JSDoc, log strings, one user-facing error message, two test files that hard-code the old product name as a string assertion, and several README headers. This task mirrors TASK-560's structure for the backend surface, with an explicit allowlist for references that are intentional (deprecated CLI alias, upstream-attribution comments, symbols owned by other rebrand tasks).

Most acutely: `main/src/test/setup.ts` mocks `app.getName()` as `'Crystal'`, and `tests/smoke.spec.ts` asserts `page.title()` is `'Crystal'` — the latter would already fail on a fresh dev build (package.json's `productName` is `Cyboflow` per TASK-558) but is masked by the smoke test not running under `pnpm test` in any current CI workflow.

## Implementation Steps

1. **Sweep gate (run as step 1 every time the executor returns).** Run:
   ```
   grep -rn --include='*.ts' --include='*.tsx' --include='*.sql' --include='*.md' -E '\bCrystal\b' main/src/ shared/ scripts/README.md tests/
   ```
   At task start this prints every backend match to inspect; at task end every line must either be in the allowlist below or have been rewritten to `Cyboflow`.

2. **Allowlist (DO NOT rewrite these — they are owned by other tasks or intentionally preserved):**
   - **Owned by TASK-561** (`enableCrystalFooter` / `disableCrystalFooter` symbol rename): any line containing `enableCrystalFooter` or `disableCrystalFooter`. Files: `main/src/types/config.ts`, `main/src/utils/shellEscape.ts`, `main/src/ipc/file.ts`, `main/src/services/worktreeManager.ts`, `main/src/services/commitManager.ts`.
   - **Owned by TASK-562** (`crystalDirectory` module rename): any line containing `crystalDirectory`, `getCrystalDirectory`, `getCrystalSubdirectory`, `setCrystalDirectory`. Files: `main/src/utils/crystalDirectory.ts`, `main/src/utils/crystalDirectory.test.ts`, plus the imports in `main/src/index.ts`, `main/src/ipc/updater.ts`, `main/src/ipc/session.ts`, `main/src/services/configManager.ts`, `main/src/services/database.ts`, `main/src/services/panels/claude/claudeCodeManager.ts`, `main/src/services/cyboflowPermissionIpcServer.ts`, `main/src/utils/logger.ts`. Note: comments in `logger.ts:30` ("centralized Crystal directory") and `database.ts:1370,1435` ("Match Crystal's existing migration") are NOT symbol references — they're prose and ARE in scope for this task.
   - **Intentional backward compat:** `--crystal-dir` deprecated CLI alias in `main/src/index.ts:122-136`. The flag name, the deprecation warning text, and the `if (flagName === '--crystal-dir=')` branch all stay. This mirrors how TASK-560 preserved the AboutDialog attribution line.
   - **Upstream historical attribution** (mirrors TASK-560's AboutDialog exemption): comments that describe the Crystal *upstream project's* `ClaudeMessageTransformer.ts` as the origin of the `context_compacted` parsing convention. These are educational/historical and must stay:
     - `shared/types/claudeStream.ts:97-98`
     - `main/src/services/streamParser/schemas.ts:82`
     - `main/src/services/streamParser/__fixtures__/README.md:81-82`
     - `main/src/services/streamParser/__tests__/schemas.test.ts:94`
     - `frontend/src/components/panels/ai/transformers/ClaudeMessageTransformer.ts:6` (in frontend, but is a stream-parser upstream attribution — also preserved)
   - **`.gitignore` legacy paths** (`.crystal/`, `main/crystal.db`): preserved so existing dev environments with leftover Crystal data dirs continue to be git-ignored. Not in `files_owned`.
   - **Build scripts targeting Linux** (`scripts/build-flatpak.sh`): the epic's broader scope ("Delete Linux/Windows-conditional code paths") will delete this file in a separate task. Not in `files_owned`.
   - **Commented-out monaco theme** (`frontend/src/components/panels/diff/MonacoDiffViewer.tsx:419`): the `'crystal-dark'`/`'crystal-light'` theme names appear in a commented-out line. Dead code preserved per `@cyboflow-hidden`-style convention. Not in `files_owned`.

3. **Rewrite `main/src/test/setup.ts:8`:** change `getName: vi.fn(() => 'Crystal')` → `getName: vi.fn(() => 'Cyboflow')`. This is a vitest mock for the Electron `app` module — no production code reads it, but the value should match the real `productName` so any future test that asserts on it works.

4. **Rewrite `tests/smoke.spec.ts:13`:** change `expect(title).toBe('Crystal')` → `expect(title).toBe('Cyboflow')`. The window title is driven by electron-builder's `productName` (currently `"Cyboflow"`, see `package.json:85`). The smoke test has been asserting a stale value since TASK-558 flipped `productName`.

5. **Rewrite `tests/permissions-ui-fixed.spec.ts:21`:** the comment `// Wait for settings dialog (header is "Crystal Settings")` → `// Wait for settings dialog (header is "Cyboflow Settings")`. **Coordination note:** the Settings.tsx header text itself is renamed by TASK-560 (line 172). If TASK-560 has not yet landed when this task ships, the spec will continue passing because the comment is documentation, not an assertion — the actual selector in the spec body doesn't grep on "Crystal Settings". Verify by reading `tests/permissions-ui-fixed.spec.ts` end-to-end and confirming no `.toBe('Crystal Settings')` or `getByText('Crystal Settings')` exists; if one does, escalate.

6. **Rewrite `main/src/services/cyboflowPermissionBridge.ts:4`:** comment `// It communicates with the main Crystal process via IPC` → `// It communicates with the main Cyboflow process via IPC`.

7. **Rewrite `main/src/preload.ts:605`:** comment `// Crystal's existing contextBridge surfaces above are preserved — this is additive.` → `// Cyboflow's existing contextBridge surfaces above are preserved — this is additive.` (The word "existing" is preserved; only the proper noun changes.)

8. **Rewrite `main/src/orchestrator/trpc/ipcAdapter.ts:33`:** comment `* Crystal's existing \`ipcMain.handle\` surface is unaffected — this call is` → `* Cyboflow's existing \`ipcMain.handle\` surface is unaffected — this call is`.

9. **Rewrite `main/src/services/cliToolRegistry.ts:170`:** JSDoc `* Central registry for managing CLI tools in Crystal` → `* Central registry for managing CLI tools in Cyboflow`.

10. **Rewrite `main/src/services/panels/cli/AbstractCliManager.ts`:**
    - L60 (JSDoc): `* Abstract base class for managing CLI tool processes in Crystal` → `* Abstract base class for managing CLI tool processes in Cyboflow`.
    - L519 (**user-facing error message**): `'- Or set a custom executable path in Crystal Settings'` → `'- Or set a custom executable path in Cyboflow Settings'`. **Coordination with TASK-560:** the Settings modal title is also renamed by TASK-560 (line 172). After both ship, the error text and the modal header match.

11. **Rewrite `main/src/services/panels/claude/claudeCodeManager.ts`** (5 sites):
    - L114: log string `\`[ClaudeCodeManager] Resuming Claude session ${claudeSessionId} for Crystal session ${sessionId}\`` → replace `Crystal session` with `Cyboflow session`.
    - L117: error message `\`Cannot resume: no Claude session_id stored for Crystal session ${sessionId}\`` → replace `Crystal session` with `Cyboflow session`.
    - L141: comment `// Only add permission-specific flags if Crystal's permission server is included` → `// Only add permission-specific flags if Cyboflow's permission server is included`.
    - L360: error message `\`Cannot resume: no Claude session_id stored for Crystal session ${sessionId}\`` (duplicate of L117 in a different branch) → same rewrite.
    - L868: JSDoc `* Set up MCP configuration for base project servers only (without Crystal permission server).` → `* Set up MCP configuration for base project servers only (without Cyboflow permission server).`

12. **Rewrite `main/src/services/taskQueue.ts:546`:** comment `// This handles cases where a worktree was created outside of Crystal` → `// This handles cases where a worktree was created outside of Cyboflow`.

13. **Rewrite `main/src/database/database.ts`** (2 sites):
    - L1370: comment `* prevent subsequent files from running (matching Crystal's existing migration` → replace `Crystal's existing migration` with `Cyboflow's existing migration` (the comment describes the inherited tolerance pattern; "existing" refers to the migration's own history in this codebase, which is now Cyboflow's).
    - L1435: comment `// Match Crystal's existing tolerance pattern (try/catch around 004/005):` → replace `Crystal's existing` with `Cyboflow's existing`.

14. **Rewrite `main/src/database/migrations/006_cyboflow_schema.sql:2`:** SQL comment `-- Strictly disjoint from Crystal's sessions/tool_panels — no cross-FK.` → `-- Strictly disjoint from the inherited sessions/tool_panels tables — no cross-FK.` (Rewording rather than `Crystal → Cyboflow` because the comment is documenting a *boundary* with the upstream-inherited schema; "inherited" is more accurate than rebranding the upstream's name.)

15. **Rewrite `main/src/services/cyboflow/__tests__/transitions.test.ts:28`:** this is a duplicate of the SQL comment above embedded in a vitest fixture string. Apply the same rewording: `-- Strictly disjoint from Crystal's sessions/tool_panels — no cross-FK.` → `-- Strictly disjoint from the inherited sessions/tool_panels tables — no cross-FK.` to keep the fixture in sync with the actual migration file.

16. **Rewrite `main/src/utils/logger.ts:30`:** comment `// Use the centralized Crystal directory` → `// Use the centralized Cyboflow directory`. (Note: the call site on L31 imports `getCrystalSubdirectory` — that symbol is owned by TASK-562 and stays untouched here.)

17. **Rewrite `main/src/ipc/session.ts`** (2 sites):
    - L1525: comment `// Create images directory in CRYSTAL_DIR/artifacts/{sessionId}` → `// Create images directory in CYBOFLOW_DIR/artifacts/{sessionId}`.
    - L1574: comment `// Create text directory in CRYSTAL_DIR/artifacts/{sessionId}` → `// Create text directory in CYBOFLOW_DIR/artifacts/{sessionId}`.

   Note: the env-var name `CYBOFLOW_DIR` is what the runtime actually reads (per `main/src/utils/crystalDirectory.ts:32` after TASK-558 flipped it — see the existing TASK-562 prereq that asserts "does NOT read CRYSTAL_DIR"). So this comment correction aligns the docs with the actual code.

18. **Rewrite `main/src/polyfills/README.md:3`:** `This directory contains polyfills needed for the Crystal application to run properly...` → `...for the Cyboflow application to run properly...`.

19. **Rewrite `scripts/README.md:3`:** `This directory contains build and maintenance scripts for the Crystal application.` → `...for the Cyboflow application.`

20. **Re-run sweep grep from step 1.** Expected: zero matches outside the allowlist categories (deprecated `--crystal-dir`, the five upstream-attribution stream-parser comments, all `enableCrystalFooter`/`disableCrystalFooter`/`crystalDirectory`/`getCrystal*`/`setCrystal*` symbol references).

21. **Run `pnpm --filter main typecheck`, `pnpm --filter main test`, `pnpm --filter frontend typecheck`, `pnpm --filter frontend lint`.** All must exit 0. (Frontend typecheck/lint are included because shared types in `shared/types/claudeStream.ts` are consumed by frontend; if any incidental import breaks, frontend typecheck catches it.)

## Acceptance Criteria

See frontmatter. Compound rule: the sweep grep in step 1 ends with matches confined to the allowlist categories and zero others.

## Test Strategy

No new tests. The verification surface is fully captured by the AC grep + typecheck + lint + the existing main vitest suite. Two of the rewritten files (`main/src/test/setup.ts`, `tests/smoke.spec.ts`) are themselves test infrastructure — their rewrites are exercised by running the vitest and Playwright suites. The `transitions.test.ts` rewrite at step 15 is a fixture-string update and is verified by running the spec.

## Hardest Decision

Whether to rewrite the SQL/test-fixture comment `-- Strictly disjoint from Crystal's sessions/tool_panels` (steps 14 and 15) as `Cyboflow's sessions/tool_panels` or as `inherited sessions/tool_panels`. **Decision: `inherited`.** The comment documents the schema boundary between the v1 Cyboflow tables and the upstream-inherited Crystal tables (`sessions`, `tool_panels`). Renaming the upstream's table-set to `Cyboflow's` would be inaccurate — those tables predate Cyboflow and come from the Crystal baseline. `inherited` is the most accurate descriptor and matches the language used in `EPIC-crystal-cuts-and-rebrand.md` ("inherited Crystal substrate"). The other choice would be to keep `Crystal's` verbatim as an upstream-attribution exemption (similar to the stream-parser comments), but the SQL/fixture comment is internal-tooling-facing rather than reader-education-facing, so neutral wording is cleaner.

## Rejected Alternatives

- **Combine this sweep with TASK-562 (crystalDirectory module rename).** Rejected: TASK-562 is a symbol/module-path rename with a backwards-compat shim and a fresh test file. This task is a pure prose/string sweep with no module restructuring. Mixing them produces a sprawling PR where the prose changes obscure the module-rename diff. The two share several files in `files_readonly` (the `crystalDirectory` import sites), but this task explicitly does NOT touch those import lines — only adjacent prose comments — so no rebase conflict.
- **Rewrite the `--crystal-dir` deprecated CLI alias to remove the legacy code path.** Rejected: the alias was added precisely as a backward-compat shim for users who scripted around the old flag name. Removing it is a separate decision tied to a deprecation timeline (announce → wait → remove). Out of scope here.
- **Use a single `sed -i` regex across the tree to flip every `\bCrystal\b` to `Cyboflow`.** Rejected: would clobber the 5 stream-parser upstream-attribution comments, the deprecated `--crystal-dir` flag, the `.gitignore` legacy paths, and the SQL/fixture comment that needs *rewording* (not literal substitution). File-by-file edits scoped above are auditable; a tree-wide `sed` is not.
- **Rewrite the SQL migration file's comment** but leave the duplicated comment in `transitions.test.ts` (step 15). Rejected: the fixture string is a literal copy of the migration's first 30 lines (used to assert migration parsing). If the migration file and the fixture diverge, the fixture-driven test would silently lose its real-migration coverage. Step 15 keeps them locked.

## Lowest Confidence Area

**OUT OF SCOPE — flagged for separate follow-up task:** `main/src/services/terminalPanelManager.ts:54-55` exposes two environment variables to the user's terminal subprocess: `CRYSTAL_SESSION_ID` and `CRYSTAL_PANEL_ID`. These are a **runtime contract** — user scripts running inside cyboflow terminal panels may already read them. Renaming to `CYBOFLOW_SESSION_ID` / `CYBOFLOW_PANEL_ID` is the right end state, but the migration needs a strategy (set both temporarily, deprecation window, etc.) rather than a flat rename. This task does **not** touch `terminalPanelManager.ts`; a separate task should handle the env-var rename with proper backwards-compat semantics. Recommend filing under the same `crystal-cuts-and-rebrand` epic.

**Secondary uncertainty: AboutDialog.tsx IPC field coordination.** `frontend/src/components/AboutDialog.tsx:13,47,165,170,171` consumes `versionInfo.crystalDirectory` from the IPC response. TASK-562 renames that field on the producer side (`main/src/ipc/updater.ts:98`: `crystalDirectory:` → `cyboflowDirectory:`) but does NOT list `AboutDialog.tsx` in its `files_owned`. After TASK-562 lands, AboutDialog will read `undefined` from a now-renamed field. This is **not** in scope for the current task — flagging it for whoever lands TASK-562 to add `AboutDialog.tsx` to the consumer-side update, or for a coordination task to follow.

**Tertiary uncertainty: deferred `RichOutputWithSidebar.tsx`, `FileEditor.tsx`, `App.tsx`, `console.ts` legacy localStorage key strings.** Each of these files contains a string literal of the form `'crystal-<something>'` representing a *legacy* localStorage key that the `migrateLocalStorageKey` helper migrates *from*. These strings MUST be preserved verbatim — they are looked up in users' actual localStorage. The acceptance-criteria grep uses `\bCrystal\b` (capital C with word boundary), which does NOT match the lowercase kebab-case `crystal-sidebar-width` etc. So these strings are already implicitly excluded from the sweep. Documenting here so the executor doesn't second-guess and "fix" them. No code change needed.
