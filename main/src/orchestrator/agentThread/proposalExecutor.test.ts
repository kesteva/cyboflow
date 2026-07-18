import { describe, it, expect, vi } from 'vitest';
import {
  executeProposal,
  reconcileOrphanedExecutingProposals,
  type ProposalExecutorDeps,
  type AgentProposalStoreLike,
  type ReprioritizeTaskChange,
  type LaunchRunResultJson,
  type ReprioritizeResultJson,
  type EditWorkflowResultJson,
} from './proposalExecutor';
import { computeSpecHash } from './specHash';
import type {
  AgentProposal,
  AgentProposalPayload,
  AgentProposalPreconditions,
  AgentProposalStatus,
} from '../../../../shared/types/agentThread';
import type { WorkflowDefinition } from '../../../../shared/types/workflows';

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

/** In-memory store with the SAME guarded-CAS semantics as AgentThreadDbStore. */
class FakeStore implements AgentProposalStoreLike {
  readonly proposals = new Map<string, AgentProposal>();

  add(p: AgentProposal): void {
    this.proposals.set(p.id, p);
  }

  getProposal(id: string): AgentProposal | null {
    const p = this.proposals.get(id);
    // Return a copy so a caller holding the pre-claim snapshot never sees later
    // mutations (mirrors the DB store, which re-reads a fresh row each call).
    return p ? { ...p } : null;
  }

  claimProposal(id: string, idempotencyKey: string): boolean {
    const p = this.proposals.get(id);
    if (!p || p.status !== 'proposed') return false;
    p.status = 'executing';
    p.idempotencyKey = idempotencyKey;
    return true;
  }

  finalizeProposal(id: string, status: 'executed' | 'failed', resultJson: string | null): boolean {
    const p = this.proposals.get(id);
    if (!p || p.status !== 'executing') return false;
    p.status = status;
    p.result = resultJson ? JSON.parse(resultJson) : null;
    p.decidedAt = 'decided';
    return true;
  }

  supersedeProposal(id: string, resultJson?: string | null): boolean {
    const p = this.proposals.get(id);
    if (!p || (p.status !== 'proposed' && p.status !== 'executing')) return false;
    p.status = 'superseded';
    p.result = resultJson ? JSON.parse(resultJson) : null;
    p.decidedAt = 'decided';
    return true;
  }

  listProposalsByStatus(status: AgentProposalStatus): AgentProposal[] {
    return [...this.proposals.values()].filter((p) => p.status === status).map((p) => ({ ...p }));
  }
}

const CURRENT_SPEC: WorkflowDefinition = {
  id: 'wf',
  phases: [
    { id: 'phase-one', label: 'Current', color: '#3b6dd6', steps: [{ id: 'step-one', name: 'Current Step', agent: 'planner', mcps: [], retries: 0 }] },
  ],
};
const NEW_SPEC: WorkflowDefinition = {
  id: 'wf',
  phases: [
    { id: 'phase-one', label: 'Edited', color: '#3b6dd6', steps: [{ id: 'step-one', name: 'Edited Step', agent: 'planner', mcps: [], retries: 0 }] },
  ],
};

function makeProposal(
  payload: AgentProposalPayload,
  over: { id?: string; preconditions?: AgentProposalPreconditions | null; status?: AgentProposalStatus; result?: unknown } = {},
): AgentProposal {
  return {
    id: over.id ?? 'p1',
    threadId: 't1',
    kind: payload.kind,
    payload,
    preconditions: over.preconditions ?? null,
    status: over.status ?? 'proposed',
    result: over.result ?? null,
    idempotencyKey: null,
    createdAt: 'now',
    decidedAt: null,
  };
}

