---
sprint: SPRINT-008
pending_count: 15
last_updated: "2026-05-15T02:10:54.297Z"
---
# Findings Queue

## FIND-SPRINT-008-7
- **source:** TASK-593 (verifier)
- **type:** claude-md
- **severity:** low
- **status:** open
- **location:** .soloflow/active/plans/claude-agent-sdk-migration/TASK-593-plan.md (AC-4 verification command)
- **description:** AC-4's verification command `grep -rn 'completionDetector\|CompletionDetector\|CompletionPayload\|ForcedPayload' main/ shared/ returns 0 matches (exit 1)` walks the build-artifact directory `main/dist/` (gitignored but not excluded from grep). Even though TASK-593 cleanly deletes the source and prunes the barrel, the literal command returns 16+ matches against compiled `.js`/`.d.ts`/`.js.map` artifacts in `main/dist/`. The verifier must manually re-run with `--exclude-dir=dist` to see the true source-tree state. Better convention for plan-authored grep ACs in this repo: include `--exclude-dir=dist --exclude-dir=node_modules` in the command literal, or scope to `main/src shared/` instead of `main/ shared/`. This convention should be added to .soloflow plan-author guidance (or CLAUDE.md) so future deletion-task plans don't trip the verifier on this same false-positive pattern.
- **suggested_action:** Document the `--exclude-dir=dist --exclude-dir=node_modules` (or `main/src` scoping) convention for grep-based AC verification commands in the soloflow plan-author skill / CLAUDE.md.










## Pre-existing findings below

- override: gating-prereqs
  task: TASK-595
  reason: "Prereq probes at sprint-init are checking files that TASK-587/590/591/592/593 will produce within this sprint; TASK-595 depends_on TASK-591 + TASK-594 (DAG enforces ordering), and TASK-595's own plan step 1 re-runs the prereq checks at executor time. Gating now would defeat the sprint's terminal smoke step."
  applied_at: $(date -u +%Y-%m-%dT%H:%M:%SZ)

## FIND-SPRINT-008-1
- **source:** TASK-588 (verifier)
- **type:** bug
- **severity:** high
- **status:** open
- **location:** main package — better-sqlite3 native binding
- **description:** better-sqlite3 prebuilt binary at node_modules/.pnpm/better-sqlite3@11.10.0/.../better_sqlite3.node is built for NODE_MODULE_VERSION 137 but the active Node runtime requires 127. This blocks every vitest case in main/src/orchestrator/__tests__/approvalRouter.test.ts from running (8/8 fail at db construction time). Reproduces identically on `main` pre-commit — pre-existing, not introduced by TASK-588. CLAUDE.md documents the fix (`pnpm electron:rebuild`).
- **suggested_action:** Run `pnpm electron:rebuild` from the repo root. Re-run `cd main && pnpm test -- approvalRouter` to confirm the 8 tests pass with case count preserved.

## FIND-SPRINT-008-2
- **source:** TASK-590 (verifier)
- **type:** improvement
- **severity:** low
- **status:** open
- **location:** main/src/services/panels/claude/claudeCodeManager.ts:372-376
- **description:** `composeMcpServers()` casts the base-project MCP server record to `Record<string, { type?: 'stdio'; command: string; args?: string[] }>`, which is narrower than the SDK's `McpStdioServerConfig` (drops `env`, `alwaysLoad`) and only covers stdio — not SSE/HTTP/SDK variants. Runtime values pass through `Object.assign` untouched, so SSE/HTTP/`env` fields will reach the SDK; the cast is type-only. But the narrowed type makes future maintainers think only stdio servers are accepted, and a future strictly-typed assignment would silently drop `env`. The SDK already exports `McpServerConfig` (union of all variants) — preferable to type the return as `Record<string, McpServerConfig>` and let the SDK validate at the boundary.
- **suggested_action:** Replace the cast on line 375 with `return mcpServers as Record<string, import('@anthropic-ai/claude-agent-sdk').McpServerConfig>;` (or import the type at the top of the file). Update the return-type annotation on line 372 to match. No runtime change.

