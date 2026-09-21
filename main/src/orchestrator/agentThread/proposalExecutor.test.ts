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
  type CreateBacklogResultJson,
  type CreateWorkflowResultJson,
  type ReviewItemStateSnapshot,
  type StartQuickSessionCreated,
  type StartQuickSessionResultJson,
  type TriageFindingsResultJson,
  type TriageReviewItemChange,
} from './proposalExecutor';
import { computeSpecHash } from './specHash';
import type {
  AgentProposal,
  AgentProposalPayload,
  AgentProposalPreconditions,
  AgentProposalStatus,
  CreateBacklogItem,
  CreateWorkflowAgent,
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
    createBacklogItem: async () => ({ taskId: 'tsk_new', ref: 'TASK-001' }),
    runInTransaction: <T>(fn: () => T): T => fn(),
    readEffectiveWorkflowSpec: () => CURRENT_SPEC,
    applyWorkflowSpec: () => {},
    createCustomAgent: async (_projectId, agent) => ({ agentKey: agent.name.toLowerCase().replace(/[^a-z0-9]+/g, '-') }),
    deleteCustomAgent: async () => {},
    createWorkflow: () => ({ workflowId: 'wf-7-custom-abcd1234' }),
    findWorkflowIdByName: () => null,
    customAgentExists: () => false,
    applyReviewItemChange: async () => {},
    readReviewItemState: () => ({ status: 'pending', stagedAt: null, selected: false }),
    startQuickSession: async () => QUICK_CREATED,
    deliverQuickSessionBrief: async () => ({ claudePanelId: 'panel-q' }),
    ...over,
  };
}

