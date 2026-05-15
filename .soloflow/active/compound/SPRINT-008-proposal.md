---
sprints: [SPRINT-008]
span_label: SPRINT-008
created: "2026-05-14T00:00:00.000Z"
counters_start:
  ideas: 16
summary:
  cleanups: 11
  backlog_tasks: 2
  claude_md: 0
  soloflow_improvements: 0
---

# Compound Proposal — SPRINT-008

## A. Clean-up items (execute now)

### A1. Remove dead @anthropic-ai/claude-code dependency and audit ReadableStream polyfill
- **Summary:** Delete the now-unused `@anthropic-ai/claude-code: ^2.0.0` entry from `main/package.json` and determine whether the ReadableStream polyfill is still required by the active SDK.
- **Source-Sprint:** SPRINT-008
- **Rationale:** TASK-590 rewrote `claudeCodeManager.ts` to import exclusively from `@anthropic-ai/claude-agent-sdk`. A grep across `main/src`, `frontend/src`, and `shared` (excluding `dist` and `node_modules`) returns zero matches for `@anthropic-ai/claude-code` other than `main/package.json`. Leaving the package pinned at `^2.0.0` pulls a ~25 MB CLI binary into every install and risks future agents adding imports from the old package thinking it is the active SDK. (FIND-SPRINT-008-15, TASK-587/590)
- **Blast radius:** `main/package.json`, `pnpm-lock.yaml`. If the polyfill is no longer needed: also `main/src/polyfills/readablestream.ts` and the `main/src/index.ts:2` import. Estimated risk: **low** — typecheck and build confirm completeness.
- **Source:** FIND-SPRINT-008-15 (sprint-code-reviewer); cross-referenced TASK-587 and TASK-590 done reports.
- **Proposed change:**
  ```diff
  // main/package.json
  -    "@anthropic-ai/claude-code": "^2.0.0",
       "@anthropic-ai/claude-agent-sdk": "^0.2.141",
  ```
  Then run `pnpm install` and `pnpm build:main && pnpm typecheck && pnpm lint`. If both pass, separately verify whether `@anthropic-ai/claude-agent-sdk` already polyfills ReadableStream on the Electron Node runtime — if yes, also delete `main/src/polyfills/readablestream.ts` and remove the `import './polyfills/readablestream'` at `main/src/index.ts:2`.

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** high
- **Reasoning:** Confirmed `main/package.json:19` still pins `@anthropic-ai/claude-code: ^2.0.0` while `main/src/services/panels/claude/claudeCodeManager.ts:4` imports only from `@anthropic-ai/claude-agent-sdk`; the only remaining source references are a polyfill README comment and a CLI-binary discovery fallback in `nodeFinder.ts:131` which is a path-string hint, not an import — removing the dep eliminates a ~25 MB unused install and the misnamed-import landmine.
- **Counterfactual:** If `nodeFinder.ts` were actually resolving the legacy package at runtime (verified by integration test), then dep removal would need a different fix path.

---

### A2. Fix MCP server type cast to use SDK's McpServerConfig union
- **Summary:** Replace the narrowed stdio-only cast in `composeMcpServers()` with the SDK's exported `McpServerConfig` union type so future SSE/HTTP/`env`-carrying servers are not silently mistyped.
- **Source-Sprint:** SPRINT-008
- **Rationale:** `composeMcpServers()` at `claudeCodeManager.ts:372-376` casts the base-project MCP server record to a type narrower than the SDK's `McpStdioServerConfig` — it drops `env`, `alwaysLoad`, and non-stdio variants. Runtime values pass through `Object.assign` untouched, so no behavior change, but the misleading cast will cause future maintainers to assume only stdio servers are accepted. The SDK already exports `McpServerConfig` (the full union). (FIND-SPRINT-008-2, TASK-590)
- **Blast radius:** `main/src/services/panels/claude/claudeCodeManager.ts` lines 372–376 only. No runtime change. Risk: **trivial**.
- **Source:** FIND-SPRINT-008-2 (TASK-590 verifier).
- **Proposed change:**
  ```diff
  // main/src/services/panels/claude/claudeCodeManager.ts
  + import type { McpServerConfig } from '@anthropic-ai/claude-agent-sdk';
  
  - private composeMcpServers(): Record<string, { type?: 'stdio'; command: string; args?: string[] }> {
  + private composeMcpServers(): Record<string, McpServerConfig> {
      const mcpServers = this.project?.mcpServers ?? {};
  -   return mcpServers as Record<string, { type?: 'stdio'; command: string; args?: string[] }>;
  +   return mcpServers as Record<string, McpServerConfig>;
    }
  ```

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** high
- **Reasoning:** Confirmed at `claudeCodeManager.ts:380-384` the cast is exactly `Record<string, { type?: 'stdio'; command: string; args?: string[] }>` — narrower than the SDK union and drops `env`/`alwaysLoad`; the comment on line 382 already pretends to document `McpServerConfig` while the actual type literal doesn't reference it, so the file currently mis-advertises its own contract.
- **Counterfactual:** If the SDK didn't export `McpServerConfig` (verify by reading `@anthropic-ai/claude-agent-sdk` `.d.ts`), the proposal as written would fail to typecheck and we'd need to fall back to `unknown`.

