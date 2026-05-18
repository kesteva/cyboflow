---
sprint: SPRINT-016
pending_count: 8
last_updated: "2026-05-18T17:35:30.008Z"
---
# Findings Queue

## FIND-SPRINT-016-2
- **source:** TASK-602 (verifier)
- **type:** claude-md
- **severity:** medium
- **status:** open
- **location:** .soloflow/active/plans/orchestrator-and-trpc-router/TASK-602-plan.md (and skill: plan-author guidance)
- **description:** TASK-602's plan contains a self-contradictory AC pair. AC6 mandates "The new spec uses real preload.ts whitelist (post-TASK-599 fix) — i.e. the spec depends on TASK-599's wrapper-storage fix and would fail if TASK-599 regressed" (verification: grep for `electron.on.*cyboflow:stream\|subscribeToStreamEvents` in `tests/cyboflow-stream-publisher.spec.ts`). The plan body's Step 6, however, explicitly authorizes a Vitest fallback that mocks `getMainWindow` and bypasses preload.ts entirely ("If the existing Playwright config can't easily start the Electron app, fall back to a Vitest integration test that mocks getMainWindow"), and the "Lowest Confidence Area" section reinforces the same downgrade path. The executor took the authorized fallback, which produces a passing spec that cannot detect a TASK-599 regression — violating AC6's stated regression-canary intent while complying with the plan body. Verifier had to make a judgment call between literal-AC and plan-body intent.
- **suggested_action:** Plan-author guidance: when an AC describes a load-bearing regression canary (e.g. "would fail if TASK-X regressed"), the plan body MUST NOT authorize a fallback that breaks that canary property. Either (a) downgrade the AC to "the spec exercises the publisher path" without the cross-task dependency claim, or (b) require the executor to escalate to HUMAN_NEEDED rather than silently take the documented fallback. Consider adding to the planner skill a rule: "fallback authorizations must be checked against every AC's verification predicate; if any predicate would no longer hold under the fallback, the AC must be revised or the fallback removed."
- **resolved_by:** 

## FIND-SPRINT-016-1
- **source:** TASK-599 (verifier)
- **type:** claude-md
- **severity:** medium
- **status:** open
- **location:** docs/CODE-PATTERNS.md (or AGENTS.md/CLAUDE.md executor guidance)
- **description:** TASK-599 executor reported the implementation complete with `test_strategy.needed: false` because `preload.ts` has no sibling test file, then skipped running `pnpm --filter main typecheck`. The committed change introduced a real TS error (`src/preload.ts(627,60): error TS2345 — wrapper type incompatible with Map value type`). The executor's "no sibling tests → no verification" inference is wrong for files that are still typechecked at the workspace level. CLAUDE.md lists `pnpm typecheck` in Common Commands but does not explicitly tell executors to run it after editing `main/src/preload.ts` or similar untested-but-type-checked files.
- **suggested_action:** Add an executor guidance line: "When modifying TS files that lack sibling tests, you must still run the workspace `typecheck` (and `lint`) for that workspace before claiming completion." Consider codifying it under TypeScript Rules in CLAUDE.md.
- **resolved_by:** 

## FIND-SPRINT-016-3
- **source:** SPRINT-016 (sprint-code-reviewer)
- **type:** improvement
- **severity:** medium
- **status:** open
- **location:** main/src/orchestrator/runLauncher.ts:58-60 and frontend/src/utils/cyboflowApi.ts:28-33
- **description:** Cross-task event-shape contract mismatch between TASK-602 publisher and the frontend StreamEvent type. The StreamEventPublisher interface defined in runLauncher.ts emits events shaped { type, payload, timestamp } — no top-level runId. RunLauncher.launch publishes { type: 'run_started', payload: { runId, worktreePath, branchName }, timestamp } with runId nested in payload only. But cyboflowApi.StreamEvent (consumed by RunView via useCyboflowStore.appendStreamEvent) declares { runId: string; type: string; payload: unknown; timestamp: string } — runId is a top-level required field. The renderer therefore receives StreamEvent objects whose .runId is undefined and the runId is only discoverable inside .payload. Today nothing in the UI reads event.runId (RunView only renders JSON.stringify of the whole event), so the mismatch is silent — but any future code that filters by event.runId will see undefined. The IPC channel already encodes runId in its name (cyboflow:stream:<runId>) so this is fine semantically; the bug is in the type contract.
- **suggested_action:** Pick one source of truth. Either (a) extend StreamEventPublisher.publish event arg to require runId at the top level and update runLauncher.launch to populate it from the runId parameter it already has; or (b) drop runId from cyboflowApi.StreamEvent since the subscription already binds to a per-runId channel and the field is redundant. Option (b) is simpler and aligns with the channel-as-discriminator design. Consider extracting a shared type from shared/types/ so both sides import the same shape.
- **resolved_by:** 






