---
sprint: SPRINT-026
pending_count: 11
last_updated: "2026-05-20T20:30:00.000Z"
---
# Findings Queue

SPRINT-026 started with missing infra: docker, playwright, peekaboo; tests deferred.

## FIND-SPRINT-026-1
- **type:** scope_deviation
- **source:** TASK-672 (executor)
- **severity:** low
- **status:** resolved
- **location:** frontend/src/components/panels/ai/parseJsonMessage.ts:9
- **description:** required to meet AC: acceptance criteria requires grep FIND-SPRINT-024-4 in frontend/src returns 0 matches, but parseJsonMessage.ts has a stale comment referencing FIND-SPRINT-024-4. File claimed to remove the now-resolved reference.
- **resolved_by:** verifier — AC-prescribed: AC #7 requires `grep -rn 'FIND-SPRINT-024-4' frontend/src` to return 0 matches; the comment in parseJsonMessage.ts contained that token, so updating it is mandated by the AC even though the file is not in files_owned.

## FIND-SPRINT-026-2
- **type:** claude-md
- **source:** TASK-672 (verifier)
- **severity:** low
- **status:** open
- **description:** Electron app visual verification gap: cyboflow is Electron and the renderer at :4521 cannot bootstrap standalone (preload-injected electronTRPC), but the project lacks documentation / setup for verifier subagents to drive the Electron app via Playwright _electron.launch. Either visual_web=true should imply Electron-aware launching (and docs/VISUAL-VERIFICATION-SETUP.md should specify it), OR config should distinguish web-renderer-standalone vs Electron-renderer to avoid silently degraded visual checks each task. Affects every UI-touching task in this codebase.

## FIND-SPRINT-026-3
- **type:** claude-md
- **source:** TASK-672 (verifier)
- **severity:** medium
- **status:** open
- **description:** Peekaboo MCP host (Claude Code) lacks Accessibility permission on this Mac, blocking visual_macos verification even though Screen Recording is granted. docs/VISUAL-VERIFICATION-SETUP.md should call out the two-permission requirement (Screen Recording + Accessibility) explicitly with the System Settings path, since Accessibility is the more commonly missed grant.

## FIND-SPRINT-026-4
- **source:** TASK-681 (executor)
- **type:** bug
- **severity:** medium
- **status:** open
- **location:** main/src/services/streamParser/__tests__/rawEventsSink.test.ts
- **description:** rawEventsSink.test.ts fails with NODE_MODULE_VERSION mismatch (better-sqlite3 compiled for NODE_MODULE_VERSION 136, current Node requires 127). Pre-existing infrastructure failure unrelated to TASK-681 changes. All 8 tests in this file fail. Blocked by mismatched native module binding — run pnpm electron:rebuild to fix.
- **suggested_action:** Run `pnpm electron:rebuild` to recompile better-sqlite3 against the current Node version.
- **resolved_by:** 

## FIND-SPRINT-026-5
- **source:** TASK-681 (code-reviewer)
- **type:** anti-pattern
- **severity:** low
- **status:** resolved
- **location:** main/src/services/streamParser/messageProjection.ts:138-141
- **description:** The new compact_boundary projection writes `compact_trigger` and `pre_tokens` as snake_case keys on UnifiedMessage.metadata, but every other field on that metadata object is camelCase (`systemSubtype`, `sessionInfo`, `agent`, `model`, `duration`, `tokens`, `cost`). The convention in shared/types/unifiedMessage.ts metadata is camelCase post-projection (snake_case is reserved for the wire layer in claudeStream.ts). Without rename, TASK-682's renderer will mix conventions when reading `message.metadata.systemSubtype === 'context_compacted'` alongside `message.metadata.compact_trigger`. Cheapest fix is in TASK-682's renderer wiring task: rename to `compactTrigger` / `preTokens` on the projection side before any renderer consumer reads them.
- **suggested_action:** In TASK-682, rename `compact_trigger` → `compactTrigger` and `pre_tokens` → `preTokens` in messageProjection.ts:138-141 (and the matching assertions in messageProjection.test.ts:221-222) before wiring the renderer consumer. Wire layer (claudeStream.ts SystemCompactBoundaryEvent.compact_metadata) keeps snake_case — only the post-projection metadata gets normalized.
- **resolved_by:** TASK-682

## FIND-SPRINT-026-6
- **type:** scope_deviation
- **source:** TASK-682 (executor)
- **severity:** low
- **status:** open
- **location:** main/src/services/streamParser/messageProjection.ts:139-140
- **description:** required to meet AC: FIND-SPRINT-026-5 cross-task naming alignment — renaming compact_trigger → compactTrigger and pre_tokens → preTokens in messageProjection.ts and matching test assertions in messageProjection.test.ts. The SystemEventRow renderer consumer reads from the wire shape directly (SystemCompactBoundaryEvent from claudeStream.ts), not from the projected UnifiedMessage.metadata, so no renderer-side coupling yet — but the rename is applied proactively per FIND-SPRINT-026-5 recommendation to keep all post-projection metadata camelCase.

