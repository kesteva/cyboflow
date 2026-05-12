---
id: TASK-355
idea: IDEA-008
status: ready
created: 2026-05-11T00:00:00Z
files_owned:
  - tests/cyboflow-day3-gate.spec.ts
  - tests/fixtures/cyboflow-day3-gate/sprint-prompt.md
  - tests/fixtures/cyboflow-day3-gate/prune-prompt.md
  - tests/helpers/cyboflowTestHarness.ts
files_readonly:
  - main/src/orchestrator/workflowRegistry.ts
  - main/src/orchestrator/runLauncher.ts
  - main/src/orchestrator/mcpConfigWriter.ts
  - main/src/services/worktreeManager.ts
  - main/src/services/panels/claude/claudeCodeManager.ts
  - frontend/src/utils/cyboflowApi.ts
  - frontend/src/stores/cyboflowStore.ts
  - docs/cyboflow_system_design.md
  - .soloflow/active/roadmaps/ROADMAP-001.md
acceptance_criteria:
  - criterion: "Test `tests/cyboflow-day3-gate.spec.ts > two runs in different workflows can be approved out of order` starts a sprint run and a prune run, waits for both to reach `awaiting_review` status, approves the PRUNE run first via direct call to the approval-router (NOT through any queue UI), then approves the SPRINT run, and asserts both runs reach `running` status after their respective approvals"
    verification: "Run `pnpm test tests/cyboflow-day3-gate.spec.ts` (or whichever Playwright/vitest invocation the test uses). Exit code is 0. The test must not be marked .skip or .todo. The test body uses both `workflows: 'sprint'` AND `workflows: 'prune'` strings literally."
  - criterion: "The approval ordering is enforced by the test: prune is approved at wall-clock time T1 and sprint at T2 where T2 > T1, AND between T1 and T2 the sprint run's status is verified to still be `awaiting_review` (not `running`, not `failed`). This proves the two runs are genuinely independent."
    verification: "Read the test body: there is an explicit `expect(sprintStatus).toBe('awaiting_review')` assertion AFTER the prune approval and BEFORE the sprint approval. grep -n \"toBe\\('awaiting_review'\\)\" tests/cyboflow-day3-gate.spec.ts returns at least 1 match."
  - criterion: "After the sprint approval is granted, the test asserts the sprint run's Claude PTY received a permission-allow reply on the socket and continued producing stream events (the run view's streamEvents array grows after approval)"
    verification: "Read the test body: there is an assertion that after `approveRun({ runId: sprintRunId, decision: 'allow' })` is called, the sprint run's status transitions to `running` AND at least one new stream event is observed for the sprint run. The test waits with a reasonable timeout (≤30s) and reports a clear failure message if either condition fails."
  - criterion: "The test does NOT depend on the not-yet-built ReviewQueueView UI — it invokes the approval action via a direct programmatic call (cyboflowApi.approveRun or, if that IPC handler is still a stub, a direct call into the main-process ApprovalRouter via electron debug-channel)"
    verification: "grep -n 'ReviewQueueView\\|<PendingApprovalCard' tests/cyboflow-day3-gate.spec.ts returns 0 matches. grep -n 'approveRun\\|ApprovalRouter' returns at least 1 match."
  - criterion: "The two test fixture prompt files exist and are short, deterministic prompts that reliably trigger a tool-use approval on the first turn (e.g. asking Claude to run `git status` so a Bash tool-use lands immediately)"
    verification: "Files tests/fixtures/cyboflow-day3-gate/sprint-prompt.md and tests/fixtures/cyboflow-day3-gate/prune-prompt.md both exist. Each contains a single-paragraph prompt that asks Claude to invoke a Bash tool (the test asserts both prompts include the literal string 'Bash' or '`git status`' or 'run a command')."
  - criterion: "The test uses a real Claude Code binary if available in PATH; if Claude Code is not available, the test must SKIP with a clear `test.skip` and a printable reason, NOT fail. This keeps CI green for environments where Claude isn't installed while still making the test the canonical day-3 gate when run locally by the developer."
    verification: "Read the test body: there is a `test.skip()` or `test.skipIf()` guard at the start that checks `findExecutableInPath('claude')` and reports 'Claude Code CLI not in PATH — skipping day-3 gate test' when absent. The test is marked PASSING (not erroring) in environments without Claude."
  - criterion: "The test uses a real temporary git repo (created via execSync `git init` in a temp dir), seeds two SoloFlow workflows (sprint + prune) against it, and tears down the repo + worktrees + database state afterwards"
    verification: "Read the test body: `beforeEach` and `afterEach` (or `beforeAll`/`afterAll`) hooks create and clean up a temp dir with git init and clean up DB. grep -n 'git init\\|fs.rm\\|fsExtra.remove' tests/cyboflow-day3-gate.spec.ts returns at least 2 matches across setup and teardown."
  - criterion: "`tests/helpers/cyboflowTestHarness.ts` exposes a `launchPair(workflowA, workflowB, projectPath)` helper that returns `{ runIdA, runIdB, waitForAwaitingReview(runId), approveRun(runId, decision), getStatus(runId), getStreamEvents(runId) }` — the harness is the only file that touches the orchestrator internals, so the test body itself stays declarative."
    verification: "Read tests/helpers/cyboflowTestHarness.ts; assert the exported `launchPair` function signature matches; grep -n 'waitForAwaitingReview\\|approveRun\\|getStatus' tests/helpers/cyboflowTestHarness.ts returns at least 3 matches."
