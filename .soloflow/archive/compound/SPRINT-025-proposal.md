---
sprints: [SPRINT-025]
span_label: SPRINT-025
created: 2026-05-20T16:15:00.000Z
counters_start:
  ideas: 18
summary:
  cleanups: 5
  backlog_tasks: 7
  claude_md: 1
  soloflow_improvements: 0
---

# Compound Proposal — SPRINT-025

## A. Clean-up items (execute now)

### A1. Remove dead `web-streams-polyfill` dependency
- **Summary:** `web-streams-polyfill@^3.3.3` is declared in `main/package.json` but has zero importers anywhere in the repo — Node 22+ ships WHATWG streams natively, making the polyfill dead.
- **Source-Sprint:** SPRINT-025
- **Rationale:** Crystal-era leftover identical in pattern to the `electron-store` removal shipped in TASK-653; confirmed zero importers by code-reviewer. Dead deps inflate the install footprint and create false signals during lockfile audits.
- **Blast radius:** `main/package.json` (1 line removed), `pnpm-lock.yaml` (regenerated), `docs/packaging/root-deps-policy.md` (add a Removed entry). Risk: trivial.
- **Source:** FIND-SPRINT-025-4 (TASK-653 code-reviewer)
- **Proposed change:**
  ```diff
  # main/package.json — remove from "dependencies"
  -    "web-streams-polyfill": "^3.3.3",
  
  # docs/packaging/root-deps-policy.md — append to ## Removed dependencies
  + - `web-streams-polyfill@^3.3.3` — removed in TASK-XXX; zero importers in main/ or anywhere in repo; Node 22+ (engine floor) ships WHATWG Streams natively.
  
  # Then: pnpm install (regenerates pnpm-lock.yaml); gate with pnpm typecheck + pnpm lint + pnpm build:main
  ```

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** high
- **Reasoning:** Repo-wide grep for `from 'web-streams-polyfill'` / `require('web-streams-polyfill')` returns zero hits across `*.ts/*.js/*.tsx/*.mjs/*.cjs` (excluding node_modules), confirming the dep is genuinely dead; only declaration site is `main/package.json:31`.
- **Counterfactual:** A grep miss caused by a dynamic `require(name)` indirection would change the verdict.

### A2. Remove dead `dotenv` dependency
- **Summary:** `dotenv@^16.4.7` is declared in both `main/package.json` and root `package.json` with zero importers anywhere in the repo — a Crystal-era leftover.
- **Source-Sprint:** SPRINT-025
- **Rationale:** Same pattern as the `electron-store` removal in TASK-653 and `web-streams-polyfill` above. Confirmed by TASK-653's code-reviewer via repo-wide grep. Dual declaration (root + main) makes this slightly higher value to clean up.
- **Blast radius:** `main/package.json` (1 line), root `package.json` (1 line), `pnpm-lock.yaml` (regenerated), `docs/packaging/root-deps-policy.md` (add Removed entry). Risk: trivial.
- **Source:** FIND-SPRINT-025-5 (TASK-653 code-reviewer)
- **Proposed change:**
  ```diff
  # Verify first: grep -rnE "from ['\"]dotenv['\"]|require\(['\"]dotenv['\"]\)" . --include='*.ts' --include='*.js' (excluding node_modules) should return 0 hits.
  
  # main/package.json — remove from "dependencies"
  -    "dotenv": "^16.4.7",
  
  # root package.json — remove from "dependencies" (or devDependencies, whichever bucket it's in)
  -    "dotenv": "^16.4.7",
  
  # docs/packaging/root-deps-policy.md — append to ## Removed dependencies
  + - `dotenv@^16.4.7` — removed in TASK-XXX; zero importers in entire repo; declared in both main/package.json and root package.json, both removed.
  
  # Then: pnpm install; gate with pnpm typecheck + pnpm lint + pnpm build:main
  ```

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** high
- **Reasoning:** Grep for `from 'dotenv'` / `require('dotenv')` across all source extensions outside node_modules returns zero hits, and the dep is declared in both `package.json:65` and `main/package.json:24` (dual declaration genuinely warrants cleanup).
- **Counterfactual:** A non-grep-visible dynamic loader (e.g. `await import(envName)`) consuming dotenv would change the verdict.

