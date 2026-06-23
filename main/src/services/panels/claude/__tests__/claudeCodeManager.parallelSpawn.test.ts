/**
 * Unit tests for ClaudeCodeManager's per-lane parallel-spawn behavior
 * (Option A — true per-lane parallel spawns).
 *
 * A programmatic sprint fan-out drives multiple lanes concurrently, each with a
 * DISTINCT `spawnKey` (`runId + ':' + itemId`) but the SAME run display panelId
 * (panelId === runId === sessionId for workflow runs). The spawn lock string, the
 * dup-guard, and the per-spawn maps (processes / sdkRuns / pipelines) key on
 * spawnKey so concurrent lanes never serialize on one panelId lock — while every
 * OUTBOUND event re-attributes to the run display panelId so lane output
 * interleaves under the run panel.
 *
 * Coverage:
 *  (a) two concurrent spawns with DISTINCT spawnKey both proceed (neither blocks
 *      on the other lock nor trips the dup-guard);
 *  (b) the dup-guard DOES block a second spawn with the SAME spawnKey;
 *  (c) output re-attribution — a lane spawn emits 'output' / 'spawned' events with
 *      panelId === runId, NOT the per-lane spawnKey;
 *  (d) killRun(runId) aborts EVERY registered lane spawnKey;
 *  (e) spawnKeysByRunId registers a lane on spawn and clears it on cleanup;
 *  (f) the DynamicWorkflowTracker refcount: attach once (0→1), and the per-run
 *      refcount entry survives a finishing lane while a sibling is still live,
 *      only clearing after the LAST lane.
 *
 * SDK mocking mirrors claudeCodeManager.killProcess.test.ts: the mock query()
 * yields one system/init event then PARKS on the AbortController until aborted, so
 * a spawn stays "mid-stream" with its maps populated until the test kills it.
 * spawnCliProcess is fire-and-forget (awaiting it before the kill deadlocks — the
 * lock is held pending iterator drain, which only the abort signal unblocks).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type Database from 'better-sqlite3';
import { ApprovalRouter } from '../../../../orchestrator/approvalRouter';
import { QuestionRouter } from '../../../../orchestrator/questionRouter';
import { dbAdapter } from '../../../../orchestrator/__test_fixtures__/dbAdapter';
import { createTestDb } from '../../../../orchestrator/__test_fixtures__/orchestratorTestDb';
import { ClaudeCodeManager } from '../claudeCodeManager';

// ---------------------------------------------------------------------------
// SDK mock — yield init, then park on the AbortController until aborted.
// ---------------------------------------------------------------------------

vi.mock('@anthropic-ai/claude-agent-sdk', () => {
  const queryFn = vi.fn((params: { prompt: string; options?: { abortController?: AbortController } }) => {
    return (async function* () {
      yield { type: 'system', subtype: 'init' } as unknown;
      const abortController = params.options?.abortController;
      if (abortController) {
        await new Promise<void>((resolve) => {
          if (abortController.signal.aborted) {
            resolve();
            return;
          }
          abortController.signal.addEventListener('abort', () => resolve(), { once: true });
        });
      }
    })();
  });
  return { query: queryFn };
});

vi.mock('../../../orchestrator/mcpServer/scriptPath', () => ({
  resolveMcpServerScriptPath: vi.fn(() => '/mock/mcp-server.js'),
}));
vi.mock('../../../utils/nodeFinder', () => ({
  findNodeExecutable: vi.fn(async () => 'node'),
}));
vi.mock('../../../utils/promptEnhancer', () => ({
  enhancePromptForStructuredCommit: vi.fn((prompt: string) => prompt),
}));
vi.mock('../../../utils/sessionValidation', () => ({
  validatePanelSessionOwnership: vi.fn(() => ({ valid: true })),
  logValidationFailure: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Minimal SessionManager mock — no DB session ⇒ runId falls back to panelId.
// ---------------------------------------------------------------------------

import type { SessionManager } from '../../../sessionManager';

function createMockSessionManager(): SessionManager {
  return {
    getDbSession: vi.fn(() => undefined),
    getPanelClaudeSessionId: vi.fn(() => undefined),
    getProjectById: vi.fn(() => undefined),
    updateSession: vi.fn(),
  } as unknown as SessionManager;
}

// ---------------------------------------------------------------------------
// Private-map accessors (index-signature reach-in, no `any`).
// ---------------------------------------------------------------------------

function getPipelines(mgr: ClaudeCodeManager): Map<string, unknown> {
  return (mgr as unknown as { pipelines: Map<string, unknown> }).pipelines;
}
function getSdkRuns(mgr: ClaudeCodeManager): Map<string, unknown> {
  return (mgr as unknown as { sdkRuns: Map<string, unknown> }).sdkRuns;
}
function getProcesses(mgr: ClaudeCodeManager): Map<string, unknown> {
  return (mgr as unknown as { processes: Map<string, unknown> }).processes;
}
function getSpawnKeysByRunId(mgr: ClaudeCodeManager): Map<string, Set<string>> {
  return (mgr as unknown as { spawnKeysByRunId: Map<string, Set<string>> }).spawnKeysByRunId;
}
function getTrackerRefcount(mgr: ClaudeCodeManager): Map<string, number> {
  return (mgr as unknown as { trackerRefcountByRunId: Map<string, number> }).trackerRefcountByRunId;
}

// ---------------------------------------------------------------------------
// Wait helper: poll until `spawnKey` is present in all three per-spawn maps.
// ---------------------------------------------------------------------------

async function waitForSpawn(mgr: ClaudeCodeManager, spawnKey: string, maxTicks = 50): Promise<void> {
  for (let i = 0; i < maxTicks; i++) {
    if (
      getPipelines(mgr).has(spawnKey) &&
      getSdkRuns(mgr).has(spawnKey) &&
      getProcesses(mgr).has(spawnKey)
    ) {
      return;
    }
    await Promise.resolve();
  }
  throw new Error(`waitForSpawn: maps did not populate for spawnKey=${spawnKey} after ${maxTicks} ticks`);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ClaudeCodeManager — per-lane parallel spawns', () => {
  let db: Database.Database;
  let mgr: ClaudeCodeManager;

  beforeEach(() => {
    db = createTestDb();
    const adapter = dbAdapter(db);
    ApprovalRouter.initialize(adapter);
    QuestionRouter.initialize(adapter);
    mgr = new ClaudeCodeManager(createMockSessionManager(), undefined, undefined, db);
  });

  afterEach(() => {
    ApprovalRouter._resetForTesting();
    QuestionRouter._resetForTesting();
    db.close();
    vi.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // (a) Two concurrent spawns with DISTINCT spawnKey both proceed.
  // -------------------------------------------------------------------------
  it('runs two concurrent lanes with distinct spawnKeys without serializing or tripping the dup-guard', async () => {
    const runId = 'run-par';
    const keyA = `${runId}:t1`;
    const keyB = `${runId}:t2`;

    // Fire-and-forget BOTH lanes. They share panelId===runId but carry distinct
    // spawnKeys, so the spawn lock (claude-spawn-<spawnKey>) does not serialize
    // them — both must populate their maps without the second waiting on the first.
    const spawnA = mgr.spawnCliProcess({
      panelId: runId,
      sessionId: runId,
      runId,
      worktreePath: '/tmp/wt',
      prompt: 'lane A',
      permissionMode: 'ignore',
      spawnKey: keyA,
    });
    const spawnB = mgr.spawnCliProcess({
      panelId: runId,
      sessionId: runId,
      runId,
      worktreePath: '/tmp/wt',
      prompt: 'lane B',
      permissionMode: 'ignore',
      spawnKey: keyB,
    });

    // Both lanes reach mid-stream concurrently — neither blocked the other.
    await waitForSpawn(mgr, keyA);
    await waitForSpawn(mgr, keyB);

    expect(getSdkRuns(mgr).has(keyA)).toBe(true);
    expect(getSdkRuns(mgr).has(keyB)).toBe(true);
    // Both lanes are registered under the SHARED runId.
    expect(getSpawnKeysByRunId(mgr).get(runId)).toEqual(new Set([keyA, keyB]));

    // Tear both down (killRun aborts every lane), then collect spawn promises.
    await mgr.killRun(runId);
    await Promise.all([spawnA, spawnB]);

    expect(getSdkRuns(mgr).size).toBe(0);
    expect(getProcesses(mgr).size).toBe(0);
  });

  // -------------------------------------------------------------------------
  // (b) The dup-guard blocks a spawn whose spawnKey already has a live process.
  //
  // NOTE: two CONCURRENT same-key spawns serialize on the spawn lock
  // (`claude-spawn-<spawnKey>`) — the second parks on the mutex until the first
  // drains, so it never reaches the dup-guard while the first holds the lock.
  // The dup-guard fires when the lock is FREE but a process is already registered
  // under the spawnKey (the re-entrant / resume path). We simulate that by
  // pre-seeding the processes map, then asserting a fresh spawn under that key
  // acquires the free lock and rejects FAST via the dup-guard (no mutex wait).
  // -------------------------------------------------------------------------
  it('rejects a spawn whose spawnKey already has a live process (dup-guard)', async () => {
    const runId = 'run-dup';
    const key = `${runId}:t1`;

    // Pre-seed a live process under the spawnKey (no lock held).
    const processes = getProcesses(mgr) as Map<string, unknown>;
    processes.set(key, { process: undefined, panelId: runId, sessionId: runId, worktreePath: '/tmp/wt' });

    // A spawn under that SAME spawnKey acquires the free lock, then trips the
    // dup-guard and rejects — keyed on spawnKey, NOT panelId.
    await expect(
      mgr.spawnCliProcess({
        panelId: runId,
        sessionId: runId,
        runId,
        worktreePath: '/tmp/wt',
        prompt: 'dup',
        permissionMode: 'ignore',
        spawnKey: key,
      }),
    ).rejects.toThrow(`Claude process already running for spawn ${key}`);

    // A DISTINCT spawnKey under the same runId is unaffected by the seeded
    // process — it spawns cleanly (proving the guard keys on spawnKey).
    const otherKey = `${runId}:t2`;
    const spawnOther = mgr.spawnCliProcess({
      panelId: runId,
      sessionId: runId,
      runId,
      worktreePath: '/tmp/wt',
      prompt: 'other',
      permissionMode: 'ignore',
      spawnKey: otherKey,
    });
    await waitForSpawn(mgr, otherKey);
    await mgr.killProcess(otherKey);
    await spawnOther;
  });

  // -------------------------------------------------------------------------
  // (c) Output re-attribution — events carry panelId === runId, not spawnKey.
  // -------------------------------------------------------------------------
  it('re-attributes a lane spawn’s output/spawned events to the run display panelId, not the spawnKey', async () => {
    const runId = 'run-attr';
    const key = `${runId}:t1`;

    const outputs: Array<{ panelId: string }> = [];
    const spawnedEvents: Array<{ panelId: string }> = [];
    mgr.on('output', (e: { panelId: string }) => outputs.push(e));
    mgr.on('spawned', (e: { panelId: string }) => spawnedEvents.push(e));

    const spawn = mgr.spawnCliProcess({
      panelId: runId,
      sessionId: runId,
      runId,
      worktreePath: '/tmp/wt',
      prompt: 'lane',
      permissionMode: 'ignore',
      spawnKey: key,
    });
    await waitForSpawn(mgr, key);

    // Every emitted event re-attributes to the run panelId (runId) — NEVER the
    // per-lane spawnKey. This is the invariant that keeps lane output under the
    // run panel and passes the AbstractAIPanelManager output gate.
    expect(spawnedEvents.length).toBeGreaterThan(0);
    expect(spawnedEvents.every((e) => e.panelId === runId)).toBe(true);
    expect(outputs.length).toBeGreaterThan(0);
    expect(outputs.every((e) => e.panelId === runId)).toBe(true);
    // None of the events leaked the spawnKey as the panelId.
    expect(outputs.some((e) => e.panelId === key)).toBe(false);
    expect(spawnedEvents.some((e) => e.panelId === key)).toBe(false);

    await mgr.killRun(runId);
    await spawn;
  });

  // -------------------------------------------------------------------------
  // (d) killRun(runId) aborts every registered lane spawnKey.
  // -------------------------------------------------------------------------
  it('killRun aborts every lane of the run (all per-spawn maps drain)', async () => {
    const runId = 'run-killall';
    const keys = [`${runId}:t1`, `${runId}:t2`, `${runId}:t3`];

    const spawns = keys.map((spawnKey) =>
      mgr.spawnCliProcess({
        panelId: runId,
        sessionId: runId,
        runId,
        worktreePath: '/tmp/wt',
        prompt: `lane ${spawnKey}`,
        permissionMode: 'ignore',
        spawnKey,
      }),
    );
    for (const k of keys) await waitForSpawn(mgr, k);

    // All three lanes are live under one runId.
    expect(getSpawnKeysByRunId(mgr).get(runId)?.size).toBe(3);
    expect(getSdkRuns(mgr).size).toBe(3);

    // One run-scoped kill aborts EVERY lane.
    await mgr.killRun(runId);
    await Promise.all(spawns);

    expect(getSdkRuns(mgr).size).toBe(0);
    expect(getProcesses(mgr).size).toBe(0);
    expect(getPipelines(mgr).size).toBe(0);
    // The run's lane registry was fully cleared (Set deleted when it empties).
    expect(getSpawnKeysByRunId(mgr).has(runId)).toBe(false);
  });

  // -------------------------------------------------------------------------
  // (e) spawnKeysByRunId registers on spawn and clears on cleanup.
  // -------------------------------------------------------------------------
  it('registers each lane in spawnKeysByRunId on spawn and removes it on cleanup', async () => {
    const runId = 'run-registry';
    const keyA = `${runId}:t1`;
    const keyB = `${runId}:t2`;

    const spawnA = mgr.spawnCliProcess({
      panelId: runId, sessionId: runId, runId, worktreePath: '/tmp/wt',
      prompt: 'A', permissionMode: 'ignore', spawnKey: keyA,
    });
    await waitForSpawn(mgr, keyA);
    expect(getSpawnKeysByRunId(mgr).get(runId)).toEqual(new Set([keyA]));

    const spawnB = mgr.spawnCliProcess({
      panelId: runId, sessionId: runId, runId, worktreePath: '/tmp/wt',
      prompt: 'B', permissionMode: 'ignore', spawnKey: keyB,
    });
    await waitForSpawn(mgr, keyB);
    expect(getSpawnKeysByRunId(mgr).get(runId)).toEqual(new Set([keyA, keyB]));

    // killRun drains both lanes; the run's Set is deleted once empty.
    await mgr.killRun(runId);
    await Promise.all([spawnA, spawnB]);
    expect(getSpawnKeysByRunId(mgr).has(runId)).toBe(false);
  });

  // -------------------------------------------------------------------------
  // (f) Tracker refcount: a finishing lane must NOT tear down a live sibling's
  //     run-scoped attachment; only the LAST lane clears the per-run entry.
  // -------------------------------------------------------------------------
  it('keeps the per-run tracker refcount alive across a finishing lane until the last lane cleans up', async () => {
    const runId = 'run-refcount';
    const keyA = `${runId}:t1`;
    const keyB = `${runId}:t2`;

    // Lane A parks on its OWN abort controller so it can be killed independently.
    const spawnA = mgr.spawnCliProcess({
      panelId: runId, sessionId: runId, runId, worktreePath: '/tmp/wt',
      prompt: 'A', permissionMode: 'ignore', spawnKey: keyA,
    });
    await waitForSpawn(mgr, keyA);
    const spawnB = mgr.spawnCliProcess({
      panelId: runId, sessionId: runId, runId, worktreePath: '/tmp/wt',
      prompt: 'B', permissionMode: 'ignore', spawnKey: keyB,
    });
    await waitForSpawn(mgr, keyB);

    // Both lanes share one runId ⇒ the per-run refcount is 2 (attach happened
    // once, on the 0→1 transition for lane A).
    expect(getTrackerRefcount(mgr).get(runId)).toBe(2);

    // Abort ONLY lane A (its single spawn), leaving lane B live. The finishing
    // lane decrements the refcount (2→1) but must NOT delete the per-run entry —
    // a sibling is still attached.
    await mgr.killProcess(keyA);
    await spawnA;
    expect(getTrackerRefcount(mgr).get(runId)).toBe(1);
    expect(getSdkRuns(mgr).has(keyB)).toBe(true); // sibling still live

    // The LAST lane's cleanup (1→0) deletes the per-run refcount entry.
    await mgr.killProcess(keyB);
    await spawnB;
    expect(getTrackerRefcount(mgr).has(runId)).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Bundle refcount: removal only after the LAST lane (SUB-HAZARD: SHARED BUNDLE).
  // -------------------------------------------------------------------------
  it('removes the shared per-session bundle only after the last lane decrements the refcount', async () => {
    const runId = 'run-bundle';
    const keyA = `${runId}:t1`;
    const keyB = `${runId}:t2`;
    const bundleRefcount = (m: ClaudeCodeManager): Map<string, number> =>
      (m as unknown as { bundleRefcountBySession: Map<string, number> }).bundleRefcountBySession;

    const spawnA = mgr.spawnCliProcess({
      panelId: runId, sessionId: runId, runId, worktreePath: '/tmp/wt',
      prompt: 'A', permissionMode: 'ignore', spawnKey: keyA,
    });
    await waitForSpawn(mgr, keyA);
    const spawnB = mgr.spawnCliProcess({
      panelId: runId, sessionId: runId, runId, worktreePath: '/tmp/wt',
      prompt: 'B', permissionMode: 'ignore', spawnKey: keyB,
    });
    await waitForSpawn(mgr, keyB);

    // Two lanes share one sessionId ⇒ the bundle refcount is 2.
    expect(bundleRefcount(mgr).get(runId)).toBe(2);

    // First lane finishing decrements to 1 — the bundle entry survives.
    await mgr.killProcess(keyA);
    await spawnA;
    expect(bundleRefcount(mgr).get(runId)).toBe(1);

    // Last lane finishing decrements to 0 — the refcount entry is removed.
    await mgr.killProcess(keyB);
    await spawnB;
    expect(bundleRefcount(mgr).has(runId)).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Leak guard: a spawn that fails in buildSdkOptions (BEFORE runSdkQuery owns
  // teardown) must NOT strand the shared-bundle refcount — otherwise the
  // genuinely-last lane can never strip the bundle. Regression for the M5
  // increment/decrement skew: bump at spawn time, decrement only in
  // runSdkQuery's finally, with a throwable `await buildSdkOptions` in between.
  // -------------------------------------------------------------------------
  it('unwinds the shared-bundle refcount when a sibling lane fails in buildSdkOptions', async () => {
    const runId = 'run-leak';
    const keyA = `${runId}:t1`;
    const keyB = `${runId}:t2`;
    const bundleRefcount = (m: ClaudeCodeManager): Map<string, number> =>
      (m as unknown as { bundleRefcountBySession: Map<string, number> }).bundleRefcountBySession;

    // Lane A spawns normally and parks mid-stream (refcount → 1).
    const spawnA = mgr.spawnCliProcess({
      panelId: runId, sessionId: runId, runId, worktreePath: '/tmp/wt',
      prompt: 'A', permissionMode: 'ignore', spawnKey: keyA,
    });
    await waitForSpawn(mgr, keyA);
    expect(bundleRefcount(mgr).get(runId)).toBe(1);

    // Lane B (same sessionId) bumps the refcount (1 → 2) then FAILS in
    // buildSdkOptions. The catch must decrement back to 1, not leave it at 2.
    const buildSpy = vi
      .spyOn(
        mgr as unknown as { buildSdkOptions: (o: unknown) => Promise<unknown> },
        'buildSdkOptions',
      )
      .mockRejectedValueOnce(new Error('build boom'));
    await expect(
      mgr.spawnCliProcess({
        panelId: runId, sessionId: runId, runId, worktreePath: '/tmp/wt',
        prompt: 'B', permissionMode: 'ignore', spawnKey: keyB,
      }),
    ).rejects.toThrow('build boom');
    buildSpy.mockRestore();

    // The failed lane left NO residue: refcount back to 1, and lane B registered
    // nothing in the per-spawn / per-run maps (it threw before those installs).
    expect(bundleRefcount(mgr).get(runId)).toBe(1);
    expect(getSpawnKeysByRunId(mgr).get(runId)).toEqual(new Set([keyA]));
    expect(getProcesses(mgr).has(keyB)).toBe(false);
    expect(getPipelines(mgr).has(keyB)).toBe(false);

    // The genuinely-LAST lane (A) can therefore still strip the bundle (1 → 0).
    await mgr.killProcess(keyA);
    await spawnA;
    expect(bundleRefcount(mgr).has(runId)).toBe(false);
  });
});
