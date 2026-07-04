/**
 * Integration tests for the cyboflow.variants tRPC router (A/B testing, mig 046).
 *
 * create/list/update/setStatus/delete happy paths + CONFLICT on label collision +
 * CONFLICT on delete-with-run-history + BAD_REQUEST on unresolvable/foreign +
 * NOT_FOUND on a missing variant.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { TRPCError } from '@trpc/server';
import { appRouter } from '../../router';
import { createContext } from '../../context';
import { WorkflowRegistry } from '../../../workflowRegistry';
import { dbAdapter } from '../../../__test_fixtures__/dbAdapter';
import { REGISTRY_SCHEMA } from '../../../../database/__test_fixtures__/registrySchema';

const WF = 'wf-global-planner';
const silentLogger = { info: () => undefined, error: () => undefined, warn: () => undefined, debug: () => undefined };

function createVariantsTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(REGISTRY_SCHEMA);
  db.exec('ALTER TABLE workflow_runs ADD COLUMN variant_id TEXT');
  db.exec(`
    CREATE TABLE workflow_variants (
      id TEXT PRIMARY KEY, workflow_id TEXT NOT NULL, label TEXT NOT NULL,
      spec_json TEXT NOT NULL DEFAULT '{}', agent_overrides_json TEXT, model TEXT, execution_model TEXT,
      weight INTEGER NOT NULL DEFAULT 1, status TEXT NOT NULL DEFAULT 'draft',
      created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE UNIQUE INDEX idx_workflow_variants_wf_label ON workflow_variants(workflow_id, label);
  `);
  db.prepare("INSERT INTO workflows (id, project_id, name, spec_json) VALUES (?, NULL, 'planner', '{}')").run(WF);
  return db;
}

function makeCaller(db: Database.Database) {
  const registry = new WorkflowRegistry(dbAdapter(db), silentLogger);
  return appRouter.createCaller(createContext({ workflowRegistry: registry }));
}

describe('cyboflow.variants', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createVariantsTestDb();
  });

  it('create → list → update → setStatus → delete happy path', async () => {
    const caller = makeCaller(db);
    const created = await caller.cyboflow.variants.create({ workflowId: WF, label: 'challenger' });
    expect(created.status).toBe('draft');
    expect(created.label).toBe('challenger');

    const list = await caller.cyboflow.variants.list({ workflowId: WF });
    expect(list.map((v) => v.id)).toEqual([created.id]);

    await caller.cyboflow.variants.update({ variantId: created.id, weight: 3, model: 'opus' });
    const afterUpdate = await caller.cyboflow.variants.list({ workflowId: WF });
    expect(afterUpdate[0].weight).toBe(3);
    expect(afterUpdate[0].model).toBe('opus');

    await caller.cyboflow.variants.setStatus({ variantId: created.id, status: 'active' });
    const afterStatus = await caller.cyboflow.variants.list({ workflowId: WF });
    expect(afterStatus[0].status).toBe('active');

    await caller.cyboflow.variants.delete({ variantId: created.id });
    expect(await caller.cyboflow.variants.list({ workflowId: WF })).toEqual([]);
  });

  it('update serializes agentOverrides to JSON (and null clears it)', async () => {
    const caller = makeCaller(db);
    const created = await caller.cyboflow.variants.create({ workflowId: WF, label: 'v' });
    await caller.cyboflow.variants.update({
      variantId: created.id,
      agentOverrides: { planner: { systemPrompt: 'hi', model: 'sonnet' } },
    });
    const raw = db.prepare('SELECT agent_overrides_json AS j FROM workflow_variants WHERE id = ?').get(created.id) as { j: string };
    expect(JSON.parse(raw.j)).toEqual({ planner: { systemPrompt: 'hi', model: 'sonnet' } });

    await caller.cyboflow.variants.update({ variantId: created.id, agentOverrides: null });
    const cleared = db.prepare('SELECT agent_overrides_json AS j FROM workflow_variants WHERE id = ?').get(created.id) as { j: string | null };
    expect(cleared.j).toBeNull();
  });

  it('create maps a label collision to CONFLICT', async () => {
    const caller = makeCaller(db);
    await caller.cyboflow.variants.create({ workflowId: WF, label: 'dup' });
    await expect(caller.cyboflow.variants.create({ workflowId: WF, label: 'dup' })).rejects.toMatchObject({
      code: 'CONFLICT',
    } satisfies Partial<TRPCError>);
  });

  it('create maps an unresolvable workflow to BAD_REQUEST', async () => {
    db.prepare("INSERT INTO workflows (id, project_id, name, spec_json) VALUES ('wf-broken', 1, 'not-a-builtin', '{}')").run();
    const caller = makeCaller(db);
    await expect(caller.cyboflow.variants.create({ workflowId: 'wf-broken', label: 'x' })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
  });

  it('create maps a missing workflow to NOT_FOUND', async () => {
    const caller = makeCaller(db);
    await expect(caller.cyboflow.variants.create({ workflowId: 'wf-missing', label: 'x' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('delete maps run-history to CONFLICT', async () => {
    const caller = makeCaller(db);
    const created = await caller.cyboflow.variants.create({ workflowId: WF, label: 'v' });
    db.prepare(
      "INSERT INTO workflow_runs (id, workflow_id, project_id, status, variant_id) VALUES ('run-1', ?, 1, 'completed', ?)",
    ).run(WF, created.id);
    await expect(caller.cyboflow.variants.delete({ variantId: created.id })).rejects.toMatchObject({
      code: 'CONFLICT',
    });
  });

  it('setStatus maps a missing variant to NOT_FOUND', async () => {
    const caller = makeCaller(db);
    await expect(caller.cyboflow.variants.setStatus({ variantId: 'wfv_nope', status: 'active' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });
});
