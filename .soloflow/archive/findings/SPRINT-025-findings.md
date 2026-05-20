---
sprint: SPRINT-025
pending_count: 18
last_updated: "2026-05-20T15:51:45.382Z"
---
# Findings Queue

## FIND-SPRINT-025-17
- **source:** TASK-667 (verifier)
- **type:** improvement
- **severity:** medium
- **status:** open
- **location:** .soloflow/active/plans/orchestrator-and-trpc-router/TASK-667-plan.md (Implementation Notes section)
- **description:** The executor's Implementation Notes record "CONFIRMED H2" but the diagnosis methodology bypassed Phase 1 step 3b's mandate to add the `[runEventBridge] published` log line, rebuild, run a fresh diagnostic workflow, and grep for the actual bridge-publish count. The notes say "Backend bridge-publish count: not available for this run (diagnostic log line was added after this run); inferred from DB as ~168 events published". This inference is logically unsound: when `skipPersistence: true`, the raw_events INSERT is owned by the CCM/EventRouter/RawEventsSink pipeline, NOT runEventBridge — so the 168-row DB count tells us only that CCM saw 168 events, not that the bridge's `onOutput` fired 168 times or that publish was called 168 times. The bridge's `onOutput` listener could plausibly have fired exactly once (e.g. H1a-style or a listener-detach upstream), which would produce the same DB count via the parallel CCM pipeline. The architectural fix (subscription in store singleton) is robust to any of H1a/H1b/H2 — so the wrong-diagnosis risk is bounded — but the "CONFIRMED H2" claim is not supported by the data the executor collected. Additionally, Phase 4 step 12's end-to-end smoke ("renderer console shows `#1`, `#2`, `#3`, ... up to at least `#25`") was not executed; AC8 ("the user-acceptance gate") is therefore not verified by either unit test or manual smoke.
- **suggested_action:** Future tasks of this "diagnose-then-fix" shape need a verifier-side check that Phase 1 step results match the schema the plan prescribed (counts named, runId named, log lines that produced the counts named). Consider an `acceptance_criteria.verification` extension that lets the verifier mechanically check the Implementation Notes block for the expected counts. Separately, this specific task's AC8 should be cleared by a human smoke after the next merge — added to human-review-queue as a deferred verification.
- **resolved_by:** 

## FIND-SPRINT-025-13
- **source:** TASK-670 (code-reviewer)
- **type:** anti-pattern
- **severity:** high
- **status:** open
- **location:** main/src/services/gitDiffManager.ts:489-490, 596-597
- **description:** TASK-670 migrated three ad-hoc escape sites (file.ts, worktreeManager.ts, runCommandManager.ts) but two equivalent — and arguably more dangerous — sites in `gitDiffManager.ts` remained untouched and use ONLY a naive `"${filePath}"` double-quote wrapper with no escape function at all: `execSync(\`wc -l < "${filePath}"\`, ...)` at line 490 and `execSync(\`cat "${filePath}"\`, ...)` at line 597. The `filePath` is built from `${worktreePath}/${cleanFile}` where `cleanFile` originates from `git ls-files --others --exclude-standard` (untracked file enumeration). Git's `ls-files` output normally does not contain shell-active characters but CAN — a malicious or compromised repo could include a file named like `'; rm -rf /; echo '.txt` which would split out of the double-quote wrapper because `"..."` does not protect against `$(...)`, backticks, `\`, or single-quote-escape-doublequote combinations. The TASK-670 plan's pre-flight grep (step 1) only searched for the specific `.replace(/"/g, '\\"')` pattern and missed sites that use NO escape function at all — i.e. raw template interpolation. The bug class is identical to what TASK-670 fixed; the migration is incomplete.
- **suggested_action:** Spawn a follow-up task to migrate `getDiffStats` (lines 480-505) and `createDiffForUntrackedFiles` (lines 585-620) in `main/src/services/gitDiffManager.ts` to either (a) `escapeShellArg(filePath)` from `main/src/utils/shellEscape.ts`, OR — preferable — (b) `child_process.spawnSync('wc', ['-l', filePath], {...})` and `fs.readFileSync(filePath)` respectively, eliminating the shell entirely. Option (b) is structurally safer for these two specific sites because `wc -l < file` can be replaced by `fs.readFileSync(filePath, 'utf8').split('\n').length - 1` (no subprocess at all) and `cat file` should just be `fs.readFileSync(filePath, 'utf8')`. The fact that these sites use shell `cat`/`wc` for what is plain file I/O is itself a smell — the unsanitized shell exposure is gratuitous.
- **resolved_by:** 

