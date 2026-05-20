---
sprint: SPRINT-023
pending_count: 9
last_updated: "2026-05-20T02:18:01.821Z"
---
# Findings Queue

SPRINT-023 started with missing infra: docker; tests deferred.

## FIND-SPRINT-023-1
- **type:** scope_deviation
- **source:** TASK-622 (executor)
- **severity:** low
- **status:** resolved
- **location:** frontend/src/App.tsx
- **description:** required to meet AC: subscribeToStuckEvents must be mounted at app top-level per plan step 4; App.tsx was files_readonly but is the only valid mount point
- **resolved_by:** verifier — plan-prescribed: Implementation Step 4 explicitly names frontend/src/App.tsx as the mount site and provides the exact useEffect snippet; AC4 verification greps App.tsx for subscribeToStuckEvents

## FIND-SPRINT-023-2
- **type:** scope_deviation
- **source:** TASK-626 (executor)
- **severity:** low
- **status:** resolved
- **resolved_by:** verifier — AC-prescribed: test_strategy targets Sidebar.tsx absence assertions ("Sidebar.tsx no longer renders the 'MCP' label or the bottom indicator block") and the new test file directly verifies the removal mandated by AC4.
- **location:** frontend/src/components/__tests__/Sidebar.mcpHealth.test.tsx
- **description:** File claimed in addition to files_owned. Required to meet AC: Sidebar MCP indicator tests must be removed/updated since the indicator block was deleted from Sidebar.tsx in this task. The test file directly tests the removed MCP dot and would fail otherwise.

## FIND-SPRINT-023-3
- **type:** scope_deviation
- **source:** TASK-622 (executor)
- **severity:** low
- **status:** resolved
- **location:** frontend/src/components/OnboardingCard.test.tsx
- **description:** required to meet AC: test file imports ReviewQueueView which now uses the new PendingApprovalCard path; mock path must be updated to match
- **resolved_by:** verifier — AC-prescribed: AC9 requires existing test suites to still pass; OnboardingCard.test.tsx transitively imports ReviewQueueView and would fail without the mock-path update + trpc mock for the slice's subscription side effect

## FIND-SPRINT-023-4
- **type:** scope_deviation
- **source:** TASK-626 (executor)
- **severity:** low
- **status:** resolved
- **resolved_by:** verifier — AC-prescribed: AC6 mandates "exactly one polling loop... grep returns matches only in mcpHealthStore.ts". The orphaned getMcpHealth() in cyboflowApi.ts would have caused AC6 to fail; removing it satisfies the single-invoke-site requirement.
- **location:** frontend/src/utils/cyboflowApi.ts
- **description:** File claimed to remove getMcpHealth() dead code — the function still contains invoke(cyboflow:mcp-health) which causes AC6 grep to fail. useMcpHealth.ts no longer calls it (polling removed in TASK-626), making getMcpHealth dead code. Removing the export satisfies the single-invoke-site AC.

## FIND-SPRINT-023-5
- **type:** cleanup
- **source:** TASK-623 (verifier)
- **severity:** low
- **status:** open
- **location:** frontend/src/hooks/useStuckNotifications.ts:101
- **description:** Unused eslint-disable directive (react-hooks/exhaustive-deps) — the rule no longer flags this useEffect block. Safe to delete the `// eslint-disable-next-line react-hooks/exhaustive-deps` comment on line 101.
- **suggested_action:** Remove the eslint-disable-next-line comment.

## FIND-SPRINT-023-6
- **source:** TASK-633 (executor)
- **type:** cleanup
- **severity:** low
- **status:** open
- **location:** main/src/services/panels/claude/__tests__/claudeCodeManager.killProcess.test.ts:81, main/src/services/panels/claude/__tests__/claudeCodeManagerWiring.test.ts:76
- **description:** Two claudeCodeManager test files still carry inline function dbAdapter definitions identical to the canonical fixture at __test_fixtures__/dbAdapter.ts. They were not in TASK-633 files_owned and were not counted in the plan pre-flight check. Migrating them to the canonical import would complete the full repo-wide consolidation.
- **suggested_action:** Add these two files to a follow-up task and apply the same canonical import pattern used in TASK-604 / TASK-633.

## FIND-SPRINT-023-7
- **type:** scope_deviation
- **source:** TASK-625 (executor)
- **severity:** low
- **status:** resolved
- **location:** frontend/src/components/OnboardingCard.test.tsx
- **description:** required to meet AC: OnboardingCard.test.tsx mocks useReviewQueueKeyboard without forwarding the onDecide arg. After removing the duplicate window.keydown listener from ReviewQueueView, the y/n dismissal path goes through useReviewQueueKeyboard.onDecide only. The test mock must be updated to capture and invoke onDecide so the y-key-dismisses test still passes.
- **resolved_by:** TASK-625

