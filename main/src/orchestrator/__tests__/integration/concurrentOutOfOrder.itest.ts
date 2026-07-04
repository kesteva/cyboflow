/**
 * Tier-3 headless (flagship): two CONCURRENT runs, approvals resolved OUT OF ORDER.
 *
 * The exact `cyboflowDayGate.test.ts` win, now deterministic & CI-safe: a
 * planner-shaped run and a sprint-shaped run each pause at a permission gate.
 * We approve the SECOND run first, then the first — both resume, stream further
 * scripted events, then rest at a trailing permission gate (`awaiting_review`).
 *
 * Every fake stream is registered under its own minted runId in the harness'
 * runId-keyed registry, so the two concurrent scenarios never bleed into each
 * other. The load-bearing assertion is per-run `raw_events` isolation: run A's
 * recorded payloads carry ONLY planner content, run B's ONLY sprint content.
 *
 * Each scenario gives its permission steps concrete tool shapes routed through
 * the REAL `options.canUseTool` → `ApprovalRouter.requestApproval` path, so the
 * awaiting_review pause / resume is the production state machine, not a stub.
 */
import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { createHeadlessHarness, type HeadlessHarness } from '../../../test/integration/headlessRun';
import {
  scenario,
  sdkAssistantToolUse,
  sdkUserToolResult,
  sdkAssistantText,
} from '../../../test/fakes/fakeSdk';

describe('Tier-3 headless: concurrent runs approved out of order stay isolated', () => {
  let harness: HeadlessHarness;
  let projectPath: string;

  beforeAll(async () => {
    projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'cyboflow-headless-concurrent-'));
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

  test('approve run B before run A; both resume, stream, and rest at a trailing gate', async () => {
    // --- planner-shaped run A: gate1 (approved) → tool round-trip → gate2 (rest) ---
    const A_TOOL_ID = 'toolu_planner_a';
    const runAScript = scenario()
      .systemInit()
      .assistantText('PLANNER_A_ANALYZING')
      .requestPermission(
        'Bash',
        { command: 'ls planner' },
        {
          onResult: (r) =>
            r.behavior === 'allow'
              ? [
                  sdkAssistantToolUse('cyboflow_create_task', { title: 'PLANNER_A_TASK' }, { toolUseId: A_TOOL_ID }),
                  sdkUserToolResult(A_TOOL_ID, 'PLANNER_A_TASK_CREATED'),
                  sdkAssistantText('PLANNER_A_DRAFTED'),
                ]
              : [],
        },
      )
      // Trailing gate: the run rests here at awaiting_review (never approved until cleanup).
      .requestPermission('Bash', { command: 'git status planner' });

    // --- sprint-shaped run B: gate1 (approved) → tool round-trip → gate2 (rest) ---
    const B_TOOL_ID = 'toolu_sprint_b';
    const runBScript = scenario()
      .systemInit()
      .assistantText('SPRINT_B_EXECUTING')
      .requestPermission(
        'Edit',
        { file_path: 'sprint.ts' },
        {
          onResult: (r) =>
            r.behavior === 'allow'
              ? [
                  sdkAssistantToolUse('cyboflow_report_step', { note: 'SPRINT_B_STEP' }, { toolUseId: B_TOOL_ID }),
                  sdkUserToolResult(B_TOOL_ID, 'SPRINT_B_STEP_DONE'),
                  sdkAssistantText('SPRINT_B_APPLIED'),
                ]
              : [],
        },
      )
      .requestPermission('Edit', { file_path: 'sprint2.ts' });

    const runA = await harness.startRun({
      projectPath,
      workflow: 'planner',
      prompt: 'plan the thing',
      scenario: runAScript,
    });
    const runB = await harness.startRun({
      projectPath,
      workflow: 'sprint',
      prompt: 'ship the thing',
      scenario: runBScript,
    });

    // 1. Both runs pause at their FIRST gate — awaiting_review with a pending approval.
    const { approvalId: a1 } = await harness.waitForAwaitingReview(runA.runId);
    const { approvalId: b1 } = await harness.waitForAwaitingReview(runB.runId);

    expect(harness.getStatus(runA.runId)).toBe('awaiting_review');
    expect(harness.getStatus(runB.runId)).toBe('awaiting_review');
    expect(harness.getReviewItems(runA.runId, 'permission')).toHaveLength(1);
    expect(harness.getReviewItems(runB.runId, 'permission')).toHaveLength(1);

    // 2. OUT OF ORDER: approve the SECOND run (B) first, then the first (A).
    await harness.approve(runB.runId, b1, 'allow');
    const { approvalId: b2 } = await harness.waitForAwaitingReview(runB.runId); // B streamed, rests at gate2

    await harness.approve(runA.runId, a1, 'allow');
    const { approvalId: a2 } = await harness.waitForAwaitingReview(runA.runId); // A streamed, rests at gate2

    // 3. Both resumed, streamed further events, and now rest at the trailing gate.
    expect(harness.getStatus(runA.runId)).toBe('awaiting_review');
    expect(harness.getStatus(runB.runId)).toBe('awaiting_review');

    // systemInit + assistantText + (onResult: toolUse + toolResult + assistantText) = 5.
    expect(harness.getRawEventCount(runA.runId)).toBe(5);
    expect(harness.getRawEventCount(runB.runId)).toBe(5);

    // 4. Honesty check: every fakeSdk builder survives the REAL narrowing (zero __unknown__).
    expect(harness.countUnknownNarrowedEvents(runA.runId)).toBe(0);
    expect(harness.countUnknownNarrowedEvents(runB.runId)).toBe(0);

    // 5. Per-run raw_events isolation — the runId-keyed registry kept the streams disjoint.
    const aBlob = JSON.stringify(harness.getRawEventPayloads(runA.runId));
    const bBlob = JSON.stringify(harness.getRawEventPayloads(runB.runId));
    expect(aBlob).toContain('PLANNER_A_ANALYZING');
    expect(aBlob).toContain('PLANNER_A_TASK_CREATED');
    expect(aBlob).not.toContain('SPRINT_B');
    expect(bBlob).toContain('SPRINT_B_EXECUTING');
    expect(bBlob).toContain('SPRINT_B_STEP_DONE');
    expect(bBlob).not.toContain('PLANNER_A');

    // Projection isolation too: A's unified messages carry only planner text.
    const aText = harness
      .getUnifiedMessages(runA.runId)
      .flatMap((m) => m.segments)
      .filter((s): s is { type: 'text'; content: string } => s.type === 'text')
      .map((s) => s.content)
      .join('\n');
    expect(aText).toContain('PLANNER_A_DRAFTED');
    expect(aText).not.toContain('SPRINT_B');

    // 6. Cleanup: resolve the trailing gates so both generators drain and `done`
    //    settles (an unresolved canUseTool would otherwise hang teardown).
    await harness.approve(runA.runId, a2, 'allow');
    await harness.approve(runB.runId, b2, 'allow');
    await runA.done;
    await runB.done;
    expect(harness.getStatus(runA.runId)).toBe('completed');
    expect(harness.getStatus(runB.runId)).toBe('completed');
  });
});