### A3. Fix stale cross-reference in `docs/packaging/root-deps-policy.md`
- **Summary:** The "Verified-safe-to-omit packages" section still reads "see Dead-dep entries below for pending cleanup" but the Dead dependencies section is now empty after TASK-653 — the pointer resolves to nothing.
- **Source-Sprint:** SPRINT-025
- **Rationale:** One-line doc edit; stale pointers erode doc trust and waste reviewer time.
- **Blast radius:** `docs/packaging/root-deps-policy.md`, 1 line. Risk: trivial.
- **Source:** FIND-SPRINT-025-6 (TASK-653 code-reviewer)
- **Proposed change:**
  ```diff
  # docs/packaging/root-deps-policy.md — "Verified-safe-to-omit packages" section, line 13
  - _(none yet — see Dead-dep entries below for pending cleanup)_
  + _(none yet)_
  ```

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** high
- **Reasoning:** `docs/packaging/root-deps-policy.md:13` literally contains the stale pointer `(none yet — see Dead-dep entries below for pending cleanup)` while the Dead-dep section directly below at line 17 reads `(none — see Removed dependencies below)` — a one-line fix to a pointer that resolves to nothing.

### A4. Remove zero-caller `pureSetRunStatus` single-map helper and its test block
- **Summary:** `pureSetRunStatus` (the original single-map pure reducer in `reviewQueueSlice.ts`) has zero production callers after TASK-669 introduced `pureSetRunStatusAllMaps`; keeping it risks future callers silently getting incomplete eviction semantics.
- **Source-Sprint:** SPRINT-025
- **Rationale:** The code-reviewer confirmed zero production callers via grep. The helper is a historical artifact of TASK-502/TASK-668 now superseded by the multi-map version. Retaining it creates a maintenance hazard: a future contributor calling `pureSetRunStatus` would miss `runReasonMap`/`runDetectedAtMap` eviction — exactly the bug TASK-669 fixed. The disambiguation comment in the file head exists only because both ship side-by-side.
- **Blast radius:** `frontend/src/stores/reviewQueueSlice.ts` (remove lines 281-293 + disambiguation comment), `frontend/src/stores/__tests__/reviewQueueSlice.test.ts` (remove 6-case test block at lines 298-334). Risk: low (confirmed zero callers).
- **Source:** FIND-SPRINT-025-10 (TASK-669 code-reviewer)
- **Proposed change:**
  ```diff
  # frontend/src/stores/reviewQueueSlice.ts
  - // Note: this helper operates on `runStatusMap` only. Use `pureSetRunStatusAllMaps` to test multi-map eviction behavior.
  - export function pureSetRunStatus(
  -   map: ReadonlyMap<string, RunStatus>,
  -   runId: string,
  -   status: RunStatus
  - ): ReadonlyMap<string, RunStatus> {
  -   if (!(runId in Object.fromEntries(map))) return map;
  -   ... (lines 281-293)
  - }
  
  # frontend/src/stores/__tests__/reviewQueueSlice.test.ts
  - // Remove the 6-case pureSetRunStatus test block (lines 298-334)
  
  # Optional: port the no-op same-reference optimization from pureSetRunStatus into the
  # eviction branch of pureSetRunStatusAllMaps for consistency (review-queue cardinality
  # makes the allocation cost negligible — judgment call).
  ```

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** high
- **Reasoning:** `grep -rn "pureSetRunStatus\b" frontend` shows zero production callers — only the export at `reviewQueueSlice.ts:281` and its own test block in `reviewQueueSlice.test.ts:43,295-330`, confirming the dead-code claim and the drift-hazard (a future caller would miss the multi-map eviction TASK-669 added).
- **Counterfactual:** Discovery of a non-grep-visible caller (e.g. dynamic property access) would change the verdict, but the helper is a named export with no string-based dispatch surface.