function baseDeps(store: FakeStore, over: Partial<ProposalExecutorDeps> = {}): ProposalExecutorDeps {
  let counter = 0;
  return {
    store,
    newIdempotencyKey: () => `key-${++counter}`,
    createQuickSession: async () => ({ sessionId: 'sess-1', worktreePath: '/wt/sess-1' }),
    launchRun: async () => ({ runId: 'run-1', worktreePath: '/wt/sess-1', branchName: 'agent-branch' }),
    cancelRun: async () => {},
    dismissSession: async () => {},
    runExists: () => true,
    applyTaskChange: async () => {},
    readTaskFields: () => null,
    runInTransaction: <T>(fn: () => T): T => fn(),
    readEffectiveWorkflowSpec: () => CURRENT_SPEC,
    applyWorkflowSpec: () => {},
    ...over,
  };
}

// ---------------------------------------------------------------------------
// Guard rails: not-found, open-session, double-confirm race
// ---------------------------------------------------------------------------

describe('executeProposal — guard rails', () => {
  it('returns not-found for an unknown proposal', async () => {
    const store = new FakeStore();
    const result = await executeProposal(baseDeps(store), 'missing');
    expect(result).toEqual({ ok: false, reason: 'not-found' });
  });

  it('rejects open-session without claiming (renderer navigation only)', async () => {
    const store = new FakeStore();
    const claimSpy = vi.spyOn(store, 'claimProposal');
    store.add(makeProposal({ kind: 'open-session', navigation: { target: 'run', runId: 'r1' } }));

    const result = await executeProposal(baseDeps(store), 'p1');

    expect(result).toEqual({ ok: false, reason: 'not-executable' });
    expect(claimSpy).not.toHaveBeenCalled();
    expect(store.proposals.get('p1')?.status).toBe('proposed');
  });

  it('double-confirm race: exactly one caller wins the claim, the loser gets claimed', async () => {
    const store = new FakeStore();
    store.add(makeProposal({ kind: 'launch-run', projectId: 7, workflowName: 'sprint', taskIds: ['T1'] }));
    const deps = baseDeps(store);

    // Start BOTH before releasing the winner's side effect: A's synchronous
    // getProposal+claim prefix runs before it suspends at the createQuickSession
    // await, so B's synchronous claim sees 'executing' and loses.
    const pA = executeProposal(deps, 'p1');
    const pB = executeProposal(deps, 'p1');
    const [rA, rB] = await Promise.all([pA, pB]);

    const wins = [rA, rB].filter((r) => r.ok);
    const losses = [rA, rB].filter((r) => !r.ok);
    expect(wins).toHaveLength(1);
    expect(losses).toEqual([{ ok: false, reason: 'claimed' }]);
    expect(store.proposals.get('p1')?.status).toBe('executed');
  });
});

// ---------------------------------------------------------------------------
// launch-run
// ---------------------------------------------------------------------------

