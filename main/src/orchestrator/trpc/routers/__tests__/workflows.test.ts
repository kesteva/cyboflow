/**
 * Integration tests for the orchestrator tRPC workflows router (TASK-711).
 *
 * Tests exercise the live workflowsRouter procedures via createCaller, using
 * an in-memory SQLite database (REGISTRY_SCHEMA), the dbAdapter fixture, and
 * a real WorkflowRegistry instance constructed per-test.
 *
 * Tests:
 *  (a) list({projectId}) returns seeded rows.
 *  (b) list({projectId}) auto-seeds the 2 in-repo built-ins when project has none.
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
import { CYBOFLOW_WORKFLOW_NAMES, WORKFLOW_DEFINITIONS } from '../../../../../../shared/types/workflows';
import type { WorkflowDefinition } from '../../../../../../shared/types/workflows';

/**
 * Minimal definition that passes the STRICT `workflowDefinitionSchema`
 * (kebab-case ids, hex colour, ≥1 phase / ≥1 step) — required because the
 * editor mutation procedures run that schema as their tRPC `.input()`.
 */
function makeDefinition(id: string): WorkflowDefinition {
  return {
    id,
    phases: [
      {
        id: 'plan',
        label: 'Plan',
        color: '#3b6dd6',
        steps: [
          { id: 'context', name: 'Get context', agent: 'idea-extractor', mcps: ['filesystem'], retries: 0 },
        ],
      },
    ],
  };
}

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
  // spec-capture (migration 026): WorkflowRegistry.updateSpec / resetSpec now
  // INSERT-OR-IGNORE a workflow_revisions snapshot (and createRun freezes
  // workflow_runs.spec_hash). Layer both additive shapes on top of
  // REGISTRY_SCHEMA — same convention as workflowRegistry.test.ts (the fixture
  // stays a frozen subset; tests layer what the code under test writes).
  db.exec('ALTER TABLE workflow_runs ADD COLUMN spec_hash TEXT');
  db.exec(`
    CREATE TABLE workflow_revisions (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      workflow_id TEXT NOT NULL,
      spec_hash   TEXT NOT NULL,
      spec_json   TEXT NOT NULL,
      created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (workflow_id, spec_hash),
      FOREIGN KEY (workflow_id) REFERENCES workflows(id) ON DELETE CASCADE
    )
  `);
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

    // Seed two PROJECT-SCOPED workflows directly (an edited per-project built-in
    // preserved by migration 030, disambiguated by the project chip in the UI).
    rawDb
      .prepare(
        `INSERT INTO workflows (id, project_id, name, workflow_path, permission_mode)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run('wf-1-sprint', 1, 'sprint', '/some/path.md', 'default');
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
      .run('wf-2-sprint', 2, 'sprint', '/proj2/path.md', 'default');

    const caller = appRouter.createCaller(createContext({ workflowRegistry: registry }));
    const result = await caller.cyboflow.workflows.list({ projectId: 1 });

    // list() reconciles the built-ins as ONE GLOBAL set on every call (migration
    // 030): the 3 `wf-global-<name>` rows are UPSERTed and surface for project 1
    // via the project_id-IS-NULL union, ALONGSIDE the 2 manually-seeded
    // project-scoped rows (the preserved edited built-ins). The renderer dedupes
    // global vs project rows by id; the router returns the raw union (5 rows).
    // The foreign project's row (wf-2-sprint) is still excluded.
    const ids = result.map((r) => r.id);
    expect(ids).toContain('wf-1-sprint');
    expect(ids).toContain('wf-1-planner');
    expect(ids).toContain('wf-global-planner');
    expect(ids).toContain('wf-global-sprint');
    expect(ids).toContain('wf-global-compound');
    expect(ids).not.toContain('wf-2-sprint');
    expect(result).toHaveLength(5);

    // The global built-ins carry NULL project_id; the preserved per-project rows
    // carry project 1.
    for (const r of result) {
      if (r.id.startsWith('wf-global-')) {
        expect(r.project_id).toBeNull();
      } else {
        expect(r.project_id).toBe(1);
      }
      // Every returned row carries spec_json (defaults to '{}' for these).
      expect(r.spec_json).toBe('{}');
    }
  });

  // -------------------------------------------------------------------------
  // (b) list auto-seeds the in-repo built-ins when project has none
  // -------------------------------------------------------------------------
  it('(b) auto-seeds the in-repo built-ins (planner+sprint+compound) as ONE GLOBAL set and returns them for a project with no workflows', async () => {
    const rawDb = createWorkflowTestDb();
    const adapter = dbAdapter(rawDb);
    const registry = new WorkflowRegistry(adapter, silentLogger);

    const caller = appRouter.createCaller(createContext({ workflowRegistry: registry }));
    const result = await caller.cyboflow.workflows.list({ projectId: 42 });

    // Every in-repo built-in must have been seeded (planner + sprint + compound).
    expect(result).toHaveLength(CYBOFLOW_WORKFLOW_NAMES.length);

    // They are GLOBAL (migration 030): NULL project_id, shared across projects,
    // surfaced for project 42 via the project_id-IS-NULL union in listByProject.
    for (const wf of result) {
      expect(wf.project_id).toBeNull();
    }

    // Verify the canonical cyboflow built-in names are present.
    const names = result.map((r) => r.name).sort();
    expect(names).toEqual([...CYBOFLOW_WORKFLOW_NAMES].sort());

    // Deterministic global id format: wf-global-<name>.
    for (const wf of result) {
      expect(wf.id).toBe(`wf-global-${wf.name}`);
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
    // spec_json is projected by get (schema default '{}').
    expect(result.spec_json).toBe('{}');
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

// ---------------------------------------------------------------------------
// Blueprint-editor procedures (getDefinition / updateSpec / resetSpec /
// createCustom). Each is exercised against a real WorkflowRegistry + in-memory
// SQLite via createCaller, mirroring the list/get tests above.
// ---------------------------------------------------------------------------

/** Insert a workflow row directly. spec_json defaults to '{}' when omitted. */
function insertWorkflow(
  rawDb: Database.Database,
  id: string,
  projectId: number,
  name: string,
  specJson = '{}',
  permissionMode = 'default',
): void {
  rawDb
    .prepare(
      `INSERT INTO workflows (id, project_id, name, spec_json, workflow_path, permission_mode)
       VALUES (?, ?, ?, ?, NULL, ?)`,
    )
    .run(id, projectId, name, specJson, permissionMode);
}

describe('cyboflow.workflows.getDefinition', () => {
  it('returns the built-in definition when spec_json is "{}" and name is a built-in', async () => {
    const rawDb = createWorkflowTestDb();
    const registry = new WorkflowRegistry(dbAdapter(rawDb), silentLogger);
    insertWorkflow(rawDb, 'wf-1-planner', 1, 'planner');

    const caller = appRouter.createCaller(createContext({ workflowRegistry: registry }));
    const result = await caller.cyboflow.workflows.getDefinition({ workflowId: 'wf-1-planner' });

    expect(result.id).toBe('planner');
    expect(result).toEqual(WORKFLOW_DEFINITIONS.planner);
  });

  it('prefers a valid spec_json override over the built-in definition', async () => {
    const rawDb = createWorkflowTestDb();
    const registry = new WorkflowRegistry(dbAdapter(rawDb), silentLogger);
    const override = makeDefinition('planner');
    override.phases[0].label = 'Overridden Plan';
    insertWorkflow(rawDb, 'wf-1-planner', 1, 'planner', JSON.stringify(override));

    const caller = appRouter.createCaller(createContext({ workflowRegistry: registry }));
    const result = await caller.cyboflow.workflows.getDefinition({ workflowId: 'wf-1-planner' });

    expect(result).toEqual(override);
    expect(result.phases[0].label).toBe('Overridden Plan');
  });

  it('resolves a CUSTOM workflow (non-built-in name + valid spec_json)', async () => {
    const rawDb = createWorkflowTestDb();
    const registry = new WorkflowRegistry(dbAdapter(rawDb), silentLogger);
    const custom = makeDefinition('my-custom-flow');
    insertWorkflow(rawDb, 'wf-1-custom-abc12345', 1, 'My Custom Flow', JSON.stringify(custom));

    const caller = appRouter.createCaller(createContext({ workflowRegistry: registry }));
    const result = await caller.cyboflow.workflows.getDefinition({ workflowId: 'wf-1-custom-abc12345' });

    expect(result).toEqual(custom);
  });

  it('throws NOT_FOUND when the workflow row is missing', async () => {
    const rawDb = createWorkflowTestDb();
    const registry = new WorkflowRegistry(dbAdapter(rawDb), silentLogger);
    const caller = appRouter.createCaller(createContext({ workflowRegistry: registry }));

    await expect(
      caller.cyboflow.workflows.getDefinition({ workflowId: 'nope' }),
    ).rejects.toSatisfy((err: unknown) => err instanceof TRPCError && err.code === 'NOT_FOUND');
  });

  it('throws NOT_FOUND when a custom row has spec_json="{}" (resolution null)', async () => {
    const rawDb = createWorkflowTestDb();
    const registry = new WorkflowRegistry(dbAdapter(rawDb), silentLogger);
    // Non-built-in name + empty spec → resolveWorkflowDefinition returns null.
    insertWorkflow(rawDb, 'wf-1-custom-broken01', 1, 'Broken Custom', '{}');

    const caller = appRouter.createCaller(createContext({ workflowRegistry: registry }));

    await expect(
      caller.cyboflow.workflows.getDefinition({ workflowId: 'wf-1-custom-broken01' }),
    ).rejects.toSatisfy((err: unknown) => err instanceof TRPCError && err.code === 'NOT_FOUND');
  });

  it('throws PRECONDITION_FAILED when workflowRegistry is not wired', async () => {
    const caller = appRouter.createCaller(createContext());
    await expect(
      caller.cyboflow.workflows.getDefinition({ workflowId: 'any' }),
    ).rejects.toSatisfy((err: unknown) => err instanceof TRPCError && err.code === 'PRECONDITION_FAILED');
  });
});

describe('cyboflow.workflows.updateSpec', () => {
  it('persists the definition and returns { ok: true }', async () => {
    const rawDb = createWorkflowTestDb();
    const registry = new WorkflowRegistry(dbAdapter(rawDb), silentLogger);
    insertWorkflow(rawDb, 'wf-1-planner', 1, 'planner');

    const definition = makeDefinition('planner');
    const caller = appRouter.createCaller(createContext({ workflowRegistry: registry }));
    const result = await caller.cyboflow.workflows.updateSpec({ workflowId: 'wf-1-planner', definition });

    expect(result).toEqual({ ok: true });

    interface SpecRow { spec_json: string }
    const row = rawDb.prepare('SELECT spec_json FROM workflows WHERE id = ?').get('wf-1-planner') as SpecRow;
    expect(JSON.parse(row.spec_json)).toEqual(definition);
  });

  it('maps a missing workflow id to NOT_FOUND', async () => {
    const rawDb = createWorkflowTestDb();
    const registry = new WorkflowRegistry(dbAdapter(rawDb), silentLogger);
    const caller = appRouter.createCaller(createContext({ workflowRegistry: registry }));

    await expect(
      caller.cyboflow.workflows.updateSpec({ workflowId: 'nope', definition: makeDefinition('x') }),
    ).rejects.toSatisfy((err: unknown) => err instanceof TRPCError && err.code === 'NOT_FOUND');
  });

  it('rejects a structurally-invalid definition as BAD_REQUEST (input zod schema)', async () => {
    const rawDb = createWorkflowTestDb();
    const registry = new WorkflowRegistry(dbAdapter(rawDb), silentLogger);
    insertWorkflow(rawDb, 'wf-1-planner', 1, 'planner');

    // Non-kebab phase id violates the strict write-path schema → tRPC BAD_REQUEST.
    const bad = makeDefinition('planner');
    bad.phases[0].id = 'Not Kebab';

    const caller = appRouter.createCaller(createContext({ workflowRegistry: registry }));
    await expect(
      caller.cyboflow.workflows.updateSpec({ workflowId: 'wf-1-planner', definition: bad }),
    ).rejects.toSatisfy((err: unknown) => err instanceof TRPCError && err.code === 'BAD_REQUEST');
  });

  it('throws PRECONDITION_FAILED when workflowRegistry is not wired', async () => {
    const caller = appRouter.createCaller(createContext());
    await expect(
      caller.cyboflow.workflows.updateSpec({ workflowId: 'any', definition: makeDefinition('x') }),
    ).rejects.toSatisfy((err: unknown) => err instanceof TRPCError && err.code === 'PRECONDITION_FAILED');
  });
});

describe('cyboflow.workflows.resetSpec', () => {
  it('resets a built-in workflow spec back to "{}" and returns { ok: true }', async () => {
    const rawDb = createWorkflowTestDb();
    const registry = new WorkflowRegistry(dbAdapter(rawDb), silentLogger);
    insertWorkflow(rawDb, 'wf-1-sprint', 1, 'sprint', JSON.stringify(makeDefinition('sprint')));

    const caller = appRouter.createCaller(createContext({ workflowRegistry: registry }));
    const result = await caller.cyboflow.workflows.resetSpec({ workflowId: 'wf-1-sprint' });

    expect(result).toEqual({ ok: true });
    interface SpecRow { spec_json: string }
    const row = rawDb.prepare('SELECT spec_json FROM workflows WHERE id = ?').get('wf-1-sprint') as SpecRow;
    expect(row.spec_json).toBe('{}');
  });

  it('maps a missing workflow id to NOT_FOUND', async () => {
    const rawDb = createWorkflowTestDb();
    const registry = new WorkflowRegistry(dbAdapter(rawDb), silentLogger);
    const caller = appRouter.createCaller(createContext({ workflowRegistry: registry }));

    await expect(
      caller.cyboflow.workflows.resetSpec({ workflowId: 'nope' }),
    ).rejects.toSatisfy((err: unknown) => err instanceof TRPCError && err.code === 'NOT_FOUND');
  });

  it('maps a reset-on-custom-flow to BAD_REQUEST', async () => {
    const rawDb = createWorkflowTestDb();
    const registry = new WorkflowRegistry(dbAdapter(rawDb), silentLogger);
    insertWorkflow(rawDb, 'wf-1-custom-abc12345', 1, 'My Custom Flow', JSON.stringify(makeDefinition('my-custom-flow')));

    const caller = appRouter.createCaller(createContext({ workflowRegistry: registry }));
    await expect(
      caller.cyboflow.workflows.resetSpec({ workflowId: 'wf-1-custom-abc12345' }),
    ).rejects.toSatisfy((err: unknown) => err instanceof TRPCError && err.code === 'BAD_REQUEST');
  });

  it('throws PRECONDITION_FAILED when workflowRegistry is not wired', async () => {
    const caller = appRouter.createCaller(createContext());
    await expect(
      caller.cyboflow.workflows.resetSpec({ workflowId: 'any' }),
    ).rejects.toSatisfy((err: unknown) => err instanceof TRPCError && err.code === 'PRECONDITION_FAILED');
  });
});

describe('cyboflow.workflows.createCustom', () => {
  it('inserts a new custom row and returns it with spec_json + generated id', async () => {
    const rawDb = createWorkflowTestDb();
    const registry = new WorkflowRegistry(dbAdapter(rawDb), silentLogger);
    const definition = makeDefinition('my-flow');

    const caller = appRouter.createCaller(createContext({ workflowRegistry: registry }));
    const row = await caller.cyboflow.workflows.createCustom({
      projectId: 1,
      name: 'My Flow',
      definition,
      permissionMode: 'acceptEdits',
    });

    expect(row.id).toMatch(/^wf-1-custom-[0-9a-f]{8}$/);
    expect(row.name).toBe('My Flow');
    expect(row.project_id).toBe(1);
    expect(row.permission_mode).toBe('acceptEdits');
    expect(JSON.parse(row.spec_json)).toEqual(definition);

    // It was actually persisted.
    interface CountRow { count: number }
    const { count } = rawDb
      .prepare('SELECT COUNT(*) AS count FROM workflows WHERE id = ?')
      .get(row.id) as CountRow;
    expect(count).toBe(1);
  });

  it('defaults permission_mode to "default" when omitted', async () => {
    const rawDb = createWorkflowTestDb();
    const registry = new WorkflowRegistry(dbAdapter(rawDb), silentLogger);
    const caller = appRouter.createCaller(createContext({ workflowRegistry: registry }));

    const row = await caller.cyboflow.workflows.createCustom({
      projectId: 1,
      name: 'No Mode Flow',
      definition: makeDefinition('no-mode-flow'),
    });
    expect(row.permission_mode).toBe('default');
  });

  it('maps a name collision with an existing row to CONFLICT', async () => {
    const rawDb = createWorkflowTestDb();
    const registry = new WorkflowRegistry(dbAdapter(rawDb), silentLogger);
    insertWorkflow(rawDb, 'wf-1-existing', 1, 'Taken Name');

    const caller = appRouter.createCaller(createContext({ workflowRegistry: registry }));
    await expect(
      caller.cyboflow.workflows.createCustom({
        projectId: 1,
        name: 'Taken Name',
        definition: makeDefinition('taken-name'),
      }),
    ).rejects.toSatisfy((err: unknown) => err instanceof TRPCError && err.code === 'CONFLICT');
  });

  it('maps a name collision with a built-in name to CONFLICT', async () => {
    const rawDb = createWorkflowTestDb();
    const registry = new WorkflowRegistry(dbAdapter(rawDb), silentLogger);
    const caller = appRouter.createCaller(createContext({ workflowRegistry: registry }));

    await expect(
      caller.cyboflow.workflows.createCustom({
        projectId: 1,
        name: 'planner',
        definition: makeDefinition('planner'),
      }),
    ).rejects.toSatisfy((err: unknown) => err instanceof TRPCError && err.code === 'CONFLICT');
  });

  it('rejects a structurally-invalid definition as BAD_REQUEST (input zod schema)', async () => {
    const rawDb = createWorkflowTestDb();
    const registry = new WorkflowRegistry(dbAdapter(rawDb), silentLogger);
    const caller = appRouter.createCaller(createContext({ workflowRegistry: registry }));

    const bad = makeDefinition('my-flow');
    bad.phases[0].color = 'not-a-hex';

    await expect(
      caller.cyboflow.workflows.createCustom({
        projectId: 1,
        name: 'Bad Color Flow',
        definition: bad,
      }),
    ).rejects.toSatisfy((err: unknown) => err instanceof TRPCError && err.code === 'BAD_REQUEST');
  });

  it('throws PRECONDITION_FAILED when workflowRegistry is not wired', async () => {
    const caller = appRouter.createCaller(createContext());
    await expect(
      caller.cyboflow.workflows.createCustom({
        projectId: 1,
        name: 'Any',
        definition: makeDefinition('any'),
      }),
    ).rejects.toSatisfy((err: unknown) => err instanceof TRPCError && err.code === 'PRECONDITION_FAILED');
  });

  it('defaults to GLOBAL scope (project_id NULL, wf-global-custom-<hex>) when projectId is omitted', async () => {
    const rawDb = createWorkflowTestDb();
    const registry = new WorkflowRegistry(dbAdapter(rawDb), silentLogger);
    const caller = appRouter.createCaller(createContext({ workflowRegistry: registry }));

    const row = await caller.cyboflow.workflows.createCustom({
      name: 'Global Flow',
      definition: makeDefinition('global-flow'),
    });

    expect(row.id).toMatch(/^wf-global-custom-[0-9a-f]{8}$/);
    expect(row.project_id).toBeNull();
    expect(row.name).toBe('Global Flow');
  });

  it('mints a project-scoped copy (wf-<projectId>-custom-<hex>) when projectId is a number', async () => {
    const rawDb = createWorkflowTestDb();
    const registry = new WorkflowRegistry(dbAdapter(rawDb), silentLogger);
    const caller = appRouter.createCaller(createContext({ workflowRegistry: registry }));

    const row = await caller.cyboflow.workflows.createCustom({
      projectId: 7,
      name: 'Project Copy',
      definition: makeDefinition('project-copy'),
    });

    expect(row.id).toMatch(/^wf-7-custom-[0-9a-f]{8}$/);
    expect(row.project_id).toBe(7);
  });

  it('rejects a project copy whose name collides with an existing GLOBAL flow (CONFLICT)', async () => {
    const rawDb = createWorkflowTestDb();
    const registry = new WorkflowRegistry(dbAdapter(rawDb), silentLogger);
    const caller = appRouter.createCaller(createContext({ workflowRegistry: registry }));

    // Create a global custom flow, then a project copy under the SAME name must
    // be rejected (a project copy may not shadow a global flow's name).
    await caller.cyboflow.workflows.createCustom({
      name: 'Shared Name',
      definition: makeDefinition('shared-name'),
    });
    await expect(
      caller.cyboflow.workflows.createCustom({
        projectId: 3,
        name: 'Shared Name',
        definition: makeDefinition('shared-name'),
      }),
    ).rejects.toSatisfy((err: unknown) => err instanceof TRPCError && err.code === 'CONFLICT');
  });
});