Suspected tasks: TASK-602 (introduced StreamEventPublisher and the synthetic run_started emit) — TASK-602 also owns the frontend cyboflowApi consumer side, but the two halves were defined in separate commits without a cross-check.

## FIND-SPRINT-016-4
- **source:** SPRINT-016 (sprint-code-reviewer)
- **type:** improvement
- **severity:** medium
- **status:** open
- **location:** main/src/preload.ts:608-652
- **description:** Pattern drift: TASK-599 introduced a new wrapper-storage pattern (top-level electronListenerWrappers Map<channel, Map<callback, wrapper>>) for the electron.on/off contextBridge pair, but main/src/preload.ts already uses a different, simpler pattern everywhere else. Every other event subscription in this file (28+ sites in electronAPI.events.*, dashboard.onUpdate/onSessionUpdate, etc.) follows the closure-capture pattern from the Crystal baseline:
- **suggested_action:** Document the contract distinction in a comment near electronListenerWrappers: the Map pattern is needed because electron.on/off exposes raw (channel, callback) register/unregister surfaces that survive across separate IPC bridge calls, whereas events.* exposes per-subscription factories that can capture the wrapper in a closure. Consider whether the electron.on/off surface itself is the right design — if it were redesigned to return a cleanup function (matching events.*), the wrapper map could be deleted entirely. If the surface must stay as-is for tRPC-electron compatibility, document that in the comment so future contributors don't propose collapsing the patterns.
- **resolved_by:** 





  onX: (callback) => {
    const wrappedCallback = (_event, data) => callback(data);
    ipcRenderer.on(channel, wrappedCallback);
    return () => ipcRenderer.removeListener(channel, wrappedCallback);
  }

This returns the cleanup closure directly to the caller — no global registry, no two-level map, no delete-on-empty bookkeeping. The new electron.on/off pair instead exposes a register-then-unregister-by-callback contract (forced by the contextBridge boundary where callbacks survive across calls), which is why a wrapper map is needed.

The two patterns now coexist in the same file: events.* uses closures, electron.on/off uses a global Map. A new contributor adding another contextBridge event listener won't know which pattern to follow.

Suspected tasks: TASK-599 (introduced electronListenerWrappers Map). The fix commit 22d16ce widened the wrapper-map value type to admit IpcRendererEvent — the type widening would not have been needed if the closure pattern had been used.

## FIND-SPRINT-016-5
- **source:** SPRINT-016 (sprint-code-reviewer)
- **type:** improvement
- **severity:** medium
- **status:** open
- **location:** main/src/ipc/cyboflow.ts:74-83
- **description:** TASK-610's makeLoggerLike stringifies context via JSON.stringify and appends to the message string, which silently drops Error stack traces and bloats log lines. The wrapped Logger branch does:
- **suggested_action:** Two options: (1) Teach the underlying Logger to accept a context object as a second arg and route it there directly (preferred — preserves structure and lets log sinks index fields). (2) If the Logger.{info,warn,error} signature truly only accepts (message, Error?), then before JSON.stringify, walk the context and replace Error instances with { message, stack } objects so they survive serialization. Also consider only stringifying when ctx has more than 0 keys to avoid trailing ' {}' on the message.
- **resolved_by:** 




  info:  (msg, ctx?) => logger.info(ctx ? `${msg} ${JSON.stringify(ctx)}` : msg),
  error: (msg, ctx?) => logger.error(ctx ? `${msg} ${JSON.stringify(ctx)}` : msg),
  ...

