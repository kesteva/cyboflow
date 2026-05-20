---
sprint: SPRINT-025
pending_count: 7
last_updated: "2026-05-20T15:30:00.000Z"
---
# Findings Queue

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
