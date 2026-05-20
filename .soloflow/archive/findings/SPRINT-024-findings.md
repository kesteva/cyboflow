---
sprint: SPRINT-024
pending_count: 11
last_updated: "2026-05-20T06:48:18.111Z"
---
# Findings Queue

## FIND-SPRINT-024-1
- **source:** TASK-634 (executor)
- **type:** bug
- **severity:** medium
- **status:** open
- **location:** main/src/orchestrator/__tests__/runExecutor.test.ts:635,816,871,1310
- **description:** 4 pre-existing test failures in runExecutor.test.ts: lifecycle-transition spy called-once assertions fail (got 2 calls), bridgeEvents short-circuit not-called assertion fails. Not related to TASK-634 changes — failures present on the branch before this task.
- **suggested_action:** Investigate runExecutor or its mocks for state bleeding between tests (spy not being reset); may need a clearAllMocks in beforeEach.
- **resolved_by:** 

## FIND-SPRINT-024-2
- **source:** TASK-634 (executor)
- **type:** bug
- **severity:** medium
- **status:** open
- **location:** main/src/database/__tests__/cyboflowSchema.test.ts:680
- **description:** Pre-existing test failure: rebuilds the table when worktree_path is NOT NULL or stuck_detected_at orphan column exists — assertion `expect(cols.some((c) => c.name === stuck_detected_at)).toBe(false)` fails (column still present after rebuild). Not caused by TASK-634 changes.
- **suggested_action:** Investigate the schema migration / reconciler that should drop stuck_detected_at; the rebuild path may not be removing it.
- **resolved_by:** 