## FIND-SPRINT-025-12
- **source:** TASK-670 (code-reviewer)
- **type:** anti-pattern
- **severity:** medium
- **status:** open
- **location:** main/src/ipc/file.ts:245, 275
- **description:** Two `execAsync(\`git commit -F ${tmpFile}\`, ...)` call sites interpolate the temp-file path into the shell command without escaping. `tmpFile` is built as `path.join(os.tmpdir(), \`cyboflow-commit-${Date.now()}.txt\`)` so the only attack surface is the system tmpdir prefix — but tmpdir paths CAN contain spaces on macOS (`/var/folders/<random>/T/...`, generally safe) and on Windows where `os.tmpdir()` resolves to a user-profile path that frequently contains spaces (e.g. `C:\Users\First Last\AppData\Local\Temp`). On any such system the bare interpolation breaks word-splitting and the commit silently fails. Lower-priority than FIND-SPRINT-025-13 because the input is bounded (system-controlled prefix + deterministic suffix) but it still warrants migration to `escapeShellArg` or — better — `child_process.execFile('git', ['commit', '-F', tmpFile], {...})` which sidesteps the shell entirely. Note that `pnpm dev` works on macOS today only because `/var/folders/...` historically has no spaces; this is a latent cross-platform defect.
- **suggested_action:** Either (a) wrap both `tmpFile` interpolations in `escapeShellArg(tmpFile)` after importing from `../utils/shellEscape`, OR (b) switch the two `execAsync` calls to `execFile` (`promisify(execFile)('git', ['commit', '-F', tmpFile], { cwd: session.worktreePath })`). Option (b) is structurally safer and consistent with the spawn-with-args path the TASK-670 "Hardest Decision" section flagged as the preferred long-term direction.
- **resolved_by:** 

## FIND-SPRINT-025-11
- **source:** TASK-670 (code-reviewer)
- **type:** improvement
- **severity:** medium
- **status:** open
- **location:** main/src/ipc/file.ts (git:execute-project handler), main/src/ipc/dashboard.ts (multiple sites), main/src/services/{commitManager,executionTracker,gitDiffManager,gitPlumbingCommands,gitStatusManager,worktreeManager}.ts
- **description:** TASK-670 closes the worst injection surface (`git:execute-project` accepted unfiltered user `args[]`), but a structural opportunity remains: the "Hardest Decision" section of the TASK-670 plan explicitly identifies `spawn('git', args, { cwd })` / `execFile` as the safer model because no shell, no escaping, no possibility of injection. The plan deferred this for `git:execute-project` specifically because of the sync-to-async return-shape rewrite — but the same argument applies repo-wide: ~30 `execSync(\`git ... ${interpolatedValue}\`)` sites across the listed files interpolate `mainBranch`, `remoteName`, `remoteBranch`, `fromCommit`, `toCommit`, `commitHash`, and `worktreePath` into shell templates. Most of these values are git-output-derived (relatively safe — hex SHAs, ref names) BUT `mainBranch` and `remoteName` are user-configured via the project settings UI, and a project configured with a malicious branch name (e.g. `main; touch /tmp/x`) would inherit the same injection class TASK-670 just fixed. The aggregate risk is medium because the attacker needs control of a project settings record (already-privileged context), but the fix is structurally cheap: introduce a `runGit(cwd, args[]): Promise<{stdout, stderr}>` helper that uses `execFile` and migrate the call sites incrementally.
- **suggested_action:** Spawn a follow-up planning task to: (1) add `runGit(cwd, args[], opts?)` and `runGitSync(cwd, args[], opts?)` helpers to `main/src/utils/shellEscape.ts` (or a new `main/src/utils/gitExec.ts`) backed by `child_process.execFile` / `execFileSync`; (2) audit `grep -rn "execSync\`git \\|execAsync\`git " main/src --include='*.ts'` for migration candidates; (3) migrate one file per task to keep diffs reviewable. Prioritize files that interpolate user-configured values (`mainBranch`, `remoteName`) before those that only interpolate git-derived hashes. This is the natural extension of TASK-670 and was explicitly flagged as the preferred long-term direction in the TASK-670 plan's "Hardest Decision" section.
- **resolved_by:** 