## FIND-SPRINT-008-3
- **source:** TASK-590 (verifier)
- **type:** improvement
- **severity:** low
- **location:** main/src/services/panels/claude/claudeCodeManager.ts:438-442, 447-453
- **status:** open
- **description:** `killProcess()` short-circuits via `abortCurrentRun()` which returns early (`if (!run) return;`) when no SDK run is active for the panel. The early-return path skips `cleanupCliResources(sessionId)`, so `ApprovalRouter.getInstance().clearPendingForRun(sessionId)` is NOT called when killProcess is invoked on a panel without an active SDK run. The pre-SDK substrate also had this behavior (you could only kill a running process), so this is parity-preserving. However, callers like `restartPanelWithHistory` (line 550-560) call killProcess defensively before spawning — if any path drops a `requestApproval` promise without consuming it, the pending row could leak across the restart. Worth a future review when the approval lifecycle is touched again.
- **suggested_action:** None for v1 — defer until approval-lifecycle gets a dedicated cleanup audit. Note in the EPIC follow-up list.

## FIND-SPRINT-008-4
- **source:** TASK-590 (code-reviewer)
- **type:** anti-pattern
- **severity:** medium
- **status:** resolved
- **location:** main/src/orchestrator/approvalRouter.ts (callsite contract) + main/src/services/cyboflowPermissionIpcServer.ts:73-78 + main/src/services/panels/claude/claudeCodeManager.ts:143,394
- **description:** Two different IDs are passed as `runId` to ApprovalRouter depending on the codepath. The legacy bridge path (`cyboflowPermissionIpcServer.ts`) calls `requestApproval(sessionId, ...)` — runId = Crystal sessionId. The new SDK path (`claudeCodeManager.ts:394`) calls `requestApproval(panelId, ...)` — runId = panelId. Critically, in the same SDK file, `cleanupCliResources(sessionId)` calls `clearPendingForRun(sessionId)` — using a DIFFERENT id from what `requestApproval` was called with. Currently masked because `clearPendingForRun` is a documented stub (no-op), but when TASK-304 implements its full body, the SDK path will fail to clean up pending approvals on run termination because it's looking for entries under `sessionId` while they're indexed by `panelId`. ApprovalRouter's docstring also doesn't pin down which one is canonical, leaving the contract ambiguous for the next consumer.
- **suggested_action:** Pick one canonical convention (panelId, since that matches workflow_runs.id semantics per the @cyboflow-hidden comment), update ApprovalRouter to document it, change `cyboflowPermissionIpcServer.ts` to pass panelId (the IPC bridge will be removed by TASK-580+ but the inconsistency should be fixed first or removed together), and in `claudeCodeManager.ts` change `cleanupCliResources` so it calls `clearPendingForRun(panelId)` not `clearPendingForRun(sessionId)`. Best aligned with TASK-304 (clearPendingForRun implementation) since the convention must be settled before that body is written.
- **resolved_by:** TASK-590

## FIND-SPRINT-008-5
- **type:** cleanup
- **source:** TASK-592 (executor)
- **severity:** low
- **status:** open
- **location:** main/src/ipc/session.ts:34, main/src/services/__tests__/claudeCodeManagerWiring.test.ts:5,268
- **description:** Stale JSDoc/inline comments still name ClaudeStreamParser and JSONParser after those symbols were deleted in TASK-590 and TASK-592. These are comment-only references (no symbol import or usage), so they do not break compilation or tests, but the AC-6 grep (exit 1) fires on them. Both files are outside TASK-592 files_owned (session.ts is files_readonly; claudeCodeManagerWiring.test.ts is unclaimed). A follow-up task should update or remove the stale comment text.
- **suggested_action:** Remove or reword the legacy pipeline descriptions in both files to reflect the SDK-shaped event pipeline introduced in TASK-590.

