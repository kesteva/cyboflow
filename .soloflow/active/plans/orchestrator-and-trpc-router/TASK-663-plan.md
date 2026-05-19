---
id: TASK-663
idea: IDEA-018
status: ready
created: 2026-05-19T00:00:00Z
files_owned:
  - main/src/orchestrator/runExecutor.ts
  - main/src/orchestrator/runEventBridge.ts
  - main/src/orchestrator/__tests__/runExecutor.test.ts
files_readonly:
  - main/src/services/panels/claude/claudeCodeManager.ts
  - main/src/orchestrator/approvalRouter.ts
  - main/src/orchestrator/preToolUseHookHelper.ts
  - main/src/services/panels/cli/AbstractCliManager.ts
  - main/src/index.ts
  - shared/types/workflows.ts
acceptance_criteria:
  - criterion: "RunExecutor.execute() passes panelId === runId (no `run-` prefix) to ClaudeSpawnerLike.spawnCliProcess"
    verification: "grep -n \"panelId = `run-\\${runId}`\" main/src/orchestrator/runExecutor.ts returns 0 matches; grep -n 'const panelId = runId' main/src/orchestrator/runExecutor.ts returns at least 1 match"
  - criterion: "RunExecutor.execute() passes sessionId === runId to ClaudeSpawnerLike.spawnCliProcess"
    verification: "grep -n \"sessionId = `run-\\${runId}`\" main/src/orchestrator/runExecutor.ts returns 0 matches; grep -n 'const sessionId = runId' main/src/orchestrator/runExecutor.ts returns at least 1 match"
  - criterion: "The runEventBridge docblock at lines 11-14 no longer warns about the panelId/runId mismatch — the FIND-SPRINT-021-4 note is removed and replaced with the post-fix invariant statement (`panelId === runId === sessionId` is now the contract)"
    verification: "grep -n 'FIND-SPRINT-021' main/src/orchestrator/runEventBridge.ts returns 0 matches; grep -n 'panelId === runId === sessionId' main/src/orchestrator/runEventBridge.ts returns at least 1 match"
  - criterion: "Existing RunExecutor test (e) now asserts panelId === run.id (not `run-${run.id}`) and passes"
    verification: "grep -n \"toBe(`run-\\${run.id}`)\" main/src/orchestrator/__tests__/runExecutor.test.ts returns 0 matches inside the test labeled '(e)'; pnpm --filter main test -- runExecutor exits 0"
  - criterion: "A new integration test ('panelId/runId alignment') exercises a real-ish wiring: it constructs a RunExecutor with an EventEmitter source, fires an 'output' event whose payload.panelId === runId, and asserts (a) the bridge processed the event (RawEventsSink INSERT row exists) and (b) the onFirstMessage callback fired exactly once"
    verification: "grep -n 'panelId/runId alignment' main/src/orchestrator/__tests__/runExecutor.test.ts returns at least 1 match; pnpm --filter main test -- runExecutor exits 0"
  - criterion: "pnpm --filter main typecheck exits 0 (no new 'electron' or 'better-sqlite3' imports introduced into main/src/orchestrator/runExecutor.ts; standalone-typecheck invariant preserved)"
    verification: "pnpm --filter main typecheck exits 0; grep -nE \"from 'electron'|from 'better-sqlite3'\" main/src/orchestrator/runExecutor.ts returns 0 matches"
  - criterion: "pnpm --filter main test exits 0 (no regression in runEventBridge, runExecutor, approvalRouter test suites)"
    verification: "pnpm --filter main test exits 0"
depends_on: []
estimated_complexity: medium
epic: orchestrator-and-trpc-router
test_strategy:
  needed: true
  justification: "Direct contract change with two existing test suites that pin the wrong invariant — the sibling test runExecutor.test.ts at lines 187-188 explicitly asserts panelId === `run-${run.id}`, which becomes the bug to lock in if not updated. Plus the integration scenario (bridge sees event, status flip happens) was the gap that hid this bug at sprint-level."
  targets:
    - behavior: "RunExecutor.execute synthesises panelId === runId === sessionId (no `run-` prefix) and passes both to spawnCliProcess"
      test_file: "main/src/orchestrator/__tests__/runExecutor.test.ts"
      type: unit
    - behavior: "Integration: RunExecutor wired with a real RunEventBridge + EventEmitter source receives an 'output' event whose payload.panelId === runId, INSERTs the raw_events row, fires onFirstMessage exactly once, and the resulting lifecycle transition `running` is invoked"
      test_file: "main/src/orchestrator/__tests__/runExecutor.test.ts"
      type: integration
---

# Fix panelId/runId mismatch in RunExecutor that prevents runs from reaching `running` status

## Objective

`RunExecutor.execute()` currently synthesises `panelId = "run-${runId}"` and `sessionId = "run-${runId}"` at `main/src/orchestrator/runExecutor.ts:181-182`. The downstream bridge filter at `main/src/orchestrator/runEventBridge.ts:158` requires `p.panelId === runId` (raw runId, no prefix), so the prefixed panelId never matches and no event is forwarded. This has two cascading production failures: (1) `onFirstMessage` never fires, so `workflow_runs.status` is stuck at `starting` forever; (2) the PreToolUse hook routes approvals through `ApprovalRouter.requestApproval(panelId, ...)`, whose guarded `UPDATE workflow_runs ... WHERE id = ?` then matches zero rows and throws `RunNotRunningError`, denying every tool call. Aligning panelId/sessionId to runId restores the invariant `panelId === runId === sessionId` that the rest of the orchestrator already assumes.

## Implementation Steps

