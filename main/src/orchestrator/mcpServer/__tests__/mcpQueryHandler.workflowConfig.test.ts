/**
 * Unit tests for the workflow + variant configuration handlers on
 * McpQueryHandler (cyboflow_*_workflow / _variant).
 *
 * These exercise the ORCHESTRATOR-SIDE handler layer in isolation: a fake
 * WorkflowConfigLike (recording calls + injectable returns/throws) stands in for
 * the real WorkflowRegistry (covered by workflowRegistry.test.ts). The tests
 * assert the wiring the handler owns:
 *   - deps.workflowConfig absent  → 'workflow_config_unavailable'
 *   - a real run is required       (resolveTaskRunContext: 'orchestrator' / missing
 *                                   / terminal runs rejected)
 *   - reads project through the compact projections
 *   - the JSON-string definition is parsed + validated with the SAME strict
 *     schema the tRPC write path runs ('invalid_json' / 'invalid_definition')
 *   - registry guard Errors map to ok:false codes (not_found / already_exists /
 *     run_history / reserved) via writeWorkflowConfigError
 *   - create scope routes projectId (global → null, project → the run's project)
 *
 * Hermetic: an in-memory better-sqlite3 with the shared test schema; a
 * writes-capturing socket double asserts the JSON response bodies.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import {
  McpQueryHandler,
  type McpQueryMessage,
  type McpQueryResponse,
  type WorkflowConfigLike,
} from '../mcpQueryHandler';
import type * as net from 'net';
import { dbAdapter } from '../../__test_fixtures__/dbAdapter';
import { createTestDb } from '../../__test_fixtures__/orchestratorTestDb';
import type { WorkflowRow, WorkflowDefinition } from '../../../../../shared/types/workflows';
import type { WorkflowVariantRow, WorkflowVariantStatus } from '../../../../../shared/types/experiments';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSocketDouble(): { socket: net.Socket; writes: string[] } {
  const writes: string[] = [];
  const socket = {
    write: (chunk: string | Buffer) => {
      writes.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
      return true;
    },
  } as unknown as net.Socket;
  return { socket, writes };
}

function parseLastWrite(writes: string[]): McpQueryResponse {
  return JSON.parse(writes[writes.length - 1]) as McpQueryResponse;
}

function seedRun(db: Database.Database, id: string, status = 'running'): void {
  db.prepare(
    `INSERT INTO workflow_runs (id, workflow_id, project_id, worktree_path, status, policy_json)
     VALUES (?, 'wf-1', 7, '/tmp/test', ?, '{}')`,
  ).run(id, status);
}

function workflowRow(over: Partial<WorkflowRow> = {}): WorkflowRow {
  return {
    id: 'wf-global-sprint',
    project_id: null,
    name: 'sprint',
    workflow_path: null,
    permission_mode: 'default',
    spec_json: '{}',
    created_at: '2026-07-14T00:00:00.000Z',
    ...over,
  };
}

function variantRow(over: Partial<WorkflowVariantRow> = {}): WorkflowVariantRow {
  return {
    id: 'var-1',
    workflow_id: 'wf-global-sprint',
    label: 'faster',
    spec_json: '{}',
    agent_overrides_json: null,
    model: null,
    execution_model: null,
    weight: 1,
    status: 'draft',
    created_at: '2026-07-14T00:00:00.000Z',
    updated_at: '2026-07-14T00:00:00.000Z',
    ...over,
  };
}

/** A minimal valid WorkflowDefinition the strict schema accepts (one phase, one step). */
const VALID_DEFINITION: WorkflowDefinition = {
  id: 'sprint',
  phases: [
    {
      id: 'phase-1',
      label: 'Phase 1',
      color: '#3b82f6',
      steps: [{ id: 'step-1', name: 'Step 1', agent: 'implement', mcps: [], retries: 0 }],
    },
  ],
};

interface Calls {
  ensureGlobalBuiltIns: number;
  listByProject: number[];
  createCustom: Array<{ projectId: number | null; name: string; specJson?: string }>;
  updateSpec: Array<{ id: string; definition: WorkflowDefinition }>;
  updateVariant: Array<{ id: string; patch: Record<string, unknown> }>;
  setVariantStatus: Array<{ id: string; status: WorkflowVariantStatus }>;
  setBaselineRotation: Array<{ id: string; patch: { inRotation?: boolean; weight?: number } }>;
}