const QUICK_CREATED: StartQuickSessionCreated = {
  sessionId: 'sess-q',
  runId: 'run-q',
  worktreePath: '/wt/sess-q',
  name: 'sunny-lake-20260921',
  substrate: 'sdk',
};

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

  it('carries a stamped workflowId into the launch, keeps the display name for the session hint, and records ignored seeds (TASK-294)', async () => {
    const store = new FakeStore();
    store.add(
      makeProposal(
        {
          kind: 'launch-run',
          projectId: 7,
          workflowName: 'dash',
          workflowId: 'wf-global-custom-e253eb7b',
          workflowScope: 'global',
          taskIds: ['T1'],
          findingIds: ['F1'],
        },
        { id: 'prop-dash0001' },
      ),
    );
    const createQuickSession = vi.fn(async () => ({ sessionId: 'sess-d', worktreePath: '/wt/sess-d' }));
    const launchRun = vi.fn(async () => ({ runId: 'run-d', worktreePath: '/wt/sess-d', branchName: 'br-d', ignoredSeeds: ['findingIds' as const] }));
    const deps = baseDeps(store, { createQuickSession, launchRun });

    const result = await executeProposal(deps, 'prop-dash0001');
    expect(result.ok && result.status).toBe('executed');
    expect(createQuickSession).toHaveBeenCalledWith({ projectId: 7, nameHint: 'agent-dash-prop-das' });
    expect(launchRun).toHaveBeenCalledWith({
      projectId: 7,
      workflowName: 'dash',
      workflowId: 'wf-global-custom-e253eb7b',
      sessionId: 'sess-d',
      substrate: undefined,
      taskIds: ['T1'],
      ideaIds: undefined,
      findingIds: ['F1'],
    });
    const rj = store.proposals.get('prop-dash0001')?.result as LaunchRunResultJson;
    expect(rj).toMatchObject({ kind: 'launch-run', status: 'executed', runId: 'run-d', ignoredSeeds: ['findingIds'] });
  });

  it('omits ignoredSeeds from the result when the launch dropped nothing', async () => {
    const store = new FakeStore();
    store.add(makeProposal({ kind: 'launch-run', projectId: 7, workflowName: 'sprint', taskIds: ['T1'] }));
    const deps = baseDeps(store, { launchRun: async () => ({ runId: 'r', worktreePath: '/w', branchName: 'b', ignoredSeeds: [] }) });
    await executeProposal(deps, 'p1');
    expect(store.proposals.get('p1')?.result).not.toHaveProperty('ignoredSeeds');
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
// create-backlog-items
// ---------------------------------------------------------------------------

describe('executeProposal — create-backlog-items', () => {
  it('creates every item in order through the chokepoint, finalizing executed', async () => {
    const store = new FakeStore();
    store.add(
      makeProposal({
        kind: 'create-backlog-items',
        projectId: 7,
        items: [
          { taskType: 'epic', title: 'An epic' },
          { taskType: 'task', title: 'A task', body: 'Do the thing', priority: 'P1', parentEpicId: 'epc_existing' },
        ],
      }),
    );

    const calls: Array<{ projectId: number; item: CreateBacklogItem }> = [];
    const createBacklogItem = vi.fn(async (projectId: number, item: CreateBacklogItem) => {
      calls.push({ projectId, item });
      return { taskId: `id-${calls.length}`, ref: `REF-${calls.length}` };
    });

    const result = await executeProposal(baseDeps(store, { createBacklogItem }), 'p1');

    if (!result.ok) throw new Error('expected ok');
    expect(result.status).toBe('executed');
    // Order is preserved — a parent epic listed first must be created first.
    expect(calls.map((c) => c.item.title)).toEqual(['An epic', 'A task']);
    expect(calls.every((c) => c.projectId === 7)).toBe(true);

    const rj = store.proposals.get('p1')?.result as CreateBacklogResultJson;
    expect(rj.items).toEqual([
      { index: 0, title: 'An epic', taskType: 'epic', ok: true, taskId: 'id-1', ref: 'REF-1' },
      { index: 1, title: 'A task', taskType: 'task', ok: true, taskId: 'id-2', ref: 'REF-2' },
    ]);
  });

  it('partial failure: item 2 of 3 rejected → items 1 & 3 still created, overall failed', async () => {
    const store = new FakeStore();
    store.add(
      makeProposal({
        kind: 'create-backlog-items',
        projectId: 7,
        items: [
          { taskType: 'task', title: 'One' },
          { taskType: 'task', title: 'Two' },
          { taskType: 'task', title: 'Three' },
        ],
      }),
    );

    const created: string[] = [];
    const createBacklogItem = vi.fn(async (_projectId: number, item: CreateBacklogItem) => {
      if (item.title === 'Two') throw new Error('idea_needs_epic');
      created.push(item.title);
      return { taskId: `id-${item.title}` };
    });

    const result = await executeProposal(baseDeps(store, { createBacklogItem }), 'p1');

    if (!result.ok) throw new Error('expected ok');
    expect(result.status).toBe('failed');
    // A rejection does NOT abort the batch — item 3 is still attempted.
    expect(created).toEqual(['One', 'Three']);

    const rj = store.proposals.get('p1')?.result as CreateBacklogResultJson;
    expect(rj.items.map((i) => i.ok)).toEqual([true, false, true]);
    expect(rj.items[1].error).toBe('idea_needs_epic');
    // No `ref` key is fabricated when the chokepoint returned none.
    expect(rj.items[0]).toEqual({ index: 0, title: 'One', taskType: 'task', ok: true, taskId: 'id-One' });
  });

  it('rejects a double-confirm: the loser never re-runs the creates', async () => {
    const store = new FakeStore();
    store.add(
      makeProposal({ kind: 'create-backlog-items', projectId: 7, items: [{ taskType: 'task', title: 'Once' }] }),
    );
    const createBacklogItem = vi.fn(async () => ({ taskId: 'id-1' }));
    const deps = baseDeps(store, { createBacklogItem });

    const first = await executeProposal(deps, 'p1');
    const second = await executeProposal(deps, 'p1');

    expect(first.ok).toBe(true);
    expect(second).toEqual({ ok: false, reason: 'claimed' });
    expect(createBacklogItem).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// create-workflow
// ---------------------------------------------------------------------------

const DOCS_FLOW: WorkflowDefinition = {
  id: 'docs-review',
  phases: [
    {
      id: 'review',
      label: 'Review',
      color: '#3b6dd6',
      steps: [
        { id: 'write', name: 'Write', agent: 'docs-writer', mcps: [], retries: 0 },
        { id: 'check', name: 'Check', agent: 'docs-checker', mcps: [], retries: 0 },
      ],
    },
  ],
};

const DOCS_AGENTS: CreateWorkflowAgent[] = [
  { name: 'Docs Writer', description: 'Writes docs.', systemPrompt: 'Write docs.', tools: ['Read', 'Edit'] },
  { name: 'Docs Checker', description: 'Checks docs.', systemPrompt: 'Check docs.', tools: ['Read'] },
];

function createWorkflowProposal(over: { scope?: 'project' | 'global'; agents?: CreateWorkflowAgent[] } = {}): AgentProposal {
  return makeProposal({
    kind: 'create-workflow',
    projectId: 7,
    name: 'Docs Review',
    definitionJson: JSON.stringify(DOCS_FLOW),
    agents: over.agents ?? DOCS_AGENTS,
    permissionMode: 'acceptEdits',
    ...(over.scope !== undefined ? { scope: over.scope } : {}),
  });
}

describe('executeProposal — create-workflow', () => {
  it('mints every agent in order, then the flow, finalizing executed', async () => {
    const store = new FakeStore();
    store.add(createWorkflowProposal());
    const order: string[] = [];
    const createCustomAgent = vi.fn(async (projectId: number, agent: CreateWorkflowAgent) => {
      order.push(`agent:${projectId}:${agent.name}`);
      return { agentKey: agent.name === 'Docs Writer' ? 'docs-writer' : 'docs-checker' };
    });
    const createWorkflow = vi.fn((args: { projectId: number | null; name: string; definition: WorkflowDefinition; permissionMode?: string }) => {
      order.push(`flow:${args.projectId}:${args.name}:${args.permissionMode}`);
      return { workflowId: 'wf-7-custom-1' };
    });

    const result = await executeProposal(baseDeps(store, { createCustomAgent, createWorkflow }), 'p1');

    if (!result.ok) throw new Error('expected ok');
    expect(result.status).toBe('executed');
    // Agents BEFORE the flow, so its step bindings resolve on the first run; the
    // project scope (the default) pins the flow to the agents' project.
    expect(order).toEqual(['agent:7:Docs Writer', 'agent:7:Docs Checker', 'flow:7:Docs Review:acceptEdits']);
    expect(createWorkflow.mock.calls[0][0].definition).toEqual(DOCS_FLOW);

    const rj = store.proposals.get('p1')?.result as CreateWorkflowResultJson;
    expect(rj).toEqual({
      kind: 'create-workflow',
      status: 'executed',
      name: 'Docs Review',
      workflowId: 'wf-7-custom-1',
      agents: [
        { index: 0, name: 'Docs Writer', ok: true, agentKey: 'docs-writer' },
        { index: 1, name: 'Docs Checker', ok: true, agentKey: 'docs-checker' },
      ],
    });
  });

  it('a global-scoped flow with no agents is created with projectId null', async () => {
    const store = new FakeStore();
    store.add(createWorkflowProposal({ scope: 'global', agents: [] }));
    const createCustomAgent = vi.fn(async () => ({ agentKey: 'x' }));
    const createWorkflow = vi.fn((_args: { projectId: number | null; name: string }) => ({ workflowId: 'wf-global-custom-1' }));

    const result = await executeProposal(baseDeps(store, { createCustomAgent, createWorkflow }), 'p1');

    if (!result.ok) throw new Error('expected ok');
    expect(result.status).toBe('executed');
    expect(createCustomAgent).not.toHaveBeenCalled();
    expect(createWorkflow.mock.calls[0][0]).toMatchObject({ projectId: null, name: 'Docs Review' });
  });

  it('saga: agent 2 of 2 fails → agent 1 is deleted again, the flow is never created, finalized failed', async () => {
    const store = new FakeStore();
    store.add(createWorkflowProposal());
    const createCustomAgent = vi.fn(async (_projectId: number, agent: CreateWorkflowAgent) => {
      if (agent.name === 'Docs Checker') throw new Error('duplicate_key');
      return { agentKey: 'docs-writer' };
    });
    const deleteCustomAgent = vi.fn(async () => {});
    const createWorkflow = vi.fn(() => ({ workflowId: 'never' }));

    const result = await executeProposal(baseDeps(store, { createCustomAgent, deleteCustomAgent, createWorkflow }), 'p1');

    if (!result.ok) throw new Error('expected ok');
    expect(result.status).toBe('failed');
    expect(createWorkflow).not.toHaveBeenCalled();
    expect(deleteCustomAgent).toHaveBeenCalledWith(7, 'docs-writer');

    const rj = store.proposals.get('p1')?.result as CreateWorkflowResultJson;
    expect(rj.status).toBe('failed');
    expect(rj.error).toMatch(/Docs Checker.*duplicate_key/);
    expect(rj.agents).toEqual([
      { index: 0, name: 'Docs Writer', ok: true, agentKey: 'docs-writer' },
      { index: 1, name: 'Docs Checker', ok: false, error: 'duplicate_key' },
    ]);
    expect(rj.compensations).toEqual([{ agentKey: 'docs-writer', ok: true }]);
    expect(rj.workflowId).toBeUndefined();
  });

  it('saga: the flow fails after both agents landed → both are unwound in reverse; a failed unwind is recorded', async () => {
    const store = new FakeStore();
    store.add(createWorkflowProposal());
    const deleted: string[] = [];
    const deleteCustomAgent = vi.fn(async (_projectId: number, agentKey: string) => {
      deleted.push(agentKey);
      if (agentKey === 'docs-writer') throw new Error('referenced by workflow(s): other-flow');
    });
    const createWorkflow = vi.fn(() => {
      throw new Error("a workflow named 'Docs Review' already exists in this project");
    });

    const result = await executeProposal(baseDeps(store, { deleteCustomAgent, createWorkflow }), 'p1');

    if (!result.ok) throw new Error('expected ok');
    expect(result.status).toBe('failed');
    expect(deleted).toEqual(['docs-checker', 'docs-writer']);
    const rj = store.proposals.get('p1')?.result as CreateWorkflowResultJson;
    expect(rj.error).toMatch(/already exists/);
    expect(rj.compensations).toEqual([
      { agentKey: 'docs-checker', ok: true },
      { agentKey: 'docs-writer', ok: false, error: 'referenced by workflow(s): other-flow' },
    ]);
  });

  it('rejects a double-confirm: the loser never re-mints anything', async () => {
    const store = new FakeStore();
    store.add(createWorkflowProposal());
    const createWorkflow = vi.fn(() => ({ workflowId: 'wf-1' }));
    const deps = baseDeps(store, { createWorkflow });

    const first = await executeProposal(deps, 'p1');
    const second = await executeProposal(deps, 'p1');

    expect(first.ok).toBe(true);
    expect(second).toEqual({ ok: false, reason: 'claimed' });
    expect(createWorkflow).toHaveBeenCalledTimes(1);
  });
});

describe('reconcileOrphanedExecutingProposals — create-workflow', () => {
  it('flow present under its name AND every agent key present → executed; never re-mints', async () => {
    const store = new FakeStore();
    store.add({ ...createWorkflowProposal(), status: 'executing' });
    const createWorkflow = vi.fn(() => ({ workflowId: 'never' }));
    const createCustomAgent = vi.fn(async () => ({ agentKey: 'never' }));

    const summary = await reconcileOrphanedExecutingProposals(
      baseDeps(store, {
        createWorkflow,
        createCustomAgent,
        findWorkflowIdByName: (projectId, name) => (projectId === 7 && name === 'Docs Review' ? 'wf-7-custom-1' : null),
        customAgentExists: (projectId, key) => projectId === 7 && (key === 'docs-writer' || key === 'docs-checker'),
      }),
    );

    expect(summary.outcomes[0].finalizedTo).toBe('executed');
    expect(createWorkflow).not.toHaveBeenCalled();
    expect(createCustomAgent).not.toHaveBeenCalled();
    const rj = store.proposals.get('p1')?.result as CreateWorkflowResultJson;
    expect(rj).toMatchObject({ status: 'executed', workflowId: 'wf-7-custom-1', reconciled: true });
    expect(rj.agents.map((a) => a.ok)).toEqual([true, true]);
  });

  it('flow present but one agent missing → failed crashed-mid-execution, listing what landed', async () => {
    const store = new FakeStore();
    store.add({ ...createWorkflowProposal(), status: 'executing' });

    const summary = await reconcileOrphanedExecutingProposals(
      baseDeps(store, {
        findWorkflowIdByName: () => 'wf-7-custom-1',
        customAgentExists: (_projectId, key) => key === 'docs-writer',
      }),
    );

    expect(summary.outcomes[0].finalizedTo).toBe('failed');
    expect(summary.outcomes[0].note).toMatch(/crashed-mid-execution/);
    const rj = store.proposals.get('p1')?.result as CreateWorkflowResultJson;
    expect(rj.agents.map((a) => [a.agentKey, a.ok])).toEqual([
      ['docs-writer', true],
      ['docs-checker', false],
    ]);
    expect(rj.error).toBe('crashed-mid-execution');
  });

  it('no flow under the name → failed crashed-mid-execution', async () => {
    const store = new FakeStore();
    store.add({ ...createWorkflowProposal({ agents: [] }), status: 'executing' });

    const summary = await reconcileOrphanedExecutingProposals(baseDeps(store));

    expect(summary.outcomes[0].finalizedTo).toBe('failed');
    expect(summary.outcomes[0].note).toMatch(/no workflow named "Docs Review"/);
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

describe('reconcileOrphanedExecutingProposals — create-backlog-items', () => {
  it('always fails a stranded create as crashed-mid-execution, never re-running the creates', async () => {
    const store = new FakeStore();
    store.add(
      makeProposal(
        {
          kind: 'create-backlog-items',
          projectId: 7,
          items: [
            { taskType: 'idea', title: 'Idea one' },
            { taskType: 'task', title: 'Task two' },
          ],
        },
        { status: 'executing' },
      ),
    );
    const createBacklogItem = vi.fn(async () => ({ taskId: 'id-x' }));

    const summary = await reconcileOrphanedExecutingProposals(baseDeps(store, { createBacklogItem }));

    expect(summary.total).toBe(1);
    expect(summary.outcomes[0].finalizedTo).toBe('failed');
    expect(summary.outcomes[0].note).toMatch(/crashed-mid-execution/);
    // Reconciliation VERIFIES; it must never perform the side effect itself.
    expect(createBacklogItem).not.toHaveBeenCalled();
    expect(store.proposals.get('p1')?.status).toBe('failed');
    const rj = store.proposals.get('p1')?.result as CreateBacklogResultJson;
    expect(rj.reconciled).toBe(true);
    expect(rj.items.map((i) => i.ok)).toEqual([false, false]);
  });
});

// ---------------------------------------------------------------------------
// triage-findings (TASK-292)
// ---------------------------------------------------------------------------

describe('executeProposal — triage-findings', () => {
  /** A fake review inbox: live state per id, mutated by the recorded chokepoint writes. */
  function inbox(initial: Record<string, ReviewItemStateSnapshot>) {
    const state = new Map(Object.entries(initial));
    const writes: Array<{ projectId: number; change: TriageReviewItemChange }> = [];
    const applyReviewItemChange = vi.fn(async (projectId: number, change: TriageReviewItemChange) => {
      writes.push({ projectId, change });
      const ids = change.op === 'set-selected' ? change.reviewItemIds : [change.reviewItemId];
      for (const id of ids) {
        const live = state.get(id);
        if (!live) throw new Error(`review item ${id} not found`);
        if (change.op === 'resolve' || change.op === 'dismiss') {
          if (live.status !== 'pending') throw new Error(`already ${live.status}`);
          state.set(id, { ...live, status: change.op === 'resolve' ? 'resolved' : 'dismissed' });
        } else if (change.op === 'approve') {
          if (live.stagedAt !== null) throw new Error('not untriaged');
          state.set(id, { ...live, stagedAt: 'now' });
        } else if (change.op === 'set-selected') {
          if (live.stagedAt === null) throw new Error('not staged');
          state.set(id, { ...live, selected: change.selected });
        }
      }
    });
    const readReviewItemState = (_projectId: number, id: string): ReviewItemStateSnapshot | null => state.get(id) ?? null;
    return { state, writes, applyReviewItemChange, readReviewItemState };
  }
  const pending = (over: Partial<ReviewItemStateSnapshot> = {}): ReviewItemStateSnapshot => ({ status: 'pending', stagedAt: null, selected: false, ...over });

  it('fans a mixed batch out through the chokepoint, actor user, one write per item (two for select-unstaged)', async () => {
    const store = new FakeStore();
    store.add(
      makeProposal({
        kind: 'triage-findings',
        projectId: 7,
        items: [
          { reviewItemId: 'r1', op: 'dismiss', resolution: 'noise' },
          { reviewItemId: 'r2', op: 'resolve' },
          { reviewItemId: 'r3', op: 'approve' },
          { reviewItemId: 'r4', op: 'set-selected', selected: true },
          { reviewItemId: 'r5', op: 'set-selected', selected: false },
        ],
      }),
    );
    const box = inbox({ r1: pending(), r2: pending(), r3: pending(), r4: pending(), r5: pending({ stagedAt: 's', selected: true }) });
    const deps = baseDeps(store, { applyReviewItemChange: box.applyReviewItemChange, readReviewItemState: box.readReviewItemState });

    const result = await executeProposal(deps, 'p1');
    expect(result.ok && result.status).toBe('executed');
    expect(box.writes.map((w) => w.change)).toEqual([
      { op: 'dismiss', actor: 'user', reviewItemId: 'r1', resolution: 'noise' },
      { op: 'resolve', actor: 'user', reviewItemId: 'r2', resolution: null },
      { op: 'approve', actor: 'user', reviewItemId: 'r3' },
      { op: 'approve', actor: 'user', reviewItemId: 'r4' },
      { op: 'set-selected', actor: 'user', reviewItemIds: ['r4'], selected: true },
      { op: 'set-selected', actor: 'user', reviewItemIds: ['r5'], selected: false },
    ]);
    expect(box.writes.every((w) => w.projectId === 7)).toBe(true);
    const rj = store.proposals.get('p1')?.result as TriageFindingsResultJson;
    expect(rj).toEqual({
      kind: 'triage-findings',
      status: 'executed',
      applied: 5,
      skipped: 0,
      items: [
        { reviewItemId: 'r1', op: 'dismiss', ok: true },
        { reviewItemId: 'r2', op: 'resolve', ok: true },
        { reviewItemId: 'r3', op: 'approve', ok: true },
        { reviewItemId: 'r4', op: 'set-selected', ok: true },
        { reviewItemId: 'r5', op: 'set-selected', ok: true },
      ],
    });
    expect(box.state.get('r4')).toEqual({ status: 'pending', stagedAt: 'now', selected: true });
  });

  it('skips (never fails) an item someone else resolved or deleted between propose and confirm', async () => {
    const store = new FakeStore();
    store.add(
      makeProposal({
        kind: 'triage-findings',
        projectId: 7,
        items: [
          { reviewItemId: 'r1', op: 'dismiss' },
          { reviewItemId: 'r2', op: 'dismiss' },
          { reviewItemId: 'r3', op: 'approve' },
        ],
      }),
    );
    const box = inbox({ r1: pending(), r2: pending({ status: 'resolved' }) });
    const deps = baseDeps(store, { applyReviewItemChange: box.applyReviewItemChange, readReviewItemState: box.readReviewItemState });

    const result = await executeProposal(deps, 'p1');
    expect(result.ok && result.status).toBe('executed');
    expect(box.applyReviewItemChange).toHaveBeenCalledTimes(1);
    const rj = store.proposals.get('p1')?.result as TriageFindingsResultJson;
    expect(rj).toMatchObject({ status: 'executed', applied: 1, skipped: 2 });
    expect(rj.items).toEqual([
      { reviewItemId: 'r1', op: 'dismiss', ok: true },
      { reviewItemId: 'r2', op: 'dismiss', ok: false, skipped: 'already resolved' },
      { reviewItemId: 'r3', op: 'approve', ok: false, skipped: 'no longer exists' },
    ]);
  });

  it('a chokepoint rejection fails that item only; the batch finalizes failed with the rest applied', async () => {
    const store = new FakeStore();
    store.add(
      makeProposal({
        kind: 'triage-findings',
        projectId: 7,
        items: [
          { reviewItemId: 'r1', op: 'approve' },
          { reviewItemId: 'r2', op: 'dismiss' },
        ],
      }),
    );
    // r1 is pending but already staged → approve is refused by the chokepoint.
    const box = inbox({ r1: pending({ stagedAt: 's' }), r2: pending() });
    const deps = baseDeps(store, { applyReviewItemChange: box.applyReviewItemChange, readReviewItemState: box.readReviewItemState });

    const result = await executeProposal(deps, 'p1');
    expect(result.ok && result.status).toBe('failed');
    const rj = store.proposals.get('p1')?.result as TriageFindingsResultJson;
    expect(rj).toMatchObject({ status: 'failed', applied: 1, skipped: 0 });
    expect(rj.items[0]).toEqual({ reviewItemId: 'r1', op: 'approve', ok: false, error: 'not untriaged' });
    expect(rj.items[1]).toEqual({ reviewItemId: 'r2', op: 'dismiss', ok: true });
    expect(box.state.get('r2')?.status).toBe('dismissed');
  });
});

describe('reconcileOrphanedExecutingProposals — triage-findings', () => {
  const payload = {
    kind: 'triage-findings' as const,
    projectId: 7,
    items: [
      { reviewItemId: 'r1', op: 'dismiss' as const },
      { reviewItemId: 'r2', op: 'approve' as const },
      { reviewItemId: 'r3', op: 'set-selected' as const, selected: true },
    ],
  };

  it('every row already reflects its op → executed, never re-written', async () => {
    const store = new FakeStore();
    store.add(makeProposal(payload, { status: 'executing' }));
    const live: Record<string, ReviewItemStateSnapshot> = {
      r1: { status: 'dismissed', stagedAt: null, selected: false },
      r2: { status: 'pending', stagedAt: 's', selected: false },
      r3: { status: 'pending', stagedAt: 's', selected: true },
    };
    const applyReviewItemChange = vi.fn(async () => {});
    const deps = baseDeps(store, { applyReviewItemChange, readReviewItemState: (_p, id) => live[id] ?? null });

    const summary = await reconcileOrphanedExecutingProposals(deps);
    expect(summary.outcomes[0]).toMatchObject({ kind: 'triage-findings', finalizedTo: 'executed' });
    expect(applyReviewItemChange).not.toHaveBeenCalled();
    expect(store.proposals.get('p1')?.result).toMatchObject({ kind: 'triage-findings', status: 'executed', applied: 3, reconciled: true });
  });

  it('a row that does not reflect its op → failed crashed-mid-execution with the per-item state', async () => {
    const store = new FakeStore();
    store.add(makeProposal(payload, { status: 'executing' }));
    const live: Record<string, ReviewItemStateSnapshot> = {
      r1: { status: 'dismissed', stagedAt: null, selected: false },
      r2: { status: 'pending', stagedAt: null, selected: false },
      // Selected but never staged does not count as applied for set-selected:true.
      r3: { status: 'pending', stagedAt: null, selected: true },
    };
    const deps = baseDeps(store, { readReviewItemState: (_p, id) => live[id] ?? null });

    const summary = await reconcileOrphanedExecutingProposals(deps);
    expect(summary.outcomes[0]).toMatchObject({ finalizedTo: 'failed', note: expect.stringContaining('crashed-mid-execution') });
    const rj = store.proposals.get('p1')?.result as TriageFindingsResultJson;
    expect(rj.items.map((i) => i.ok)).toEqual([true, false, false]);
    expect(rj.applied).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// start-quick-session (TASK-295)
// ---------------------------------------------------------------------------

describe('executeProposal — start-quick-session', () => {
  it('mints the session, delivers the brief as its first prompt, and finalizes executed with the Open target', async () => {
    const store = new FakeStore();
    store.add(
      makeProposal({
        kind: 'start-quick-session',
        projectId: 7,
        brief: 'Look at findings rvw_1 and rvw_2 in main/src/foo.ts and propose fixes.',
        name: 'findings-sweep',
        substrate: 'interactive',
        inPlace: true,
      }),
    );
    const created: StartQuickSessionCreated = { ...QUICK_CREATED, name: 'findings-sweep', substrate: 'interactive' };
    const startQuickSession = vi.fn(async () => created);
    const deliverQuickSessionBrief = vi.fn(async () => ({ claudePanelId: 'panel-1' }));
    const deps = baseDeps(store, { startQuickSession, deliverQuickSessionBrief });

    const result = await executeProposal(deps, 'p1');

    expect(result.ok && result.status).toBe('executed');
    expect(startQuickSession).toHaveBeenCalledWith({ projectId: 7, name: 'findings-sweep', substrate: 'interactive', inPlace: true });
    // The brief rides on the minted session's own resolved shape — nothing re-derived.
    expect(deliverQuickSessionBrief).toHaveBeenCalledWith({ ...created, brief: 'Look at findings rvw_1 and rvw_2 in main/src/foo.ts and propose fixes.' });
    const rj = store.proposals.get('p1')?.result as StartQuickSessionResultJson;
    expect(rj).toEqual({
      kind: 'start-quick-session',
      status: 'executed',
      sessionId: 'sess-q',
      runId: 'run-q',
      worktreePath: '/wt/sess-q',
      sessionName: 'findings-sweep',
      substrate: 'interactive',
      claudePanelId: 'panel-1',
    });
  });

  it('defaults: no name / substrate → the boot layer mints them; inPlace false', async () => {
    const store = new FakeStore();
    store.add(makeProposal({ kind: 'start-quick-session', projectId: 7, brief: 'Hello' }));
    const startQuickSession = vi.fn(async () => QUICK_CREATED);
    await executeProposal(baseDeps(store, { startQuickSession }), 'p1');
    expect(startQuickSession).toHaveBeenCalledWith({ projectId: 7, inPlace: false });
  });

  it('saga: session-create fails → no compensation, finalized failed', async () => {
    const store = new FakeStore();
    store.add(makeProposal({ kind: 'start-quick-session', projectId: 7, brief: 'Hello' }));
    const dismissSession = vi.fn(async () => {});
    const deliverQuickSessionBrief = vi.fn(async () => ({ claudePanelId: 'never' }));
    const deps = baseDeps(store, {
      startQuickSession: async () => {
        throw new Error('git identity missing');
      },
      deliverQuickSessionBrief,
      dismissSession,
    });

    const result = await executeProposal(deps, 'p1');

    expect(result.ok && result.status).toBe('failed');
    expect(deliverQuickSessionBrief).not.toHaveBeenCalled();
    expect(dismissSession).not.toHaveBeenCalled();
    const rj = store.proposals.get('p1')?.result as StartQuickSessionResultJson;
    expect(rj).toEqual({ kind: 'start-quick-session', status: 'failed', error: 'git identity missing' });
  });

  it('saga: brief delivery fails after the session exists → the session is dismissed, finalized failed', async () => {
    const store = new FakeStore();
    store.add(makeProposal({ kind: 'start-quick-session', projectId: 7, brief: 'Hello' }));
    const dismissSession = vi.fn(async () => {});
    const cancelRun = vi.fn(async () => {});
    const deps = baseDeps(store, {
      deliverQuickSessionBrief: async () => {
        throw new Error('the Claude panel manager is not available yet');
      },
      dismissSession,
      cancelRun,
    });

    const result = await executeProposal(deps, 'p1');

    expect(result.ok && result.status).toBe('failed');
    // The FULL dismiss sweeps the sentinel with the session — no separate cancel-run step.
    expect(dismissSession).toHaveBeenCalledWith('sess-q');
    expect(cancelRun).not.toHaveBeenCalled();
    const rj = store.proposals.get('p1')?.result as StartQuickSessionResultJson;
    expect(rj).toMatchObject({
      kind: 'start-quick-session',
      status: 'failed',
      error: 'the Claude panel manager is not available yet',
      sessionId: 'sess-q',
      runId: 'run-q',
      sessionName: 'sunny-lake-20260921',
      compensations: [{ step: 'dismiss-session', ok: true }],
    });
  });

  it('saga: a failing dismiss is RECORDED, never thrown away', async () => {
    const store = new FakeStore();
    store.add(makeProposal({ kind: 'start-quick-session', projectId: 7, brief: 'Hello' }));
    const deps = baseDeps(store, {
      deliverQuickSessionBrief: async () => {
        throw new Error('spawn failed');
      },
      dismissSession: async () => {
        throw new Error('worktree busy');
      },
    });
    await executeProposal(deps, 'p1');
    const rj = store.proposals.get('p1')?.result as StartQuickSessionResultJson;
    expect(rj.compensations).toEqual([{ step: 'dismiss-session', ok: false, error: 'worktree busy' }]);
    expect(store.proposals.get('p1')?.status).toBe('failed');
  });
});

describe('reconcileOrphanedExecutingProposals — start-quick-session', () => {
  it('always fails a stranded start as crashed-mid-execution, never re-minting the session', async () => {
    const store = new FakeStore();
    store.add(makeProposal({ kind: 'start-quick-session', projectId: 7, brief: 'Hello' }, { status: 'executing' }));
    const startQuickSession = vi.fn(async () => QUICK_CREATED);
    const deliverQuickSessionBrief = vi.fn(async () => ({ claudePanelId: 'x' }));

    const summary = await reconcileOrphanedExecutingProposals(baseDeps(store, { startQuickSession, deliverQuickSessionBrief }));

    expect(summary.outcomes[0].finalizedTo).toBe('failed');
    expect(summary.outcomes[0].note).toMatch(/crashed-mid-execution/);
    expect(startQuickSession).not.toHaveBeenCalled();
    expect(deliverQuickSessionBrief).not.toHaveBeenCalled();
    const rj = store.proposals.get('p1')?.result as StartQuickSessionResultJson;
    expect(rj).toEqual({ kind: 'start-quick-session', status: 'failed', reconciled: true, error: 'crashed-mid-execution' });
  });
});