### A5. Add missing `isCyboflowRunId` guard to the `exit` handler in `attachProcessLifecycleHandlers`
- **Summary:** The `exit` handler at `main/src/events.ts:560` is missing the `isCyboflowRunId` guard that TASK-667 added to its paired `spawned` handler at line 510, causing spurious Crystal session-table queries on every cyboflow run exit.
- **Source-Sprint:** SPRINT-025
- **Rationale:** High-severity bug (FIND-SPRINT-025-18) surfaced by the sprint-level code-reviewer. When a cyboflow run terminates, the unguarded exit handler runs `validatePanelEventContext`, `sessionManager.setSessionExitCode`, `sessionManager.updateSession`, `runCommandManager.stopRunCommands`, and `executionTracker.endExecution` against IDs the Crystal `sessions` table never wrote — potential errors or silent no-ops depending on session-table content. Five other guard sites (826, 877, 939, 1089, 506) apply the protection symmetrically across spawn/exit/output pairs; this is the only asymmetric site. The fix mirrors an already-approved pattern.
- **Blast radius:** `main/src/events.ts` (1 guard line added at line ~560 + optional comment). Risk: low.
- **Source:** FIND-SPRINT-025-18 (SPRINT-025 sprint-code-reviewer)
- **Proposed change:**
  ```diff
  # main/src/events.ts — the exit handler inside attachProcessLifecycleHandlers (~line 560)
  
  manager.on(exit, async ({ panelId, sessionId, exitCode, signal }) => {
  + if (isCyboflowRunId(panelId) || isCyboflowRunId(sessionId)) return; // mirrors spawned guard at line 510
    // ... existing body (validatePanelEventContext, sessionManager.setSessionExitCode, etc.)
  });
  
  # Consider also adding a comment pairing the two guards:
  # "spawned/exit guards must match — see isCyboflowRunId guard at line 510 (spawned) and line ~560 (exit)"
  ```

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** high
- **Reasoning:** Grep confirms the asymmetry exactly as claimed — `isCyboflowRunId` guards exist at `events.ts:510, 826, 877, 939, 1089` (5 sites) but the `manager.on('exit', ...)` at line 560 directly proceeds to `validatePanelEventContext` with zero guard, while its paired `spawned` handler at line 506 is guarded; high severity matches the unguarded sessionManager writes documented in FIND-SPRINT-025-18.

---

## B. Backlog tasks (refine into execution-ready plans)

### B1. Fix 4 pre-existing runExecutor.test.ts failures (lifecycle double-fire)
- **Summary:** Four tests in `main/src/orchestrator/__tests__/runExecutor.test.ts` fail on main with spy call-count assertions — `running()` fires twice instead of once, pointing to a redundant lifecycle transition call in `RunExecutor`.
- **Source-Sprint:** SPRINT-025
- **Source:** FIND-SPRINT-025-1 (TASK-653 executor), FIND-SPRINT-025-8 second instance (TASK-665 executor) — same 4 failures reproduced identically on both TASK-653 and TASK-665 worktrees.
- **Problem:** Tests at lines 626, 807, 862, 1284 of `runExecutor.test.ts` assert `running()` is called exactly 1× (or 0× in the bridge-drop case), but the spy records 2× (or 1×). The double-fire indicates `RunExecutor.onLifecycleTransition` is triggering the `running` lifecycle from two code paths — likely `sdk_initialized` phase AND a secondary path (`post_spawn` or similar) added in a recent sprint. The test failures are reproducible on the current `main` branch and predate SPRINT-025.
- **Proposed direction:** Audit `RunExecutor.onLifecycleTransition` (and all callers in `main/src/orchestrator/`) for the `running()` transition trigger. Compare the call graph against the last clean sprint (before the regression landed). The fix is likely removing a duplicate `lifecycleTransitions.running()` call or gating one invocation behind a check that it has not already fired. Add a regression-guard assertion to the fixed test that proves exactly one `running()` transition per run.
- **Scope:** small

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** high
- **Reasoning:** Failures reproduced identically across two independent worktrees (TASK-653 and TASK-665 executors) and the test file shows the running()-counting assertions at lines 708, 820, 1229, 1283 — broken lifecycle counts on a hot orchestrator path produce silent double-firing that is exactly the regression class a "exactly one running() per run" invariant exists to catch.

