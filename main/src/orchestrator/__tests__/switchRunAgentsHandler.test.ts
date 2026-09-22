/**
 * switchRunAgentsHandler — "Switch runtime & retry" on a limit-paused
 * programmatic run. Pins the validate-before-write ORDER (every noOp leaves the
 * override column untouched), the target normalization, both scopes, the
 * visual-verify exclusion, the lost-race ('already_settled') path, and the
 * clear/read helpers. Every collaborator besides the DB is a fake.
 */
import { describe, it, expect, vi } from 'vitest';
import type Database from 'better-sqlite3';
import { createTestDb, seedRun } from '../__test_fixtures__/orchestratorTestDb';
import { dbAdapter } from '../__test_fixtures__/dbAdapter';
import {
  clearRunAgentTargets,
  readRunAgentTargets,
  switchRunAgentsHandler,
  type PendingPauseRef,
  type SwitchRunAgentsDeps,
  type SwitchRunAgentsInput,
} from '../switchRunAgentsHandler';
import type { AgentProvider } from '../../../../shared/types/agentRuntime';

function makeDb(opts: { programmatic?: boolean; column?: boolean } = {}): { db: Database.Database; runId: string } {
  const db = createTestDb({
    includeSubstrate: true,
    ...(opts.column === false ? {} : { includeRunAgentTargetOverrides: true }),
  });
  const { runId } = seedRun(db, { status: 'awaiting_review' });
  if (opts.programmatic !== false) {
    db.prepare("UPDATE workflow_runs SET execution_model = 'programmatic' WHERE id = ?").run(runId);
  }
  return { db, runId };
}

function overridesJson(db: Database.Database, runId: string): string | null {
  return (
    db.prepare('SELECT agent_target_overrides_json AS v FROM workflow_runs WHERE id = ?').get(runId) as {
      v: string | null;
    }
  ).v;
}

const AGENTS: Array<{ agentKey: string; provider: AgentProvider }> = [
  { agentKey: 'implement', provider: 'claude' },
  { agentKey: 'code-review', provider: 'claude' },
  { agentKey: 'visual-verify', provider: 'claude' },
  { agentKey: 'research', provider: 'codex' },
];

function pause(overrides: Partial<PendingPauseRef> = {}): PendingPauseRef {
  return {
    reviewItemId: 'rvw_1',
    projectId: 1,
    payload: {
      kind: 'decision',
      gate: 'systemic-pause',
      stepId: 'implement',
      agentKeys: ['implement'],
      blockedProvider: 'claude',
      origin: 'step',
      fanOut: false,
    },
    ...overrides,
  };
}

function makeDeps(
  db: Database.Database,
  overrides: Partial<SwitchRunAgentsDeps> = {},
): SwitchRunAgentsDeps & {
  resolveItem: ReturnType<typeof vi.fn>;
} {
  const resolveItem = vi.fn(async () => 'resolved' as const);
  return {
    db: dbAdapter(db),
    isProviderEnabled: () => true,
    isProviderReady: async () => true,
    listRunAgentTargets: () => AGENTS,
    findPendingPause: async () => pause(),
    resolveItem,
    ...overrides,
  } as SwitchRunAgentsDeps & { resolveItem: ReturnType<typeof vi.fn> };
}

function input(runId: string, over: Partial<SwitchRunAgentsInput> = {}): SwitchRunAgentsInput {
  return {
    runId,
    reviewItemId: 'rvw_1',
    scope: 'provider',
    target: { runtime: 'codex-sdk', providerModel: 'gpt-5.6-sol' },
    ...over,
  };
}

