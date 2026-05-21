---
sprint: SPRINT-027
pending_count: 4
last_updated: "2026-05-21T01:18:30.028Z"
---
# Findings Queue

SoloFlow workflow defect: duplicate plan IDs exist for TASK-684 (claude-agent-sdk-migration + crystal-cuts-and-rebrand), TASK-685 (same epics), TASK-686 (cyboflow-shell-architecture + testing-infrastructure), TASK-687 (same epics). Excluded from this sprint to prevent state corruption. Needs deduplication via /soloflow:planner or manual review of .soloflow/active/plans/.
SPRINT-027 started with missing infra: playwright (stale shadows), peekaboo (CLI missing + stale shadows); visual_web and visual_macos checks deferred to `skipped_unable`.

## FIND-SPRINT-027-1
- **source:** TASK-673 (executor)
- **type:** bug
- **severity:** medium
- **status:** resolved
- **location:** main/src/database/__tests__/cyboflowSchema.test.ts:680
- **description:** Pre-existing test failure: cyboflowSchema.test.ts asserts stuck_detected_at column should not exist after reconciler runs, but the column persists. Test assertion: expect(cols.some(c => c.name === stuck_detected_at)).toBe(false) fails. Unrelated to TASK-673 changes.
- **suggested_action:** Investigate schema reconciler for workflow_runs table — stuck_detected_at orphan column removal may not be executing in test environment.
- **resolved_by:** TASK-675

## FIND-SPRINT-027-2
- **source:** TASK-673 (executor)
- **type:** bug
- **severity:** low
- **status:** open
- **location:** main/src/services/panels/claude/__tests__/claudeCodeManager.killProcess.test.ts
- **description:** Pre-existing test failure: killProcess mid-stream test times out at 5000ms. Test: killProcess mid-stream clears pipelines, sdkRuns, and processes maps. Unrelated to TASK-673 changes.
- **suggested_action:** Investigate ClaudeCodeManager.killProcess test — likely needs a longer timeout or a mock that resolves faster.
- **resolved_by:** 



SoloFlow workflow defect: TASK-674 (SPRINT-025-compounder) was a duplicate of TASK-671 (SPRINT-024-compound) — both targeted the same 4 stale assertions in runExecutor.test.ts. Acceptance met by a5f0a83. Compound's task-extraction step should deduplicate against open backlog tasks targeting the same files/symbols.

## FIND-SPRINT-027-3
- **source:** TASK-676 (executor)
- **type:** bug
- **severity:** low
- **status:** open
- **location:** main/src/services/panels/claude/__tests__/claudeCodeManager.killProcess.test.ts
- **description:** killProcess mid-stream test intermittently times out at 5000ms when running the full suite. The test passed when isolated but timed out during the full suite run. This is outside TASK-676 scope but surfaced during the required full-suite run in step 8.
- **suggested_action:** Investigate whether killProcess relies on a real timer/process that needs mocking, or increase the test timeout. Running the test file in isolation passes. NOTE (verifier): duplicate of FIND-SPRINT-027-2 — both describe the same pre-existing killProcess timeout. Compounder should merge or close one when resolved.
- **resolved_by:** 

## FIND-SPRINT-027-4
- **source:** TASK-676 (verifier)
- **type:** improvement
- **severity:** low
- **status:** open
- **location:** main/src/database/__test_fixtures__/registrySchema.ts:76
- **description:** With TASK-676 consolidating the orchestrator-side raw_events fixture, the registry-side `registrySchema.ts` still inlines its own copy of the raw_events DDL (as part of GATE_SCHEMA). The two now describe the same table from two different fixture trees. Not a defect today — they're scoped to different test suites — but the next contributor to add a column to raw_events has to remember to update both files plus the production migration. Worth considering a shared root-level constant or having GATE_SCHEMA import RAW_EVENTS_DDL from the orchestrator fixture.
- **suggested_action:** Either (a) re-export `RAW_EVENTS_DDL` from `main/src/orchestrator/__test_fixtures__/rawEvents.ts` and have `registrySchema.ts` concatenate it into GATE_SCHEMA, or (b) leave as-is and add an inline comment in both fixtures pointing at each other. Defer to next compounder pass.
- **resolved_by:** 

## FIND-SPRINT-027-5
- **source:** TASK-677 (verifier)
- **type:** claude-md
- **severity:** low
- **status:** open
- **description:** verification.visual_web=true but the Playwright MCP target (http://localhost:4521) has stale shadows: dev server not running and Electron preload electronTRPC is unreachable. TerminalPanel.tsx displayCwd render path could not be exercised in this verifier run. Already escalated under dedup_key visual_web_electron_unreachable. CLAUDE.md / VISUAL-VERIFICATION-SETUP.md should call out that visual_web with playwright_target.kind=electron requires either (a) a live `pnpm dev` server, (b) a Playwright-Electron CDP attach launcher, or (c) visual_web=false.