---

### A3. Remove unused `assertTransitionAllowed` import from claudeCodeManager.ts
- **Summary:** Drop the unused `assertTransitionAllowed` import on `claudeCodeManager.ts:15` — a leftover from an earlier draft of TASK-590 that the final implementation does not use.
- **Source-Sprint:** SPRINT-008
- **Rationale:** `grep -c assertTransitionAllowed main/src/services/panels/claude/claudeCodeManager.ts` returns 1 (the import line only). The final TASK-590 implementation delegates the state-machine guard to `transitionToAwaitingReview()` internally. The import contributes to ESLint `no-unused-vars` noise (currently at warning level only because tester mode is not blocking), and sets a misleading "two imports from stateMachine" expectation. (FIND-SPRINT-008-11, TASK-590)
- **Blast radius:** `main/src/services/panels/claude/claudeCodeManager.ts` line 15 only. Risk: **trivial**.
- **Source:** FIND-SPRINT-008-11 (sprint-code-reviewer).
- **Proposed change:**
  ```diff
  // main/src/services/panels/claude/claudeCodeManager.ts:15
  - import { assertTransitionAllowed, transitionToAwaitingReview } from '../../cyboflow/stateMachine';
  + import { transitionToAwaitingReview } from '../../cyboflow/stateMachine';
  ```

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** high
- **Reasoning:** Confirmed `claudeCodeManager.ts:15` imports `assertTransitionAllowed` from `../../cyboflow/stateMachine` and grep returns exactly 1 occurrence (the import line); the production callsite at line 712 uses `transitionToAwaitingReview` from `../../cyboflow/transitions` instead — also noteworthy that the proposed diff is slightly wrong about the import path (proposal says `cyboflow/stateMachine` for both, but the live file already imports `transitionToAwaitingReview` from `cyboflow/transitions`), so the executor must drop the entire stateMachine import line rather than just one name.
- **Counterfactual:** Skip if a follow-up plan in flight already touches this import region.

---

### A4. Annotate CYBOFLOW_RUN_ID env entry with @cyboflow-hidden or remove it
- **Summary:** Either mark `CYBOFLOW_RUN_ID` in `composeRunEnv()` as `@cyboflow-hidden` (if IDEA-013 shell-hook variant may consume it) or remove it outright — the SDK runs in-process and no spawned subprocess reads this env var today.
- **Source-Sprint:** SPRINT-008
- **Rationale:** `composeRunEnv()` at `claudeCodeManager.ts:386-393` sets `CYBOFLOW_RUN_ID: options.panelId` in the SDK run env. The SDK runs in-process — there is no spawned subprocess reading env. `grep -rn CYBOFLOW_RUN_ID main/src frontend/src shared` returns exactly one hit: the assignment line. The env entry misleads future maintainers into believing a subprocess is reading it. Two paths: (a) if IDEA-013 shell-hook variant is expected to read it, annotate with `@cyboflow-hidden` per project convention; (b) if no consumer is anticipated, delete it. (FIND-SPRINT-008-12, TASK-590)
- **Blast radius:** `main/src/services/panels/claude/claudeCodeManager.ts` lines 386–393. No runtime behavior change (SDK ignores unknown env entries). Risk: **trivial**.
- **Source:** FIND-SPRINT-008-12 (sprint-code-reviewer).
- **Proposed change (option a — @cyboflow-hidden annotation):**
  ```diff
  // main/src/services/panels/claude/claudeCodeManager.ts
    private composeRunEnv(options: RunOptions): Record<string, string | undefined> {
      return {
        ...process.env,
  -     CYBOFLOW_RUN_ID: options.panelId,
  +     // @cyboflow-hidden CYBOFLOW_RUN_ID: reserved for IDEA-013 shell-hook variant
  +     // that may need the panel ID in its subprocess env. Remove if IDEA-013 takes
  +     // a different integration path.
  +     CYBOFLOW_RUN_ID: options.panelId,
        ...(options.mcpDebug ? { MCP_DEBUG: '1' } : {}),
      };
    }
  ```
  **Preferred option (b — remove):** simply delete the `CYBOFLOW_RUN_ID` line if IDEA-013 planning confirms a different integration path; IDEA-013 can re-add it when needed.

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** medium
- **Reasoning:** Grep across `main/src frontend/src shared` returns exactly one hit at `claudeCodeManager.ts:390` (the assignment), confirming no consumer; the SDK runs in-process so there's no subprocess env-channel — leaving option (b) deletion as the lowest-cost fix, since the `@cyboflow-hidden` placeholder route adds 3 lines of speculative comment for an integration that may never come.
- **Counterfactual:** If IDEA-013 has a settled shell-hook design that requires this env var, option (a) is preferable.