describe('switchRunAgentsHandler — refusals are decided before any write', () => {
  it('not_found for an unknown run', async () => {
    const { db } = makeDb();
    await expect(switchRunAgentsHandler(input('nope'), makeDeps(db))).resolves.toEqual({ noOp: 'not_found' });
  });

  it('not_programmatic for an orchestrated run', async () => {
    const { db, runId } = makeDb({ programmatic: false });
    await expect(switchRunAgentsHandler(input(runId), makeDeps(db))).resolves.toEqual({
      noOp: 'not_programmatic',
    });
    expect(overridesJson(db, runId)).toBeNull();
  });

  it('no_target for an empty target', async () => {
    const { db, runId } = makeDb();
    await expect(switchRunAgentsHandler(input(runId, { target: {} }), makeDeps(db))).resolves.toEqual({
      noOp: 'no_target',
    });
  });

  it.each([
    ['an unknown runtime', { runtime: 'bogus-sdk' }],
    ['a non-alias Claude model', { runtime: 'claude-sdk', model: 'gpt-5' }],
    ['an effort outside the target provider scale (Claude max on Codex)', { runtime: 'codex-sdk', effort: 'max' }],
    ['an effort outside the target provider scale (Codex minimal on Claude)', { runtime: 'claude-sdk', effort: 'minimal' }],
    ['a whitespace provider model', { runtime: 'codex-sdk', providerModel: '   ' }],
  ])('invalid_target for %s', async (_label, target) => {
    const { db, runId } = makeDb();
    const result = await switchRunAgentsHandler(
      input(runId, { target: target as SwitchRunAgentsInput['target'] }),
      makeDeps(db),
    );
    expect(result).toEqual({ noOp: 'invalid_target' });
    expect(overridesJson(db, runId)).toBeNull();
  });

  it('provider_disabled when the target provider is switched off', async () => {
    const { db, runId } = makeDb();
    const isProviderReady = vi.fn(async () => true);
    const result = await switchRunAgentsHandler(
      input(runId),
      makeDeps(db, { isProviderEnabled: (p) => p !== 'codex', isProviderReady }),
    );
    expect(result).toEqual({ noOp: 'provider_disabled' });
    expect(isProviderReady).not.toHaveBeenCalled();
    expect(overridesJson(db, runId)).toBeNull();
  });

  it('provider_unavailable when the target provider is not ready (or the probe throws)', async () => {
    const { db, runId } = makeDb();
    await expect(
      switchRunAgentsHandler(input(runId), makeDeps(db, { isProviderReady: async () => false })),
    ).resolves.toEqual({ noOp: 'provider_unavailable' });
    await expect(
      switchRunAgentsHandler(
        input(runId),
        makeDeps(db, {
          isProviderReady: async () => {
            throw new Error('probe boom');
          },
        }),
      ),
    ).resolves.toEqual({ noOp: 'provider_unavailable' });
    expect(overridesJson(db, runId)).toBeNull();
  });

  it('item_not_pending when the caller names an item but nothing is pending', async () => {
    const { db, runId } = makeDb();
    const deps = makeDeps(db, { findPendingPause: async () => null });
    await expect(switchRunAgentsHandler(input(runId), deps)).resolves.toEqual({ noOp: 'item_not_pending' });
    expect(overridesJson(db, runId)).toBeNull();
  });

  it('item_mismatch when the caller names a different item than the pending pause', async () => {
    const { db, runId } = makeDb();
    const deps = makeDeps(db);
    await expect(
      switchRunAgentsHandler(input(runId, { reviewItemId: 'rvw_other' }), deps),
    ).resolves.toEqual({ noOp: 'item_mismatch' });
    expect(deps.resolveItem).not.toHaveBeenCalled();
    expect(overridesJson(db, runId)).toBeNull();
  });

  it.each([
    ['a fan-out pause', pause({ payload: { kind: 'decision', gate: 'systemic-pause', agentKeys: ['implement'], fanOut: true } })],
    ['a pause with no agentKeys', pause({ payload: { kind: 'decision', gate: 'systemic-pause' } })],
    ['a pre-feature pause (null payload)', pause({ payload: null })],
  ])('step_scope_unavailable for %s', async (_label, pending) => {
    const { db, runId } = makeDb();
    const deps = makeDeps(db, { findPendingPause: async () => pending });
    await expect(switchRunAgentsHandler(input(runId, { scope: 'step' }), deps)).resolves.toEqual({
      noOp: 'step_scope_unavailable',
    });
    expect(overridesJson(db, runId)).toBeNull();
  });

  it('step_scope_unavailable with no pending pause at all (override-only call)', async () => {
    const { db, runId } = makeDb();
    const deps = makeDeps(db, { findPendingPause: async () => null });
    await expect(
      switchRunAgentsHandler(input(runId, { scope: 'step', reviewItemId: undefined }), deps),
    ).resolves.toEqual({ noOp: 'step_scope_unavailable' });
  });

  it('no_agents when nothing resolves onto the blocked provider', async () => {
    const { db, runId } = makeDb();
    const deps = makeDeps(db, {
      listRunAgentTargets: () => [{ agentKey: 'research', provider: 'codex' }],
      findPendingPause: async () => pause({ payload: { kind: 'decision', gate: 'systemic-pause', blockedProvider: 'claude' } }),
    });
    await expect(switchRunAgentsHandler(input(runId), deps)).resolves.toEqual({ noOp: 'no_agents' });
    expect(overridesJson(db, runId)).toBeNull();
  });
});