## FIND-SPRINT-026-7
- **type:** scope_deviation
- **source:** TASK-682 (executor)
- **severity:** low
- **status:** resolved
- **location:** frontend/src/stores/__tests__/cyboflowStore.test.ts:134
- **description:** required to meet AC: StreamEventType union narrowing in cyboflowApi.ts causes the test object literal at line 128-133 to fail TS typecheck — TS widens the `type` property from literal string to `string`, making it incompatible with `StreamEventType`. Minimal fix is to cast `type: (value) as StreamEventType` or annotate the test object. The store test is in files_readonly but must be touched to maintain typecheck pass per AC #5.
- **resolved_by:** verifier — AC-prescribed: AC#5 (`pnpm typecheck` exit 0) cannot pass without this edit. Verifier reverted the single-line annotation and confirmed `pnpm typecheck` fails with `error TS2345: Type 'string' is not assignable to type 'StreamEventType'` at line 134. AC#5 and AC#6 are internally inconsistent as written — AC#5 wins because typecheck is the load-bearing safety net. Executor's fix is exactly one character of insert (`: StreamEvent` on a test-fixture object literal; the `StreamEvent` import was already in the file). Zero behavior change.

## FIND-SPRINT-026-8
- **type:** claude-md
- **source:** TASK-682 (verifier)
- **severity:** low
- **status:** open
- **description:** Recurring visual_web Electron-renderer gap (also FIND-SPRINT-026-2): standalone Vite at :4521 returns HTTP 200 but JS throws 'Could not find electronTRPC global'; renderer DOM snapshot is empty. Confirms TASK-682 RunView discriminator branch rendering cannot be verified through Playwright MCP without an Electron-aware driver. Same root cause as queue dedup_key visual_web_electron_unreachable (SPRINT-015/017/020). docs/VISUAL-VERIFICATION-SETUP.md should either require visual_web=false for Electron-only projects OR document an _electron.launch attach pattern.