---

### A5. Downgrade clearPendingForRun stub console.warn to debug level
- **Summary:** Change the `console.warn` in `ApprovalRouter.clearPendingForRun()` to a debug-level log so every Claude run termination stops emitting a spurious warning in the backend log until TASK-304 implements the body.
- **Source-Sprint:** SPRINT-008
- **Rationale:** `claudeCodeManager.ts:316` calls `ApprovalRouter.getInstance().clearPendingForRun(panelId)` unconditionally in `runSdkQuery`'s `finally` block — runs on every Claude session end (normal, error, or abort). `approvalRouter.ts:326-333`'s stub body logs `console.warn('[ApprovalRouter] clearPendingForRun(${runId}) called — stub, no-op until TASK-304')`. Multi-panel users running many short sessions will see one warn line per termination in `cyboflow-backend-debug.log`, giving the impression of an active bug on every run. The stub behavior (no-op) is correct; the severity of the log signal is not. (FIND-SPRINT-008-16, TASK-588/590)
- **Blast radius:** `main/src/orchestrator/approvalRouter.ts:332`. One line change. Risk: **trivial**.
- **Source:** FIND-SPRINT-008-16 (sprint-code-reviewer).
- **Proposed change:**
  ```diff
  // main/src/orchestrator/approvalRouter.ts:326-333
    clearPendingForRun(runId: string): void {
  -   console.warn(`[ApprovalRouter] clearPendingForRun(${runId}) called — stub, no-op until TASK-304`);
  +   // stub — no-op until TASK-304 implements the full cleanup body
  +   // (panelId convention confirmed by TASK-590 round-2 fix)
    }
  ```

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** high
- **Reasoning:** Confirmed `approvalRouter.ts:332` is exactly the warn line as described and `claudeCodeManager.ts:316` calls it unconditionally in the finally block — every Claude session termination logs a spurious "stub" warning that gives the false impression of a live defect; one-line silencer in an already-stub method is the minimal fix and B2 will replace the body wholesale later.
- **Counterfactual:** If B2 is sequenced to land in the same iteration, fold A5 into B2 instead of a standalone edit.

---

### A6. Update or delete stale streamParser __fixtures__/README.md
- **Summary:** Delete `main/src/services/streamParser/__fixtures__/README.md` (and the now-empty `__fixtures__/` directory) because TASK-594 deleted all 11 JSON files the README describes.
- **Source-Sprint:** SPRINT-008
- **Rationale:** TASK-594 migrated parser tests from on-disk JSON fixtures to inline `sdkMockFactories.ts`. The `__fixtures__/` directory now contains only `README.md`. That README lists a fixture inventory (`system_init.json`, `system_compact.json`, etc.) referencing 11 files that no longer exist on disk, and documents a CLI-wire-format capture command and quarterly re-capture schedule that are now meaningless — the canonical mock source is `sdkMockFactories.ts`, version-locked to `@anthropic-ai/claude-agent-sdk` not the `claude` CLI. (FIND-SPRINT-008-13, TASK-594)
- **Blast radius:** `main/src/services/streamParser/__fixtures__/README.md` and the `__fixtures__/` directory itself. No source code touched. Risk: **trivial**.
- **Source:** FIND-SPRINT-008-13 (sprint-code-reviewer); TASK-594 done report acknowledges the stale README.
- **Proposed change:**
  ```
  rm main/src/services/streamParser/__fixtures__/README.md
  rmdir main/src/services/streamParser/__fixtures__/
  ```
  If the directory must be retained for Git tracking, replace the README with a single line: `Mock factories are in __tests__/sdkMockFactories.ts (SDK-typed inline factories, replacing the deleted JSON fixtures).`

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** high
- **Reasoning:** Confirmed `ls main/src/services/streamParser/__fixtures__/` returns only `README.md`; the README's "Fixture Inventory" lists 11 JSON files that don't exist and its capture command targets `claude --output-format stream-json` (CLI wire) while the actual mocks now live in `__tests__/sdkMockFactories.ts` typed against the SDK — pure documentation rot, zero risk.
- **Counterfactual:** None — the file is unambiguously stale.

