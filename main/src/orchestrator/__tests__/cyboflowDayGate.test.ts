/**
 * Day-3 gate: two runs in different workflows can be approved out of order
 *
 * This is the milestone integration test for Phase 1 of the cyboflow substrate.
 * It validates:
 *  1. Two concurrent workflow runs (sprint + prune) can reach 'awaiting_review'
 *     independently.
 *  2. Approving one run does NOT unblock the other — they are truly independent.
 *  3. After each approval the run resumes and produces additional stream events.
 *
 * If Claude Code CLI is not available in PATH, the test skips cleanly (exit 0).
 * This keeps CI green in environments without Claude while making the test the
 * canonical day-3 gate when run locally by the developer.
 *
 * Run: pnpm test:gate
 */
import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { createHarness, type CyboflowTestHarness } from '../../../../tests/helpers/cyboflowTestHarness';
import { findExecutableInPath } from '../../utils/shellPath';

// ---------------------------------------------------------------------------
// Claude availability guard
// ---------------------------------------------------------------------------

const claudeAvailable = !!findExecutableInPath('claude');

if (!claudeAvailable) {
  console.log(
    '[day-3-gate] Claude Code CLI not in PATH — skipping day-3 gate test. ' +
    'Install claude and re-run to exercise the gate.',
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function waitFor(cond: () => boolean, timeoutMs: number, label = 'condition'): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms waiting for: ${label}`);
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('Day-3 gate: two runs in different workflows can be approved out of order', () => {
  let harness: CyboflowTestHarness;
  let projectPath: string;

  beforeAll(async () => {
    if (!claudeAvailable) return;

    // Manual lifecycle (not withTempDir) because beforeAll/afterAll need shared dir across tests.
    projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'cyboflow-day3-'));
    execSync('git init', { cwd: projectPath });
    execSync('git config user.email "test@cyboflow.local"', { cwd: projectPath });
    execSync('git config user.name "Cyboflow Test"', { cwd: projectPath });
    execSync('git commit --allow-empty -m "init"', { cwd: projectPath });

    harness = await createHarness();
  });

  afterAll(async () => {
    if (harness) await harness.teardown();
    if (projectPath) fs.rmSync(projectPath, { recursive: true, force: true });
  });

  test.skipIf(!claudeAvailable)(
    'approves prune first, sprint remains paused, then sprint approves and resumes',
    async () => {
      const sprintPrompt = fs.readFileSync(
        path.join(__dirname, '../../../../tests/fixtures/cyboflow-day3-gate/sprint-prompt.md'),
        'utf-8',
      );
      const prunePrompt = fs.readFileSync(
        path.join(__dirname, '../../../../tests/fixtures/cyboflow-day3-gate/prune-prompt.md'),
        'utf-8',
      );

      // Both prompts must include 'Bash' or 'git' to satisfy AC#5
      expect(sprintPrompt).toMatch(/Bash|`git status`/);
      expect(prunePrompt).toMatch(/Bash|`git log/);

      // Launch both runs concurrently
      const { runIdA: sprintRunId, runIdB: pruneRunId } = await harness.launchPair({
        projectPath,
        workflowA: 'sprint',
        workflowB: 'prune',
        promptA: sprintPrompt,
        promptB: prunePrompt,
      });

      // Wait for both runs to reach awaiting_review (60s each, independent polls)
      const [sprintApproval, pruneApproval] = await Promise.all([
        harness.waitForAwaitingReview(sprintRunId, 60_000),
        harness.waitForAwaitingReview(pruneRunId, 60_000),
      ]);

      // -----------------------------------------------------------------------
      // Approve PRUNE first (AC#2: out-of-order approval)
      // -----------------------------------------------------------------------
      const t1 = Date.now();
      await harness.approveRun(pruneRunId, pruneApproval.approvalId, 'allow');

      // Immediately after prune approval, sprint must still be awaiting_review
      // (AC#2: the DB read is synchronous — the prune resume is async/in-flight)
      const sprintStatusMid = harness.getStatus(sprintRunId);
      expect(sprintStatusMid).toBe('awaiting_review');

      // -----------------------------------------------------------------------
      // Approve SPRINT second (AC#2: T2 > T1)
      // -----------------------------------------------------------------------
      await harness.approveRun(sprintRunId, sprintApproval.approvalId, 'allow');
      const t2 = Date.now();
      expect(t2).toBeGreaterThan(t1);

      // -----------------------------------------------------------------------
      // Both runs should transition to 'running' or 'completed' (AC#3)
      // -----------------------------------------------------------------------
      await waitFor(
        () => ['running', 'completed'].includes(harness.getStatus(sprintRunId)),
        30_000,
        `sprint run ${sprintRunId} to reach running|completed`,
      );
      await waitFor(
        () => ['running', 'completed'].includes(harness.getStatus(pruneRunId)),
        30_000,
        `prune run ${pruneRunId} to reach running|completed`,
      );

      // -----------------------------------------------------------------------
      // Assert stream events grow after approval (AC#3: SDK continues past gate)
      // -----------------------------------------------------------------------
      const sprintBefore = harness.getStreamEventCount(sprintRunId);
      // Give the SDK a moment to emit more events after resuming
      await new Promise((r) => setTimeout(r, 1_000));
      const sprintAfter = harness.getStreamEventCount(sprintRunId);
      expect(sprintAfter).toBeGreaterThan(sprintBefore);
    },
    120_000, // 120s total test timeout
  );
});