### B2. Fix pre-existing `cyboflowSchema.test.ts` failure — stuck_detected_at orphan column
- **Summary:** One test in `main/src/database/__tests__/cyboflowSchema.test.ts` fails on main because the 006 schema reconciler leaves the `stuck_detected_at` column intact when it should have removed it.
- **Source-Sprint:** SPRINT-025
- **Source:** FIND-SPRINT-025-2 (TASK-653 executor)
- **Problem:** Test at line 680 of `cyboflowSchema.test.ts` asserts that `stuck_detected_at` does NOT exist in `workflow_runs` after the reconciler runs a `NOT NULL` constraint flip — but the column still exists. The reconciler logic for column removal or schema reconciliation of `workflow_runs` appears to skip the orphan `stuck_detected_at` column. Reproducible on `main`.
- **Proposed direction:** Inspect the `006_cyboflow_schema.sql` migration's reconciler logic for `workflow_runs` (the `reconciler` block that handles `NOT NULL` constraint drift). Identify why `stuck_detected_at` is not being dropped when it should be absent from the target schema. Fix the reconciler to correctly drop orphan columns not present in the canonical table definition, or add the column to the canonical definition if it was omitted by mistake.
- **Scope:** small

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** high
- **Reasoning:** Test at `cyboflowSchema.test.ts:680` asserts `cols.some((c) => c.name === 'stuck_detected_at')).toBe(false)` after the reconciler runs and seeds the table with `stuck_detected_at INTEGER` at line 650; a failing reconciler that leaves orphan schema columns is a real schema-drift bug, not cosmetic.

### B3. Complete raw_events DDL deduplication — consolidate fixture and fix remaining inline copy
- **Summary:** `main/src/services/streamParser/__tests__/rawEventsSink.test.ts` still inlines an identical `raw_events` DDL, defeating the deduplication goal of TASK-665, and the new fixture lives in a directory (`__tests__/__fixtures__/`) that diverges from the established `__test_fixtures__/` sibling convention.
- **Source-Sprint:** SPRINT-025
- **Source:** FIND-SPRINT-025-9 (TASK-665 code-reviewer), FIND-SPRINT-025-8 first instance (TASK-665 code-reviewer)
- **Problem:** After TASK-665, the raw_events DDL still has four sources of truth: (1) production migration 006, (2) `GATE_SCHEMA` in `database/__test_fixtures__/registrySchema.ts:76-84`, (3) the new orchestrator fixture at `main/src/orchestrator/__tests__/__fixtures__/rawEvents.ts`, and (4) the inline copy in `rawEventsSink.test.ts:26-34`. Additionally, the new fixture uses `__tests__/__fixtures__/` naming while three established sibling fixtures live under `__test_fixtures__/` (e.g., `main/src/orchestrator/__test_fixtures__/{dbAdapter,loggerLikeSpy}.ts`).
- **Proposed direction:** (1) Move `main/src/orchestrator/__tests__/__fixtures__/rawEvents.ts` → `main/src/orchestrator/__test_fixtures__/rawEvents.ts` to align with the established convention (co-located alongside `dbAdapter.ts` and `loggerLikeSpy.ts`). (2) Update all import sites in `runEventBridge.test.ts` and `runExecutor.test.ts` to the new path. (3) Update `rawEventsSink.test.ts` to import `RAW_EVENTS_DDL` and `makeRawEventsDb` from the (now relocated) fixture instead of inlining. (4) Run `grep -rn "CREATE TABLE.*raw_events" main/` to find any further copies. After this task, the only DDL source of truth for tests should be the single `__test_fixtures__/rawEvents.ts` fixture (the production migration 006 remains the deployment source of truth separately).
- **Scope:** small

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** high
- **Reasoning:** Repo grep confirms three test DDL sources of truth (`__test_fixtures__/registrySchema.ts:76`, `__tests__/__fixtures__/rawEvents.ts:17`, and the inline `rawEventsSink.test.ts:27`) plus production migration 006 — and the new fixture diverges from the established `__test_fixtures__/` convention (which already holds `dbAdapter.ts` and `loggerLikeSpy.ts` in the same orchestrator dir), so the relocation + dedup is the proportional fix for the very drift TASK-665 set out to kill.

