/**
 * Integration tests for the orchestrator tRPC workflows router (TASK-711).
 *
 * Tests exercise the live workflowsRouter procedures via createCaller, using
 * an in-memory SQLite database (REGISTRY_SCHEMA), the dbAdapter fixture, and
 * a real WorkflowRegistry instance constructed per-test.
 *
 * Tests:
 *  (a) list({projectId}) returns seeded rows.
 *  (b) list({projectId}) auto-seeds 5 SoloFlow defaults when project has none.
 *  (c) get({workflowId}) returns the matching row by id.
 *  (d) get({workflowId}) throws TRPCError code='NOT_FOUND' for an unknown id.
 *  (e) list and get both throw TRPCError code='PRECONDITION_FAILED' when
 *      ctx.workflowRegistry is undefined.
 */
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { TRPCError } from '@trpc/server';
import { appRouter } from '../../router';
import { createContext } from '../../context';
import { WorkflowRegistry } from '../../../workflowRegistry';
import { dbAdapter } from '../../../__test_fixtures__/dbAdapter';
import { REGISTRY_SCHEMA } from '../../../../database/__test_fixtures__/registrySchema';

// ---------------------------------------------------------------------------
// Test-database setup
// ---------------------------------------------------------------------------

/**
 * Creates a fresh in-memory SQLite database with REGISTRY_SCHEMA (workflows +
 * workflow_runs tables) and FK enforcement ON.
 */
function createWorkflowTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(REGISTRY_SCHEMA);
  return db;
}

/**
 * Minimal logger stub that satisfies LoggerLike (info/error/warn/debug).
 * Suppresses output to keep test output clean.
 */
const silentLogger = {
  info: () => undefined,
  error: () => undefined,
  warn: () => undefined,
  debug: () => undefined,
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('cyboflow.workflows.list', () => {
  // -------------------------------------------------------------------------
  // (a) list returns seeded rows
  // -------------------------------------------------------------------------
  it('(a) returns seeded workflow rows for the given projectId', async () => {
    const rawDb = createWorkflowTestDb();
    const adapter = dbAdapter(rawDb);
    const registry = new WorkflowRegistry(adapter, silentLogger);

    // Seed two workflows directly.
    rawDb
      .prepare(
        `INSERT INTO workflows (id, project_id, name, workflow_path, permission_mode)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run('wf-1-soloflow', 1, 'soloflow', '/some/path.md', 'default');
    rawDb
      .prepare(
        `INSERT INTO workflows (id, project_id, name, workflow_path, permission_mode)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run('wf-1-planner', 1, 'planner', '/other/path.md', 'acceptEdits');

    // Seed a workflow for a different project — must NOT appear.
    rawDb
      .prepare(
        `INSERT INTO workflows (id, project_id, name, workflow_path, permission_mode)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run('wf-2-soloflow', 2, 'soloflow', '/proj2/path.md', 'default');

    const caller = appRouter.createCaller(createContext({ workflowRegistry: registry }));
    const result = await caller.cyboflow.workflows.list({ projectId: 1 });

    expect(result).toHaveLength(2);
    const ids = result.map((r) => r.id);
    expect(ids).toContain('wf-1-soloflow');
    expect(ids).toContain('wf-1-planner');
    expect(ids).not.toContain('wf-2-soloflow');
  });

  // -------------------------------------------------------------------------
  // (b) list auto-seeds 5 SoloFlow defaults when project has none
  // -------------------------------------------------------------------------
  it('(b) auto-seeds 5 SoloFlow defaults and returns them when project has no workflows', async () => {
    const rawDb = createWorkflowTestDb();
    const adapter = dbAdapter(rawDb);
    const registry = new WorkflowRegistry(adapter, silentLogger);

    const caller = appRouter.createCaller(createContext({ workflowRegistry: registry }));
    const result = await caller.cyboflow.workflows.list({ projectId: 42 });

    // 5 defaults must have been seeded.
    expect(result).toHaveLength(5);

    // All belong to projectId=42.
    for (const wf of result) {
      expect(wf.project_id).toBe(42);
    }

    // Verify the canonical SoloFlow names are present.
    const names = result.map((r) => r.name).sort();
    expect(names).toEqual(['compound', 'planner', 'prune', 'soloflow', 'sprint']);

    // Deterministic id format: wf-<projectId>-<name>.
    for (const wf of result) {
      expect(wf.id).toBe(`wf-42-${wf.name}`);
    }
  });

  // -------------------------------------------------------------------------
  // (e-1) list throws PRECONDITION_FAILED when workflowRegistry is undefined
  // -------------------------------------------------------------------------
  it('(e) throws PRECONDITION_FAILED when workflowRegistry is not wired', async () => {
    const caller = appRouter.createCaller(createContext());

    await expect(
      caller.cyboflow.workflows.list({ projectId: 1 }),
    ).rejects.toSatisfy(
      (err: unknown) => err instanceof TRPCError && err.code === 'PRECONDITION_FAILED',
    );
  });
});

describe('cyboflow.workflows.get', () => {
  // -------------------------------------------------------------------------
  // (c) get returns the matching row by id
  // -------------------------------------------------------------------------
  it('(c) returns the matching WorkflowRow for a known workflowId', async () => {
    const rawDb = createWorkflowTestDb();
    const adapter = dbAdapter(rawDb);
    const registry = new WorkflowRegistry(adapter, silentLogger);

    rawDb
      .prepare(
        `INSERT INTO workflows (id, project_id, name, workflow_path, permission_mode)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run('wf-99-sprint', 99, 'sprint', '/path/sprint.md', 'dontAsk');

    const caller = appRouter.createCaller(createContext({ workflowRegistry: registry }));
    const result = await caller.cyboflow.workflows.get({ workflowId: 'wf-99-sprint' });

    expect(result.id).toBe('wf-99-sprint');
    expect(result.project_id).toBe(99);
    expect(result.name).toBe('sprint');
    expect(result.workflow_path).toBe('/path/sprint.md');
    expect(result.permission_mode).toBe('dontAsk');
  });

  // -------------------------------------------------------------------------
  // (d) get throws NOT_FOUND for an unknown workflowId
  // -------------------------------------------------------------------------
  it('(d) throws TRPCError NOT_FOUND for an unknown workflowId', async () => {
    const rawDb = createWorkflowTestDb();
    const adapter = dbAdapter(rawDb);
    const registry = new WorkflowRegistry(adapter, silentLogger);

    const caller = appRouter.createCaller(createContext({ workflowRegistry: registry }));

    await expect(
      caller.cyboflow.workflows.get({ workflowId: 'nonexistent-workflow-id' }),
    ).rejects.toSatisfy(
      (err: unknown) => err instanceof TRPCError && err.code === 'NOT_FOUND',
    );
  });

  // -------------------------------------------------------------------------
  // (e-2) get throws PRECONDITION_FAILED when workflowRegistry is undefined
  // -------------------------------------------------------------------------
  it('(e) throws PRECONDITION_FAILED when workflowRegistry is not wired', async () => {
    const caller = appRouter.createCaller(createContext());

    await expect(
      caller.cyboflow.workflows.get({ workflowId: 'any-id' }),
    ).rejects.toSatisfy(
      (err: unknown) => err instanceof TRPCError && err.code === 'PRECONDITION_FAILED',
    );
  });
});