depends_on: [TASK-354]
estimated_complexity: high
epic: workflow-runs-and-day3-gate
test_strategy:
  needed: true
  justification: "This task IS the test. Per the IDEA description and design doc §7, this is THE EXPLICIT MILESTONE TEST — if it passes the fork-path bet is validated; if it fails the greenfield reset is on the table. The test is the deliverable, not a side artifact."
  targets:
    - behavior: "two runs in different workflows can be paused on tool-use approvals and approved in any order"
      test_file: "tests/cyboflow-day3-gate.spec.ts"
      type: integration
prerequisites:
  - check: "command -v claude >/dev/null 2>&1"
    fix: "Install Claude Code CLI: https://docs.anthropic.com/en/docs/claude-code/overview"
    description: "Day-3 gate test spawns real Claude Code processes; without the CLI the test skips (does not fail) but the gate is not actually verified."
    blocking: false
  - check: "command -v git >/dev/null 2>&1"
    fix: "Install git via Xcode command line tools: xcode-select --install"
    description: "Test creates a temp git repo via `git init`; git is also required by WorktreeManager."
    blocking: true
  - check: "test -f main/dist/services/mcpPermissionBridge.js || test -f main/src/services/mcpPermissionBridge.ts"
    fix: "Run `pnpm build:main` to compile the main process, or ensure mcpPermissionBridge.ts exists in source"
    description: "The per-run .mcp.json references the bridge script path; if the build artifact (or, for dev, the source) is missing, Claude cannot spawn the bridge and the gate cannot run."
    blocking: true
---

# Day-3 Gate Test: Two Parallel Runs, Approve Out of Order

## Objective

Ship the explicit milestone test that validates the entire Phase 1 substrate. Start a sprint run and a prune run; both reach `awaiting_review` when Claude requests a tool use; approve the prune one FIRST via direct programmatic call (the queue UI does not yet exist); verify the sprint run remains paused; approve the sprint run SECOND; verify both runs resume independently with their Claude PTYs receiving the correct socket replies. The test's pass/fail is the day-3 gate — if it fails, per the brief's risk tolerance, the greenfield reset is on the table.

## Implementation Steps