## FIND-SPRINT-008-6
- **type:** cleanup
- **source:** TASK-591 (executor)
- **severity:** low
- **status:** open
- **location:** main/src/services/cyboflowPermissionBridge.ts
- **description:** cyboflowPermissionBridge.ts is now dead code: TASK-590 removed all callers and TASK-591 deleted the JS build artifact. tsc still emits dist/main/src/services/cyboflowPermissionBridge.js and .d.ts on every build. The file was intentionally left out of TASK-591 scope per the plan. Schedule deletion in a dead-code sweep sprint after TASK-595 confirms SDK substrate is fully operational.
- **suggested_action:** Delete main/src/services/cyboflowPermissionBridge.ts in a follow-up dead-code sweep task. Also remove the glob main/dist/services/**/*.js from asarUnpack if it re-includes bridge outputs, or add a negation entry.

## FIND-SPRINT-008-8
- **source:** SPRINT-008 (sprint-code-reviewer)
- **type:** improvement
- **severity:** medium
- **status:** open
- **location:** main/src/services/streamParser/__tests__/sdkMockFactories.ts (missing factory) + schemas.test.ts (missing test)
- **description:** SystemCompactBoundary SDK shape lacks a mock factory and tests — TASK-589 type/schema added without TASK-594 fixture follow-through.
- **suggested_action:** Add a systemCompactBoundary(overrides) factory to sdkMockFactories.ts modeled on the SystemCompactBoundaryEvent interface (compact_metadata.trigger, compact_metadata.pre_tokens). Add a describe(SystemCompactBoundaryEvent) block in schemas.test.ts that round-trips it through narrower.narrow() and asserts subtype === compact_boundary. Add it to the exhaustive-switch fixtures array so the assertNever tripwire fires if a future migration drops the variant.
- **resolved_by:** 









TASK-589 added SystemCompactBoundaryEvent to the ClaudeStreamEvent union (shared/types/claudeStream.ts:127-136) and systemCompactBoundarySchema to the runtime parser (main/src/services/streamParser/schemas.ts:121-130) — the Claude Agent SDK shape for context-window compaction. TASK-594 then replaced the on-disk JSON fixtures with inline factory functions in sdkMockFactories.ts, but only exported systemCompact() (the legacy CLI shape), not systemCompactBoundary(). As a result schemas.test.ts and typedEventNarrowing.test.ts never exercise the compact_boundary subtype that the SDK actually emits — the variant is in the union and schema solely to keep the type-system honest but is unverified at runtime. The exhaustive-switch fixtures array (schemas.test.ts:373-386) covers compact but not compact_boundary, so a parser regression on the SDK variant would only surface in production.

Suspected tasks: TASK-589, TASK-594

## FIND-SPRINT-008-9
- **source:** SPRINT-008 (sprint-code-reviewer)
- **type:** improvement
- **severity:** medium
- **status:** open
- **location:** main/src/services/streamParser/__tests__/sdkMockFactories.ts + schemas.test.ts
- **description:** resultErrorMaxStructuredOutputRetries factory is missing — TASK-589 added the 5th result subtype but TASK-594 only exports 4 result factories.
- **suggested_action:** Add a resultErrorMaxStructuredOutputRetries(overrides: Partial<ResultEvent>) factory to sdkMockFactories.ts. Add the corresponding `it(...)` block to the ResultEvent describe in schemas.test.ts and a new entry [resultErrorMaxStructuredOutputRetries(), result/error_max_structured_output_retries] to the exhaustive-switch fixtures array.
- **resolved_by:** 








TASK-589 expanded ResultEvent.subtype from 4 to 5 terminal conditions (claudeStream.ts:208) by adding error_max_structured_output_retries (SDK-only). The schema schemas.ts:242 enforces all five via resultUnionSchema (discriminatedUnion). TASK-594s sdkMockFactories.ts exports resultSuccess, resultErrorMaxTurns, resultErrorMaxBudgetUsd, resultErrorDuringExecution — but NOT resultErrorMaxStructuredOutputRetries. schemas.test.ts:192-252 tests each existing factory and the exhaustive-switch fixtures array covers result/success, result/error_max_turns, result/error_max_budget_usd, result/error_during_execution — but not the 5th. The variant is parsed but no round-trip test asserts the subtype literal or is_error contract, so a wire-format regression for the SDKs structured-output-retry exhaustion would silently break the result-handling chain.