describe('switchRunAgentsHandler — write + retry', () => {
  it("provider scope: every agent on the blocked provider, normalized for Codex, then resolves the pause (retry)", async () => {
    const { db, runId } = makeDb();
    const deps = makeDeps(db);

    const result = await switchRunAgentsHandler(input(runId), deps);

    expect(result).toEqual({
      delivered: true,
      agentKeys: ['implement', 'code-review', 'visual-verify'],
      target: { runtime: 'codex-sdk', model: null, providerModel: 'gpt-5.6-sol' },
      retried: true,
    });
    const stored = JSON.parse(overridesJson(db, runId) ?? '{}') as Record<string, unknown>;
    expect(Object.keys(stored).sort()).toEqual(['code-review', 'implement', 'visual-verify']);
    expect(stored.implement).toEqual({ runtime: 'codex-sdk', model: null, providerModel: 'gpt-5.6-sol' });
    expect(deps.resolveItem).toHaveBeenCalledWith({
      projectId: 1,
      reviewItemId: 'rvw_1',
      resolution: 'retry: switched 3 agent(s) (implement, code-review, visual-verify) → codex-sdk / gpt-5.6-sol',
    });
  });

  it("provider scope unions the pause's own agentKeys (e.g. an agent already pinned elsewhere)", async () => {
    const { db, runId } = makeDb();
    const deps = makeDeps(db, {
      findPendingPause: async () =>
        pause({
          payload: {
            kind: 'decision',
            gate: 'systemic-pause',
            agentKeys: ['research'],
            blockedProvider: 'claude',
          },
        }),
    });
    const result = await switchRunAgentsHandler(input(runId), deps);
    expect('delivered' in result && result.agentKeys).toEqual(['implement', 'code-review', 'visual-verify', 'research']);
  });

  it("provider scope falls back to the run's provider when the pause names none", async () => {
    const { db, runId } = makeDb();
    db.prepare("UPDATE workflow_runs SET agent_provider = 'codex', agent_runtime = 'codex-sdk' WHERE id = ?").run(runId);
    const deps = makeDeps(db, {
      findPendingPause: async () => pause({ payload: null }),
    });
    const result = await switchRunAgentsHandler(
      input(runId, { target: { runtime: 'claude-sdk', model: 'sonnet' } }),
      deps,
    );
    expect(result).toMatchObject({
      delivered: true,
      agentKeys: ['research'],
      target: { runtime: 'claude-sdk', model: 'sonnet', providerModel: null },
    });
  });

  it('step scope: exactly the pause agentKeys', async () => {
    const { db, runId } = makeDb();
    const deps = makeDeps(db);
    const result = await switchRunAgentsHandler(
      input(runId, { scope: 'step', target: { runtime: 'claude-sdk', model: 'haiku', effort: 'low' } }),
      deps,
    );
    expect(result).toEqual({
      delivered: true,
      agentKeys: ['implement'],
      target: { runtime: 'claude-sdk', model: 'haiku', providerModel: null, effort: 'low' },
      retried: true,
    });
    expect(deps.resolveItem).toHaveBeenCalledWith(
      expect.objectContaining({ resolution: 'retry: switched 1 agent(s) (implement) → claude-sdk / haiku · effort low' }),
    );
  });

  it("always persists a runtime (the run's own when the target names none)", async () => {
    const { db, runId } = makeDb();
    const result = await switchRunAgentsHandler(
      input(runId, { scope: 'step', target: { model: 'opus' } }),
      makeDeps(db),
    );
    expect(result).toMatchObject({ target: { runtime: 'claude-sdk', model: 'opus', providerModel: null } });
  });

  it('excludes visual-verify on a provider with no verify runtime, with a note', async () => {
    const { db, runId } = makeDb();
    const result = await switchRunAgentsHandler(
      input(runId, { target: { runtime: 'omp-sdk', providerModel: 'some-model' } }),
      makeDeps(db),
    );
    expect(result).toMatchObject({ delivered: true, agentKeys: ['implement', 'code-review'], retried: true });
    expect('delivered' in result && result.note).toMatch(/visual-verify was left on its current provider/);
  });

  it('replaces covered entries wholesale and keeps the others', async () => {
    const { db, runId } = makeDb();
    db.prepare('UPDATE workflow_runs SET agent_target_overrides_json = ? WHERE id = ?').run(
      JSON.stringify({
        implement: { runtime: 'claude-sdk', model: 'opus', effort: 'max' },
        research: { runtime: 'pi-sdk' },
      }),
      runId,
    );
    await switchRunAgentsHandler(
      input(runId, { scope: 'step', target: { runtime: 'codex-sdk' } }),
      makeDeps(db),
    );
    expect(JSON.parse(overridesJson(db, runId) ?? '{}')).toEqual({
      implement: { runtime: 'codex-sdk', model: null },
      research: { runtime: 'pi-sdk' },
    });
  });

  it("lost race: the pause already cleared ⇒ delivered, retried:false, a note — the override stays written", async () => {
    const { db, runId } = makeDb();
    const deps = makeDeps(db, { resolveItem: vi.fn(async () => 'already_settled' as const) });
    const result = await switchRunAgentsHandler(input(runId), deps);
    expect(result).toMatchObject({
      delivered: true,
      retried: false,
      note: 'The pause had already cleared; the switch applies from the next spawn.',
    });
    expect(overridesJson(db, runId)).not.toBeNull();
  });

  it('never throws after the write: a failing resolve is reported as a note', async () => {
    const { db, runId } = makeDb();
    const deps = makeDeps(db, {
      resolveItem: vi.fn(async () => {
        throw new Error('router down');
      }),
    });
    const result = await switchRunAgentsHandler(input(runId), deps);
    expect(result).toMatchObject({ delivered: true, retried: false });
    expect('delivered' in result && result.note).toMatch(/could not be resolved/);
    expect(overridesJson(db, runId)).not.toBeNull();
  });

  it('override-only: no pending pause and no reviewItemId ⇒ writes, retries nothing', async () => {
    const { db, runId } = makeDb();
    const deps = makeDeps(db, { findPendingPause: async () => null });
    const result = await switchRunAgentsHandler(input(runId, { reviewItemId: undefined }), deps);
    expect(result).toMatchObject({ delivered: true, retried: false });
    expect(deps.resolveItem).not.toHaveBeenCalled();
    expect(overridesJson(db, runId)).not.toBeNull();
  });
});