1. **Pre-flight grep** — confirm the full blast radius of the prefix string. Run `grep -rn 'run-\\${runId}' main/src/orchestrator/` and `grep -rn '\`run-\${runId}\`' main/src/orchestrator/`; record matches. Expected hits: `runExecutor.ts:181-182` only.
2. **Edit `main/src/orchestrator/runExecutor.ts` lines 179-182.** Replace:
   ```ts
   // Deterministic synthetic identifiers — panelId and sessionId are derived
   // from runId so ClaudeCodeManager can track them without a separate lookup.
   const panelId = `run-${runId}`;
   const sessionId = `run-${runId}`;
   ```
   with:
   ```ts
   // Invariant: panelId === runId === sessionId across the orchestrator surface.
   // The bridge filter at runEventBridge.ts:158 keys on raw runId; ApprovalRouter's
   // workflow_runs UPDATE keys on runId. Any other value here silently breaks both.
   const panelId = runId;
   const sessionId = runId;
   ```
3. **Verify `ClaudeSpawnerLike.spawnCliProcess` accepts the plain runId.** Read `main/src/services/panels/claude/claudeCodeManager.ts:212-314` (`spawnCliProcess` + `runSdkQuery`). The implementation already uses `panelId` as an opaque key into `this.processes` / `this.sdkRuns` / `this.pipelines`, and `runSdkQuery` sets `const runId = panelId;` at line 328 — so dropping the `run-` prefix is a pure pass-through with no contract change downstream. No edits required here; this step is a read-only verification.
4. **Update `main/src/orchestrator/runEventBridge.ts` lines 11-14.** Replace the FIND-SPRINT-021-4 mismatch note with an INVARIANT note: `panelId === runId === sessionId` is the contract every consumer (ApprovalRouter UPDATE, RawEventsSink run_id column, onFirstMessage) relies on.
5. **Edit `main/src/orchestrator/__tests__/runExecutor.test.ts` lines 187-188 (test labeled `(e)`).** Replace:
   ```ts
   expect(opts.panelId).toBe(`run-${run.id}`);
   expect(opts.sessionId).toBe(`run-${run.id}`);
   ```
   with:
   ```ts
   expect(opts.panelId).toBe(run.id);
   expect(opts.sessionId).toBe(run.id);
   ```
6. **Add a new integration test** at the end of `main/src/orchestrator/__tests__/runExecutor.test.ts`, in a new `describe('panelId/runId alignment — integration with RunEventBridge', ...)` block. The test must:
   - Construct a `new Database(':memory:')` with the same `raw_events` DDL used in `runEventBridge.test.ts:32-40` (FK enforcement OFF).
   - Construct an `EventEmitter` as the source.
   - Build a `lifecycleTransitions` spy that records calls to `running(runId)`.
   - Build a publisher spy and a logger spy.
   - Construct `TestableRunExecutor` (the existing test subclass at line 91) with all collaborators wired, including the source and rawDb so `bridgeEvents` is active.
   - Mock the spawner so `spawnCliProcess` synchronously calls `source.emit('output', { panelId: <runId>, sessionId: <runId>, type: 'json', data: <systemEvent>, timestamp: new Date() })` before resolving, simulating the SDK iterator's first event.
   - Await `executor.execute(run.id)`.
   - Assert: (a) `SELECT COUNT(*) FROM raw_events WHERE run_id = ?` returns 1 (or 0 once TASK-664's skipPersistence guard lands — coordinate with TASK-664's tightened assertion), (b) `lifecycleTransitions.running` was called once with `run.id`, (c) `publisher.publish` was called once with `run.id` as the first argument.
7. **Run the tests.** `pnpm --filter main test -- runExecutor` and `pnpm --filter main test -- runEventBridge` must both exit 0.
8. **Final completeness gate.** Re-run step 1's grep — `grep -rn 'run-\\${runId}' main/src/orchestrator/` must return 0 matches. Then `pnpm --filter main typecheck` must exit 0.

## Acceptance Criteria

See frontmatter. The two grep ACs encode the structural invariant; the integration-test AC encodes the behavioural invariant that the sprint-level verifier should have caught.

## Test Strategy

- **Unit (existing test (e) at lines 173-191):** flip the assertions to `expect(opts.panelId).toBe(run.id)` and `expect(opts.sessionId).toBe(run.id)`. Without this flip, the corrected production code would fail the existing test — that test currently pins the bug.
- **Integration (new):** the gap surfaced by FIND-SPRINT-021-4 was that no test wired the bridge + executor together with a real EventEmitter. The new integration test reproduces the path that production takes (bridge attached BEFORE spawn, spawn-time emit on the source, bridge processes it, status flips to `running`). Use `Database(':memory:')` + `foreign_keys = OFF`.

## Hardest Decision

Whether to verify ClaudeCodeManager end-to-end with a real spawner or stay at the spawner-stub level. Stub-level integration is the cheapest test that would have caught FIND-SPRINT-021-4.

## Rejected Alternatives

- **Option B: keep the `run-` prefix everywhere and instead change the bridge filter to accept `panelId === \`run-${runId}\`` and ApprovalRouter to strip the prefix.** Rejected — propagates the prefix to two more consumers, each needing its own un-prefix logic.
- **Option C: introduce a `derivePanelIdFromRunId(runId)` helper.** Rejected as premature — the function would be the identity function.

## Lowest Confidence Area

The integration test's spawner mock emits the 'output' event synchronously inside `spawnCliProcess`. In production the SDK iterator drives the emit asynchronously. The shortcut is acceptable because `bridgeEvents` is attached BEFORE `spawnCliProcess` is called, but a reviewer should sanity-check the spawner mock's emit happens before its `Promise<void>` resolves.