/** Build a fake WorkflowConfigLike + a per-method override bag + a call recorder. */
function makeFakeConfig(over: Partial<WorkflowConfigLike> = {}): {
  cfg: WorkflowConfigLike;
  calls: Calls;
} {
  const calls: Calls = {
    ensureGlobalBuiltIns: 0,
    listByProject: [],
    createCustom: [],
    updateSpec: [],
    updateVariant: [],
    setVariantStatus: [],
    setBaselineRotation: [],
  };
  const cfg: WorkflowConfigLike = {
    getById: () => workflowRow(),
    listByProject: (projectId) => {
      calls.listByProject.push(projectId);
      return [workflowRow(), workflowRow({ id: 'wf-99-custom-abcd1234', project_id: 99, name: 'my-flow' })];
    },
    ensureGlobalBuiltIns: () => {
      calls.ensureGlobalBuiltIns += 1;
    },
    getBaselineRotation: () => ({ inRotation: false, weight: 1 }),
    updateSpec: (id, definition) => {
      calls.updateSpec.push({ id, definition });
    },
    resetSpec: () => undefined,
    createCustom: (params) => {
      calls.createCustom.push({ projectId: params.projectId, name: params.name, specJson: params.specJson });
      return workflowRow({ id: 'wf-global-custom-deadbeef', project_id: params.projectId, name: params.name });
    },
    deleteWorkflow: () => undefined,
    listVariants: () => [variantRow()],
    createVariantFromCurrent: (_workflowId, label) => variantRow({ label }),
    updateVariant: (id, patch) => {
      calls.updateVariant.push({ id, patch });
    },
    setVariantStatus: (id, status) => {
      calls.setVariantStatus.push({ id, status });
    },
    deleteVariant: () => undefined,
    setBaselineRotation: (id, patch) => {
      calls.setBaselineRotation.push({ id, patch });
    },
    ...over,
  };
  return { cfg, calls };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('McpQueryHandler workflow/variant config', () => {
  let db: Database.Database;

  beforeEach(() => {
    // includeWorkflowRunTaskColumns: resolveTaskRunContext SELECTs current_step_id
    // + steps_snapshot_json (migration 011/014), absent from the base GATE_SCHEMA.
    db = createTestDb({ disableForeignKeys: true, includeWorkflowRunTaskColumns: true });
    seedRun(db, 'run-quick');
  });

  it('returns workflow_config_unavailable when the dep is not injected', async () => {
    const handler = new McpQueryHandler(dbAdapter(db)); // no deps
    const { socket, writes } = makeSocketDouble();
    await handler.handleMessage({ type: 'mcp-list-workflows', requestId: 'r1', runId: 'run-quick' }, socket);
    const res = parseLastWrite(writes);
    expect(res.ok).toBe(false);
    expect(res.error).toBe('workflow_config_unavailable');
  });

  it('rejects the orchestrator sentinel run (task_write_requires_real_run)', async () => {
    const { cfg } = makeFakeConfig();
    const handler = new McpQueryHandler(dbAdapter(db), undefined, { workflowConfig: cfg });
    const { socket, writes } = makeSocketDouble();
    await handler.handleMessage(
      { type: 'mcp-list-workflows', requestId: 'r1', runId: 'orchestrator' },
      socket,
    );
    const res = parseLastWrite(writes);
    expect(res.ok).toBe(false);
    expect(res.error).toBe('task_write_requires_real_run');
  });

  it('list_workflows reconciles built-ins, scopes by the run project, returns compact rows', async () => {
    const { cfg, calls } = makeFakeConfig();
    const handler = new McpQueryHandler(dbAdapter(db), undefined, { workflowConfig: cfg });
    const { socket, writes } = makeSocketDouble();
    await handler.handleMessage({ type: 'mcp-list-workflows', requestId: 'r1', runId: 'run-quick' }, socket);
    const res = parseLastWrite(writes);
    expect(res.ok).toBe(true);
    expect(calls.ensureGlobalBuiltIns).toBe(1);
    expect(calls.listByProject).toEqual([7]); // the seeded run's project_id
    const data = res.data as { workflows: Array<Record<string, unknown>> };
    expect(data.workflows).toHaveLength(2);
    expect(data.workflows[0]).toMatchObject({
      id: 'wf-global-sprint',
      scope: 'global',
      is_built_in: true,
      has_custom_spec: false,
    });
    // The compact projection must NOT leak the spec_json blob.
    expect(data.workflows[0]).not.toHaveProperty('spec_json');
    expect(data.workflows[1]).toMatchObject({ scope: 'project', is_built_in: false });
  });

  it('get_workflow returns not_found when the id is unknown', async () => {
    const { cfg } = makeFakeConfig({ getById: () => null });
    const handler = new McpQueryHandler(dbAdapter(db), undefined, { workflowConfig: cfg });
    const { socket, writes } = makeSocketDouble();
    await handler.handleMessage(
      { type: 'mcp-get-workflow', requestId: 'r1', runId: 'run-quick', workflowId: 'nope' },
      socket,
    );
    const res = parseLastWrite(writes);
    expect(res.ok).toBe(false);
    expect(res.error).toBe('not_found');
  });

  it('get_workflow returns the resolved definition + baseline rotation', async () => {
    const { cfg } = makeFakeConfig();
    const handler = new McpQueryHandler(dbAdapter(db), undefined, { workflowConfig: cfg });
    const { socket, writes } = makeSocketDouble();
    await handler.handleMessage(
      { type: 'mcp-get-workflow', requestId: 'r1', runId: 'run-quick', workflowId: 'wf-global-sprint' },
      socket,
    );
    const res = parseLastWrite(writes);
    expect(res.ok).toBe(true);
    const data = res.data as { workflow: Record<string, unknown>; definition: unknown; baseline_rotation: unknown };
    expect(data.workflow).toMatchObject({ id: 'wf-global-sprint' });
    // spec_json '{}' → the built-in fallback definition (non-null for a real built-in name).
    expect(data.baseline_rotation).toEqual({ inRotation: false, weight: 1 });
  });

  it('update_workflow rejects malformed JSON and an invalid definition without calling updateSpec', async () => {
    const { cfg, calls } = makeFakeConfig();
    const handler = new McpQueryHandler(dbAdapter(db), undefined, { workflowConfig: cfg });

    const bad = makeSocketDouble();
    await handler.handleMessage(
      { type: 'mcp-update-workflow', requestId: 'r1', runId: 'run-quick', workflowId: 'wf-global-sprint', definitionJson: '{not json' },
      bad.socket,
    );
    expect(parseLastWrite(bad.writes).error).toBe('invalid_json');

    const invalid = makeSocketDouble();
    await handler.handleMessage(
      { type: 'mcp-update-workflow', requestId: 'r2', runId: 'run-quick', workflowId: 'wf-global-sprint', definitionJson: '{"phases":"nope"}' },
      invalid.socket,
    );
    expect(parseLastWrite(invalid.writes).error).toBe('invalid_definition');

    expect(calls.updateSpec).toHaveLength(0);
  });

  it('update_workflow persists a valid definition and maps a registry "not found" to not_found', async () => {
    const ok = makeFakeConfig();
    const handlerOk = new McpQueryHandler(dbAdapter(db), undefined, { workflowConfig: ok.cfg });
    const s1 = makeSocketDouble();
    await handlerOk.handleMessage(
      {
        type: 'mcp-update-workflow',
        requestId: 'r1',
        runId: 'run-quick',
        workflowId: 'wf-global-sprint',
        definitionJson: JSON.stringify(VALID_DEFINITION),
      },
      s1.socket,
    );
    expect(parseLastWrite(s1.writes).ok).toBe(true);
    expect(ok.calls.updateSpec).toHaveLength(1);

    const missing = makeFakeConfig({
      updateSpec: () => {
        throw new Error('WorkflowRegistry.updateSpec: workflow x not found');
      },
    });
    const handlerMissing = new McpQueryHandler(dbAdapter(db), undefined, { workflowConfig: missing.cfg });
    const s2 = makeSocketDouble();
    await handlerMissing.handleMessage(
      {
        type: 'mcp-update-workflow',
        requestId: 'r2',
        runId: 'run-quick',
        workflowId: 'x',
        definitionJson: JSON.stringify(VALID_DEFINITION),
      },
      s2.socket,
    );
    const res = parseLastWrite(s2.writes);
    expect(res.ok).toBe(false);
    expect(res.error).toBe('not_found');
  });

  it('create_workflow routes scope to projectId (global → null, project → run project)', async () => {
    const { cfg, calls } = makeFakeConfig();
    const handler = new McpQueryHandler(dbAdapter(db), undefined, { workflowConfig: cfg });

    const g = makeSocketDouble();
    await handler.handleMessage(
      { type: 'mcp-create-workflow', requestId: 'r1', runId: 'run-quick', name: 'g-flow', scope: 'global' },
      g.socket,
    );
    expect(parseLastWrite(g.writes).ok).toBe(true);

    const p = makeSocketDouble();
    await handler.handleMessage(
      { type: 'mcp-create-workflow', requestId: 'r2', runId: 'run-quick', name: 'p-flow', scope: 'project' },
      p.socket,
    );
    expect(parseLastWrite(p.writes).ok).toBe(true);

    expect(calls.createCustom).toEqual([
      { projectId: null, name: 'g-flow', specJson: undefined },
      { projectId: 7, name: 'p-flow', specJson: undefined },
    ]);
  });

  it('create_workflow maps a name collision to already_exists', async () => {
    const { cfg } = makeFakeConfig({
      createCustom: () => {
        throw new Error("WorkflowRegistry.createCustom: a global workflow named 'x' already exists");
      },
    });
    const handler = new McpQueryHandler(dbAdapter(db), undefined, { workflowConfig: cfg });
    const { socket, writes } = makeSocketDouble();
    await handler.handleMessage(
      { type: 'mcp-create-workflow', requestId: 'r1', runId: 'run-quick', name: 'x' },
      socket,
    );
    const res = parseLastWrite(writes);
    expect(res.ok).toBe(false);
    expect(res.error).toBe('already_exists');
  });

  it('delete_workflow maps a run-history refusal to run_history', async () => {
    const { cfg } = makeFakeConfig({
      deleteWorkflow: () => {
        throw new Error('WorkflowRegistry.deleteWorkflow: workflow x has run history (3 run(s)); refusing to delete');
      },
    });
    const handler = new McpQueryHandler(dbAdapter(db), undefined, { workflowConfig: cfg });
    const { socket, writes } = makeSocketDouble();
    await handler.handleMessage(
      { type: 'mcp-delete-workflow', requestId: 'r1', runId: 'run-quick', workflowId: 'x' },
      socket,
    );
    const res = parseLastWrite(writes);
    expect(res.ok).toBe(false);
    expect(res.error).toBe('run_history');
  });

  it('update_variant forwards only the supplied fields (definition validated + re-serialized)', async () => {
    const { cfg, calls } = makeFakeConfig();
    const handler = new McpQueryHandler(dbAdapter(db), undefined, { workflowConfig: cfg });
    const { socket, writes } = makeSocketDouble();
    await handler.handleMessage(
      {
        type: 'mcp-update-variant',
        requestId: 'r1',
        runId: 'run-quick',
        variantId: 'var-1',
        model: 'claude-sonnet-5',
        weight: 3,
        agentOverridesJson: null,
      },
      socket,
    );
    expect(parseLastWrite(writes).ok).toBe(true);
    expect(calls.updateVariant).toHaveLength(1);
    expect(calls.updateVariant[0].patch).toEqual({ model: 'claude-sonnet-5', weight: 3, agentOverridesJson: null });
    // Fields not supplied must be absent from the patch (not undefined-valued).
    expect(calls.updateVariant[0].patch).not.toHaveProperty('specJson');
    expect(calls.updateVariant[0].patch).not.toHaveProperty('label');
  });

  it('delete_variant maps a run-history refusal to run_history', async () => {
    const { cfg } = makeFakeConfig({
      deleteVariant: () => {
        throw new Error('WorkflowRegistry.deleteVariant: variant v has run history (2 run(s)); retire it instead');
      },
    });
    const handler = new McpQueryHandler(dbAdapter(db), undefined, { workflowConfig: cfg });
    const { socket, writes } = makeSocketDouble();
    await handler.handleMessage(
      { type: 'mcp-delete-variant', requestId: 'r1', runId: 'run-quick', variantId: 'v' },
      socket,
    );
    const res = parseLastWrite(writes);
    expect(res.ok).toBe(false);
    expect(res.error).toBe('run_history');
  });

  it('set_baseline_rotation forwards the patch and returns the updated participation', async () => {
    const { cfg, calls } = makeFakeConfig({
      getBaselineRotation: () => ({ inRotation: true, weight: 2 }),
    });
    const handler = new McpQueryHandler(dbAdapter(db), undefined, { workflowConfig: cfg });
    const { socket, writes } = makeSocketDouble();
    await handler.handleMessage(
      { type: 'mcp-set-baseline-rotation', requestId: 'r1', runId: 'run-quick', workflowId: 'wf-global-sprint', inRotation: true, weight: 2 },
      socket,
    );
    const res = parseLastWrite(writes);
    expect(res.ok).toBe(true);
    expect(calls.setBaselineRotation).toEqual([{ id: 'wf-global-sprint', patch: { inRotation: true, weight: 2 } }]);
    expect((res.data as { baseline_rotation: unknown }).baseline_rotation).toEqual({ inRotation: true, weight: 2 });
  });
});
