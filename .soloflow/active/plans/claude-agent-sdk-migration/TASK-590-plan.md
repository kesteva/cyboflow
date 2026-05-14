---
id: TASK-590
idea: IDEA-014
status: approved
created: 2026-05-14T00:00:00Z
files_owned:
  - main/src/services/panels/claude/claudeCodeManager.ts
files_readonly:
  - main/src/orchestrator/approvalRouter.ts
  - shared/types/approval.ts
  - shared/types/claudeStream.ts
  - main/src/services/streamParser/schemas.ts
  - main/src/services/streamParser/eventRouter.ts
  - main/src/services/streamParser/rawEventsSink.ts
  - main/src/services/streamParser/messageProjection.ts
  - main/src/services/streamParser/index.ts
  - main/src/services/streamParser/typedEventNarrowing.ts
  - main/src/services/panels/claude/claudePanelManager.ts
  - main/src/services/panels/ai/AbstractAIPanelManager.ts
  - main/src/services/panels/cli/AbstractCliManager.ts
  - main/src/services/sessionManager.ts
  - main/src/services/cliManagerFactory.ts
  - main/src/utils/promptEnhancer.ts
  - main/src/services/cyboflow/stateMachine.ts
  - main/src/services/cyboflow/transitions.ts
  - main/src/utils/mutex.ts
  - main/package.json
acceptance_criteria:
  - criterion: "claudeCodeManager.ts no longer imports from '@homebridge/node-pty-prebuilt-multiarch'."
    verification: "grep -n '@homebridge/node-pty-prebuilt-multiarch' main/src/services/panels/claude/claudeCodeManager.ts returns 0 matches."
  - criterion: "claudeCodeManager.ts imports `query` from '@anthropic-ai/claude-agent-sdk'."
    verification: "grep -n \"from '@anthropic-ai/claude-agent-sdk'\" main/src/services/panels/claude/claudeCodeManager.ts shows at least one import including `query`."
  - criterion: "claudeCodeManager.ts no longer imports ClaudeStreamParser, CompletionDetector, or the related stream-json parser modules."
    verification: "grep -nE 'ClaudeStreamParser|CompletionDetector|LineBufferer|JSONParser' main/src/services/panels/claude/claudeCodeManager.ts returns 0 matches."
  - criterion: "PATH-discovery / claudeExecutablePath helpers (findExecutableInPath, testClaudeCodeInDirectory, testClaudeCodeAvailability, claudeCodeTest) are no longer imported."
    verification: "grep -nE 'findExecutableInPath|testClaudeCodeInDirectory|testClaudeCodeAvailability|claudeCodeTest' main/src/services/panels/claude/claudeCodeManager.ts returns 0 matches."
  - criterion: "All 8 parity SDK options are passed to query(): cwd, model (omit-for-auto), mcpServers, systemPrompt with preset:claude_code, includePartialMessages:true, resume (when continuing), hooks.PreToolUse, env."
    verification: "Open main/src/services/panels/claude/claudeCodeManager.ts and confirm that the literal options object passed to query() contains property keys: cwd, mcpServers, systemPrompt, includePartialMessages, hooks, env. Also confirm `model` is conditionally set when options.model && options.model !== 'auto', and `resume` is conditionally set when isResume===true. systemPrompt literal contains `type: 'preset'` and `preset: 'claude_code'`."
  - criterion: "session_id is captured from the first SystemInitEvent and routed through the existing addPanelOutput auto-capture (no new direct sessionManager writes added)."
    verification: "Open the file and confirm that for every event yielded by the query iterator where event.type === 'system', the manager emits an `output` event with type: 'json' and data: event so AbstractAIPanelManager forwards it to sessionManager.addPanelOutput (which already extracts session_id from system/init per sessionManager.ts:849-858 and :935-959)."
  - criterion: "PreToolUse hook invokes ApprovalRouter and translates ApprovalDecision to the SDK hookSpecificOutput shape."
    verification: "grep -n 'ApprovalRouter' main/src/services/panels/claude/claudeCodeManager.ts shows the hook callback calling ApprovalRouter.getInstance().requestApproval(...); confirm the returned decision.behavior maps 'allow' -> { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', updatedInput: decision.updatedInput } } and 'deny' -> { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: decision.message } }."
  - criterion: "continuePanel issues a fresh query() with options.resume set to the persisted session_id rather than spawning a process."
    verification: "Open continuePanel in the file and confirm it ultimately calls spawnCliProcess (or equivalent SDK-spawn helper) with isResume:true; confirm no process.kill / spawn / pty references remain in the continuePanel control flow."
  - criterion: "MCP servers are passed inline as an object literal (no temp .json file written for the cyboflow-permissions server)."
    verification: "grep -nE 'mcp-config|setupMcpConfigurationSync|fs.writeFileSync.*mcp' main/src/services/panels/claude/claudeCodeManager.ts returns 0 matches for the cyboflow-permissions config writer."
  - criterion: "The bridge-spawn path is removed (no --permission-prompt-tool argv, no cyboflowPermissionBridge import or path computation)."
    verification: "grep -nE 'permission-prompt-tool|cyboflowPermissionBridge|build-cyboflow-permission-bridge' main/src/services/panels/claude/claudeCodeManager.ts returns 0 matches."
  - criterion: "Completion detection no longer uses CompletionDetector; the query() async iterator's natural termination triggers cleanup and the existing 'exit' event upstream."
    verification: "grep -n 'CompletionDetector' main/src/services/panels/claude/claudeCodeManager.ts returns 0 matches. Confirm that after the iterator completes the manager calls cleanupPipeline and emits an 'exit' event with the same payload shape AbstractAIPanelManager forwards (panelId, sessionId, exitCode, signal)."
  - criterion: "pnpm typecheck passes."
    verification: "Run `cd main && pnpm typecheck` and `pnpm typecheck` from repo root; both exit 0."