## FIND-SPRINT-023-8
- **source:** SPRINT-023 (sprint-code-reviewer)
- **type:** improvement
- **severity:** medium
- **status:** open
- **location:** frontend/src/components/PendingApprovalCard.tsx
- **description:** Duplicate PendingApprovalCard files — base variant is now dead code.
- **suggested_action:** Delete frontend/src/components/PendingApprovalCard.tsx and frontend/src/components/__tests__/PendingApprovalCard.test.tsx. Move any unique test cases from the deleted test file into frontend/src/components/ReviewQueue/__tests__/PendingApprovalCard.test.tsx. Update OnboardingCard.test.tsx mock comment that still references the moved path.
- **resolved_by:** 







After TASK-622 swapped ReviewQueueView to import from ./ReviewQueue/PendingApprovalCard (the stuck-aware variant), the original frontend/src/components/PendingApprovalCard.tsx (184 lines) has zero production importers. Only its own test file frontend/src/components/__tests__/PendingApprovalCard.test.tsx (449 lines) imports it. The two cards share an identical CardChrome subcomponent, identical 4 mutation handlers (approve/reject for single + group), and identical layout — the ReviewQueue variant simply adds the stuck-run branch. This is a classic post-fork orphan: TASK-625 also patched the base file (adding onDecide + .catch wiring) to keep the orphan and its tests passing, but no production path executes it. Violates docs/CODE-PATTERNS.md §Extract-shared-utility refactors: prove completeness — TASK-622 moved the canonical path without retiring the old one. Per the convention this is binding, not advisory.

Suspected tasks: TASK-622 (swap), TASK-625 (patched the orphan), TASK-624 (only touched the new variant)

## FIND-SPRINT-023-9
- **source:** SPRINT-023 (sprint-code-reviewer)
- **type:** improvement
- **severity:** medium
- **status:** open
- **location:** frontend/src/hooks/useStuckNotifications.ts:40,112 + frontend/src/stores/reviewQueueSlice.ts:47,193
- **description:** Duplicate StuckEventsClient interface and duplicate onStuckDetected subscription across two App-level mounts.
- **suggested_action:** Extract the shared interface to shared/types/stuckDetection.ts (or a new frontend/src/utils/stuckEventsClient.ts) so both consumers import a single type. For the doubled subscription, either (a) have useStuckNotifications subscribe to the Zustand slice (read runStatusMap diffs and dispatch notifications) instead of opening its own tRPC subscription, or (b) explicitly document why two independent subscriptions are intentional. Option (a) is preferred — it makes the slice the single source of truth for stuck events.
- **resolved_by:** 






TASK-622 (reviewQueueSlice.subscribeToStuckEvents, mounted via App.tsx:89-93) and TASK-623 (useStuckNotifications, mounted via App.tsx:80) each redeclare the same StuckEventsClient interface verbatim:

  interface StuckEventsClient {
    onStuckDetected: {
      subscribe(input: undefined, callbacks: { onData: (event: StuckDetectedEvent) => void; onError: (err: unknown) => void }): { unsubscribe(): void };
    };
  }

Both do the same cast: `trpc.cyboflow.events as unknown as StuckEventsClient`. Both subscribe at App top-level, so every stuck event traverses the IPC bridge twice and triggers two independent observer chains — one writes runStatusMap, the other dispatches macOS notifications. The interface is forward-looking until TASK-254 ships; once it does, both sites still have to be updated in sync. Per-task reviewers could not see this — only the cross-task view shows the duplication and the doubled IPC subscription.

Suspected tasks: TASK-622, TASK-623

## FIND-SPRINT-023-10
- **source:** SPRINT-023 (sprint-code-reviewer)
- **type:** improvement
- **severity:** medium
- **status:** open
- **location:** frontend/src/hooks/useMcpHealth.ts
- **description:** Deprecated useMcpHealth hook has zero production callers — entire file is dead code kept for non-existent backward compatibility.
- **suggested_action:** Delete frontend/src/hooks/useMcpHealth.ts and frontend/src/hooks/__tests__/useMcpHealth.test.tsx. Any future 4-value consumer should call the underlying IPC channel directly per the existing JSDoc note, or read from mcpHealthStore. Also remove the @cyboflow-hidden removal commit b7f5eff change since the file itself can go.
- **resolved_by:** 





TASK-626 removed the Sidebar MCP indicator (the only production consumer of useMcpHealth) and refactored the hook to delegate to mcpHealthStore. The JSDoc at line 9 says it is preserved "as a thin adapter over the store for any remaining 4-value consumers" — but grep across frontend/src shows zero production callers of useMcpHealth(): only the hook itself and its own tests reference it. The adapter also implements a lossy round-trip (UI 3-value status mapped back to a 4-value McpServerHealth shape with restartAttempts hardcoded to 0), which would silently corrupt data if anyone did call it.

Suspected tasks: TASK-626