## FIND-SPRINT-024-3
- **source:** TASK-634 (code-reviewer)
- **type:** cleanup
- **severity:** low
- **status:** open
- **location:** main/src/orchestrator/__tests__/workflowRegistry.test.ts:20-21
- **description:** Duplicate import of the `path` module — line 20 has `import { join } from 'path'` and line 21 has `import * as path from 'path'`. Both are used (line 20's `join` 17 times; namespace `path.relative` and `path.join` on lines 572,578). Predates TASK-634 (already present in 5c08a56^) but the executor touched this import block while removing `mkdtempSync` and `tmpdir`, and had the opportunity to collapse to a single namespace import.
- **suggested_action:** Collapse to a single `import * as path from 'path'` and rewrite the 17 `join(...)` callsites to `path.join(...)`, OR drop the namespace import and inline `path.relative` as `relative` from `'path'` alongside `join`. Optional — both imports work and the dual-import idiom is not strictly broken.
- **resolved_by:** 

## FIND-SPRINT-024-4
- **source:** TASK-637 (code-reviewer)
- **type:** anti-pattern
- **severity:** high
- **status:** open
- **location:** frontend/src/types/electron.d.ts:86,317 and frontend/src/utils/api.ts:90,520
- **description:** The IPC declaration `getJsonMessages: (panelId: string) => Promise<IPCResponse<ClaudeJsonMessage[]>>` is stale. At runtime the `panels:get-json-messages` handler in `main/src/ipc/session.ts:937` returns `UnifiedMessage[]` (built by `projectStoredOutputs` → `MessageProjection`). The two shapes are incompatible: `ClaudeJsonMessage` has `type`/`message`/`data`/etc.; `UnifiedMessage` has `role`/`segments`/`metadata`. This type lie is what forced the original `as unknown as JSONMessage[]` and `as unknown as UserPromptMessage[]` double-casts in MessagesView/RichOutputView, and it caused TASK-637's adapter refactor to introduce a runtime regression (parseJsonMessage was designed against ClaudeJsonMessage but receives UnifiedMessage in practice). The same mismatch applies to the legacy `sessions:get-json-messages` handler.
- **suggested_action:** Change both `getJsonMessages` IPC type declarations from `IPCResponse<ClaudeJsonMessage[]>` to `IPCResponse<UnifiedMessage[]>` (import from `shared/types/unifiedMessage`). Then redesign `parseJsonMessage` against the real UnifiedMessage shape (discriminate on `role` + `metadata.systemSubtype`, not `type`/`message`/`data`). The simpler immediate fix is to drop the parseJsonMessage adapter entirely and feed `outputResponse.data` straight into `messageTransformer.transform()` (which is a passthrough cast to `UnifiedMessage[]`).
- **resolved_by:** 

## FIND-SPRINT-024-5
- **source:** TASK-637 (verifier)
- **type:** bug
- **severity:** medium
- **status:** open
- **location:** frontend/src/components/panels/ai/MessagesView.tsx:39-49
- **description:** The fix commit bb926cd hard-codes `setSessionInfo(null)` in the initial-load path of MessagesView.tsx, dropping session_info detection from `panels:get-json-messages` payload. In practice this preserves pre-existing behavior (the prior baseline code's `'type' in msgData && msgData.type === 'session_info'` check was already dead against UnifiedMessage shape because UnifiedMessage uses `role` not `type`, so foundSessionInfo never matched), so this is NOT a user-visible regression on the load path. However, the realtime `session:output` handler (lines 67-119) still has session_info detection logic that may also be dead/stale against current message shapes — its `parsedData.type === 'session_info'` check looks for a Crystal-era shape that may not be emitted by the current Electron app. Worth verifying whether the MessagesView Session Information card has ever rendered post-UnifiedMessage migration, or whether the entire feature should be reworked to drive off UnifiedMessage metadata.systemSubtype === 'init' like RichOutputView does (line 764).
- **suggested_action:** When FIND-SPRINT-024-4 is addressed (correcting the IPC type to UnifiedMessage), also redesign MessagesView's Session Information card to read from the system init UnifiedMessage (`role === 'system' && metadata.systemSubtype === 'init'` carries `metadata.sessionInfo`). Keep the current `setSessionInfo(null)` hard-code as a TODO until the rework lands.
- **resolved_by:** 

## FIND-SPRINT-024-6
- **type:** scope_deviation
- **source:** TASK-646 (executor)
- **severity:** low
- **status:** resolved
- **location:** main/src/orchestrator/__tests__/runExecutor.test.ts
- **description:** required to meet AC: sweep-grep gate AC requires all orchestrator test files to use shared fixture; runExecutor.test.ts has a local makeLogger() that would violate the completeness gate. Claimed to migrate it alongside the other 6 identified files.
- **resolved_by:** verifier — plan-prescribed: Implementation Step 1 ("Add any missed sites to files_owned") + AC-prescribed: sweep-grep gate AC4 would fail without this migration

## FIND-SPRINT-024-7
- **type:** scope_deviation
- **source:** TASK-646 (executor)
- **severity:** low
- **status:** resolved
- **location:** main/src/orchestrator/__tests__/preToolUseHookHelper.test.ts
- **description:** required to meet AC: sweep-grep gate AC requires all orchestrator test files to use shared fixture; preToolUseHookHelper.test.ts has a local makeLogger() that would violate the completeness gate. Claimed to migrate it alongside the other 6 identified files.
- **resolved_by:** verifier — plan-prescribed: Implementation Step 1 ("Add any missed sites to files_owned") + AC-prescribed: sweep-grep gate AC4 would fail without this migration

## FIND-SPRINT-024-9
- **source:** TASK-649 (code-reviewer)
- **type:** cleanup
- **severity:** low
- **status:** open
- **location:** main/src/services/panels/claude/__tests__/claudeCodeManagerWiring.test.ts:314-319
- **description:** The warn assertion uses a less idiomatic pattern than the sibling test for the same code path. Current form: `expect(logger.warn).toHaveBeenCalled()` followed by `const warn = logger.warn as unknown as import('vitest').MockInstance; expect(warn.mock.calls[0][0]).toContain('[rawEventsSink]')`. The sibling test at `main/src/services/streamParser/__tests__/rawEventsSink.test.ts:225-231` exercises the identical fail-soft path and expresses the assertion as `expect(mockLogger.warn).toHaveBeenCalledWith(expect.stringContaining('[rawEventsSink] insert failed for runId='))` — no inline `import('vitest')` cast, no manual mock-array indexing, and it asserts the full call shape rather than a substring of the first positional arg.
- **suggested_action:** Replace lines 313-319 with two `expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining(...))` assertions mirroring the sibling test. Removes the `as unknown as MockInstance` cast and the inline `import('vitest')` type import.
- **resolved_by:** 

## FIND-SPRINT-024-8
- **type:** scope_deviation
- **source:** TASK-647 (executor)
- **severity:** low
- **status:** resolved
- **location:** main/src/services/panels/claude/__tests__/claudeCodeManager.killProcess.test.ts
- **description:** required to meet AC: this test file uses ClaudeCodeManager.setSharedDb() in beforeEach/afterEach and new ClaudeCodeManager() without db arg. Removing the static injector (AC-1) makes these calls compile errors. File must be updated to pass db as 5th constructor arg and remove setSharedDb calls.
- **resolved_by:** TASK-647

## FIND-SPRINT-024-10
- **source:** SPRINT-024 (sprint-code-reviewer)
- **type:** improvement
- **severity:** medium
- **status:** open
- **location:** main/src/services/panels/claude/__tests__/claudeCodeManagerWiring.test.ts:30-43
- **description:** Cross-task duplicate logger-spy factory — TASK-646 introduced the canonical shared makeSpyLogger() fixture at main/src/orchestrator/__test_fixtures__/loggerLikeSpy.ts and migrated 8 orchestrator/IPC test files to use it. One commit later in the same sprint, TASK-649 added a separate local makeLoggerSpy() factory inside claudeCodeManagerWiring.test.ts (lines 30-43) instead of reusing the shared fixture. Both factories serve the same purpose (vi.fn() spies for warn/info). The shapes differ (LoggerLike with info/warn/error/debug vs Pick<Logger, warn|info|verbose>), but the wiring test only actually asserts on .warn, which both shapes provide.
- **suggested_action:** Either (a) import { makeSpyLogger } from "../../../../orchestrator/__test_fixtures__/loggerLikeSpy" and use it directly — the LoggerLike shape it returns is assignable to Pick<Logger, warn|info> because the production Logger class implements info/warn/error/debug; or (b) move the wiring test fixture into the shared loggerLikeSpy.ts module as a second exported variant (e.g. makeProdLoggerSpy()) and reference it from the wiring test. Option (a) is simpler — the verbose method is unused at the call site so the type cast `logger as unknown as Logger` already used in the file would still apply.
- **resolved_by:** 





Suspected tasks: TASK-646, TASK-649

## FIND-SPRINT-024-11
- **source:** SPRINT-024 (sprint-code-reviewer)
- **type:** improvement
- **severity:** low
- **status:** open
- **location:** main/src/services/cliManagerFactory.ts:177
- **description:** Inline `import("better-sqlite3").Database` type cast — TASK-647 introduced `const db = options?.db as import("better-sqlite3").Database | undefined;` to thread the database handle through the factory. The file already imports concrete classes from `./panels/claude/claudeCodeManager` (which itself does `import type Database from "better-sqlite3"` at line 9). An inline `import(...)` type cast in body code is harder to read than a top-of-file `import type Database from "better-sqlite3"`. The pattern also bypasses any structural validation — only a truthy check happens at runtime.
- **suggested_action:** Add `import type Database from "better-sqlite3";` at the top of cliManagerFactory.ts (mirroring claudeCodeManager.ts line 9), then rewrite line 177 as `const db = options?.db as Database | undefined;`. Strictly cosmetic — the runtime behavior is identical.
- **resolved_by:** 




Suspected tasks: TASK-647

## FIND-SPRINT-024-12
- **source:** SPRINT-024 (sprint-code-reviewer)
- **type:** improvement
- **severity:** low
- **status:** open
- **location:** package.json:55-56
- **description:** test:unit duplicates the verify-schema-parity invocation rather than reusing the dedicated `verify:schema` script. Current state (TASK-639):
- **suggested_action:** Change the `test:unit` chain segment `... && node scripts/verify-schema-parity.js && ...` to `... && pnpm run verify:schema && ...`. Single source of truth.
- **resolved_by:** 



  "verify:schema": "node scripts/verify-schema-parity.js",
  "test:unit": "pnpm --filter main test && pnpm --filter frontend test && node scripts/verify-schema-parity.js && node scripts/__tests__/verify-schema-parity.test.js && pnpm run test:build"

The `node scripts/verify-schema-parity.js` token in `test:unit` should be `pnpm run verify:schema` so the script path is declared once. If the script later moves (e.g. relocates under `scripts/verify/` or gets a different name), the duplicate hard-coded path silently breaks.

Suspected tasks: TASK-639

## FIND-SPRINT-024-13
- **source:** SPRINT-024 (sprint-code-reviewer)
- **type:** improvement
- **severity:** medium
- **status:** open
- **location:** main/src/services/cliManagerFactory.ts:170-187
- **description:** Lost type safety in factory DI plumbing — TASK-647 replaced the static `ClaudeCodeManager.setSharedDb()` injector with constructor DI threaded through `additionalOptions?: unknown`. The new claude factory:
- **suggested_action:** Either (a) add a structural duck-type check before the cast — e.g. `if (!db || typeof (db as { prepare?: unknown }).prepare !== "function") throw new TypeError(...)` — to fail fast at construction with a meaningful error; or (b) tighten the ManagerFactoryFunction signature in cliToolRegistry.ts to accept a discriminated union of tool-specific option shapes (claude: { db: Database }; codex: {}; ...) so the factory dispatch site is type-checked end-to-end. Option (a) is the minimal patch; option (b) is a larger refactor worth filing as backlog.
- **resolved_by:** 


  const claudeManagerFactory: ManagerFactoryFunction = (
    sessionManager: unknown,
    logger?: Logger,
    configManager?: ConfigManager,
    additionalOptions?: unknown,
  ) => {
    const options = additionalOptions as Record<string, unknown> | undefined;
    const db = options?.db as import("better-sqlite3").Database | undefined;
    if (!db) {
      throw new TypeError("[CliManagerFactory] claude tool requires `db` in additionalOptions");
    }
    return new ClaudeCodeManager(...);
  };

The `additionalOptions` parameter is typed as `unknown` and the contained `db` is cast via `as`, but there is no validation that the cast target is actually a better-sqlite3 Database — only a truthy check. A caller could pass `additionalOptions: { db: "not actually a db" }` and the TypeError would not fire; the failure would surface at the first `db.prepare()` call inside RawEventsSink. This is the systemic shape required by the registry-pluggable `ManagerFactoryFunction` signature in cliToolRegistry.ts:115, but the cross-cutting drop in type safety is real.

Suspected tasks: TASK-647

## FIND-SPRINT-024-14
- **source:** SPRINT-024 (sprint-code-reviewer)
- **type:** improvement
- **severity:** medium
- **status:** open
- **location:** frontend/src/components/panels/ai/parseJsonMessage.ts:49-106 and frontend/src/components/panels/ai/__tests__/parseJsonMessage.test.ts
- **description:** Cross-task dead runtime code — TASK-637 added parseJsonMessage() + parseJsonMessages() functions to centralize the IPC adapter conversion. The follow-up fix commit bb926cd (also TASK-637) determined the adapter was shape-mismatched against the real UnifiedMessage IPC payload and reverted both consumer call sites (MessagesView.tsx and RichOutputView.tsx) to bypass the adapter and pass raw payloads through. Result: as of sprint close, `parseJsonMessage` and `parseJsonMessages` are imported by NOTHING in the frontend tree — only the *type* exports (JSONMessage, UserPromptMessage, SessionInfo) are still used. The runtime functions and their full 41-line test file have zero production callers, but the test file still runs in the test:unit chain and gates merges on dead-code behavior.

Verification: `grep -rn parseJsonMessage frontend/src` returns matches only for the type re-export imports, the test file, and the dead-code self-references inside parseJsonMessage.ts itself.

Suspected tasks: TASK-637
- **suggested_action:** Either (a) delete parseJsonMessage() + parseJsonMessages() function exports and the parseJsonMessage.test.ts file entirely, keeping only the type declarations (interfaces JSONMessage, UserPromptMessage, SessionInfo) — minimal preservation of what consumers actually import; or (b) keep both and redesign parseJsonMessage against the real UnifiedMessage shape per the suggestion in FIND-SPRINT-024-4 (discriminate on role + metadata.systemSubtype, not type/message/data). Option (a) is the simpler clean-up. Either way, the current state — dead production code shipping with green tests — is misleading.
- **resolved_by:** 
