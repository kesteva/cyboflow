/**
 * Tier-3 headless: the permission gate (real `canUseTool` → ApprovalRouter).
 *
 * A `fakeSdk` `.requestPermission()` invokes the REAL `options.canUseTool` the
 * harness passes, which routes to `ApprovalRouter.requestApproval`. That call
 * co-writes — inside ONE db.transaction — the `approvals` row, the
 * `workflow_runs.status = 'awaiting_review'` transition, and a blocking
 * `review_items(kind='permission', blocking=1)` row. We assert those co-exist at
 * the pause, then drive both verdicts:
 *
 *  - allow → the run resumes, the scripted tool round-trip flows into the unified
 *    projection, and the folded review item resolves;
 *  - deny  → the run rests WITHOUT applying the tool (no tool_call projected) and
 *    the deny-shaped `PermissionResult` reaches the scenario's `onResult`.
 *
 * The harness exposes `workflow_runs.status` (getStatus), the folded
 * `review_items` (getReviewItems), and the pending approval id
 * (waitForAwaitingReview) — the observable proxies for the atomic co-write. The
 * raw `approvals` columns are not surfaced (see gaps).
 */
import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { PermissionResult } from '@anthropic-ai/claude-agent-sdk';
import { createHeadlessHarness, type HeadlessHarness } from '../../../test/integration/headlessRun';
import { scenario, sdkAssistantToolUse, sdkUserToolResult } from '../../../test/fakes/fakeSdk';

describe('Tier-3 headless: permission gate co-writes and allow/deny verdicts', () => {
  let harness: HeadlessHarness;
  let projectPath: string;

  beforeAll(async () => {
    projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'cyboflow-headless-permission-'));
    execSync('git init', { cwd: projectPath });
    execSync('git config user.email "test@cyboflow.local"', { cwd: projectPath });
    execSync('git config user.name "Cyboflow Test"', { cwd: projectPath });
    execSync('git commit --allow-empty -m "init"', { cwd: projectPath });
    harness = await createHeadlessHarness();
  });

  afterAll(async () => {
    if (harness) await harness.teardown();
    if (projectPath) fs.rmSync(projectPath, { recursive: true, force: true });
  });

  test('allow: co-write appears, run resumes, and the tool result flows', async () => {
    const TOOL_ID = 'toolu_perm_allow';
    let capturedResult: PermissionResult | undefined;

    const script = scenario()
      .systemInit()
      .assistantText('about to run a shell command')
      .requestPermission(
        'Bash',
        { command: 'echo hi' },
        {
          onResult: (r) => {
            capturedResult = r;
            return r.behavior === 'allow'
              ? [
                  sdkAssistantToolUse('Bash', { command: 'echo hi' }, { toolUseId: TOOL_ID }),
                  sdkUserToolResult(TOOL_ID, 'hi\n'),
                ]
              : [];
          },
        },
      )
      .resultSuccess();

    const run = await harness.startRun({
      projectPath,
      workflow: 'planner',
      prompt: 'run a tool',
      scenario: script,
    });

    // Pause: the run rests at awaiting_review with a pending approval id.
    const { approvalId } = await harness.waitForAwaitingReview(run.runId);
    expect(approvalId).toBeTruthy(); // the approvals row co-exists (JOIN on status='pending').

    // The blocking permission review_item co-committed with the workflow_runs transition.
    expect(harness.getStatus(run.runId)).toBe('awaiting_review');
    const pending = harness.getReviewItems(run.runId, 'permission');
    expect(pending).toHaveLength(1);
    expect(pending[0].kind).toBe('permission');
    expect(pending[0].blocking).toBe(1);
    expect(pending[0].status).toBe('pending');
    expect(pending[0].title).toBe('Permission: Bash');
    expect(pending[0].run_id).toBe(run.runId);

    // allow → run resumes and drains.
    await harness.approve(run.runId, approvalId, 'allow');
    await run.done;

    expect(harness.getStatus(run.runId)).toBe('completed');
    expect(harness.countUnknownNarrowedEvents(run.runId)).toBe(0);
    // systemInit + assistantText + (onResult: toolUse + toolResult) + resultSuccess = 5.
    expect(harness.getRawEventCount(run.runId)).toBe(5);

    // The scripted tool round-trip flows into the unified projection.
    const toolCalls = harness
      .getUnifiedMessages(run.runId)
      .flatMap((m) => m.segments)
      .filter((s) => s.type === 'tool_call');
    const bash = toolCalls.find((s) => s.type === 'tool_call' && s.tool.name === 'Bash');
    expect(bash).toBeDefined();
    if (bash && bash.type === 'tool_call') {
      expect(bash.tool.result?.content).toContain('hi');
    }

    // The folded review item resolved when the approval was granted.
    const resolved = harness.getReviewItems(run.runId, 'permission');
    expect(resolved[0].status).toBe('resolved');

    // The allow verdict reached the scenario's canUseTool result.
    expect(capturedResult?.behavior).toBe('allow');
  });

  test('deny: run rests without applying the tool and the deny shape reaches the scenario', async () => {
    let capturedResult: PermissionResult | undefined;

    const script = scenario()
      .systemInit()
      .assistantText('about to run a dangerous command')
      .requestPermission(
        'Bash',
        { command: 'rm -rf /' },
        {
          onResult: (r) => {
            capturedResult = r;
            // Tool is NOT applied on deny — emit no tool round-trip.
            return [];
          },
        },
      )
      .resultSuccess();

    const run = await harness.startRun({
      projectPath,
      workflow: 'planner',
      prompt: 'run a dangerous tool',
      scenario: script,
    });

    const { approvalId } = await harness.waitForAwaitingReview(run.runId);
    expect(harness.getStatus(run.runId)).toBe('awaiting_review');

    // deny → the agent may retry, so the run transitions back and finishes.
    await harness.approve(run.runId, approvalId, 'deny');
    await run.done;

    expect(harness.getStatus(run.runId)).toBe('completed');
    expect(harness.countUnknownNarrowedEvents(run.runId)).toBe(0);
    // systemInit + assistantText + (no onResult events) + resultSuccess = 3.
    expect(harness.getRawEventCount(run.runId)).toBe(3);

    // The tool was NOT applied: no tool_call projected.
    const toolCalls = harness
      .getUnifiedMessages(run.runId)
      .flatMap((m) => m.segments)
      .filter((s) => s.type === 'tool_call');
    expect(toolCalls).toHaveLength(0);

    // The deny-shaped PermissionResult reached the scenario's canUseTool result.
    expect(capturedResult?.behavior).toBe('deny');
    if (capturedResult?.behavior === 'deny') {
      expect(capturedResult.message).toBe('denied by headless harness');
    }

    // The folded permission review item resolved (rejected) rather than lingering.
    const items = harness.getReviewItems(run.runId, 'permission');
    expect(items[0].status).toBe('resolved');
  });
});