### B4. Promote `hasCwdString` guard to shared module and consolidate cwd-narrowing across backend and frontend
- **Summary:** The `hasCwdString` type guard exists only in `main/src/ipc/panels.ts` while `terminalPanelManager.ts` duplicates the narrowing logic in three places and `TerminalPanel.tsx` uses an unsafe `as TerminalPanelState | undefined` cast — four sites with no shared source of truth.
- **Source-Sprint:** SPRINT-025
- **Source:** FIND-SPRINT-025-7 (TASK-657 code-reviewer), FIND-SPRINT-025-20 (SPRINT-025 sprint-code-reviewer)
- **Problem:** `hasCwdString` was written properly in `main/src/ipc/panels.ts:13` (full type guard, no `any` casts). Three additional sites in `main/src/services/terminalPanelManager.ts` (lines 82-91, 249-250, 286) and one in `frontend/src/components/panels/TerminalPanel.tsx:268-273` each implement their own cwd-narrowing, the frontend version being an unsafe type assertion (`as TerminalPanelState | undefined`) that will silently pass any object shape to the compiler. If `customState.cwd` changes schema (e.g., to an object with `path` + `displayName`), all four sites must be updated in lockstep.
- **Proposed direction:** Promote `hasCwdString` and any shared `TerminalCustomState` type to `shared/types/panels.ts` (or a new `shared/types/panelCwd.ts`). Import from both `main/src/ipc/panels.ts`, `main/src/services/terminalPanelManager.ts` (three sites), and `frontend/src/components/panels/TerminalPanel.tsx`. Replace the frontend unsafe cast at line 270 with `hasCwdString(panel.state?.customState) ? panel.state.customState.cwd : workingDirectory ?? ''`. In `terminalPanelManager.ts`, consolidate the `initializeTerminal`/`saveTerminalState`/`restoreTerminalState` cwd logic to all delegate to the shared guard. Also evaluate whether `terminalPanelManager.initializeTerminal` should skip its own `customState.cwd` write now that `panels:initialize` always persists it first (eliminating the double-write noted in FIND-SPRINT-025-7). Pair with unit tests for the frontend usage path.
- **Scope:** medium

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** high
- **Reasoning:** Direct read confirms four genuinely-divergent cwd-narrowing sites — proper guard at `main/src/ipc/panels.ts:13`, three inline narrowings at `terminalPanelManager.ts:83-86, 249, 286`, and the unsafe `as TerminalPanelState | undefined` cast at `TerminalPanel.tsx:271` that bypasses any type check; `shared/types/panels.ts` already exists as a natural promotion target so the change cost is bounded.

### B5. Complete shell injection mitigation in `gitDiffManager.ts` (high-severity unescaped filenames)
- **Summary:** `gitDiffManager.ts` at lines 490 and 597 interpolate file paths from `git ls-files --others` directly into shell commands with no escaping — a high-severity injection surface for adversarial repository filenames that TASK-670's migration sweep missed.
- **Source-Sprint:** SPRINT-025
- **Source:** FIND-SPRINT-025-13 (TASK-670 code-reviewer)
- **Problem:** `execSync(\`wc -l < "${filePath}"\`, ...)` at line 490 and `execSync(\`cat "${filePath}"\`, ...)` at line 597 in `getDiffStats` and `createDiffForUntrackedFiles` use only a `"..."` wrapper with no escape function. `filePath` originates from `git ls-files --others --exclude-standard`, and a malicious repo could include a filename like `'; rm -rf /; echo '.txt` that breaks out of double-quote wrapping. TASK-670's pre-flight grep searched only for `.replace(/"/g, '\\"')` and missed sites with no escape function at all.
- **Proposed direction:** Replace both shell subprocess calls with pure Node.js equivalents: (a) `execSync(\`wc -l < "${filePath}"\`)` → `fs.readFileSync(filePath, 'utf8').split('\n').length - 1` (no subprocess at all), and (b) `execSync(\`cat "${filePath}"\`)` → `fs.readFileSync(filePath, 'utf8')` (same). This eliminates the shell entirely for these two sites — structurally safer than adding `escapeShellArg` because file I/O via `fs` carries zero injection risk. Add adversarial filename test cases (filename with single-quote, space, `$(...)` characters) to the existing `shellEscape.test.ts` or a new `gitDiffManager.test.ts`.
- **Scope:** small

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** high
- **Reasoning:** Direct read confirms both injection sites verbatim — `execSync(\`wc -l < "${filePath}"\`)` at `gitDiffManager.ts:490` and `execSync(\`cat "${filePath}"\`)` at line 597 use only naive double-quote wrapping, and `filePath` derives from `git ls-files --others --exclude-standard` (untracked enumeration); the `fs.readFileSync` replacement removes the subprocess entirely, satisfying both proportionality and a real high-severity attack class.