depends_on: [TASK-587, TASK-588, TASK-589]
estimated_complexity: high
epic: claude-agent-sdk-migration
test_strategy:
  needed: false
  justification: "Per the EPIC, task-skeleton scope, and IDEA prior-art notes, unit-test migration is explicitly out of scope for T4 and is owned by TASK-594. The existing sibling test files (main/src/services/__tests__/claudeCodeManagerWiring.test.ts and main/src/services/__tests__/claudeCodeManagerPermissions.test.ts) will break under this rewrite — that is the expected, scoped consequence T4 hands off to TASK-594. T4 is intentionally allowed to land with those tests temporarily red. Verification gate for T4 is `pnpm typecheck` plus a manual `pnpm dev` smoke from the executor; full red-to-green test parity is the explicit gate on TASK-594, which depends_on TASK-592 and TASK-593 specifically so the test rewrite happens against a settled new substrate. Spec-internal note: I read both sibling test files; both directly assert PTY-spawn / parseCliOutput / CompletionDetector behavior that is removed by this task — there is no surgical fix that keeps them green within T4's diff. The orchestrator should plan to land T4 with these two test files broken, and T4 -> T8 (TASK-594) is the unblock path."
---

# Rewrite claudeCodeManager.ts to use SDK query() — all 8 parity options wired

## Objective