describe('executeProposal — launch-run', () => {
  it('mints a session then launches the seeded run, finalizing executed', async () => {
    const store = new FakeStore();
    store.add(makeProposal({ kind: 'launch-run', projectId: 7, workflowName: 'sprint', taskIds: ['T1', 'T2'] }, { id: 'prop-abcd1234ef' }));

    const createQuickSession = vi.fn(async () => ({ sessionId: 'sess-9', worktreePath: '/wt/sess-9' }));
    const launchRun = vi.fn(async () => ({ runId: 'run-9', worktreePath: '/wt/sess-9', branchName: 'br-9' }));
    const deps = baseDeps(store, { createQuickSession, launchRun });

    const result = await executeProposal(deps, 'prop-abcd1234ef');

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.status).toBe('executed');
    // Session name hint is stable + derived from the workflow + proposal id prefix.
    expect(createQuickSession).toHaveBeenCalledWith({ projectId: 7, nameHint: 'agent-sprint-prop-abc' });
    // Seeds + freshly-minted sessionId are threaded into the launch.
    expect(launchRun).toHaveBeenCalledWith({ projectId: 7, workflowName: 'sprint', sessionId: 'sess-9', substrate: undefined, taskIds: ['T1', 'T2'], ideaIds: undefined, findingIds: undefined });

    const stored = store.proposals.get('prop-abcd1234ef');
    expect(stored?.status).toBe('executed');
    const rj = stored?.result as LaunchRunResultJson;
    expect(rj).toMatchObject({ kind: 'launch-run', status: 'executed', sessionId: 'sess-9', runId: 'run-9', branchName: 'br-9' });
  });

  it('saga: session-create fails → no compensation, finalized failed', async () => {
    const store = new FakeStore();
    store.add(makeProposal({ kind: 'launch-run', projectId: 7, workflowName: 'planner', ideaIds: ['IDEA-1'] }));

    const cancelRun = vi.fn(async () => {});
    const dismissSession = vi.fn(async () => {});
    const deps = baseDeps(store, {
      createQuickSession: async () => {
        throw new Error('worktree create failed');
      },
      cancelRun,
      dismissSession,
    });

    const result = await executeProposal(deps, 'p1');

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.status).toBe('failed');
    // Nothing was created → nothing to compensate.
    expect(cancelRun).not.toHaveBeenCalled();
    expect(dismissSession).not.toHaveBeenCalled();
    const rj = store.proposals.get('p1')?.result as LaunchRunResultJson;
    expect(rj.status).toBe('failed');
    expect(rj.error).toContain('worktree create failed');
    expect(rj.compensations).toBeUndefined();
    expect(store.proposals.get('p1')?.status).toBe('failed');
  });

  it('saga: launch fails after session created → session compensated (dismiss), finalized failed', async () => {
    const store = new FakeStore();
    store.add(makeProposal({ kind: 'launch-run', projectId: 7, workflowName: 'compound', findingIds: ['F1'] }));

    const cancelRun = vi.fn(async () => {});
    const dismissSession = vi.fn(async () => {});
    const deps = baseDeps(store, {
      createQuickSession: async () => ({ sessionId: 'sess-3', worktreePath: '/wt/sess-3' }),
      launchRun: async () => {
        throw new Error('launch rejected');
      },
      cancelRun,
      dismissSession,
    });

    const result = await executeProposal(deps, 'p1');

    if (!result.ok) throw new Error('expected ok');
    expect(result.status).toBe('failed');
    // No runId was minted (launch threw) → cancelRun skipped; the session is unwound.
    expect(cancelRun).not.toHaveBeenCalled();
    expect(dismissSession).toHaveBeenCalledWith('sess-3');
    const rj = store.proposals.get('p1')?.result as LaunchRunResultJson;
    expect(rj.sessionId).toBe('sess-3');
    expect(rj.compensations).toEqual([{ step: 'dismiss-session', ok: true }]);
  });

  it('saga: a compensation step that itself fails is recorded, not thrown away', async () => {
    const store = new FakeStore();
    store.add(makeProposal({ kind: 'launch-run', projectId: 7, workflowName: 'sprint', taskIds: ['T1'] }));

    const deps = baseDeps(store, {
      createQuickSession: async () => ({ sessionId: 'sess-4', worktreePath: '/wt/sess-4' }),
      launchRun: async () => {
        throw new Error('launch rejected');
      },
      dismissSession: async () => {
        throw new Error('dismiss failed');
      },
    });

    const result = await executeProposal(deps, 'p1');

    if (!result.ok) throw new Error('expected ok');
    expect(result.status).toBe('failed');
    const rj = store.proposals.get('p1')?.result as LaunchRunResultJson;
    expect(rj.compensations).toEqual([{ step: 'dismiss-session', ok: false, error: 'dismiss failed' }]);
  });
});

// ---------------------------------------------------------------------------
// reprioritize-backlog
// ---------------------------------------------------------------------------