### B6. Migrate remaining `execSync(\`git ... ${value}\`)` sites to `execFile`-backed `runGit` helper
- **Summary:** Approximately 30 `execSync(\`git ... ${interpolatedValue}\`)` sites across `main/` use no escape function for values like `mainBranch` and `remoteName` that are user-configured — the same injection class TASK-670 just closed for commit messages.
- **Source-Sprint:** SPRINT-025
- **Source:** FIND-SPRINT-025-11 (TASK-670 code-reviewer)
- **Problem:** Files including `main/src/ipc/file.ts`, `main/src/ipc/dashboard.ts`, `main/src/services/{commitManager,executionTracker,gitDiffManager,gitPlumbingCommands,gitStatusManager,worktreeManager}.ts` each interpolate git-derived values or user-configured strings (`mainBranch`, `remoteName`, `remoteBranch`, `fromCommit`, `toCommit`, `commitHash`, `worktreePath`) into shell template literals. Most values are git-derived hex SHAs (relatively safe), but `mainBranch` and `remoteName` come from the project settings UI. The TASK-670 plan explicitly flagged `spawn('git', args, { cwd })` / `execFile` as the preferred long-term direction and deferred the broader migration.
- **Proposed direction:** (1) Add `runGit(cwd: string, args: string[], opts?: ExecFileOptions): Promise<{stdout: string; stderr: string}>` and `runGitSync(cwd: string, args: string[], opts?: ExecFileSyncOptions): {stdout: string; stderr: string}` helpers to `main/src/utils/shellEscape.ts` (or a new `main/src/utils/gitExec.ts`) backed by `child_process.execFile` / `execFileSync`. (2) Audit via `grep -rn "execSync\`git \|execAsync\`git " main/src --include='*.ts'`. (3) Migrate one file per task starting with files that interpolate user-configured values (`mainBranch`, `remoteName`), then move to git-derived hashes. Each file-migration task should add/update unit tests.
- **Scope:** large

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** medium
- **Reasoning:** Grep counts 28 `execSync(\`git ...\`)` / `execAsync(\`git ...\`)` sites across `main/src`, including `dashboard.ts:349,356` interpolating user-configured `remoteName`/`mainBranch` — a real injection surface in the same class TASK-670 just closed, and a `runGit(cwd, args[])` helper is the proportional fix (a single shared util that callers migrate to incrementally) rather than per-site shell escaping.
- **Counterfactual:** If a project-settings input-validation layer already restricts `mainBranch`/`remoteName` to git-safe ref chars on the write path, the urgency drops and B5 alone could suffice.

### B7. Extract `handleAddTerminal` into a shared `useAddTerminalPanel` hook
- **Summary:** `handleAddTerminal` is implemented near-verbatim in both `ProjectView.tsx` and `SessionView.tsx`; if the `panelApi.createPanel` shape changes (as it did when TASK-657 modified the IPC layer), both sites must be updated in lockstep.
- **Source-Sprint:** SPRINT-025
- **Source:** FIND-SPRINT-025-19 (SPRINT-025 sprint-code-reviewer)
- **Problem:** `ProjectView.tsx:176-193` and `SessionView.tsx:250-268` share identical `handleAddTerminal` logic — same `panelApi.createPanel` call, same `addPanel`, `setActivePanelInStore`, `panelApi.setActivePanel` sequence. They differ only by session source and one extra `addToHistory` call in `SessionView`. The sprint-level code-reviewer flagged that per-task reviewers cannot see across files; this duplication is invisible until sprint scope. A future third terminal-creation site (e.g., from a command palette) would clone a third copy.
- **Proposed direction:** Extract `useAddTerminalPanel(session: Session | null, opts?: { addToHistory?: boolean }): () => Promise<void>` into `frontend/src/hooks/useAddTerminalPanel.ts`. The hook encapsulates the `panelApi.createPanel({ type: 'terminal', ... }) + addPanel + setActivePanelInStore + panelApi.setActivePanel` sequence; the optional `addToHistory` flag covers the `SessionView` extension. Both `ProjectView` and `SessionView` replace their `useCallback` + `panelApi` calls with a single `useAddTerminalPanel(session, { addToHistory: ... })` invocation. Add a unit test that asserts the hook calls `panelApi.createPanel` with `type: 'terminal'` — this will catch future `panelApi.createPanel` shape drift before it silently diverges across call sites.
- **Scope:** small

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** high
- **Reasoning:** Direct read of `ProjectView.tsx:176-193` and `SessionView.tsx:250-268` confirms the bodies are identical modulo session source and one extra `addToHistory(...)` line — exactly the "third future call site clones a third copy" trap the proposed hook eliminates, and TASK-657's IPC-layer change is concrete evidence the shape does churn.

