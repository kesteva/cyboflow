/**
 * cyboflow.runs.switchPausedStepAgents / clearRunAgentTargets / runAgentTargets —
 * the procedure layer over switchRunAgentsHandler. The handler's full matrix is
 * in orchestrator/__tests__/switchRunAgentsHandler.test.ts; here: the
 * METHOD_NOT_SUPPORTED-when-unwired guard (this file is its own module instance,
 * so the deps start null), zod input validation, verbatim delegation, and the
 * read query.
 */
import { describe, it, expect, vi } from 'vitest';
import { TRPCError } from '@trpc/server';
import { appRouter } from '../../router';
import { createContext } from '../../context';
import { dbAdapter } from '../../../__test_fixtures__/dbAdapter';
import { createTestDb, seedRun } from '../../../__test_fixtures__/orchestratorTestDb';
import { setSwitchRunAgentsDeps } from '../runs';
import type { SwitchRunAgentsDeps } from '../../../switchRunAgentsHandler';

function makeDb(): { db: ReturnType<typeof createTestDb>; runId: string } {
  const db = createTestDb({ includeSubstrate: true, includeRunAgentTargetOverrides: true });
  const { runId } = seedRun(db, { status: 'awaiting_review' });
  db.prepare("UPDATE workflow_runs SET execution_model = 'programmatic' WHERE id = ?").run(runId);
  return { db, runId };
}

const isMethodNotSupported = (err: unknown): boolean =>
  err instanceof TRPCError && err.code === 'METHOD_NOT_SUPPORTED';

describe('cyboflow.runs agent-target procedures', () => {
  // Must run FIRST in this file: the module-level deps are still null.
  it('both mutations throw METHOD_NOT_SUPPORTED until setSwitchRunAgentsDeps()', async () => {
    const caller = appRouter.createCaller(createContext());
    await expect(
      caller.cyboflow.runs.switchPausedStepAgents({ runId: 'r', scope: 'provider', target: { runtime: 'codex-sdk' } }),
    ).rejects.toSatisfy(isMethodNotSupported);
    await expect(caller.cyboflow.runs.clearRunAgentTargets({ runId: 'r' })).rejects.toSatisfy(isMethodNotSupported);
  });

  it('switchPausedStepAgents delegates and returns the handler result verbatim', async () => {
    const { db, runId } = makeDb();
    const resolveItem = vi.fn(async () => 'resolved' as const);
    const deps: SwitchRunAgentsDeps = {
      db: dbAdapter(db),
      isProviderEnabled: () => true,
      isProviderReady: async () => true,
      listRunAgentTargets: () => [{ agentKey: 'implement', provider: 'claude' }],
      findPendingPause: async () => ({
        reviewItemId: 'rvw_1',
        projectId: 1,
        payload: { kind: 'decision', gate: 'systemic-pause', agentKeys: ['implement'], blockedProvider: 'claude' },
      }),
      resolveItem,
    };
    setSwitchRunAgentsDeps(deps);
    try {
      const caller = appRouter.createCaller(createContext({ db: dbAdapter(db) }));
      const result = await caller.cyboflow.runs.switchPausedStepAgents({
        runId,
        reviewItemId: 'rvw_1',
        scope: 'step',
        target: { runtime: 'codex-sdk', providerModel: 'gpt-5.6-sol', model: null, effort: 'high' },
      });
      expect(result).toEqual({
        delivered: true,
        agentKeys: ['implement'],
        target: { runtime: 'codex-sdk', model: null, providerModel: 'gpt-5.6-sol', effort: 'high' },
        retried: true,
      });
      expect(resolveItem).toHaveBeenCalledOnce();

      // The read query sees what was written.
      await expect(caller.cyboflow.runs.runAgentTargets({ runId })).resolves.toEqual({
        implement: { runtime: 'codex-sdk', model: null, providerModel: 'gpt-5.6-sol', effort: 'high' },
      });

      // A noOp passes through verbatim.
      await expect(
        caller.cyboflow.runs.switchPausedStepAgents({ runId, scope: 'provider', target: {} }),
      ).resolves.toEqual({ noOp: 'no_target' });

      // Revert clears it.
      await expect(caller.cyboflow.runs.clearRunAgentTargets({ runId })).resolves.toEqual({ delivered: true });
      await expect(caller.cyboflow.runs.runAgentTargets({ runId })).resolves.toBeNull();
    } finally {
      db.close();
    }
  });

  it('rejects malformed input at the zod layer (unknown runtime / model alias / scope / empty providerModel)', async () => {
    const { db, runId } = makeDb();
    try {
      const caller = appRouter.createCaller(createContext({ db: dbAdapter(db) }));
      const bad: unknown[] = [
        { runId, scope: 'provider', target: { runtime: 'bogus-sdk' } },
        { runId, scope: 'provider', target: { model: 'gpt-5' } },
        { runId, scope: 'everything', target: { runtime: 'codex-sdk' } },
        { runId, scope: 'provider', target: { providerModel: '' } },
      ];
      for (const input of bad) {
        await expect(
          caller.cyboflow.runs.switchPausedStepAgents(
            input as Parameters<typeof caller.cyboflow.runs.switchPausedStepAgents>[0],
          ),
        ).rejects.toSatisfy((err: unknown) => err instanceof TRPCError && err.code === 'BAD_REQUEST');
      }
    } finally {
      db.close();
    }
  });

  it('runAgentTargets is null on a DB without the column, and PRECONDITION_FAILED without a db', async () => {
    const db = createTestDb({ includeSubstrate: true });
    const { runId } = seedRun(db);
    try {
      const caller = appRouter.createCaller(createContext({ db: dbAdapter(db) }));
      await expect(caller.cyboflow.runs.runAgentTargets({ runId })).resolves.toBeNull();
      const noDb = appRouter.createCaller(createContext());
      await expect(noDb.cyboflow.runs.runAgentTargets({ runId })).rejects.toSatisfy(
        (err: unknown) => err instanceof TRPCError && err.code === 'PRECONDITION_FAILED',
      );
    } finally {
      db.close();
    }
  });
});
