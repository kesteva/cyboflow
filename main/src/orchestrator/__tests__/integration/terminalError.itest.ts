/**
 * Tier-3 mocked-SDK integration — terminal-error propagation.
 *
 * A fake `query()` that streams a few well-formed events and THEN rejects
 * mid-stream (`makeThenRejectQuery`) — models the SDK producing output and then
 * throwing (auth/network/spawn failure surfaced as a thrown iterator error). The
 * headless harness's spawn loop mirrors RunExecutor's terminal seam: the thrown
 * error routes the run to `failed`, and every event that had ALREADY streamed is
 * persisted in `raw_events` (the writer runs per-event, so a later throw cannot
 * unwind the rows it already wrote).
 *
 * Asserts:
 *   1. the run rests at `failed` (NOT `completed`/`awaiting_review`);
 *   2. the raw_events streamed before the reject survive (count == pre-reject
 *      event count), oldest-first, with the scripted event types;
 *   3. ZERO events narrow to `{ kind: '__unknown__' }` — the honesty check: the
 *      pre-reject builders survive the REAL TypedEventNarrowing.
 *
 * DEVIATION from the plan's M6 sketch (code won): the plan wanted the *real*
 * `RunExecutor` to own the `failed` transition. The sanctioned M6a `headlessRun`
 * harness (built on M5) drives the injected `query()` through a hand-rolled spawn
 * loop instead, whose catch flips `workflow_runs.status` to `failed` — the same
 * observable terminal behaviour (status + persisted rows), just not through
 * `RunExecutor.execute()`. Recorded as a gap.
 */
import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { createHeadlessHarness, type HeadlessHarness } from '../../../test/integration/headlessRun';
import { sdkSystemInit, sdkAssistantText, makeThenRejectQuery } from '../../../test/fakes/fakeSdk';

describe('Tier-3 headless: mid-stream SDK rejection fails the run but keeps streamed raw_events', () => {
  let harness: HeadlessHarness;
  let projectPath: string;

  beforeAll(async () => {
    projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'cyboflow-headless-terminal-'));
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

  test('two events stream, then the iterator throws → status failed, both events persist, zero __unknown__', async () => {
    // Two well-formed events land BEFORE the reject; the third pull throws.
    const streamed: readonly SDKMessage[] = [
      sdkSystemInit(),
      sdkAssistantText('Partway through the turn, then the model connection drops.'),
    ];
    const PRE_REJECT_COUNT = streamed.length;

    const run = await harness.startRun({
      projectPath,
      workflow: 'sprint',
      prompt: 'stream a bit then die',
      scenario: makeThenRejectQuery(streamed, new Error('SDK transport closed unexpectedly')),
    });

    // Event-driven rest: `done` settles when the fake generator throws and the
    // harness spawn loop writes the terminal status — no sleeps.
    await run.done;

    // 1. The thrown iterator error routes the run to `failed` (not completed).
    expect(harness.getStatus(run.runId)).toBe('failed');

    // 2. Every event streamed before the reject is durably persisted.
    expect(harness.getRawEventCount(run.runId)).toBe(PRE_REJECT_COUNT);
    const payloads = harness.getRawEventPayloads(run.runId);
    expect(payloads).toHaveLength(PRE_REJECT_COUNT);
    const types = payloads.map((p) =>
      p !== null && typeof p === 'object' && 'type' in p
        ? (p as { type: unknown }).type
        : undefined,
    );
    expect(types).toEqual(['system', 'assistant']);

    // 3. Honesty check — the persisted pre-reject events narrow cleanly.
    expect(harness.countUnknownNarrowedEvents(run.runId)).toBe(0);
  });
});