---

### A7. Remove stale JSDoc/comment references to deleted parser symbols
- **Summary:** Remove or reword two stale comment-only references to `ClaudeStreamParser` and `JSONParser` in `main/src/ipc/session.ts:34` and `main/src/services/streamParser/__tests__/sdkMockFactories.ts` (formerly `claudeCodeManagerWiring.test.ts`).
- **Source-Sprint:** SPRINT-008
- **Rationale:** TASK-590 and TASK-592 deleted `ClaudeStreamParser` and `JSONParser`. Two files outside those tasks' `files_owned` still contain comment-only text naming the deleted symbols: `session.ts:34` (JSDoc line) and the test file (comments at lines 5 and 268). These cause the AC-6 grep to return false positives on deletion-task plans, as FIND-SPRINT-008-5 documents. (FIND-SPRINT-008-5, TASK-592)
- **Blast radius:** `main/src/ipc/session.ts` (one JSDoc line), and either the now-deleted or current test wiring file. Comments only — no compilation or behavior impact. Risk: **trivial**.
- **Source:** FIND-SPRINT-008-5 (TASK-592 executor).
- **Proposed change:** In `main/src/ipc/session.ts:34`, replace any JSDoc description that mentions `ClaudeStreamParser` or `JSONParser` with a description of the current SDK-shaped event pipeline (events flow from `claudeCodeManager`'s `for await` loop through `EventRouter` → `RawEventsSink` / `MessageProjection`). In the test file, remove or reword the inline comment references to the deleted symbols.

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** medium
- **Reasoning:** Confirmed `session.ts:34` JSDoc names `ClaudeStreamParser` (a deleted symbol) but the cited wiring test file `main/src/services/__tests__/claudeCodeManagerWiring.test.ts` no longer exists (find returned nothing) and `sdkMockFactories.ts` doesn't reference either symbol; the proposal's second target is stale, so the executor's scope reduces to a one-line JSDoc edit in `session.ts` — still worth doing because the comment is actively misleading on a public-projection helper.
- **Counterfactual:** If the wiring test reappears in an in-flight plan, expand scope to include it then.

---

### A8. Add SystemCompactBoundary mock factory and test coverage
- **Summary:** Add a `systemCompactBoundary()` factory to `sdkMockFactories.ts` and a corresponding test block in `schemas.test.ts` so the `compact_boundary` SDK variant is exercised by the test suite.
- **Source-Sprint:** SPRINT-008
- **Rationale:** TASK-589 added `SystemCompactBoundaryEvent` (subtype `compact_boundary`) to the `ClaudeStreamEvent` union and `systemCompactBoundarySchema` to `schemas.ts`. TASK-594 then built `sdkMockFactories.ts` but only exported `systemCompact()` (the legacy CLI shape), not `systemCompactBoundary()`. As a result `schemas.test.ts` and `typedEventNarrowing.test.ts` never exercise the `compact_boundary` subtype that the SDK actually emits. The exhaustive-switch fixtures array in `schemas.test.ts:373-386` covers `compact` but not `compact_boundary`, so a parser regression on the SDK variant would only surface in production. (FIND-SPRINT-008-8, sprint-code-reviewer)
- **Blast radius:** `main/src/services/streamParser/__tests__/sdkMockFactories.ts` (one factory function added) and `main/src/services/streamParser/__tests__/schemas.test.ts` (one describe block + one fixtures-array entry added). No production code touched. Risk: **trivial**.
- **Source:** FIND-SPRINT-008-8 (sprint-code-reviewer).
- **Proposed change:**
  ```diff
  // main/src/services/streamParser/__tests__/sdkMockFactories.ts
  + export function systemCompactBoundary(
  +   overrides: Partial<SystemCompactBoundaryEvent> = {}
  + ): SystemCompactBoundaryEvent {
  +   return {
  +     type: 'system',
  +     subtype: 'compact_boundary',
  +     compact_metadata: {
  +       trigger: 'context_window_threshold',
  +       pre_tokens: 90000,
  +     },
  +     ...overrides,
  +   };
  + }

  // main/src/services/streamParser/__tests__/schemas.test.ts
  // Add to describe('SystemCompactBoundaryEvent') block:
  + it('round-trips compact_boundary via narrower.narrow()', () => {
  +   const event = systemCompactBoundary();
  +   const result = narrower.narrow(event);
  +   expect(result.subtype).toBe('compact_boundary');
  + });

  // Add to exhaustive-switch fixtures array:
  + [systemCompactBoundary(), 'system/compact_boundary'],
  ```

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** high
- **Reasoning:** Confirmed `shared/types/claudeStream.ts:127-136` defines `SystemCompactBoundaryEvent` and is in the union at line 292; `schemas.ts:121-130` defines `systemCompactBoundarySchema` and adds it to `systemUnionSchema` at line 137; but `sdkMockFactories.ts` exports only `systemCompact()` (CLI shape) and the exhaustive-switch fixtures array at `schemas.test.ts:373-385` lacks `compact_boundary` — the SDK actually emits this subtype so the gap is a real production-only path, and the assertNever tripwire's design relies on a fixture per variant.
- **Counterfactual:** None — the missing factory is a direct gap in the documented test contract.

---

### A9. Add resultErrorMaxStructuredOutputRetries mock factory and test coverage
- **Summary:** Add a `resultErrorMaxStructuredOutputRetries()` factory to `sdkMockFactories.ts` and a corresponding `it(...)` block in `schemas.test.ts` so the SDK-only 5th result subtype is exercised by the test suite.
- **Source-Sprint:** SPRINT-008
- **Rationale:** TASK-589 added `error_max_structured_output_retries` as the 5th `ResultEvent.subtype` (SDK-only). The Zod schema in `schemas.ts:242` enforces all five via `resultUnionSchema` (discriminated union). TASK-594's `sdkMockFactories.ts` exports 4 result factories but not `resultErrorMaxStructuredOutputRetries`. The exhaustive-switch fixtures array in `schemas.test.ts` covers the other 4 result subtypes but not this one, so a wire-format regression for the SDK's structured-output-retry exhaustion path would not be caught before production. (FIND-SPRINT-008-9, sprint-code-reviewer)
- **Blast radius:** `main/src/services/streamParser/__tests__/sdkMockFactories.ts` (one factory added) and `main/src/services/streamParser/__tests__/schemas.test.ts` (one it-block + one fixtures-array entry added). No production code touched. Risk: **trivial**.
- **Source:** FIND-SPRINT-008-9 (sprint-code-reviewer).
- **Proposed change:**
  ```diff
  // main/src/services/streamParser/__tests__/sdkMockFactories.ts
  + export function resultErrorMaxStructuredOutputRetries(
  +   overrides: Partial<ResultEvent> = {}
  + ): ResultEvent {
  +   return {
  +     type: 'result',
  +     subtype: 'error_max_structured_output_retries',
  +     is_error: true,
  +     ...overrides,
  +   };
  + }

  // main/src/services/streamParser/__tests__/schemas.test.ts
  // Add inside describe('ResultEvent'):
  + it('round-trips error_max_structured_output_retries', () => {
  +   const event = resultErrorMaxStructuredOutputRetries();
  +   const result = narrower.narrow(event);
  +   expect(result.subtype).toBe('error_max_structured_output_retries');
  +   expect((result as ResultEvent).is_error).toBe(true);
  + });

  // Add to exhaustive-switch fixtures array:
  + [resultErrorMaxStructuredOutputRetries(), 'result/error_max_structured_output_retries'],
  ```

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** high
- **Reasoning:** Confirmed `claudeStream.ts:208` lists 5 subtypes including `error_max_structured_output_retries`, `schemas.ts:242-245` defines `resultErrorMaxStructuredOutputRetriesSchema` and includes it in the discriminated union at line 253, but `sdkMockFactories.ts` only exports four `result*` factories (success, MaxTurns, MaxBudgetUsd, ErrorDuringExecution) and the `schemas.test.ts` exhaustive fixtures array (lines 380-383) covers four — the 5th subtype is SDK-only and the assertNever tripwire fires on coverage gaps, so this is a real test-suite hole.
- **Counterfactual:** None — the omission is a direct test-coverage gap on a code path that the schema explicitly enforces.

---

### A10. Rebuild better-sqlite3 to fix ABI mismatch (environment action)
- **Summary:** Run `pnpm electron:rebuild` to resolve the `NODE_MODULE_VERSION 137 vs 127` ABI mismatch that prevents all 32 database-bound tests from running.
- **Source-Sprint:** SPRINT-008
- **Rationale:** `better-sqlite3` prebuilt binary is built for NODE_MODULE_VERSION 137 but the active Electron Node runtime requires 127. This blocks every vitest case in `approvalRouter.test.ts`, `rawEventsSink.test.ts`, `cyboflowSchema.test.ts`, and 3 others — 32 tests fail at DB construction time before any test body runs. The root cause is environmental, pre-dates SPRINT-008, and reproduces identically on `main` pre-commit (confirmed by TASK-588 verifier). CLAUDE.md documents the fix. Already queued in `human-review-queue.md` as `better_sqlite3_node_module_version_mismatch`. (FIND-SPRINT-008-1, TASK-588)
- **Blast radius:** No files changed. Rebuilds a native binding in `node_modules`. Risk: **trivial** — the existing CLAUDE.md documents this as the canonical fix.
- **Source:** FIND-SPRINT-008-1 (TASK-588 verifier); `better_sqlite3_node_module_version_mismatch` entry in `human-review-queue.md`.
- **Proposed change:**
  ```bash
  pnpm electron:rebuild
  cd main && pnpm test -- approvalRouter   # confirm 8/8 pass
  pnpm --filter main exec vitest run src/services/streamParser/__tests__/rawEventsSink.test.ts  # confirm 8/8 pass
  ```

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** high
- **Reasoning:** Confirmed `.soloflow/human-review-queue.md:21` carries `dedup_key: better_sqlite3_node_module_version_mismatch` with the exact same `pnpm electron:rebuild` action and CLAUDE.md documents the same fix; the recommendation is a no-files-changed environment step that unblocks 32 DB-bound tests with zero risk.
- **Counterfactual:** None — this is the canonical documented fix.

---

### A11. Dead-code sweep: remove MCP-IPC-bridge island (PermissionIpcServer + Bridge TS source)
- **Summary:** Delete `cyboflowPermissionBridge.ts`, `cyboflowPermissionIpcServer.ts`, and remove the `permissionIpcPath` plumbing from `ClaudeCodeManager`, `cliManagerFactory.ts`, and `main/src/index.ts` — the entire MCP-IPC-bridge substrate is dead after TASK-590's in-process `PreToolUse` hook replaced it.
- **Source-Sprint:** SPRINT-008
- **Rationale:** TASK-590 replaced the MCP-bridge-over-unix-socket permission path with an in-process `PreToolUse` hook closing over `panelId` → `ApprovalRouter`. The surrounding plumbing was not removed: (1) `main/src/services/cyboflowPermissionBridge.ts` — TS source, `tsc` still emits a `dist/` artifact on every build; (2) `main/src/services/cyboflowPermissionIpcServer.ts` — still booted at app launch in `main/src/index.ts:564-579`, calls `start()` (mkdir sockets dir, net.createServer().listen()), plumbs socket path through `ClaudeCodeManager` constructor; (3) `claudeCodeManager.ts:88` — `permissionIpcPath?: string | null` ctor parameter, set but never read in the file body; (4) `cliManagerFactory.ts:178-184` — still threads `permissionIpcPath` through `additionalOptions`. The island consumes a real filesystem socket per app launch despite no SDK code reading it. TASK-591 already acknowledged the TS source deletion was out of scope and flagged it for a follow-up sweep. (FIND-SPRINT-008-6, FIND-SPRINT-008-10, TASK-591)
- **Blast radius:** 4 files deleted/modified: `main/src/services/cyboflowPermissionBridge.ts` (delete), `main/src/services/cyboflowPermissionIpcServer.ts` (delete), `main/src/services/panels/claude/claudeCodeManager.ts` (remove ctor param + field reference), `main/src/services/cliManagerFactory.ts` (remove `additionalOptions.permissionIpcPath` threading), `main/src/index.ts` (remove `CyboflowPermissionIpcServer` boot block + import). Also verify the `main/dist/services/**/*.js` `asarUnpack` glob in root `package.json` does not need a negation entry after deletion (TASK-591 pruned the explicit path entries; this sweep removes the source so no dist artifact will be emitted). Risk: **low** — these files have zero SDK code callers, confirmed by `grep`.
- **Source:** FIND-SPRINT-008-6 (TASK-591 executor); FIND-SPRINT-008-10 (sprint-code-reviewer).
- **Proposed change:** Delete `main/src/services/cyboflowPermissionBridge.ts` and `main/src/services/cyboflowPermissionIpcServer.ts`. In `main/src/services/panels/claude/claudeCodeManager.ts`, remove the `private permissionIpcPath?: string | null` constructor parameter and its assignment. In `main/src/services/cliManagerFactory.ts:178-184`, remove the `permissionIpcPath` line from `additionalOptions`. In `main/src/index.ts:564-579`, remove the `CyboflowPermissionIpcServer` instantiation block and its import. Run `pnpm typecheck && pnpm build:main` to confirm all consumers compile clean.

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** medium
- **Reasoning:** Confirmed `claudeCodeManager.ts:88` declares `private permissionIpcPath?: string | null` and grep finds zero subsequent reads of `this.permissionIpcPath` in the file; `index.ts:566-578` still boots `new CyboflowPermissionIpcServer()` and `await ipcServer.start()` (which creates a real filesystem socket per app launch) but no SDK call path consumes the socket path; one subtle wrinkle the proposal undersells — `approvalRouter.ts:107, 122, 158` carry comment-only references to `CyboflowPermissionIpcServer` in its initialization doc that will need a reword in the same commit to avoid leaving dangling docs.
- **Counterfactual:** If IDEA-013's shell-hook variant is expected to revive the IPC socket plumbing imminently, defer this sweep and add `@cyboflow-hidden` markers instead.

---

## B. Backlog tasks (refine into execution-ready plans)

### B1. Audit killProcess cleanup ordering to prevent raw_events loss on kill-mid-stream
- **Summary:** Investigate whether reordering `killProcess()` to abort the SDK run before disposing the `RawEventsSink` listener would prevent stale-open raw_events rows on `continuePanel`-triggered kill-respawn sequences.
- **Source-Sprint:** SPRINT-008
- **Source:** FIND-SPRINT-008-14 (sprint-code-reviewer); TASK-590 done report "Forward references".
- **Problem:** `killProcess()` at `claudeCodeManager.ts:447-451` calls `cleanupPipeline(panelId)` BEFORE `abortCurrentRun(panelId)`. `cleanupPipeline` disposes the `RawEventsSink` listener and removes `EventRouter` listeners. `abortCurrentRun` then signals `abortController.abort()` and awaits `run.iteratorDone`. In the window between cleanup and abort signal propagation, the SDK async iterator may push additional events to `router.emitForRun(runId, event)` — which now has no listeners. Those events' `RawEventsSink` rows are never written. The pre-SDK PTY substrate did not have this race because OS-level kill was synchronous. The non-deterministic row count matters most in `continuePanel` (line 516-522), which calls `killProcess` defensively before re-spawning — any tail events from the killed run are silently dropped. Two fix options: (a) reorder — call `abortCurrentRun` first, then `cleanupPipeline` (the `runSdkQuery` finally block makes `cleanupPipeline` a no-op in the common case); (b) remove the redundant `cleanupPipeline` call from `killProcess` and rely solely on `runSdkQuery`'s `finally` (simpler, but requires confirming `iteratorDone` only resolves after `finally` completes). The fix touches the kill/abort async control flow in `claudeCodeManager.ts` — warrants a dedicated task with an executor loop plus a plan section verifying the `finally`-before-emit invariant.
- **Proposed direction:** Write a task that: (1) documents the current ordering with evidence from the code; (2) chooses option (b) — remove `cleanupPipeline(panelId)` from `killProcess` and verify via code review that `runSdkQuery`'s `finally` always runs after the iterator is exhausted; (3) adds a comment in `killProcess` explaining the deliberate ordering. No new abstractions needed. The task should include a unit-test assertion that after `killProcess`, `cleanupPipeline` state is consistent. Files in scope: `main/src/services/panels/claude/claudeCodeManager.ts`.
- **Scope:** small

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** medium
- **Reasoning:** Confirmed `killProcess()` at `claudeCodeManager.ts:447-451` does call `cleanupPipeline(panelId)` before `abortCurrentRun(panelId)`, and the abort-check at line 280 is at the top of the for-await loop — so events the SDK has already pushed into the iterator's internal queue before abort propagates will flow into `router.emitForRun` at line 288 after `cleanupPipeline` has nulled the sink listener; `continuePanel` at line 516 does call `killProcess` defensively before respawn, making this a real path. The proposed direction (option b — delete the redundant `cleanupPipeline` call from `killProcess`) is the smallest correct fix.
- **Counterfactual:** If the SDK's async iterator drains synchronously on `abortController.abort()` (verifiable from the SDK source), then no events can be queued post-abort and the race is theoretical — DONT_IMPLEMENT.

---

### B2. Implement full clearPendingForRun body (TASK-304 approval-lifecycle cleanup)
- **Summary:** Replace the `clearPendingForRun` no-op stub in `ApprovalRouter` with a real implementation that cancels and removes pending approval rows indexed by `panelId` when a run terminates.
- **Source-Sprint:** SPRINT-008
- **Source:** FIND-SPRINT-008-3 (TASK-590 verifier); FIND-SPRINT-008-16 (sprint-code-reviewer); TASK-588 forward reference ("TASK-304").
- **Problem:** `ApprovalRouter.clearPendingForRun(runId)` at `approvalRouter.ts:326-333` is a documented stub (no-op). TASK-590 wires it unconditionally in `runSdkQuery`'s `finally` block, meaning every Claude session termination calls a no-op. Two downstream issues compound from the stub: (a) any `requestApproval` promise left pending when a run aborts (e.g., via `killProcess`) will never resolve — the promise leaks across restarts, potentially causing phantom approval prompts; (b) `restartPanelWithHistory` calls `killProcess` defensively before re-spawning — if any tool-call approval is in-flight at kill time, `clearPendingForRun` being a no-op means the promise chain hangs. `panelId` is now confirmed as the canonical `runId` convention (TASK-590 round-2 fix resolved FIND-SPRINT-008-4). The implementation needs to: find all `ApprovalRequest` entries keyed to `runId`, reject their waiting `resolve`/`reject` callbacks with a "run terminated" error (or special cancellation sentinel), and remove them from internal state. The `ApprovalRouter` internal pending map structure must be consulted before planning.
- **Proposed direction:** Read `approvalRouter.ts` in full to understand the pending map shape. Implement `clearPendingForRun` to reject pending promises with a `RunTerminatedError` (or an `ApprovalDecision` sentinel such as `{ action: 'denied', reason: 'run_terminated' }`). Update `claudeCodeManager.ts`'s `PreToolUse` hook to handle this sentinel gracefully (it currently expects `ApprovalDecision`). Add unit tests for: (1) clearPendingForRun with active pending entry resolves the promise as denied; (2) clearPendingForRun with no pending entries is a no-op without error. Files in scope: `main/src/orchestrator/approvalRouter.ts`, `main/src/services/panels/claude/claudeCodeManager.ts`, `main/src/orchestrator/__tests__/approvalRouter.test.ts`.
- **Scope:** medium

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** high
- **Reasoning:** Confirmed `approvalRouter.ts:326-333` is a documented stub keyed by `pending: Map<approvalId, PendingEntry>` (line 86) where each `PendingEntry` carries `request.runId`, `resolve`, `reject`, and `socketReply` — so the implementation surface is well-defined; the stub is called on every Claude termination at `claudeCodeManager.ts:316` and a stale finding (`FIND-SPRINT-008-3`) and SPRINT-006 archive review (`FIND-SPRINT-006-19`) both reference `TASK-304` as the canonical landing place — recurring across at least 3 sprints, with concrete severity (a left-pending approval promise leaks across `killProcess` + restart, potentially hanging tool-call resolution forever).
- **Counterfactual:** None — the no-op semantics combined with multi-sprint references to TASK-304 make this a refinement-ready backlog item.

---

## C. CLAUDE.md / CODE-PATTERNS.md improvements (apply now)

_No items._

---

## Suppressed — SoloFlow Defects

The following candidate C-items were evaluated and dropped because they describe SoloFlow plan-authoring behavior rather than project-specific conventions. They would evaporate if the user stopped using SoloFlow and are not about this codebase's code, schema, or domain.

- **Grep AC commands should exclude build artifacts (dist/, node_modules/)** — FIND-SPRINT-008-7 proposed adding a rule to CLAUDE.md or plan-author guidance that deletion-task AC grep commands include `--exclude-dir=dist --exclude-dir=node_modules`. This rule governs how SoloFlow plan-authors write verification commands, not how cyboflow's code is structured. It would apply identically to any other project using SoloFlow with a `dist/` output directory. Consider opening an issue or running `/soloflow:compound --tester` against this sprint in a SoloFlow-tester setup to surface it as a maintainer recommendation.

---

## Reconciled Findings (informational)

The following finding was `status: resolved` in the findings file and confirmed resolved in a done report — no triage action taken:

- `FIND-SPRINT-008-4` — `status: resolved` in findings file; claimed resolved by TASK-590 (done report: `/Users/raimundoesteva/Developer/cyboflow/.soloflow/archive/done/claude-agent-sdk-migration/TASK-590-done.md`, Round 2 fix: "Approval cleanup aligned to panelId — `clearPendingForRun(panelId)` matches `requestApproval(panelId, ...)` filing; resolved FIND-SPRINT-008-4").