---

## C. CLAUDE.md / CODE-PATTERNS.md improvements (apply now)

### C1. Document the `rawEvents` shared test fixture in `docs/CODE-PATTERNS.md`
- **Summary:** Add a brief `rawEvents` shared-fixture entry to CODE-PATTERNS.md mirroring the dbAdapter / loggerLikeSpy entries, so future test authors find it instead of inlining a fourth DDL copy.
- **Source-Sprint:** SPRINT-025
- **Target file:** `/Users/raimundoesteva/Developer/cyboflow/docs/CODE-PATTERNS.md`
- **Action:** insert-after `### main/src/orchestrator/__test_fixtures__/loggerLikeSpy` block (after line 118, before line 120 "Database seed helpers")
- **Status:** ready
- **source_item:** C1
- **Apply timing:** apply AFTER B3 ships (which relocates fixture from `__tests__/__fixtures__/` to `__test_fixtures__/`). If applied before B3, change `__test_fixtures__/rawEvents` path to `__tests__/__fixtures__/rawEvents`.
- **Diff:**
  ```diff
  --- a/docs/CODE-PATTERNS.md
  +++ b/docs/CODE-PATTERNS.md
  @@ -118,6 +118,14 @@
   - **Canonical example:** `main/src/orchestrator/__tests__/runLauncher.test.ts` (LoggerLike); `main/src/services/panels/claude/__tests__/claudeCodeManagerWiring.test.ts` (production Logger).
   
  +### `main/src/orchestrator/__test_fixtures__/rawEvents`
  +
  +- **Path:** `main/src/orchestrator/__test_fixtures__/rawEvents.ts`
  +- **Use it for:** Any test that needs a `raw_events` table — persistence (`bridgeEvents`, `RawEventsSink`), consumption (`runExecutor`), or schema reconciliation. Exports `RAW_EVENTS_DDL`, `makeRawEventsDb()` (in-memory `better-sqlite3` with the table created and FKs off), and `countRawEvents(db, runId)`. Do NOT inline `CREATE TABLE ... raw_events` locally — a migration 006 schema change must propagate via this single source.
  +- **Why single-source:** TASK-665 extracted this to kill three inline DDL copies; FIND-SPRINT-025-9 caught a fourth (`rawEventsSink.test.ts`) the migration sweep missed. New `raw_events` test sites import here.
  +- **Canonical example:** `main/src/orchestrator/__tests__/runEventBridge.test.ts`; `main/src/orchestrator/__tests__/runExecutor.test.ts`.
  +
   ### Database seed helpers (pending — see compounded FIND-SPRINT-018-12)
  ```

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** medium
- **Reasoning:** The proposed entry mirrors the existing dbAdapter/loggerLikeSpy entries (`CODE-PATTERNS.md:107-118`) one-for-one and points future authors away from inlining a fifth DDL copy — FIND-SPRINT-025-9 caught the fourth inline copy in `rawEventsSink.test.ts:27` precisely because no doc steer existed; the rule meaningfully prevents recurrence rather than describing a one-off.
- **Counterfactual:** If B3 is skipped (fixture stays in `__tests__/__fixtures__/`), update the Path line accordingly before applying.