## FIND-SPRINT-025-10
- **source:** TASK-669 (code-reviewer)
- **type:** cleanup
- **severity:** low
- **status:** open
- **location:** frontend/src/stores/reviewQueueSlice.ts:281 (pureSetRunStatus)
- **description:** After TASK-669 introduced `pureSetRunStatusAllMaps` to mirror the Zustand action's multi-map eviction, the original single-map `pureSetRunStatus` helper has zero production callers — `grep -rn "pureSetRunStatus\b" frontend` shows only the helper's own export and its test block. The Zustand action and tests for it now exercise the multi-map path; the single-map helper is purely a historical artifact of TASK-502/TASK-668 and risks drift: a future contributor could call `pureSetRunStatus` thinking they are getting full eviction semantics and silently leak `runReasonMap` / `runDetectedAtMap` entries (exactly the bug TASK-669 fixed). The dual export also bloats the file header comment ("Note: this helper operates on `runStatusMap` only. Use `pureSetRunStatusAllMaps` to test multi-map eviction behavior.") with disambiguation that exists only because both helpers ship side-by-side.
- **suggested_action:** Remove `pureSetRunStatus` (lines 281-293) and its 6-case test block (`reviewQueueSlice.test.ts:298-334`), keeping only `pureSetRunStatusAllMaps` as the canonical pure reducer for `setRunStatus`. The "Note:" disambiguation comment on `pureSetRunStatusAllMaps` becomes redundant and can also be trimmed. Minor: while editing, consider porting the "same-reference when no-op" optimization from `pureSetRunStatus` (`if (!(runId in map)) return map`) to the eviction branch of `pureSetRunStatusAllMaps` for consistency, though review-queue cardinality makes the allocation cost negligible.
- **resolved_by:** 