describe('clearRunAgentTargets / readRunAgentTargets', () => {
  it('clears the column for a programmatic run', () => {
    const { db, runId } = makeDb();
    db.prepare('UPDATE workflow_runs SET agent_target_overrides_json = ? WHERE id = ?').run(
      JSON.stringify({ implement: { runtime: 'codex-sdk' } }),
      runId,
    );
    expect(readRunAgentTargets(dbAdapter(db), runId)).toEqual({ implement: { runtime: 'codex-sdk' } });
    expect(clearRunAgentTargets({ runId }, { db: dbAdapter(db) })).toEqual({ delivered: true });
    expect(overridesJson(db, runId)).toBeNull();
    expect(readRunAgentTargets(dbAdapter(db), runId)).toBeNull();
  });

  it('refuses unknown and orchestrated runs', () => {
    const { db, runId } = makeDb({ programmatic: false });
    expect(clearRunAgentTargets({ runId: 'nope' }, { db: dbAdapter(db) })).toEqual({ noOp: 'not_found' });
    expect(clearRunAgentTargets({ runId }, { db: dbAdapter(db) })).toEqual({ noOp: 'not_programmatic' });
  });

  it('readRunAgentTargets is null on a DB without the column (pre-144)', () => {
    const { db, runId } = makeDb({ column: false });
    expect(readRunAgentTargets(dbAdapter(db), runId)).toBeNull();
  });
});