### C2. Document the `__test_fixtures__/` directory convention in `docs/CODE-PATTERNS.md`
- **Summary:** Add a one-line convention note that shared test fixtures live in sibling `__test_fixtures__/` directories (not under `__tests__/__fixtures__/`) so future authors don't re-introduce the divergent layout B3 is fixing.
- **Source-Sprint:** SPRINT-025
- **Target file:** `/Users/raimundoesteva/Developer/cyboflow/docs/CODE-PATTERNS.md`
- **Action:** insert-after `- **Test colocation:**` bullet in "File / Directory Conventions" (after line 12)
- **Status:** ready
- **source_item:** C1
- **Diff:**
  ```diff
  --- a/docs/CODE-PATTERNS.md
  +++ b/docs/CODE-PATTERNS.md
  @@ -10,6 +10,9 @@
   - **Test colocation:** Unit tests live in `__tests__/` subdirectories next to the file
     under test (e.g. `main/src/services/__tests__/gitStatusManager.test.ts`). E2E tests
     are top-level in `tests/`.
  +- **Shared test fixtures:** Live in sibling `__test_fixtures__/` directories (NOT under
  +  `__tests__/__fixtures__/`). See `main/src/orchestrator/__test_fixtures__/` for canonical
  +  examples (`dbAdapter.ts`, `loggerLikeSpy.ts`, `rawEvents.ts`).
   - **Barrels:** No barrel `index.ts` re-exports used; import paths are explicit.
  ```

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** medium
- **Reasoning:** The convention already holds in current code (`main/src/__test_fixtures__/`, `main/src/database/__test_fixtures__/`, `main/src/orchestrator/__test_fixtures__/` — three established sibling locations) and TASK-665 just clone-faulted into the divergent `__tests__/__fixtures__/` layout because nothing documented the choice; a one-line File/Directory Convention entry is the proportional preventive — no new file, no new abstraction.
- **Counterfactual:** If B3 is dropped, leaving the divergent path live as the only "raw_events" fixture, the rule should also be dropped to avoid rule-drift against the actual file layout.

---

## Suppressed — SoloFlow Defects

- **Plan AC dry-run against prescribed body (FIND-SPRINT-025-3)** — The TASK-653 plan's AC8a grep (`grep -nE '^- \`electron-store'`) would necessarily fail once AC8b's prescribed `## Removed dependencies` section was written, because the prescribed body satisfies AC8b while failing AC8a. The suggested fix ("dry-run the grep against the prescribed text before accepting the plan") is advice to SoloFlow plan-authoring and verification agents, not to the project codebase. It would evaporate if the user stopped using SoloFlow. Consider opening an issue or running `/soloflow:compound --tester` against this sprint in a SoloFlow-tester setup to surface it as a maintainer recommendation.

- **Diagnosis rigor gap / verifier methodology check (FIND-SPRINT-025-17)** — The finding recommends an `acceptance_criteria.verification` extension that lets the verifier mechanically check Implementation Notes blocks for prescribed counts and named log lines. This is about how SoloFlow's verifier agent should enforce diagnostic-rigor requirements, not about the project codebase. A rule in project CLAUDE.md about verifier behavior would be SoloFlow lore, not project convention. Consider opening an issue or running `/soloflow:compound --tester` against this sprint in a SoloFlow-tester setup to surface it as a maintainer recommendation.

---

## Reconciled Findings (informational)

No stale-open findings found — no done report in SPRINT-025 contains a `**Findings resolved:**` line referencing any finding that still shows `status: open` in the findings file. The three findings with `status: resolved` (FIND-SPRINT-025-14, FIND-SPRINT-025-15, FIND-SPRINT-025-16) were correctly marked by the verifier.

**Note on duplicate FIND-SPRINT-025-8 key:** The findings file contains two entries with the ID `FIND-SPRINT-025-8`. The first (source: TASK-665 code-reviewer) covers the CODE-PATTERNS.md documentation gap and `__test_fixtures__/` naming convention — triaged as C1 above. The second (source: TASK-665 executor) covers the same 4 pre-existing runExecutor.test.ts failures as FIND-SPRINT-025-1 — triaged as B1 above. Both are open; the duplicate key appears to be a findings-file authoring error (two distinct findings assigned the same ID).
