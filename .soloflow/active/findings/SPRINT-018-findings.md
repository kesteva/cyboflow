---
sprint: SPRINT-018
pending_count: 4
last_updated: "2026-05-18T20:50:00Z"
---

# Findings Queue

## FIND-SPRINT-018-1
- **source:** TASK-642 (verifier)
- **type:** cleanup
- **severity:** low
- **status:** open
- **location:** main/src/orchestrator/__tests__/runEventBridge.test.ts:22
- **description:** `TypedEventNarrowing` is imported from `../../services/streamParser` but never referenced in the test body. The bridge uses the default-constructed narrowing under the hood, so the test does not need to import it. ESLint flags it as `@typescript-eslint/no-unused-vars` (warning, not error).
- **suggested_action:** Drop `TypedEventNarrowing` from the import; keep only `EventRouter` and `RawEventsSink`.
- **resolved_by:**

## FIND-SPRINT-018-2
- **source:** TASK-642 (verifier)
- **type:** cleanup
- **severity:** low
- **status:** open
- **location:** main/src/orchestrator/__tests__/runEventBridge.test.ts:96-99
- **description:** The `unknownEvent` fixture is declared but never consumed — the malformed-payload test (case 7) emits an inline raw object instead. ESLint flags this as `@typescript-eslint/no-unused-vars` (warning). The fixture is misleading because it shows a pre-built __unknown__ shape that the bridge never produces from the emit path it tests.
- **suggested_action:** Either delete the fixture, or rework case 7 to round-trip it (would need to feed it through `narrowing.narrow` first — probably not worth it; deletion is simpler).
- **resolved_by:**

## FIND-SPRINT-018-3
- **source:** TASK-642 (code-reviewer)
- **type:** anti-pattern
- **severity:** low
- **status:** open
- **location:** main/src/orchestrator/runEventBridge.ts:89-94 + main/src/services/streamParser/rawEventsSink.ts:38-44
- **description:** `deriveEnvelopeType` in runEventBridge.ts is a verbatim duplicate of `deriveEventType` in rawEventsSink.ts — both check `'kind' in event && event.kind === '__unknown__'` and fall back to `event.type`. The mapping from `ClaudeStreamEvent → event_type` is now defined in two places, so a future variant rename (e.g. a third "kind"-tagged catch-all) must be updated in both files or the sink/bridge views diverge silently. TASK-642's files_owned excluded rawEventsSink.ts, so the bridge correctly duplicated the helper rather than editing the sink — this is a cross-task cleanup, not a TASK-642 defect.
- **suggested_action:** Promote a single `deriveEventType(event: ClaudeStreamEvent): string` helper to `main/src/services/streamParser/index.ts` (or a new `derivers.ts`), then have both runEventBridge.ts and rawEventsSink.ts import it. Add a unit test for the helper itself rather than testing the mapping through each call site.
- **resolved_by:**

## FIND-SPRINT-018-4
- **source:** TASK-643 (code-reviewer)
- **type:** anti-pattern
- **severity:** medium
- **status:** open
- **location:** main/src/orchestrator/permissionModeMapper.ts:40-82 + main/src/services/panels/claude/claudeCodeManager.ts:481-519
- **description:** `deferToApprovalRouter` in permissionModeMapper.ts is a near-verbatim duplicate of `ClaudeCodeManager.makePreToolUseHook`: identical try/catch shape, identical allow/deny branches, identical `updatedInput` and `permissionDecisionReason` spreads, identical safe-deny reason string `'Internal approval-router error'`, identical `() => {}` socketReply, identical `'PreToolUse' as const` / `'allow' as const` / `'deny' as const` literals. The only differences are the log-line prefix and the surrounding class vs. module shell. Same drift profile as FIND-SPRINT-018-3 (deriveEnvelopeType): TASK-643's `claudeCodeManager.ts` is in files_readonly, so the mapper correctly duplicated rather than edited the legacy panel — this is a cross-task cleanup, not a TASK-643 defect. Going forward, any change to the SDK's PreToolUseHookOutput contract (e.g. a new `decisionReason` shape, additional metadata field, or richer ApprovalDecision branches) must be applied in BOTH files or the legacy chat-panel path and the new RunExecutor path will silently diverge.
- **suggested_action:** Hoist a shared `routePreToolUseThroughApprovalRouter(pretool, callerId, logger?, callerLabel?): Promise<HookJSONOutput>` helper into `main/src/orchestrator/` (e.g. a new `preToolUseHookHelper.ts`). Have both `permissionModeMapper.deferToApprovalRouter` and `claudeCodeManager.makePreToolUseHook` delegate to it. The `callerLabel` lets each call site keep its own log prefix without re-declaring the body. Verify both pipelines still pass their unit tests after the consolidation. Plan with `claudeCodeManager.ts` in files_owned and `permissionModeMapper.ts` in files_readonly (or both owned), since the consolidation must edit the legacy panel.
- **resolved_by:**