Replace the PTY-spawn + stream-json parser substrate in `main/src/services/panels/claude/claudeCodeManager.ts` with an in-process `@anthropic-ai/claude-agent-sdk` `query()` consumer. After this task, the Claude panel no longer depends on the `claude` CLI binary, the MCP permission bridge, the `node-pty` import (for the Claude panel — terminal panel's import survives), or the stream-json parser pipeline (parser/lineBufferer/jsonParser/completionDetector). All 8 parity-verified SDK options surface to the call. Permission gating routes inline through `ApprovalRouter.getInstance()`. `session_id` capture, resume continuation, the upstream event contract (`output`/`spawned`/`exit`/`error` events feeding `AbstractAIPanelManager`), and the renderer/review-queue user-visible behavior are all preserved.

## Implementation Steps

1. **Verify SDK dep landed (sanity check from T1).** Run `grep -n '"@anthropic-ai/claude-agent-sdk"' main/package.json`. If 0 matches, stop and escalate — T1 (TASK-587) is the prereq and must have added the dep first.

2. **Inheritance decision (no AbstractCliManager rewire).** Keep `class ClaudeCodeManager extends AbstractCliManager`. This is the IDEA's option (a). Justification: `cliManagerFactory.ts` returns `AbstractCliManager`, `ClaudePanelManager`'s constructor accepts `AbstractCliManager`, and `AbstractAIPanelManager` consumes `cliManager.on('output' | 'spawned' | 'exit' | 'error', ...)` events plus `cliManager.startPanel / continuePanel / stopPanel / killProcess / isPanelRunning / getAllProcesses` methods. Breaking the inheritance would churn at least four files outside `files_owned`. Instead, override every PTY-touching method to no-op or throw and supply trivial implementations of the remaining abstract methods.

3. **Replace imports.**
   - Remove: `electron.app`, `fs` (unless retained for base-project `.mcp.json` discovery), `os`, `child_process.execSync`, `testClaudeCodeAvailability / testClaudeCodeInDirectory`, `findExecutableInPath`, `findNodeExecutable`, `getCrystalDirectory`, `ClaudeStreamParser`, `EventRouter`, `RawEventsSink`, `CompletionDetector`, and `CompletionPayload`/`ForcedPayload` type imports from the stream-json glue.
   - Retain: `ApprovalRouter`, `AbstractCliManager`, `withLock`, `enhancePromptForStructuredCommit`, `assertTransitionAllowed`, `transitionToAwaitingReview`, types from models / logger / configManager, `Database`.
   - Re-import survivors `EventRouter` and `RawEventsSink` from the streamParser barrel for the new pipeline plumbing.
   - Add: `import { query, type Options, type HookCallback, type PreToolUseHookInput, type SDKMessage } from '@anthropic-ai/claude-agent-sdk'`.

4. **Replace the `ClaudeCodeProcess` interface.** Use a controller:
   ```ts
   interface ClaudeSdkRun {
     abortController: AbortController;
     iteratorDone: Promise<void>;
     panelId: string;
     sessionId: string;
     worktreePath: string;
   }
   ```
   Keep a private map keyed by panelId (`private readonly sdkRuns = new Map<string, ClaudeSdkRun>()`). Maintain a minimal `CliProcess`-shaped entry in `this.processes` (inherited from `AbstractCliManager`) so `isPanelRunning`/`getAllProcesses`/`killAllProcesses` keep working — overrides in this class never invoke the stub's PTY-shaped `process` field.

5. **Override `spawnCliProcess` end-to-end (do not call `super.spawnCliProcess`).** Replace body with:
   1. `withLock(\`claude-spawn-\${options.panelId}\`, async () => { ... })`.
   2. Resume validation against `sessionManager.getPanelClaudeSessionId(options.panelId)`.
   3. Build SDK options via new `buildSdkOptions(options)` (step 6).
   4. Create `AbortController`, push the `ClaudeSdkRun` and a stub `CliProcess` into the maps.
   5. Wire per-run pipeline (EventRouter + optional RawEventsSink). Drop `parser` and `detector` from `PipelineTuple`.
   6. Emit existing `session_info` output event with SDK-flavored descriptor.
   7. Emit `spawned` event.
   8. Start the consumer with `query({ prompt, options: sdkOptions })`; wrap iteration in an async IIFE assigned to `run.iteratorDone`. On every event: forward to EventRouter and emit `output` event upstream. On natural completion: emit `exit` with `exitCode: 0`. On error: emit `error` then `exit` with `exitCode: 1`. Always cleanup in `finally`.

6. **Implement `buildSdkOptions(options): Options`.** Replace `buildCommandArgs` entirely:
   ```ts
   const sdkOptions: Options = {
     cwd: options.worktreePath,
     includePartialMessages: true,
     systemPrompt: {
       type: 'preset',
       preset: 'claude_code',
       append: this.composeSystemPromptAppend(options),
     },
     mcpServers: this.composeMcpServers(options),
     env: this.composeRunEnv(options),
     hooks: {
       PreToolUse: [{
         hooks: [this.makePreToolUseHook(options.panelId)],
       }],
     },
   };
   if (options.model && options.model !== 'auto') {
     sdkOptions.model = options.model;
   }
   if (options.isResume) {
     const claudeSessionId = this.sessionManager.getPanelClaudeSessionId(options.panelId);
     if (!claudeSessionId) {
       throw new Error(`Cannot resume: no Claude session_id stored for Crystal session ${options.sessionId}`);
     }
     sdkOptions.resume = claudeSessionId;
   }
   ```
   - `composeSystemPromptAppend(options)` reuses `enhancePromptForStructuredCommit` + existing `buildSystemPromptAppend`.
   - `composeMcpServers(options)` returns the inline object: omit cyboflow-permissions (replaced by hooks) + compose base-project `.mcp.json` servers as inline literals. Do NOT write a temp `.json` file.
   - `composeRunEnv(options)` returns `{ CYBOFLOW_RUN_ID: options.panelId, ...(verbose ? { MCP_DEBUG: '1' } : {}) }`.
   - `makePreToolUseHook(panelId): HookCallback` returns an async function:
     ```ts
     return async (input, _toolUseId, _ctx) => {
       const pretool = input as PreToolUseHookInput;
       try {
         const decision = await ApprovalRouter.getInstance().requestApproval(
           panelId,
           pretool.tool_name,
           pretool.tool_input as Record<string, unknown>,
           () => {},
         );
         if (decision.behavior === 'allow') {
           return {
             hookSpecificOutput: {
               hookEventName: 'PreToolUse',
               permissionDecision: 'allow',
               ...(decision.updatedInput ? { updatedInput: decision.updatedInput } : {}),
             },
           };
         }
         return {
           hookSpecificOutput: {
             hookEventName: 'PreToolUse',
             permissionDecision: 'deny',
             ...(decision.message ? { permissionDecisionReason: decision.message } : {}),
           },
         };
       } catch (err) {
         this.logger?.error(`[ClaudeCodeManager] PreToolUse hook failed for ${pretool.tool_name}: ${err instanceof Error ? err.message : String(err)}`);
         return {
           hookSpecificOutput: {
             hookEventName: 'PreToolUse',
             permissionDecision: 'deny',
             permissionDecisionReason: 'Internal approval-router error',
           },
         };
       }
     };
     ```
   - Compatibility note: if TASK-588 reshapes `ApprovalRouter.requestApproval` to take an object payload, swap the call site to the object form here.

7. **Compose the SDK `prompt` argument.** Use `enhancePromptForStructuredCommit(options.prompt, dbSession || { id: sessionId }, this.logger)` as the prompt value. Do NOT concatenate the system-prompt-append into it.

8. **Override `continuePanel`.** Replace `await this.killProcess(panelId)` with `await this.abortCurrentRun(panelId)`. Keep `skip_continue_next` flag handling verbatim.

9. **Override `killProcess(panelId)`.**
   ```ts
   override async killProcess(panelId: string): Promise<void> {
     this.cleanupPipeline(panelId);
     await this.abortCurrentRun(panelId);
     this.processes.delete(panelId);
   }
   ```
   Where `abortCurrentRun` calls `run.abortController.abort()` then `await run.iteratorDone.catch(() => {})`.

10. **`cleanupPipeline(panelId)` simplification.** Drop `parser.flush() / detector.dispose()`. Body becomes sink dispose + router clearRun.

11. **Drop `setupProcessHandlers` override entirely.**

12. **Drop `parseCliOutput` substance.** Return `[]` and add a JSDoc note.

13. **Drop `buildCommandArgs` substance.** Return `[]`.

14. **Drop `getCliExecutablePath`.** Return a sentinel `'sdk-in-process'`.

15. **Override `testCliAvailability` to always return available.**

16. **Drop MCP setup methods.** Remove `setupMcpConfigurationSync`, `setupMcpConfiguration`, `setupBaseProjectMcpConfig`. Keep `getBaseProjectMcpServers` for inline composition; simplify return shape to omit `mcpJsonPath`.

17. **Slim `cleanupCliResources`.** Drop the temp-file `setTimeout` cleanups. Keep only `ApprovalRouter.getInstance().clearPendingForRun(sessionId)`.

18. **Slim `initializeCliEnvironment`.** Body becomes `return this.composeRunEnv(options)` or `return {}`.

19. **Preserve `tryTransitionToAwaitingReview` and the `@cyboflow-hidden` annotation.**

20. **Preserve `restartPanelWithHistory`.** Kill path now goes through SDK abort flow.

21. **Preserve `spawnClaudeCode` and `startPanel` public signatures verbatim.**

22. **Verify upstream event contract is intact** against `AbstractAIPanelManager.setupEventHandlers`. Confirm `output`, `spawned`, `exit`, `error` shapes preserved.

23. **Run `pnpm typecheck`** from both `main/` and repo root.

24. **Smoke check.** Run `pnpm dev`. Create a fresh Claude panel, send "say hi". Confirm: panel streams a response, no `pty.write` in logs, tool-using prompt triggers `PreToolUse` through the review queue.

## Acceptance Criteria

1. **No node-pty import.** `grep` returns 0 matches.
2. **SDK imported.** `query` from `@anthropic-ai/claude-agent-sdk`.
3. **No stream-json parser imports.** `ClaudeStreamParser` / `CompletionDetector` / `LineBufferer` / `JSONParser` all gone. `EventRouter` and `RawEventsSink` may still be imported.
4. **No PATH discovery / `claudeExecutablePath` config.** All discovery helpers gone.
5. **All 8 SDK options wired** including `model` omit-for-auto and `resume` when continuing.
6. **`session_id` capture path preserved** via upstream `output` events and `sessionManager.addPanelOutput`.
7. **`PreToolUse` hook routes through `ApprovalRouter`** with proper `hookSpecificOutput` mapping and fail-closed deny on errors.
8. **`continuePanel` uses `options.resume`, not respawn.**
9. **Inline `mcpServers`, no temp file** for cyboflow-permissions.
10. **Bridge-spawn path gone.** No `--permission-prompt-tool`, no bridge import.
11. **No `CompletionDetector`.** Completion is iterator end + upstream `exit`.
12. **`pnpm typecheck` green.**

## Test Strategy

`needed: false`. Owned by TASK-594. Sibling test files (`claudeCodeManagerWiring.test.ts`, `claudeCodeManagerPermissions.test.ts`) will break under this rewrite — that is the expected, scoped consequence. Manual smoke is the executor gate (step 24).

## Hardest Decision

**Whether to keep `extends AbstractCliManager` or break the inheritance.** Picked option (a) — keep inheritance and override PTY-touching methods — because breaking it would force changes in four files outside `files_owned` (`cliManagerFactory.ts`, `cliToolRegistry.ts`, `ClaudePanelManager` constructor, `AbstractAIPanelManager`). The "invites code-rot" worry is minor: PTY methods inherited but never called are localized and grepable.

## Rejected Alternatives

1. **Break the inheritance** (option (b) from IDEA). Rejected due to cross-file blast radius.
2. **Keep `ClaudeStreamParser` and feed SDK events through it.** Rejected — feeding typed objects into a string-parser is a contortion.
3. **Use `canUseTool` instead of `hooks.PreToolUse`.** EPIC §Out of scope rejects this.
4. **Persist `session_id` directly from this file** instead of routing through `addPanelOutput`. Rejected — would risk drift between two persistence paths.

## Lowest Confidence Area

**The exact `mcpServers` literal shape under the SDK.** The SDK supports `type: 'sdk'`, `type: 'stdio'`, and HTTP variants. The plan assumes the EPIC's inline-literal approach and drops cyboflow-permissions entirely. If T1's smoke probe surfaces incompatibilities with a particular base-project `.mcp.json` shape, the executor must loop back rather than guess.

A secondary risk: the SDK's `HookCallback` return type may differ from the assumed `{ hookSpecificOutput: { hookEventName, permissionDecision, ... } }` shape. Centralized into `makePreToolUseHook` so a single edit corrects.

A tertiary risk: TASK-588's `requestApproval` shape — if it changed to an object form, swap at `makePreToolUseHook`. The contract (`Promise<ApprovalDecision>` with discriminant `behavior`) is what matters.