1. **Create `tests/helpers/cyboflowTestHarness.ts`** as the orchestrator-internals adapter. The test body should be declarative; the harness encapsulates the messy bits:
   ```ts
   export interface CyboflowTestHarness {
     launchPair(args: { projectPath: string; workflowA: 'sprint' | 'prune'; workflowB: 'sprint' | 'prune'; promptA: string; promptB: string; }): Promise<{ runIdA: string; runIdB: string; }>;
     waitForAwaitingReview(runId: string, timeoutMs?: number): Promise<{ approvalId: string }>;
     approveRun(runId: string, approvalId: string, decision: 'allow' | 'deny'): Promise<void>;
     getStatus(runId: string): string;
     getStreamEventCount(runId: string): number;
     teardown(): Promise<void>;
   }

   export async function createHarness(): Promise<CyboflowTestHarness> { /* ... */ }
   ```
   - `launchPair` instantiates a fresh `WorkflowRegistry`, `WorktreeManager`, `RunLauncher`, `McpConfigWriter`, and the ApprovalRouter (from epic 7) bound to an in-test orchestrator socket. It seeds the two workflows pointing at the fixture prompt files. It calls `runLauncher.launch(workflowId, projectPath)` twice and triggers the Claude spawn for each.
   - The actual Claude spawn integration (calling `ClaudeCodeManager.spawnCliProcess` with the runs' worktreePath, the new `strictMcpConfig: true` option, and the prompt from the fixture .md file) is composed inside the harness. This is the only place the orchestrator's full launch flow is exercised end-to-end before epic 6's tRPC router lands.
   - `waitForAwaitingReview` polls `SELECT status, (SELECT id FROM approvals WHERE run_id = ? AND status = 'pending' LIMIT 1) AS approval_id FROM workflow_runs WHERE id = ?` until status='awaiting_review' AND approval_id IS NOT NULL, with a default 60s timeout. Returns the approvalId.
   - `approveRun` calls the ApprovalRouter directly (`approvalRouter.decide(runId, approvalId, 'allow' | 'deny')`) — bypasses any UI. This is the day-3 gate's defining property: the test runs without a queue UI.
   - `getStatus` reads `workflow_runs.status` from the DB.
   - `getStreamEventCount` reads `SELECT COUNT(*) FROM raw_events WHERE run_id = ?`.
   - `teardown` kills any live PTYs, removes worktrees, deletes the test DB, removes the temp project dir.

2. **Create fixture prompts** under `tests/fixtures/cyboflow-day3-gate/`:
   - `sprint-prompt.md`: a single short prompt that reliably triggers a Bash tool call on Claude's first turn. Example body: `"Run \`git status\` using the Bash tool and report the output."`
   - `prune-prompt.md`: another short prompt that also triggers a Bash tool call. Example body: `"Run \`git log --oneline -5\` using the Bash tool and report the output."`

   These prompts intentionally use the Bash tool because: (a) the Bash tool is universally available, (b) it always triggers the permission-prompt-tool path in `approve` mode, (c) the commands are read-only so no actual side effects occur in the test repo.

3. **Create `tests/cyboflow-day3-gate.spec.ts`**. Skeleton:
   ```ts
   import { describe, test, expect, beforeAll, afterAll } from 'vitest'; // or playwright/test
   import { execSync } from 'child_process';
   import * as fs from 'fs';
   import * as path from 'path';
   import * as os from 'os';
   import { createHarness, CyboflowTestHarness } from './helpers/cyboflowTestHarness';
   import { findExecutableInPath } from '../main/src/utils/shellPath';

   describe('Day-3 gate: two runs in different workflows can be approved out of order', () => {
     let harness: CyboflowTestHarness;
     let projectPath: string;
     const claudeAvailable = !!findExecutableInPath('claude');

     beforeAll(async () => {
       if (!claudeAvailable) return;
       projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'cyboflow-day3-'));
       execSync('git init', { cwd: projectPath });
       execSync('git commit --allow-empty -m "init"', { cwd: projectPath });
       harness = await createHarness();
     });

     afterAll(async () => {
       if (harness) await harness.teardown();
       if (projectPath) fs.rmSync(projectPath, { recursive: true, force: true });
     });

     test.skipIf(!claudeAvailable)('approves prune first, sprint remains paused, then sprint approves and resumes', async () => {
       const sprintPrompt = fs.readFileSync(path.join(__dirname, 'fixtures/cyboflow-day3-gate/sprint-prompt.md'), 'utf-8');
       const prunePrompt = fs.readFileSync(path.join(__dirname, 'fixtures/cyboflow-day3-gate/prune-prompt.md'), 'utf-8');

       const { runIdA: sprintRunId, runIdB: pruneRunId } = await harness.launchPair({
         projectPath, workflowA: 'sprint', workflowB: 'prune',
         promptA: sprintPrompt, promptB: prunePrompt,
       });

       const sprintApproval = await harness.waitForAwaitingReview(sprintRunId);
       const pruneApproval  = await harness.waitForAwaitingReview(pruneRunId);

       // Approve prune FIRST
       const t1 = Date.now();
       await harness.approveRun(pruneRunId, pruneApproval.approvalId, 'allow');

       // While prune is processing the approval, sprint must remain awaiting_review
       const sprintStatusMid = harness.getStatus(sprintRunId);
       expect(sprintStatusMid).toBe('awaiting_review');

       // Approve sprint SECOND
       await harness.approveRun(sprintRunId, sprintApproval.approvalId, 'allow');
       const t2 = Date.now();
       expect(t2).toBeGreaterThan(t1);

       // Both should now resume; assert each transitions back to 'running' (or beyond, e.g., 'completed')
       await waitFor(() => ['running','completed'].includes(harness.getStatus(sprintRunId)), 30000);
       await waitFor(() => ['running','completed'].includes(harness.getStatus(pruneRunId)), 30000);

       // Assert stream events continue to arrive after approval (each run made progress past the approval)
       const sprintBefore = harness.getStreamEventCount(sprintRunId);
       await new Promise(r => setTimeout(r, 1000));
       const sprintAfter = harness.getStreamEventCount(sprintRunId);
       expect(sprintAfter).toBeGreaterThan(sprintBefore);
     }, 120000);
   });

   async function waitFor(cond: () => boolean, timeoutMs: number): Promise<void> { /* poll with 200ms interval */ }
   ```

4. **Skip-on-missing-Claude semantics.** The test ALWAYS exits 0 on the test framework — either it passes (Claude available + gate works) or it skips (Claude not available). It NEVER fails on a missing Claude binary. The skip message is printed via `console.log` so CI logs make it obvious whether the gate was actually run. The developer running this locally (with Claude installed) is the canonical day-3 gate scenario.

5. **Test framework choice.** Use **vitest** (already configured in `main/package.json`) running from the repo root with a custom config that includes `tests/` and the helper. The Playwright suites under `tests/` are for end-to-end Electron UI flows; the day-3 gate is a main-process orchestrator integration test that does not need a real Electron window — vitest is the right fit. If running vitest against the `tests/` folder isn't yet wired, add `"test:gate": "vitest --config vitest.config.gate.ts tests/cyboflow-day3-gate.spec.ts"` to the root `package.json` scripts. The config file (if needed) is a new owned artifact — add to `files_owned` if it ends up required.

6. **Cleanup discipline.** The test MUST tear down its Claude PTY processes, MCP bridge subprocesses, worktrees, temp project dir, and any database rows it inserted. `afterAll` and the `teardown()` method are responsible. Leaked PTYs in CI will hang subsequent test runs.

7. **Re-run determinism.** The two prompts are read-only Bash commands; running the test multiple times against the same temp project does not accumulate state because each run gets a fresh `mkdtempSync` directory. No flakiness is acceptable; if the test fails intermittently due to Claude timing (e.g., `awaiting_review` not reached within 60s), the harness's poll timeout is bumped — the test itself is allowed up to 120s total.

## Acceptance Criteria

See frontmatter. The 8 criteria together encode the gate: two runs, approve out of order, sprint remains paused between approvals, both resume independently with stream events flowing, all without depending on any UI that has not yet been built.

## Test Strategy

This task IS the test. The day-3 gate is the integration that exercises every previous task end-to-end. If any of TASK-351 through TASK-354 has a regression, this test will fail with a localizable error (the harness's poll-and-assert pattern gives specific failure points).

## Hardest Decision

Whether to assert intermediate "sprint is still paused while prune is approving" as a strict invariant. The race condition concern: if Claude resumes the prune run instantaneously (microseconds after the socket reply), the test's `expect(sprintStatusMid).toBe('awaiting_review')` runs after both runs' approvals — false negative. Two options:
- (a) Approve both, then assert both reach `running` eventually. Cheaper, less brittle, but weaker proof.
- (b) Approve prune; assert sprint still paused via DB read; approve sprint; assert both run.

Chose (b). The DB read of `workflow_runs.status` is synchronous-fast (better-sqlite3) and happens immediately after the `approveRun(prune)` promise resolves. The prune-resume work happens asynchronously in the orchestrator (after the socket reply lands on the bridge subprocess, which is an inter-process write). The window for the assertion is wide enough (milliseconds) that the assertion is stable in practice. If empirically this assertion is flaky, fallback to (a) and document the gate as weaker.

## Rejected Alternatives

- **Use Playwright to drive the test through the actual Electron app UI.** Rejected because the queue UI is not yet built (Phase 2). The gate test must work with only the substrate that's done by end of day 3 — orchestrator + .mcp.json + minimal frontend. UI-driven approval is out of scope for the gate.
- **Mock Claude Code entirely with a fake stdio process that emits canned events.** Rejected because the gate's whole point is to prove the real fork-path Claude → bridge → socket → ApprovalRouter loop works. A mocked Claude bypasses the load-bearing primitives — a green mock test gives false confidence and would let a real-Claude regression ship to the day-3 gate undetected.
- **Run two separate test cases, one per workflow, and assume independence.** Rejected because the gate's defining property is "approve in any order while both are paused simultaneously." Sequential tests don't exercise the concurrent-pause condition. The whole risk this test addresses is whether the per-panel substrate fights workspace-scoped queuing.

## Lowest Confidence Area

Whether the test reliably reaches `awaiting_review` for both runs within the 60s harness timeout. Claude's first-turn behavior depends on the model version (default model selection in `claude -p` invocation), the prompt phrasing, and any background variability in Claude's tool-call decisions. The fixture prompts are crafted to maximize the chance of an immediate Bash tool use, but Claude could elect to describe what it would do first (a text-only response). Mitigation: if test failures localize to "timed out waiting for awaiting_review", iterate the fixture prompt wording until empirically reliable (e.g., add "First, before any analysis, run the Bash command ..."). The test is the canonical day-3 gate; tuning the prompts to keep the test reliable is part of meeting the gate, not a workaround.
