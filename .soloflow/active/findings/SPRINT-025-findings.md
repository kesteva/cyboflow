---
sprint: SPRINT-025
pending_count: 10
last_updated: "2026-05-20T14:30:00.000Z"
---
# Findings Queue

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