Suspected tasks: TASK-589, TASK-594

## FIND-SPRINT-008-10
- **source:** SPRINT-008 (sprint-code-reviewer)
- **type:** improvement
- **severity:** medium
- **status:** open
- **location:** main/src/services/panels/claude/claudeCodeManager.ts:88 + main/src/index.ts:566-579 + main/src/services/cliManagerFactory.ts:178-184 + main/src/services/cyboflowPermissionIpcServer.ts
- **description:** CyboflowPermissionIpcServer is still booted at app launch but its socket path has no consumer in the SDK substrate — TASK-590 replaced the MCP-bridge wiring with an in-process PreToolUse hook but left the entire IPC plumb intact.
- **suggested_action:** In a follow-up dead-code sweep: (1) remove the `permissionIpcPath` ctor parameter from ClaudeCodeManager; (2) remove the additionalOptions wiring in cliManagerFactory.ts:178-184; (3) delete the CyboflowPermissionIpcServer boot block in main/src/index.ts:564-579 and the import; (4) delete main/src/services/cyboflowPermissionIpcServer.ts itself. The deletion can land in the same sweep that removes cyboflowPermissionBridge.ts (FIND-SPRINT-008-6) since both belong to the same MCP-IPC-bridge substrate that TASK-590 retired.
- **resolved_by:** 







ClaudeCodeManager constructor still takes `private permissionIpcPath?: string | null` (claudeCodeManager.ts:88) — the field is set but never read anywhere in the file body (grep returns only the declaration line). CliManagerFactory still threads permissionIpcPath through additionalOptions (cliManagerFactory.ts:178-184). main/src/index.ts:566-579 still instantiates CyboflowPermissionIpcServer, calls start() (which mkdir-s a sockets directory, writes/unlinks a probe file, and net.createServer().listen()), and plumbs the socket path into the manager. The PreToolUse hook (claudeCodeManager.ts:399-438) instead closes over `panelId` directly via ApprovalRouter.getInstance().requestApproval(panelId, ...). No SDK code path reads from or writes to the unix socket; cyboflowPermissionIpcServer.ts and cyboflowPermissionBridge.ts (FIND-SPRINT-008-6 covers the bridge) form a dead-code island that nonetheless consumes a filesystem socket per app launch.

Suspected tasks: TASK-590, TASK-591

## FIND-SPRINT-008-11
- **source:** SPRINT-008 (sprint-code-reviewer)
- **type:** improvement
- **severity:** low
- **status:** open
- **location:** main/src/services/panels/claude/claudeCodeManager.ts:15
- **description:** Unused import `assertTransitionAllowed` from `../../cyboflow/stateMachine` — TASK-590 rewrite carried it over without a body that uses it.
- **suggested_action:** Drop `assertTransitionAllowed` from the import on line 15. Verify tsc --noEmit and ESLint no-unused-vars stay green.
- **resolved_by:** 






Line 15 imports assertTransitionAllowed alongside transitionToAwaitingReview (line 16). transitionToAwaitingReview is used inside the @cyboflow-hidden tryTransitionToAwaitingReview() method (line 712). assertTransitionAllowed is not referenced anywhere in the file body — `grep -c assertTransitionAllowed` returns 1 (the import line only). Likely a leftover from an earlier draft of TASK-590 that explicitly asserted the guard before calling the transition; the final implementation delegates the guard to transitionToAwaitingReview() internally.

Suspected tasks: TASK-590