describe('executeProposal — reprioritize-backlog', () => {
  it('applies every item with actor:user + expectedVersion, finalizing executed', async () => {
    const store = new FakeStore();
    store.add(
      makeProposal(
        {
          kind: 'reprioritize-backlog',
          projectId: 7,
          items: [
            { taskId: 'T1', priority: 'P0' },
            { taskId: 'T2', stageId: 'stage-x' },
            { taskId: 'T3', priority: 'P1' },
          ],
        },
        { preconditions: { kind: 'reprioritize-backlog', expectedVersions: { T1: 3, T2: 5 } } },
      ),
    );

    const calls: Array<{ projectId: number; change: ReprioritizeTaskChange }> = [];
    const applyTaskChange = vi.fn(async (projectId: number, change: ReprioritizeTaskChange) => {
      calls.push({ projectId, change });
    });
    const result = await executeProposal(baseDeps(store, { applyTaskChange }), 'p1');

    if (!result.ok) throw new Error('expected ok');
    expect(result.status).toBe('executed');

    // Actor is 'user' on EVERY chokepoint call; seeds map correctly; expectedVersion
    // comes from preconditions (T3 has none → undefined).
    expect(calls.map((c) => c.change.actor)).toEqual(['user', 'user', 'user']);
    expect(calls[0].change).toEqual({ actor: 'user', taskId: 'T1', fields: { priority: 'P0' }, expectedVersion: 3 });
    expect(calls[1].change).toEqual({ actor: 'user', taskId: 'T2', stageId: 'stage-x', expectedVersion: 5 });
    expect(calls[2].change).toEqual({ actor: 'user', taskId: 'T3', fields: { priority: 'P1' } });

    const rj = store.proposals.get('p1')?.result as ReprioritizeResultJson;
    expect(rj.items).toEqual([
      { taskId: 'T1', ok: true },
      { taskId: 'T2', ok: true },
      { taskId: 'T3', ok: true },
    ]);
  });

  it('partial failure: item 2 of 3 fails → items 1 & 3 still applied, overall failed', async () => {
    const store = new FakeStore();
    store.add(
      makeProposal({
        kind: 'reprioritize-backlog',
        projectId: 7,
        items: [
          { taskId: 'T1', priority: 'P0' },
          { taskId: 'T2', priority: 'P1' },
          { taskId: 'T3', priority: 'P2' },
        ],
      }),
    );

    const applied: string[] = [];
    const applyTaskChange = vi.fn(async (_projectId: number, change: ReprioritizeTaskChange) => {
      if (change.taskId === 'T2') throw new Error('concurrency');
      applied.push(change.taskId);
    });
    const result = await executeProposal(baseDeps(store, { applyTaskChange }), 'p1');

    if (!result.ok) throw new Error('expected ok');
    expect(result.status).toBe('failed');
    // Later items are NOT aborted by an earlier failure.
    expect(applied).toEqual(['T1', 'T3']);
    const rj = store.proposals.get('p1')?.result as ReprioritizeResultJson;
    expect(rj.items).toEqual([
      { taskId: 'T1', ok: true },
      { taskId: 'T2', ok: false, error: 'concurrency' },
      { taskId: 'T3', ok: true },
    ]);
    expect(store.proposals.get('p1')?.status).toBe('failed');
  });
});

// ---------------------------------------------------------------------------
// edit-workflow
// ---------------------------------------------------------------------------