## FIND-SPRINT-023-11
- **source:** SPRINT-023 (sprint-code-reviewer)
- **type:** improvement
- **severity:** medium
- **status:** open
- **location:** main/src/ipc/file.ts:795-821
- **description:** TASK-628 did NOT migrate the git:execute-project handler to escapeShellArg — leaves ad-hoc shell escaping that the task was meant to retire.
- **suggested_action:** In main/src/ipc/file.ts:795-821, replace the inline arg-mapper with buildSafeCommand('git', ...request.args) from main/src/utils/shellEscape.ts. Audit pattern: grep -rn 'replace(/"/g' main/src to find any other inline shell escapers TASK-628 missed.
- **resolved_by:** 




TASK-628 consolidated commit-footer composition into main/src/utils/commitFooter.ts and routed git/file handlers through appendCommitFooter / buildGitCommitCommand. But the git:execute-project handler in file.ts:795 still inlines its own shell escaper at line 811-816 — it wraps args in double quotes and only escapes the inner double-quote. This double-quote-with-backslash-escape pattern is strictly weaker than escapeShellArg (the canonical single-quote escaper from shellEscape.ts that TASK-628 reaffirmed) — for example, it does not protect against backticks, dollar-paren command substitution, or shell metacharacters in arg values. Per docs/CODE-PATTERNS.md sec Extract-shared-utility refactors: prove completeness, the TASK-628 plan should have grepped for inline escape patterns across main/src and migrated them all.

Suspected tasks: TASK-628

## FIND-SPRINT-023-12
- **source:** SPRINT-023 (sprint-code-reviewer)
- **type:** improvement
- **severity:** low
- **status:** open
- **location:** main/src/orchestrator/cancelAndRestartHandler.ts:124-128
- **description:** WARN-on-every-cancel log added in TASK-627 has no rate limit and no severity gate — every Cancel and restart click logs the same multi-line warning, even though the no-op is by design until TASK-304.
- **suggested_action:** Either (a) downgrade to logger.debug, (b) emit once per ApprovalRouter init and remove the per-invocation log, or (c) gate behind a process.env.CYBOFLOW_DEBUG_APPROVALS flag. The information is already in the button tooltip — production logs do not need a paragraph per cancel.
- **resolved_by:** 



The added logger.warn at line 124 fires unconditionally on every cancelAndRestart invocation and includes a long string about TASK-304 not having landed. Once Cancel and restart becomes a routinely-clicked button this will flood production logs with the same warning per click. The corresponding tooltip on the button (PendingApprovalCard.tsx:181) already communicates the same caveat to the user. A single startup-time log when ApprovalRouter is initialized (or a one-shot per session) would surface the limitation without the per-invocation noise.

Suspected tasks: TASK-627

## FIND-SPRINT-023-13
- **source:** SPRINT-023 (sprint-code-reviewer)
- **type:** improvement
- **severity:** low
- **status:** open
- **location:** frontend/src/stores/reviewQueueSlice.ts:168-182
- **description:** runReasonMap and runDetectedAtMap have no eviction policy — only runStatusMap evicts on terminal status, causing unbounded growth for the new maps over a long session.
- **suggested_action:** Either (a) extend setRunStatus's terminal-eviction branch to also delete the matching runReasonMap and runDetectedAtMap entries, or (b) gate writes on whether the run is still tracked in runStatusMap. The JSDoc claim that the reason 'stays available for diagnostic display even after cancel' should be verified — if no consumer actually reads it post-cancel, evict.
- **resolved_by:** 


TASK-624 added runReasonMap and runDetectedAtMap alongside the existing runStatusMap, but setRunStatus only evicts the status key on terminal transitions (completed/canceled/failed) — see lines 168-182. The two new maps keep their entries indefinitely. The JSDoc at line 80 even calls this out: 'Entries are written alongside runStatusMap but are NOT evicted on terminal status'. Over a long-running session with many stuck-then-canceled runs the maps accumulate dead entries.

Suspected tasks: TASK-624

## FIND-SPRINT-023-14
- **source:** SPRINT-023 (sprint-code-reviewer)
- **type:** improvement
- **severity:** low
- **status:** open
- **location:** main/src/services/terminalSessionManager.ts:48-52 + main/src/services/terminalPanelManager.ts:55-59
- **description:** CYBOFLOW_SESSION_ID + CRYSTAL_SESSION_ID dual-set pattern is inlined in two PTY managers — should live in a shared helper to prevent drift when the deprecation window closes.

TASK-631 added the dual-set in terminalSessionManager.ts:48-52, and the identical pattern already exists in terminalPanelManager.ts:55-59. Both ship the same TODO comment about removing CRYSTAL_SESSION_ID post-v1. When the deprecation window closes, both call sites must be updated in lockstep — a future grep for CRYSTAL_SESSION_ID will surface them, but a tiny shared helper makes the removal a one-line change and prevents one site from drifting (e.g. adding a third name).

Suspected tasks: TASK-631
- **suggested_action:** Extract a helper in a new main/src/utils/cyboflowSessionEnv.ts: export function cyboflowSessionEnvVars(sessionId: string): Record<string, string> { return { CYBOFLOW_SESSION_ID: sessionId, CRYSTAL_SESSION_ID: sessionId }; }. Both managers spread it into their env block. Single deletion site when the deprecation lifts.
- **resolved_by:** 