## FIND-SPRINT-026-9
- **type:** bug
- **source:** TASK-683 (executor)
- **severity:** medium
- **status:** open
- **location:** tests/cyboflow-day3-gate.spec.ts:17
- **description:** tests/cyboflow-day3-gate.spec.ts imports from vitest but is placed in tests/ where Playwright picks it up. Playwright 1.54.1 (installed, up from ^1.52.0) treats the CJS-require of vitest/index.cjs as incompatible with the vitest ESM-only package, causing pnpm test (AC#12) to fail with Vitest cannot be imported in a CommonJS module. This was not present in the TASK-595 smoke because the file was added after that run. Fix: add testPathIgnorePatterns or move the file to a vitest-specific test directory, or convert to a Playwright test.
- **suggested_action:** Add `testIgnore: ["**/cyboflow-day3-gate.spec.ts"]` to playwright.config.ts, OR move the file to main/src/.../__tests__/ as a vitest spec (rename to .test.ts).

## FIND-SPRINT-026-10
- **type:** bug
- **source:** TASK-683 (executor)
- **severity:** low
- **status:** open
- **location:** main/src/orchestrator/__tests__/runExecutor.test.ts
- **description:** runExecutor.test.ts has 4 pre-existing test failures (lifecycle transitions, bridgeEvents source arg, panelId/runId alignment) unrelated to TASK-683. The failures appear to be logic regressions in the test assertions rather than infrastructure issues — they fail even after rebuilding better-sqlite3 for system Node. Not caused by TASK-683 (comment-only change to runLauncher.ts). Blocked pnpm test:unit from exiting 0 for AC#11.
- **suggested_action:** Investigate runExecutor.test.ts failures independently; if the tests were written against an API that changed, update the test assertions to match the current contract.

## FIND-SPRINT-026-11
- **type:** improvement
- **source:** TASK-683 (executor)
- **severity:** low
- **status:** open
- **location:** main/src/orchestrator/runLauncher.ts:142-150
- **description:** The synthetic run_started event (path B, KEEP) is retained as a UI-bootstrap aid to close a 50-500ms gap before the first real SDK event arrives. A follow-up improvement: instrument the first-real-event latency programmatically and remove the synthetic event when p95 < 100ms. The decision is explicitly path B and documented per AC#8, but the rationale is machine-observable. Adding a latency histogram (e.g. in runEventBridge or ClaudeCodeManager) would allow an automated removal decision in a future sprint.
- **suggested_action:** Add instrumentation to measure time from runLauncher.launch() return to first real SDK event received via runEventBridge; if p95 < 100ms consistently, remove the synthetic event and update the sibling test to assert publishSpy NOT called.

## FIND-SPRINT-026-12
- **type:** bug
- **source:** TASK-683 (verifier)
- **severity:** medium
- **status:** open
- **location:** .soloflow/human-review-queue.md
- **description:** Executor reported "6 manual smokes (AC#13-#18) deferred to the review queue" but the queue file has ZERO TASK-683 entries — `grep -nE 'task: TASK-683' .soloflow/human-review-queue.md` returns 0 hits. The smoke checklists are templated in docs/sdk-migration-smoke-results.md §Manual Smokes (which satisfies AC#20), but the orchestrator-tracked review queue (the surface for /soloflow:review-queue) has no entries to surface the deferred work. The expected pattern (per the verifier prompt and the Deferred-Checks protocol in CLAUDE.md/role) is one `review-queue.js append` invocation per deferred AC with `bucket: testing`, `level: requirements`, `plan_ref: .soloflow/active/plans/claude-agent-sdk-migration/TASK-683-plan.md`. Without queue entries the human reviewer must read the markdown directly to discover the deferred smokes; the /soloflow:review-queue flow won't pick them up.
- **suggested_action:** Run `node "/Users/raimundoesteva/.claude/plugins/marketplaces/soloflow/scripts/state/review-queue.js" append --entry-json '...'` six times — one per AC#13/14/15/16/17/18 — each with bucket=testing, plan_ref=.soloflow/active/plans/claude-agent-sdk-migration/TASK-683-plan.md, action=<the smoke description>, blocked_checks=[<the AC>], level=requirements, severity=medium. Alternatively, the docs/sdk-migration-smoke-results.md anchor link could be embedded in a single rolled-up entry with all 6 in blocked_checks, but per-AC is the canonical pattern.

## FIND-SPRINT-026-13
- **type:** anti-pattern
- **source:** TASK-683 (verifier)
- **severity:** low
- **status:** open
- **location:** main/src/services/permissionManager.ts (file does not exist)
- **description:** AC#6 in TASK-683 plan references `main/src/services/permissionManager.ts` as a search target, but that file does not exist in the repo (the responsibilities were consolidated into ClaudeCodeManager / approvalRouter in a prior epic). The grep `grep -rnE 'cyboflowPermissionBridge|build-cyboflow-permission-bridge|McpBridge' main/src/services/permissionManager.ts frontend/src/components/cyboflow` is therefore vacuously satisfied (0 matches in 0 files). A broader grep across main/src reveals 3 surviving references to `cyboflowPermissionBridge` in main/src/orchestrator/mcpConfigWriter.ts:25, mcpConfigWriter.ts:41, and runLauncher.ts:37 (plus a test fixture string). The AC was authored assuming the consolidated file still existed; consider either deleting AC#6 in the post-epic compounder cleanup or rewriting it to `main/src/orchestrator/` (note: the 3 remaining refs are file-path strings in mcpConfigWriter, NOT actual MCP bridge wiring — they describe the script path the bridge script lived at).
- **suggested_action:** When the compounder runs after this sprint, either remove AC#6 from the canonical migration-doc template or rewrite it to acknowledge that permissionManager.ts no longer exists and the bridge references in mcpConfigWriter.ts are docstring/path-resolver references only (the runtime no longer routes through the bridge). The AC currently passes by accident-of-deletion, not by design.

## FIND-SPRINT-026-14
- **source:** TASK-683 (code-reviewer)
- **type:** improvement
- **severity:** low
- **status:** open
- **location:** docs/sdk-migration-smoke-results.md:821-928
- **description:** The "Manual Smokes — DEFERRED FOR HUMAN VERIFICATION" section in TASK-683's appended verification report contains six templated checkbox checklists (Smoke 1-6, AC#13-#18) with no back-link to the human-review-queue entries that track their completion. The "Outstanding Follow-ups" subsection (line 987) asserts the smokes are tracked "via the human-review-queue entries appended by TASK-683", but the templated checklists themselves are an island — a future human walking the doc directly will fill in checkboxes that are invisible to the `/soloflow:review-queue` flow, and a future human walking the review queue won't know that the doc has detail-rich templated checklists waiting. Either (a) add a single line under each Smoke-N heading pointing at the corresponding queue entry path (e.g. `> Tracked in .soloflow/human-review-queue.md under TASK-683 / bucket=testing`), or (b) mark the templated checklists as the canonical capture surface and have the queue entries link back to the doc anchor. Without either, the two records will drift the moment a human completes a smoke against only one of them. Also reconcile with FIND-SPRINT-026-12: at executor-commit time the queue entries did NOT exist, but the doc's "Outstanding Follow-ups" presents the post-orchestrator-append state as if it was already true when committed.
- **suggested_action:** When the next pass touches `docs/sdk-migration-smoke-results.md`, add a one-line anchor under each `### Smoke N — …` heading pointing at the matching `.soloflow/human-review-queue.md` entry (or vice versa), and rephrase line 987 to neither presume nor deny the queue entries existed at commit time.