## FIND-SPRINT-008-12
- **source:** SPRINT-008 (sprint-code-reviewer)
- **type:** improvement
- **severity:** low
- **status:** open
- **location:** main/src/services/panels/claude/claudeCodeManager.ts:389-392 (composeRunEnv)
- **description:** `CYBOFLOW_RUN_ID` env var is set in every Claude run env but has no consumer in the SDK substrate — TASK-590 carried over the env entry from the pre-SDK MCP-bridge era where the bridge subprocess read it.
- **suggested_action:** Drop the CYBOFLOW_RUN_ID entry from composeRunEnv() unless a future external tool (e.g. IDEA-013 shell-hook variant) is expected to consume it. If retention is desired for forward compatibility, replace with a `@cyboflow-hidden` comment explaining the intended future consumer.
- **resolved_by:** 





composeRunEnv() builds `{ ...process.env, CYBOFLOW_RUN_ID: options.panelId, MCP_DEBUG?: 1 }` (claudeCodeManager.ts:386-393). The SDK runs in-process — there is no spawned subprocess that reads env. The PreToolUse hook closes over panelId directly. `grep -rn CYBOFLOW_RUN_ID main/src frontend/src shared` returns exactly one hit: the assignment line above. Setting the env adds zero behavior but signals to future maintainers that some subprocess is reading it; this is misleading.

Suspected tasks: TASK-590

## FIND-SPRINT-008-13
- **source:** SPRINT-008 (sprint-code-reviewer)
- **type:** improvement
- **severity:** low
- **status:** open
- **location:** main/src/services/streamParser/__fixtures__/README.md
- **description:** Stale doc — README describes 11 fixture JSON files that no longer exist (deleted by TASK-594).
- **suggested_action:** Either delete __fixtures__/README.md entirely (and the now-empty __fixtures__ directory) or rewrite it to point at sdkMockFactories.ts as the canonical mock source and document the SDK-version re-capture schedule (against @anthropic-ai/claude-agent-sdk versions, not the claude CLI).
- **resolved_by:** 




