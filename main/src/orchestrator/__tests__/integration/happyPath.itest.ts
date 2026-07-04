/**
 * Tier-3 mocked-SDK integration — happy-path proving scenario.
 *
 * The `cyboflowDayGate.test.ts` shape MINUS the live SDK: real orchestrator stack
 * (WorkflowRegistry / RunLauncher / ApprovalRouter) over a migration-replay temp DB,
 * a real `git init` worktree, ONLY `query()` faked (a `fakeSdk` scenario injected
 * via `headlessRun`).
 *
 * Scripts systemInit → assistantText → one cyboflow tool_use round-trip
 * (tool_use + tool_result) → resultSuccess, then asserts:
 *   1. status transitions running → completed (the actual no-permission rest state
 *      — the fake never fires `canUseTool`, so the run does NOT pause at
 *      awaiting_review; verified against the harness spawn loop);
 *   2. raw_events row count == scripted event count;
 *   3. ZERO events narrow to `{ kind: '__unknown__' }` (the honesty check — every
 *      fakeSdk builder survives the REAL TypedEventNarrowing);
 *   4. the unified-message projection re-projects the scripted content (assistant
 *      text + the folded tool_use/tool_result round-trip).
 */
import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { createHeadlessHarness, type HeadlessHarness } from '../../../test/integration/headlessRun';
import { scenario } from '../../../test/fakes/fakeSdk';

describe('Tier-3 headless: happy-path run rests at completed with a clean projection', () => {
  let harness: HeadlessHarness;
  let projectPath: string;

  beforeAll(async () => {
    projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'cyboflow-headless-proj-'));
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

  test('scripted systemInit → text → tool round-trip → resultSuccess', async () => {
    const toolUseId = 'toolu_headless_happy';
    const assistantText = 'Reporting progress on the task.';

    const script = scenario()
      .systemInit()
      .assistantText(assistantText)
      .toolUse('cyboflow_report_step', { note: 'step 1 of 1' }, { toolUseId })
      .userToolResult(toolUseId, 'step recorded')
      .resultSuccess();
    const SCRIPTED_EVENT_COUNT = 5;

    const run = await harness.startRun({
      projectPath,
      workflow: 'planner',
      prompt: 'do the thing',
      scenario: script,
    });

    // The run is 'running' the instant startRun returns (no await between the
    // synchronous status write in spawnFakeRun and here lets the fake drain).
    expect(harness.getStatus(run.runId)).toBe('running');

    // Event-driven rest: no sleeps — `done` settles when the fake generator drains.
    await run.done;

    // 1. running → completed (no permission step ⇒ no awaiting_review pause).
    expect(harness.getStatus(run.runId)).toBe('completed');

    // 2. raw_events count == scripted event count.
    expect(harness.getRawEventCount(run.runId)).toBe(SCRIPTED_EVENT_COUNT);

    // 3. ZERO __unknown__ — every fakeSdk builder survives the real narrowing.
    expect(harness.countUnknownNarrowedEvents(run.runId)).toBe(0);

    // 4. Unified-message projection re-projects the scripted content.
    const messages = harness.getUnifiedMessages(run.runId);

    const textSegments = messages
      .flatMap((m) => m.segments)
      .filter((s): s is { type: 'text'; content: string } => s.type === 'text');
    expect(textSegments.some((s) => s.content.includes(assistantText))).toBe(true);

    const toolCallSegments = messages
      .flatMap((m) => m.segments)
      .filter((s) => s.type === 'tool_call');
    const reportStep = toolCallSegments.find(
      (s) => s.type === 'tool_call' && s.tool.name === 'cyboflow_report_step',
    );
    expect(reportStep).toBeDefined();
    // The tool_result was folded onto its tool_use by MessageProjection.
    if (reportStep && reportStep.type === 'tool_call') {
      expect(reportStep.tool.result?.content).toContain('step recorded');
    }
  });
});