## FIND-SPRINT-025-9
- **source:** TASK-665 (code-reviewer)
- **type:** anti-pattern
- **severity:** medium
- **status:** open
- **location:** main/src/services/streamParser/__tests__/rawEventsSink.test.ts:26-34
- **description:** TASK-665 extracted a canonical `raw_events` DDL into `main/src/orchestrator/__tests__/__fixtures__/rawEvents.ts` to deduplicate the schema across orchestrator tests, but `rawEventsSink.test.ts:26-34` still inlines an identical copy of the same DDL (`CREATE TABLE IF NOT EXISTS raw_events (id, run_id, event_type, payload_json, created_at)` — column-for-column match). The plan's stated objective ("a maintainer changing the raw_events schema in migration 006 has exactly one test fixture to update") is materially overstated: after TASK-665, the raw_events DDL still has FOUR sources of truth — production migration 006, `GATE_SCHEMA` in `database/__test_fixtures__/registrySchema.ts:76-84`, the new orchestrator fixture, and this third in-`__tests__` copy. Migration 006 column changes would have to touch all four. The streamParser test was outside TASK-665's `files_owned` (correctly — scope discipline) but the leftover defeats the dedup goal.
- **suggested_action:** Either (a) import `RAW_EVENTS_DDL` + `makeRawEventsDb` from the new orchestrator fixture into `rawEventsSink.test.ts` (cross-tree import is ugly but de-dups), OR (b) hoist the fixture one level up to `main/src/__test_fixtures__/rawEvents.ts` so both `orchestrator/__tests__/` and `services/streamParser/__tests__/` can import it cleanly, OR (c) absorb the raw_events DDL into the existing `GATE_SCHEMA` constant (it's already there) and reuse `GATE_SCHEMA` everywhere — pick one, then audit `grep -rn "CREATE TABLE.*raw_events" main/` for any further copies.
- **resolved_by:** 

## FIND-SPRINT-025-8
- **source:** TASK-665 (code-reviewer)
- **type:** claude-md
- **severity:** low
- **status:** open
- **location:** docs/CODE-PATTERNS.md:107-118 (shared-fixture section)
- **description:** The new `main/src/orchestrator/__tests__/__fixtures__/rawEvents.ts` fixture is now the third shared orchestrator test fixture (alongside `__test_fixtures__/dbAdapter.ts` and `__test_fixtures__/loggerLikeSpy.ts`), and the other two ARE documented in CODE-PATTERNS.md at lines 107-118 ("Use it for", "Canonical example"). The new fixture has no entry, which means future test authors grepping CODE-PATTERNS.md for "raw_events" or "RAW_EVENTS_DDL" will not find a "don't clone locally" steer and may re-introduce the inline DDL the fixture was created to retire. Additionally, the new fixture uses a different directory naming convention (`__tests__/__fixtures__/` instead of the established `__test_fixtures__/` sibling pattern used in three existing locations: `main/src/__test_fixtures__/tmp.ts`, `main/src/database/__test_fixtures__/registrySchema.ts`, `main/src/orchestrator/__test_fixtures__/{dbAdapter,loggerLikeSpy}.ts`). The plan's "Rejected Alternatives" considered flat layout but did not check for the existing project convention.
- **suggested_action:** Either: (1) Add a CODE-PATTERNS.md entry under "Shared Utilities" mirroring the dbAdapter/loggerLikeSpy entry format (Path / Use it for / Canonical example) and accept the directory-naming divergence as deliberate, OR (2) move the fixture to `main/src/orchestrator/__test_fixtures__/rawEvents.ts` to align with the established convention, then add the CODE-PATTERNS.md entry. Option 2 is preferred — it consolidates with `dbAdapter.ts` and `loggerLikeSpy.ts` in one directory and avoids future "is it __fixtures__ or __test_fixtures__?" cargo-culting.
- **resolved_by:** 

## FIND-SPRINT-025-7
- **source:** TASK-657 (code-reviewer)
- **type:** improvement
- **severity:** low
- **status:** open
- **location:** main/src/ipc/panels.ts:29 (resolveTerminalCwd) and main/src/services/terminalPanelManager.ts:82-91, 249-250, 286
- **description:** After TASK-657 there are now two writers of `customState.cwd`: (1) `panels:initialize` in `main/src/ipc/panels.ts` persists the resolved cwd via `panelManager.updatePanel` before spawning the PTY, and (2) `terminalPanelManager.initializeTerminal` rewrites the same field at lines 82-91 as part of its `{isInitialized, cwd, shellType, dimensions}` block. The plan's "Rejected Alternatives" section explicitly deferred consolidation, noting it would be worthwhile "if a non-IPC code path... needed the same resolution logic — at which point extracting `resolveTerminalCwd` to a shared util would be the move." That third caller is now visible: `terminalPanelManager.restoreTerminalState` (line 286) computes its own `state.cwd || process.cwd()` fallback, and `terminalPanelManager.saveTerminalState` (lines 249-250) does the same `(panel.state.customState && 'cwd' in panel.state.customState) ? panel.state.customState.cwd : undefined` narrowing. Three call sites duplicate the priority/narrowing logic. Extracting `resolveTerminalCwd` + `hasCwdString` to a shared util (e.g. `main/src/services/panels/terminalCwd.ts`) would let all three call sites delegate to one implementation, eliminate the double-write in the new-init path, and remove the inline narrowing at terminalPanelManager:249.
- **suggested_action:** Future task: extract `hasCwdString` + `resolveTerminalCwd` from `main/src/ipc/panels.ts` to a shared util module imported by both `panels.ts` (for `panels:initialize`) and `terminalPanelManager.ts` (for `initializeTerminal`/`restoreTerminalState`/`saveTerminalState`). Have `terminalPanelManager.initializeTerminal` skip its own `customState.cwd` write when the IPC layer has already persisted it, OR collapse the double-write by having the IPC handler only call `initializeTerminal` and letting that be the sole writer (acceptable now that `panels:initialize` always invokes `initializeTerminal` — the "short-circuit at line 31" concern in the plan only applies to re-init paths, where `customState.cwd` is already persisted from the prior init).

## FIND-SPRINT-025-6
- **source:** TASK-653 (code-reviewer)
- **type:** cleanup
- **severity:** low
- **status:** open
- **location:** docs/packaging/root-deps-policy.md:13
- **description:** Stale cross-reference. The "Verified-safe-to-omit packages" section reads `_(none yet — see Dead-dep entries below for pending cleanup)_`, but after TASK-653 the "Dead dependencies in main/package.json" section is now empty (`_(none — see Removed dependencies below)_`). The "see Dead-dep entries below for pending cleanup" pointer no longer resolves to anything actionable.
- **suggested_action:** Update the placeholder to either `_(none yet)_` or redirect to the Removed dependencies section. One-line doc edit.
- **resolved_by:** 

## FIND-SPRINT-025-5
- **source:** TASK-653 (code-reviewer)
- **type:** cleanup
- **severity:** low
- **status:** open
- **location:** main/package.json:24 (and root package.json:62)
- **description:** `dotenv@^16.4.7` is declared as a runtime dependency in both `main/package.json` and root `package.json` but has zero importers in the entire repo (repo-wide grep for `dotenv` across all `.ts/.tsx/.js/.mjs/.cjs` files outside `node_modules` and `pnpm-lock.yaml` returns 0 hits). Same pattern as the just-removed `electron-store` — Crystal-era leftover. Removal candidate.
- **suggested_action:** Repeat the TASK-653 playbook: confirm with `grep -rnE "from ['\"]dotenv['\"]|require\(['\"]dotenv['\"]\)" . --include='*.ts' --include='*.js'` (excluding node_modules), remove from both manifests, refresh lockfile, gate with typecheck/lint/tests, record under `## Removed dependencies` in `docs/packaging/root-deps-policy.md`.
- **resolved_by:** 

## FIND-SPRINT-025-4
- **source:** TASK-653 (code-reviewer)
- **type:** cleanup
- **severity:** low
- **status:** open
- **location:** main/package.json:31
- **description:** `web-streams-polyfill@^3.3.3` is declared as a runtime dependency in `main/package.json` but has zero importers anywhere in the repo (repo-wide grep across all source files returns only the manifest line itself). Same pattern as the just-removed `electron-store` — likely a Crystal-era leftover introduced when the main process needed `ReadableStream`/`WritableStream` polyfills before Node 22 made them globals. Modern Node 22+ (the repo's engine floor) ships WHATWG streams natively, so the polyfill is dead. Removal candidate.
- **suggested_action:** Repeat the TASK-653 playbook: confirm zero importers, remove from `main/package.json`, refresh lockfile, gate with typecheck/lint/tests, record under `## Removed dependencies` in `docs/packaging/root-deps-policy.md`. If a packaged-build smoke test still loads without errors, the removal is safe.
- **resolved_by:** 

## FIND-SPRINT-025-3
- **source:** TASK-653 (verifier)
- **type:** claude-md
- **severity:** low
- **status:** open
- **location:** .soloflow/active/plans/apple-signing-notarization-setup/TASK-653-plan.md
- **description:** AC8 in the TASK-653 plan is internally self-contradictory: AC8a requires `grep -nE '^- \`electron-store' docs/packaging/root-deps-policy.md` to return 0 matches, but implementation step #6 prescribes a new "## Removed dependencies" section whose body starts with `` - `electron-store@^11.0.0` — removed in TASK-653 ... ``. The prescribed body necessarily satisfies the AC8b "removed in TASK-653" grep AND simultaneously fails the AC8a literal grep. The verifier accepted intent (Dead deps section is empty, removal is recorded) but flagging for future plan-author awareness so the acceptance grep matches the prescribed body.
- **suggested_action:** When a plan specifies grep-based ACs that interact with prescribed doc bodies, dry-run the grep against the prescribed text before accepting the plan. Either anchor AC8a to a specific section ("inside ## Dead dependencies in main/package.json the bullet does not appear") or scope the grep so the Removed dependencies entry is excluded.
- **resolved_by:** 

## FIND-SPRINT-025-1
- **type:** bug
- **source:** TASK-653 (executor)
- **severity:** medium
- **status:** open
- **location:** main/src/orchestrator/__tests__/runExecutor.test.ts
- **description:** 4 tests in runExecutor.test.ts fail on both main branch and the TASK-653 worktree (pre-existing, unrelated to electron-store removal). Failures: onLifecycleTransition routes each phase / source arg lifecycleTransitions.running() fires / source absent: bridgeEvents short-circuits / bridge drops output event when panelId has run- prefix. All spy call-count assertions fail. Likely a test isolation issue introduced in a recent sprint.
- **suggested_action:** Investigate spy call count expectations in runExecutor tests — may need to reset spies between subtests or fix the bridgeEvents wiring logic.
- **resolved_by:** 

## FIND-SPRINT-025-2
- **type:** bug
- **source:** TASK-653 (executor)
- **severity:** low
- **status:** open
- **location:** main/src/database/__tests__/cyboflowSchema.test.ts:680
- **description:** 1 test in cyboflowSchema.test.ts fails on both main branch and TASK-653 worktree (pre-existing). Test: 006_cyboflow_schema — workflow_runs reconciler > rebuilds the table when worktree_path is NOT NULL. Asserts that stuck_detected_at column does not exist after reconciler runs, but it still exists. Likely a schema migration reconciler bug.
- **suggested_action:** Investigate the 006 schema reconciler logic for stuck_detected_at orphan column removal.
- **resolved_by:** 

## FIND-SPRINT-025-8
- **source:** TASK-665 (executor)
- **type:** bug
- **severity:** medium
- **status:** open
- **location:** main/src/orchestrator/__tests__/runExecutor.test.ts:626,807,862,1284
- **description:** 4 pre-existing test failures in runExecutor.test.ts unrelated to TASK-665 refactoring. Tests: (1) lifecycle transitions > onLifecycleTransition routes each phase — running() called 2x not 1x; (2) source arg integration > running() fired 2x not 1x; (3) source absent: running() fired 1x when expected 0; (4) panelId/runId alignment: running() fired 1x when expected 0. These failures exist identically in the main branch and appear to be a regression in RunExecutor lifecycle wiring (running() is being called from two code paths). Present before and after this refactor task.
- **suggested_action:** Investigate RunExecutor.onLifecycleTransition — it appears running() is being triggered from both the sdk_initialized phase AND post_spawn or similar, causing double-firing. Check if a recent commit added a redundant lifecycle transition call.
- **resolved_by:** 

## FIND-SPRINT-025-14
- **type:** scope_deviation
- **source:** TASK-667 (executor)
- **severity:** low
- **status:** resolved
- **location:** frontend/src/stores/cyboflowStore.ts
- **description:** H2 confirmed as root cause; moving subscription from RunView useEffect to store-level singleton requires modifying cyboflowStore.ts which was not in files_owned. The plan explicitly describes this as the recommended H2 fix.
- **resolved_by:** verifier — plan-prescribed: Phase 2 step 9 explicitly names `cyboflowStore.ts` as the H2 fix target ("Move the subscription to a Zustand-level singleton. In `cyboflowStore.ts`, on `setActiveRun(runId)`, call `cyboflowApi.subscribeToStreamEvents` ONCE per runId..."). Executor also amended `files_owned` to include the file.

## FIND-SPRINT-025-15
- **type:** scope_deviation
- **source:** TASK-667 (executor)
- **severity:** low
- **status:** resolved
- **location:** frontend/src/components/cyboflow/RunView.tsx
- **description:** H2 confirmed as root cause; RunView.tsx subscription useEffect must be removed and replaced with a no-op since subscription is now in the store. Required to complete the H2 fix.
- **resolved_by:** verifier — plan-prescribed: Phase 2 step 9 names `RunView.tsx` as "subscription-free" once the store singleton is in place ("RunView's useEffect becomes a no-op for subscriptions"). Executor also amended `files_owned` to include the file.

## FIND-SPRINT-025-16
- **type:** scope_deviation
- **source:** TASK-667 (executor)
- **severity:** low
- **status:** resolved
- **location:** frontend/src/components/cyboflow/__tests__/RunView.test.tsx
- **description:** RunView tests must be updated since the subscription was moved from RunView useEffect to the store. Tests that assert subscribe/unsubscribe is called by RunView are no longer valid and need to reflect the new architecture.
- **resolved_by:** verifier — AC-prescribed: AC "All existing runEventBridge.test.ts cases continue to pass; any new tests added for the confirmed hypothesis pass" combined with the Phase 2 step 9 fix requires updating the RunView test surface to match the new no-subscription contract. Executor also amended `files_owned` to include the file.

## FIND-SPRINT-025-18
- **source:** SPRINT-025 (sprint-code-reviewer)
- **type:** bug
- **severity:** high
- **status:** open
- **location:** main/src/events.ts:560
- **description:** `attachProcessLifecycleHandlers` `exit` handler missing the `isCyboflowRunId` guard that TASK-667 added to the matching `spawned` handler at line 506.
- **suggested_action:** Add `if (isCyboflowRunId(panelId) || isCyboflowRunId(sessionId)) return;` as the first line of the `manager.on(exit, ...)` handler at events.ts:560, mirroring the spawned-handler addition at line 510. Add a regression unit test or comment requiring the guard to appear in matched spawn/exit pairs. Consider extracting the spawn+exit handler pair into a `attachProcessLifecycleHandlersForTool(manager, tool, {skipForCyboflow: true})` helper so the guard is applied by construction rather than per-callback.
- **resolved_by:** 



```
manager.on(spawned, async ({ panelId, sessionId }) => {
  if (isCyboflowRunId(panelId) || isCyboflowRunId(sessionId)) return; // line 510 — added by TASK-667
  ...
});

manager.on(exit, async ({ panelId, sessionId, exitCode, signal }) => {
  // NO GUARD — falls through to validatePanelEventContext / sessionManager queries
  // line 560 onward
});
```

When a cyboflow run terminates via the Claude Code manager, this unguarded handler runs `validatePanelEventContext`, `sessionManager.setSessionExitCode`, `sessionManager.updateSession`, `runCommandManager.stopRunCommands`, and `executionTracker.endExecution` against IDs the Crystal `sessions` table never wrote. The matching `claudeCodeManager.on(exit)` at line 937 IS guarded — only `attachProcessLifecycleHandlers` inner pair (506 + 560) is half-applied. The other guarded sites in the file (826, 877, 939, 1089) all apply the protection symmetrically across spawn/exit/output. This is exactly the cross-task drift pattern documented in CODE-PATTERNS.md "Extract-shared-utility refactors: prove completeness".

Suspected tasks: TASK-667

## FIND-SPRINT-025-19
- **source:** SPRINT-025 (sprint-code-reviewer)
- **type:** improvement
- **severity:** medium
- **status:** open
- **location:** frontend/src/components/ProjectView.tsx:176-193, frontend/src/components/SessionView.tsx:250-268
- **description:** `handleAddTerminal` is duplicated near-verbatim across both views — same panelApi sequence, same body shape, differ only by session source and one extra `addToHistory` call.
- **suggested_action:** Extract a `useAddTerminalPanel(session: Session | null, opts?: { addToHistory?: boolean }): () => Promise<void>` hook into `frontend/src/hooks/useAddTerminalPanel.ts` that encapsulates the panelApi.createPanel + addPanel + setActivePanelInStore + panelApi.setActivePanel sequence, and call it from both ProjectView and SessionView. The hook signature should accept a `Session | null` so both callers narrow uniformly; the optional `addToHistory` flag covers the SessionView extension. Pair the extraction with a unit test that catches future shape drift in `panelApi.createPanel({ type: terminal, ... })`. While there, add a CODE-PATTERNS.md entry under "Shared Utilities" so the next contributor finds it before re-cloning.
- **resolved_by:** 


```
// ProjectView.tsx:176-193
const handleAddTerminal = useCallback(async () => {
  if (!mainRepoSessionId || !mainRepoSession) { console.warn(...); return; }
  const newPanel = await panelApi.createPanel({ sessionId: mainRepoSessionId, type: terminal, title: Terminal, initialState: { cwd: mainRepoSession.worktreePath } });
  addPanel(newPanel);
  setActivePanelInStore(mainRepoSessionId, newPanel.id);
  await panelApi.setActivePanel(mainRepoSessionId, newPanel.id);
}, [mainRepoSessionId, mainRepoSession, addPanel, setActivePanelInStore]);

// SessionView.tsx:250-268 — identical except for activeSession source + addToHistory
const handleAddTerminal = useCallback(async () => {
  if (!activeSession) { console.warn(...); return; }
  const newPanel = await panelApi.createPanel({ sessionId: activeSession.id, type: terminal, title: Terminal, initialState: { cwd: activeSession.worktreePath } });
  addPanel(newPanel);
  setActivePanelInStore(activeSession.id, newPanel.id);
  await panelApi.setActivePanel(activeSession.id, newPanel.id);
  addToHistory(activeSession.id, newPanel.id);
}, [activeSession, addPanel, setActivePanelInStore, addToHistory]);
```

The per-task code-reviewer reviews one file at a time and cannot see this. At sprint level the duplication is obvious. If the panelApi shape (`type`, `title`, `initialState.cwd`) ever changes — exactly what TASK-657 just changed at the IPC layer — both call sites must be updated in lockstep or a third future site will diverge. This is the same drift surface CODE-PATTERNS.md warns about for shared utilities.

Suspected tasks: TASK-658

## FIND-SPRINT-025-20
- **source:** SPRINT-025 (sprint-code-reviewer)
- **type:** improvement
- **severity:** medium
- **status:** open
- **location:** frontend/src/components/panels/TerminalPanel.tsx:268-273, main/src/ipc/panels.ts:9-33
- **description:** Two tasks introduced "derive cwd from `panel.state.customState`" logic in the same sprint but neither shared the narrowing helper, and the frontend leg uses an unsafe type assertion that bypasses the pattern TASK-657 carefully established in the backend.

Backend (TASK-657, main/src/ipc/panels.ts:13) — proper type guard:
```
function hasCwdString(state: ToolPanelState[customState]): state is { cwd: string } {
  return typeof state === object && state !== null && cwd in state
    && typeof (state as Record<string, unknown>).cwd === string
    && ((state as Record<string, unknown>).cwd as string).length > 0;
}
```

Frontend (TASK-659, frontend/src/components/panels/TerminalPanel.tsx:270-273) — unsafe cast:
```
const displayCwd =
  (panel.state?.customState as TerminalPanelState | undefined)?.cwd ??
  workingDirectory ??
  ;
```

The cast assertion (`as TerminalPanelState | undefined`) will succeed at compile time for ANY object shape — including future non-terminal panel types whose `customState` happens to have a `cwd` field. If a non-terminal panel is rendered through this component path (or if `customState` is missing `cwd`), the runtime value silently falls through to `workingDirectory` or empty string instead of triggering a type error. The backend pattern would catch the same input and route to the `process.cwd()` fallback explicitly.

FIND-SPRINT-025-7 already flagged the backend triplicate (`panels.ts` + `terminalPanelManager.ts` lines 82-91, 249-250, 286). With TASK-659 the same logic now spreads to the frontend too — four call sites total, none sharing a single source of truth. A `customState.cwd` schema change would have to update all four.

Suspected tasks: TASK-657, TASK-659
- **suggested_action:** Promote `hasCwdString` from `main/src/ipc/panels.ts:13` to `shared/types/panels.ts` (or a new `shared/types/panelCwd.ts`) so both packages import the same narrowing. Update both `main/src/ipc/panels.ts`, `main/src/services/terminalPanelManager.ts` (3 sites — already in FIND-SPRINT-025-7), AND `frontend/src/components/panels/TerminalPanel.tsx:270` to use it. The frontend hook becomes `const displayCwd = hasCwdString(panel.state?.customState) ? panel.state.customState.cwd : workingDirectory ?? ` — eliminating the unsafe assertion. Combine this with FIND-SPRINT-025-7s backend consolidation into one cleanup task.
- **resolved_by:** 