TASK-594 migrated parser tests from on-disk fixtures (__fixtures__/*.json) to inline SDK-mock factories (sdkMockFactories.ts), deleting all 11 JSON files. The __fixtures__ directory now contains only README.md. That README still includes a `## Fixture Inventory` table listing system_init.json, system_api_retry.json, system_compact.json, assistant.json, user_string_content.json, user_array_content.json, result_success.json, result_error_max_turns.json, result_error_max_budget_usd.json, result_error_during_execution.json, stream_event.json — none of which exist on disk. The capture command, quarterly re-capture schedule, and CLI-version-recording instructions are also now misleading: the canonical mock source is sdkMockFactories.ts and the re-capture target is the SDKs sdk.d.ts not the CLI wire format.

Suspected tasks: TASK-594

## FIND-SPRINT-008-14
- **source:** SPRINT-008 (sprint-code-reviewer)
- **type:** improvement
- **severity:** low
- **status:** open
- **location:** main/src/services/panels/claude/claudeCodeManager.ts:447-451 (killProcess) vs :312-326 (runSdkQuery finally)
- **description:** `killProcess()` calls cleanupPipeline() BEFORE abortCurrentRun() — events emitted by the in-flight SDK iterator between the cleanup and the abort signal arrival drop silently instead of persisting via RawEventsSink.
- **suggested_action:** Reorder killProcess body to: await abortCurrentRun(panelId) FIRST, then cleanupPipeline(panelId) (which becomes a no-op in the common case because runSdkQuerys finally already cleaned). Alternatively delete the redundant cleanupPipeline call from killProcess and rely on runSdkQuerys finally — simpler and correct since iteratorDone resolves only after finally runs.
- **resolved_by:** 



killProcess body (lines 447-451): cleanupPipeline(panelId) -> abortCurrentRun(panelId) -> processes.delete(panelId). cleanupPipeline calls sink?.dispose(runId) (removes the RawEventsSink listener) and router.clearRun(runId) (removeAllListeners). abortCurrentRun then signals abortController.abort() and awaits run.iteratorDone. The for-await loop in runSdkQuery (line 279) checks abortController.signal.aborted at the TOP of each iteration but the SDK may push additional events into the async iterator before the abort signal propagates. Those events reach `router.emitForRun(runId, event)` (line 288) which then emits to a router with no listeners — silently dropped. RawEventsSink rows for those final events never land. The pre-SDK substrate did not have this race because PTY kill was synchronous and pty-output buffering stopped at OS-signal delivery. Idempotent re-cleanup in the runSdkQuery `finally` block is benign — it just doesnt fix the lost-events window. Persistence loss matters less for normal-completion paths (which run cleanup in the finally AFTER the iterator ends) but creates non-deterministic raw_events row counts for kill-mid-stream sequences (continuePanel:516-522 calls killProcess defensively before re-spawn).

Suspected tasks: TASK-590

## FIND-SPRINT-008-15
- **source:** SPRINT-008 (sprint-code-reviewer)
- **type:** improvement
- **severity:** low
- **status:** open
- **location:** main/package.json:19
- **description:** `@anthropic-ai/claude-code: ^2.0.0` dependency is now unused — TASK-587 added the new `@anthropic-ai/claude-agent-sdk` dep but left the legacy `@anthropic-ai/claude-code` dep in place.
- **suggested_action:** In a follow-up dependency-hygiene task: (1) remove `@anthropic-ai/claude-code: ^2.0.0` from main/package.json; (2) re-run `pnpm install` and `pnpm test` + `pnpm build:main` to confirm nothing regresses; (3) audit whether the readablestream polyfill is still required by @anthropic-ai/claude-agent-sdk on the target Electron Node runtime — if not, also delete main/src/polyfills/readablestream.ts and the main/src/index.ts:2 import.
- **resolved_by:** 


Grep across main/src + frontend/src + shared (excluding dist + node_modules) returns zero matches for `@anthropic-ai/claude-code` other than the package.json line and a stale polyfill README. TASK-590 rewrote claudeCodeManager.ts to use only `@anthropic-ai/claude-agent-sdk`. Leaving the legacy package pinned at ^2.0.0 pulls a ~25MB CLI binary into every install and risks future agents adding `from @anthropic-ai/claude-code` imports thinking theyre consuming the active SDK. The Web-Streams polyfill (main/src/polyfills/readablestream.ts, imported by main/src/index.ts:2) was originally added for the @anthropic-ai/claude-code SDK; whether the SDK migration retired the need is a separate question — see Action.

Suspected tasks: TASK-587, TASK-590

## FIND-SPRINT-008-16
- **source:** SPRINT-008 (sprint-code-reviewer)
- **type:** improvement
- **severity:** low
- **status:** open
- **location:** main/src/services/panels/claude/claudeCodeManager.ts:316 + main/src/orchestrator/approvalRouter.ts:326-333
- **description:** Every Claude run termination logs a `console.warn(clearPendingForRun(...) called — stub, no-op until TASK-304)` line because the SDK substrate calls it unconditionally in runSdkQuerys finally.

claudeCodeManager.ts:316 calls `ApprovalRouter.getInstance().clearPendingForRun(panelId)` in runSdkQuerys finally block — runs on every Claude session end (normal completion, error, abort). approvalRouter.ts:326-333s clearPendingForRun body is a documented stub: `console.warn([ApprovalRouter] clearPendingForRun(${runId}) called — stub, no-op until TASK-304)`. Every Claude session therefore emits one warn line per termination into cyboflow-backend-debug.log and the production log stream. For multi-panel users running many short Claude sessions, this is noisy; more concerning is that the warning gives the impression of an in-flight bug. Two design options: (a) silence the stub by making it a debug-level log until TASK-304 implements the body, or (b) gate the call in claudeCodeManager so it only fires when there are known pending approvals.

Suspected tasks: TASK-588, TASK-590
- **suggested_action:** Either downgrade the stub warning to `this.logger?.verbose(...)`-style in approvalRouter.ts:332 (no behavior change, just quieter logs until TASK-304 implements the body), or in claudeCodeManager.ts:316 only call clearPendingForRun when ApprovalRouter.getPending().some(p => p.runId === panelId). Option (a) is the lower-risk one-line fix.
- **resolved_by:** 