Callers in main/src/orchestrator/* commonly pass error bags like:

  this.logger.error('RunLauncher: launch failed', { runId, workflowId, error: errMsg });
  this.logger.error('RunLauncher: failed to mark run as failed after launch error', { runId, originalError: errMsg, dbError: dbErr instanceof Error ? dbErr.message : String(dbErr) });

but also (in workflowRegistry.ts:236):

  this.logger.error(msg, { path, error: err instanceof Error ? err.message : String(err) });

JSON.stringify(new Error('x')) returns '{}' — Error objects do not serialize their message or stack via JSON.stringify. The current implementation already string-extracts .message before stringifying, which avoids the empty-object case for these specific call sites, but every future caller who passes a raw Error (or a deeply-nested object containing one) will lose data silently. The fallback console branch (lines 65-70) correctly passes ctx as a second arg to console.error, which native console handles structurally. Only the wrapped-Logger branch flattens to a string.

Suspected tasks: TASK-610 (introduced the JSON.stringify wrapping).

## FIND-SPRINT-016-6
- **source:** SPRINT-016 (sprint-code-reviewer)
- **type:** improvement
- **severity:** medium
- **status:** open
- **location:** main/src/orchestrator/workflowRegistry.ts:128-153
- **description:** @cyboflow-hidden annotation applied to actively-called code. TASK-601 marked DEFAULT_SOLOFLOW_WORKFLOWS with: '@cyboflow-hidden — TASK-610 owns cyboflow.ts and will replace this compat shim with a direct call to buildDefaultSoloFlowWorkflows() + resolveSoloFlowPluginRoot(). Remove this export when that task lands.'
- **suggested_action:** Either (a) remove the @cyboflow-hidden marker and replace with a plain TODO/@deprecated JSDoc tag describing the migration plan, or (b) actually do the migration: change cyboflow.ts:155 to call buildDefaultSoloFlowWorkflows(resolveSoloFlowPluginRoot(os.homedir()).root) directly and delete the DEFAULT_SOLOFLOW_WORKFLOWS export. Option (b) is the intent expressed in the comment and is a small, mechanical change. Also reaffirm in CLAUDE.md / CODE-PATTERNS.md that @cyboflow-hidden is not a TODO-tracking mechanism.
- **resolved_by:** 



But DEFAULT_SOLOFLOW_WORKFLOWS is actively imported and used at runtime: main/src/ipc/cyboflow.ts:19 — `import { ..., DEFAULT_SOLOFLOW_WORKFLOWS } from '../orchestrator/workflowRegistry'`; and main/src/ipc/cyboflow.ts:155 — `DEFAULT_SOLOFLOW_WORKFLOWS.map((wf) => ({ ... }))`.

The @cyboflow-hidden convention (CLAUDE.md and docs/CODE-PATTERNS.md) is reserved for code that is intentionally unreachable in v1 — either Crystal-baseline preserved for future re-enablement OR a forward-looking placeholder awaiting a later integration task. CLAUDE.md explicitly says: 'Do NOT add the marker to actively-called code.'

The TASK-601 author appears to have used @cyboflow-hidden as a TODO marker (planned to be cleaned up by TASK-610), but TASK-610 actually shipped without doing that cleanup — cyboflow.ts:155 still uses the compat shim. So the marker is now (a) on actively-called code and (b) the planned cleanup never happened.

Suspected tasks: TASK-601 (added the marker), TASK-610 (was expected to remove it but did not — only added the logger fix).

## FIND-SPRINT-016-7
- **source:** SPRINT-016 (sprint-code-reviewer)
- **type:** improvement
- **severity:** low
- **status:** open
- **location:** main/src/preload.ts:621-651
- **description:** Duplicated whitelist literal in electron.on and electron.off. Both branches declare:
- **suggested_action:** Hoist a single module-level constant: `const VALID_ELECTRON_CHANNELS = new Set(['permission:request']);` plus a helper `isAllowedElectronChannel(channel: string): boolean { return VALID_ELECTRON_CHANNELS.has(channel) || channel.startsWith('cyboflow:stream:'); }`. Use it in both on() and off(). Future additions touch a single place.
- **resolved_by:** 


  const validChannels = [
    'permission:request'
  ];
  if (validChannels.includes(channel) || channel.startsWith('cyboflow:stream:')) {

The array literal is identical across the two functions, and the prefix check 'cyboflow:stream:' is also duplicated. If a future task adds another whitelisted channel, the contributor must remember to update both arrays — easy to miss because they live 13 lines apart. Suspected tasks: TASK-599 introduced the cyboflow:stream: prefix in both sites.

## FIND-SPRINT-016-8
- **source:** SPRINT-016 (sprint-code-reviewer)
- **type:** improvement
- **severity:** low
- **status:** open
- **location:** main/src/orchestrator/workflowRegistry.ts:60-105
- **description:** resolveSoloFlowPluginRoot emits a console.warn for the fallback path while the rest of the orchestrator subsystem uses an injected LoggerLike. The comment on line 55 acknowledges the gap: 'this function does not own a logger instance'. But the same module's WorkflowRegistry class does receive a LoggerLike, and the DEFAULT_SOLOFLOW_WORKFLOWS IIFE on lines 147-153 runs the resolver at module-import time before any logger exists. Module-level eager evaluation forces the console.warn rather than a structured log; it also makes the resolver impossible to silence in tests without spying on console (which the new tests in workflowRegistry.test.ts do via vi.spyOn(console, 'warn')). Suspected tasks: TASK-601 (introduced both resolveSoloFlowPluginRoot and the module-eager IIFE).
- **suggested_action:** Two changes: (1) Accept an optional `logger?: LoggerLike` parameter on resolveSoloFlowPluginRoot and use logger.warn when provided, falling back to console.warn only when no logger is passed. (2) Make DEFAULT_SOLOFLOW_WORKFLOWS lazy — convert from an exported constant to an exported function that takes a homeDir (and optional logger) and is invoked from the IPC handler. This also eliminates the @cyboflow-hidden compat-shim concern from FIND-SPRINT-016-6.
- **resolved_by:** 
