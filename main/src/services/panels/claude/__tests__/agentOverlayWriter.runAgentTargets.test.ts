/**
 * The RUN agent-target layer (migration 144 — workflow_runs
 * .agent_target_overrides_json) at the seam that feeds a programmatic spawn:
 * `resolveRunEffectiveAgents`. Proves it is the HIGHEST-precedence target layer
 * (beats the frozen spec's `agentConfigs` AND a variant delta), fails soft on an
 * absent column / malformed blob, and that `listRunAgentTargets` resolves each
 * agent's provider (pin ⇒ its runtime's provider, else the run's stamp).
 */
import { describe, it, expect } from 'vitest';
import type Database from 'better-sqlite3';
import {
  listRunAgentTargets,
  readRunAgentTargetOverrides,
  resolveRunEffectiveAgents,
} from '../agentOverlayWriter';
import { createTestDb, seedRun } from '../../../../orchestrator/__test_fixtures__/orchestratorTestDb';
import { makeSpyLogger } from '../../../../orchestrator/__test_fixtures__/loggerLikeSpy';
import { materializeForLevel } from '../../../../../../shared/tuning/workflowTuning';

/** A real built-in sprint spec with a workflow-level `implement` pin layered on. */
function sprintSpecWithImplementPin(): string {
  const def = JSON.parse(materializeForLevel('sprint', '', 'standard')) as Record<string, unknown>;
  const configs = (def.agentConfigs ?? {}) as Record<string, Record<string, unknown>>;
  configs.implement = { ...(configs.implement ?? {}), model: 'sonnet', effort: 'high' };
  def.agentConfigs = configs;
  return JSON.stringify(def);
}

function makeRun(opts: { withColumn: boolean }): { db: Database.Database; runId: string } {
  const db = createTestDb({
    includeSubstrate: true,
    ...(opts.withColumn ? { includeRunAgentTargetOverrides: true } : {}),
  });
  const { runId, workflowId } = seedRun(db, { workflowName: 'sprint' });
  db.prepare('UPDATE workflows SET spec_json = ? WHERE id = ?').run(sprintSpecWithImplementPin(), workflowId);
  return { db, runId };
}

function addVariant(db: Database.Database, runId: string, deltas: Record<string, unknown>): void {
  db.exec('CREATE TABLE workflow_variants (id TEXT PRIMARY KEY, agent_overrides_json TEXT)');
  db.prepare('INSERT INTO workflow_variants (id, agent_overrides_json) VALUES (?, ?)').run(
    'var-1',
    JSON.stringify(deltas),
  );
  db.prepare("UPDATE workflow_runs SET variant_id = 'var-1' WHERE id = ?").run(runId);
}

function setOverrides(db: Database.Database, runId: string, json: string | null): void {
  db.prepare('UPDATE workflow_runs SET agent_target_overrides_json = ? WHERE id = ?').run(json, runId);
}

describe('resolveRunEffectiveAgents — run agent-target overrides', () => {
  it('the workflow pin + variant delta resolve as before when no override is written', () => {
    const { db, runId } = makeRun({ withColumn: true });
    addVariant(db, runId, { implement: { model: 'haiku' } });
    const impl = resolveRunEffectiveAgents(db, runId).find((a) => a.agentKey === 'implement');
    expect(impl?.model).toBe('haiku'); // variant beats workflow config
    expect(impl?.effort).toBe('high'); // workflow config
    expect(impl?.runtime).toBeUndefined();
  });

  it('beats BOTH the variant delta and the workflow config for the fields it sets', () => {
    const { db, runId } = makeRun({ withColumn: true });
    addVariant(db, runId, { implement: { model: 'haiku' } });
    setOverrides(
      db,
      runId,
      JSON.stringify({
        implement: { runtime: 'codex-sdk', model: null, providerModel: 'gpt-5.6-sol', effort: null },
      }),
    );
    const eff = resolveRunEffectiveAgents(db, runId);
    const impl = eff.find((a) => a.agentKey === 'implement');
    expect(impl?.runtime).toBe('codex-sdk');
    expect(impl?.model).toBeNull(); // the variant's haiku cleared
    expect(impl?.providerModel).toBe('gpt-5.6-sol');
    expect(impl?.effort).toBeUndefined(); // the workflow's 'high' cleared
    // Untouched agents keep their resolution.
    expect(eff.find((a) => a.agentKey === 'code-review')?.runtime).toBeUndefined();
  });

  it('is fail-soft on a DB without the column (pre-144)', () => {
    const { db, runId } = makeRun({ withColumn: false });
    expect(readRunAgentTargetOverrides(db, runId)).toBeNull();
    const impl = resolveRunEffectiveAgents(db, runId).find((a) => a.agentKey === 'implement');
    expect(impl?.model).toBe('sonnet');
  });

  it('skips a malformed blob and warns once per run', () => {
    const { db, runId } = makeRun({ withColumn: true });
    setOverrides(db, runId, '{not json');
    const logger = makeSpyLogger();
    const impl = resolveRunEffectiveAgents(db, runId, logger).find((a) => a.agentKey === 'implement');
    resolveRunEffectiveAgents(db, runId, logger);
    expect(impl?.model).toBe('sonnet');
    expect(logger.calls.filter((c) => c.message.includes('agent_target_overrides_json'))).toHaveLength(1);
  });
});

describe('listRunAgentTargets', () => {
  it('pairs each agent with its pinned runtime provider, else the run stamp', () => {
    const { db, runId } = makeRun({ withColumn: true });
    setOverrides(db, runId, JSON.stringify({ implement: { runtime: 'codex-sdk' } }));
    const targets = listRunAgentTargets(db, runId);
    expect(targets.find((t) => t.agentKey === 'implement')?.provider).toBe('codex');
    expect(targets.find((t) => t.agentKey === 'code-review')?.provider).toBe('claude');

    db.prepare("UPDATE workflow_runs SET agent_provider = 'omp', agent_runtime = 'omp-sdk' WHERE id = ?").run(runId);
    const after = listRunAgentTargets(db, runId);
    expect(after.find((t) => t.agentKey === 'code-review')?.provider).toBe('omp');
    expect(after.find((t) => t.agentKey === 'implement')?.provider).toBe('codex');
  });

  it('lists only the agents the run\'s frozen definition binds, not the whole catalogue', () => {
    const { db, runId } = makeRun({ withColumn: true });
    const keys = listRunAgentTargets(db, runId).map((t) => t.agentKey);
    // The sprint chain binds these (outer steps + the fan-out inner chain) …
    expect(keys).toEqual(expect.arrayContaining(['implement', 'code-review', 'task-verify', 'sprint-verify']));
    // … and never the launch/planner/compound agents, which a switch must not touch.
    for (const foreign of ['interview', 'context', 'compounder', 'verify-setup']) {
      expect(keys).not.toContain(foreign);
    }
  });

  it('falls back to every effective agent when the frozen definition cannot be resolved', () => {
    const { db, runId } = makeRun({ withColumn: true });
    db.prepare("UPDATE workflows SET spec_json = '{}'").run();
    const keys = listRunAgentTargets(db, runId).map((t) => t.agentKey);
    expect(keys).toEqual(expect.arrayContaining(['implement', 'interview', 'compounder']));
  });

  it('returns [] for an unknown run', () => {
    const { db } = makeRun({ withColumn: true });
    expect(listRunAgentTargets(db, 'nope')).toEqual([]);
  });
});