describe('executeProposal — edit-workflow', () => {
  it('applies the validated definition when the spec hash matches', async () => {
    const store = new FakeStore();
    store.add(
      makeProposal(
        { kind: 'edit-workflow', workflowId: 'wf', definitionJson: JSON.stringify(NEW_SPEC) },
        { preconditions: { kind: 'edit-workflow', specHash: computeSpecHash(CURRENT_SPEC) } },
      ),
    );

    const applyWorkflowSpec = vi.fn();
    // vi.fn cannot type a generic call signature, so spy alongside a plain generic fake.
    const txnSpy = vi.fn();
    const txn = <T,>(fn: () => T): T => {
      txnSpy();
      return fn();
    };
    const result = await executeProposal(baseDeps(store, { applyWorkflowSpec, runInTransaction: txn }), 'p1');

    if (!result.ok) throw new Error('expected ok');
    expect(result.status).toBe('executed');
    // The read-hash-compare-apply core ran inside the injected transaction.
    expect(txnSpy).toHaveBeenCalledTimes(1);
    expect(applyWorkflowSpec).toHaveBeenCalledWith('wf', NEW_SPEC);
    const rj = store.proposals.get('p1')?.result as EditWorkflowResultJson;
    expect(rj).toMatchObject({ kind: 'edit-workflow', status: 'executed', workflowId: 'wf', appliedHash: computeSpecHash(CURRENT_SPEC) });
  });

  it('stale spec hash → superseded (no apply) + a refreshed-diff loopback turn', async () => {
    const store = new FakeStore();
    store.add(
      makeProposal(
        { kind: 'edit-workflow', workflowId: 'wf', definitionJson: JSON.stringify(NEW_SPEC) },
        // Drafted against a hash that no longer matches the current effective spec.
        { preconditions: { kind: 'edit-workflow', specHash: 'stale-hash-0000' } },
      ),
    );

    const applyWorkflowSpec = vi.fn();
    const result = await executeProposal(baseDeps(store, { applyWorkflowSpec }), 'p1');

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected refusal');
    expect(result.reason).toBe('superseded');
    if (result.reason !== 'superseded') throw new Error('expected superseded');
    expect(result.loopbackTurn).toContain('changed since you drafted this edit');
    expect(applyWorkflowSpec).not.toHaveBeenCalled();
    expect(store.proposals.get('p1')?.status).toBe('superseded');
    const rj = store.proposals.get('p1')?.result as EditWorkflowResultJson;
    expect(rj).toMatchObject({ status: 'superseded', reason: 'spec-hash-mismatch', expectedHash: 'stale-hash-0000', actualHash: computeSpecHash(CURRENT_SPEC) });
  });

  it('invalid definition → validation-failed + finalize failed, with zod issues in the loopback', async () => {
    const store = new FakeStore();
    store.add(
      makeProposal(
        { kind: 'edit-workflow', workflowId: 'wf', definitionJson: JSON.stringify({ not: 'a workflow' }) },
        { preconditions: { kind: 'edit-workflow', specHash: computeSpecHash(CURRENT_SPEC) } },
      ),
    );

    const applyWorkflowSpec = vi.fn();
    const result = await executeProposal(baseDeps(store, { applyWorkflowSpec }), 'p1');

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected refusal');
    expect(result.reason).toBe('validation-failed');
    if (result.reason !== 'validation-failed') throw new Error('expected validation-failed');
    expect(result.loopbackTurn.length).toBeGreaterThan(0);
    expect(applyWorkflowSpec).not.toHaveBeenCalled();
    expect(store.proposals.get('p1')?.status).toBe('failed');
    const rj = store.proposals.get('p1')?.result as EditWorkflowResultJson;
    expect(rj.status).toBe('failed');
    expect(rj.reason).toBe('validation-failed');
    expect(Array.isArray(rj.issues)).toBe(true);
    expect((rj.issues ?? []).length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Boot reconciliation of orphaned 'executing' rows
// ---------------------------------------------------------------------------

describe('reconcileOrphanedExecutingProposals', () => {
  it('launch-run: run recorded in result_json that EXISTS → executed', async () => {
    const store = new FakeStore();
    store.add(
      makeProposal({ kind: 'launch-run', projectId: 7, workflowName: 'sprint', taskIds: ['T1'] }, { status: 'executing', result: { kind: 'launch-run', runId: 'run-1' } }),
    );
    const summary = await reconcileOrphanedExecutingProposals(baseDeps(store, { runExists: (id) => id === 'run-1' }));

    expect(summary.total).toBe(1);
    expect(summary.outcomes[0].finalizedTo).toBe('executed');
    expect(store.proposals.get('p1')?.status).toBe('executed');
  });

  it('launch-run: run recorded that does NOT exist → failed crashed-mid-execution', async () => {
    const store = new FakeStore();
    store.add(
      makeProposal({ kind: 'launch-run', projectId: 7, workflowName: 'sprint', taskIds: ['T1'] }, { status: 'executing', result: { kind: 'launch-run', runId: 'run-gone' } }),
    );
    const summary = await reconcileOrphanedExecutingProposals(baseDeps(store, { runExists: () => false }));

    expect(summary.outcomes[0].finalizedTo).toBe('failed');
    const rj = store.proposals.get('p1')?.result as LaunchRunResultJson;
    expect(rj.status).toBe('failed');
    expect(rj.error).toBe('crashed-mid-execution');
    expect(rj.reconciled).toBe(true);
  });

  it('launch-run: no run id recorded → failed crashed-mid-execution (never re-runs the launch)', async () => {
    const store = new FakeStore();
    store.add(makeProposal({ kind: 'launch-run', projectId: 7, workflowName: 'sprint', taskIds: ['T1'] }, { status: 'executing', result: null }));
    const launchRun = vi.fn(async () => ({ runId: 'x', worktreePath: '/x', branchName: 'x' }));
    const summary = await reconcileOrphanedExecutingProposals(baseDeps(store, { launchRun }));

    expect(summary.outcomes[0].finalizedTo).toBe('failed');
    expect(launchRun).not.toHaveBeenCalled();
  });

  it('reprioritize: all items already carry proposed values → executed; otherwise failed', async () => {
    const store = new FakeStore();
    store.add(
      makeProposal(
        {
          kind: 'reprioritize-backlog',
          projectId: 7,
          items: [
            { taskId: 'T1', priority: 'P0' },
            { taskId: 'T2', stageId: 'stage-x' },
          ],
        },
        { status: 'executing' },
      ),
    );
    const readTaskFields = (_pid: number, taskId: string) =>
      taskId === 'T1' ? { priority: 'P0' as const, stageId: 'anything' } : { priority: 'P2' as const, stageId: 'stage-x' };
    const summary = await reconcileOrphanedExecutingProposals(baseDeps(store, { readTaskFields }));

    expect(summary.outcomes[0].finalizedTo).toBe('executed');
    const rj = store.proposals.get('p1')?.result as ReprioritizeResultJson;
    expect(rj.items).toEqual([
      { taskId: 'T1', ok: true },
      { taskId: 'T2', ok: true },
    ]);
  });

  it('reprioritize: a not-yet-applied item → failed crashed-mid-execution', async () => {
    const store = new FakeStore();
    store.add(
      makeProposal({ kind: 'reprioritize-backlog', projectId: 7, items: [{ taskId: 'T1', priority: 'P0' }] }, { status: 'executing' }),
    );
    const summary = await reconcileOrphanedExecutingProposals(
      baseDeps(store, { readTaskFields: () => ({ priority: 'P2', stageId: null }) }),
    );

    expect(summary.outcomes[0].finalizedTo).toBe('failed');
    const rj = store.proposals.get('p1')?.result as ReprioritizeResultJson;
    expect(rj.items).toEqual([{ taskId: 'T1', ok: false }]);
  });

  it('edit-workflow: current spec hash equals the proposed edit → executed; else failed', async () => {
    const applied = new FakeStore();
    applied.add(
      makeProposal({ kind: 'edit-workflow', workflowId: 'wf', definitionJson: JSON.stringify(NEW_SPEC) }, { status: 'executing' }),
    );
    // The edit landed: current effective spec == the proposed definition.
    const summaryApplied = await reconcileOrphanedExecutingProposals(baseDeps(applied, { readEffectiveWorkflowSpec: () => NEW_SPEC }));
    expect(summaryApplied.outcomes[0].finalizedTo).toBe('executed');

    const notApplied = new FakeStore();
    notApplied.add(
      makeProposal({ kind: 'edit-workflow', workflowId: 'wf', definitionJson: JSON.stringify(NEW_SPEC) }, { status: 'executing' }),
    );
    const summaryStale = await reconcileOrphanedExecutingProposals(baseDeps(notApplied, { readEffectiveWorkflowSpec: () => CURRENT_SPEC }));
    expect(summaryStale.outcomes[0].finalizedTo).toBe('failed');
  });
});
