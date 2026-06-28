/**
 * Unit tests for AgentOverrideRouter — the agent_overrides write chokepoint
 * (migration 028).
 *
 * Covered (AC-P1-4 / AC-P1-9):
 *  - upsert of a builtin → row persisted (base_agent_key==agent_key, is_custom=0),
 *    version bumped on the second upsert.
 *  - reset → the builtin override row is gone.
 *  - createCustom → is_custom=1, base_agent_key NULL, name 'cyboflow-<key>'.
 *  - createCustom with a builtin key → reserved_key.
 *  - duplicate createCustom → duplicate_key.
 *  - deleteCustom of a workflow-referenced key → conflict listing workflow names.
 *  - reset of a custom / deleteCustom of a builtin → error.
 *  - BLOCKER guard: an upsert writes ZERO entity_events rows (the CHECK forbids an
 *    'agent_override' entity_type and would abort the txn).
 *  - emit: agentOverrideChangeEvents fires on the per-project + 'agent-override-all'
 *    channels with {projectId, agentKey}.
 */
import { describe, it, expect, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  AgentOverrideRouter,
  agentOverrideChangeEvents,
  agentOverrideProjectChannel,
  AGENT_OVERRIDE_ALL_CHANNEL,
} from '../agentOverrideRouter';
import { AgentOverrideError } from '../agents/agentValidation';
import { dbAdapter } from '../__test_fixtures__/dbAdapter';
import type { AgentOverrideRow } from '../../database/models';
import type { AgentChangedEvent } from '../../../../shared/types/agents';
import type { CliTool } from '../../../../shared/types/cliTools';

// ---------------------------------------------------------------------------
// Test DB builder: projects + 006 (workflows + entity_events) + 028 (inline,
// the migration file is owned by a sibling task and not yet on disk).
// ---------------------------------------------------------------------------

function buildDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      path TEXT NOT NULL UNIQUE,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);
  db.prepare('INSERT INTO projects (id, name, path) VALUES (1, ?, ?)').run('Proj', '/tmp/p1');
  db.prepare('INSERT INTO projects (id, name, path) VALUES (2, ?, ?)').run('Proj2', '/tmp/p2');

  const migDir = join(__dirname, '..', '..', 'database', 'migrations');
  // 006 brings the `workflows` table (referential guard) + the entity_events
  // table whose CHECK is the BLOCKER we assert against.
  db.exec(readFileSync(join(migDir, '006_cyboflow_schema.sql'), 'utf-8'));
  db.exec(readFileSync(join(migDir, '011_workflow_step_tracking.sql'), 'utf-8'));
  db.exec(readFileSync(join(migDir, '014_native_tasks.sql'), 'utf-8'));
  db.exec(readFileSync(join(migDir, '015_entity_model_rebuild.sql'), 'utf-8'));

  // migration 029 + 036 schema (mirrored inline; column order per the contract).
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_overrides (
      id TEXT PRIMARY KEY,
      project_id INTEGER NOT NULL,
      agent_key TEXT NOT NULL,
      base_agent_key TEXT,
      name TEXT NOT NULL,
      role TEXT,
      description TEXT NOT NULL,
      system_prompt TEXT NOT NULL,
      tools_json TEXT NOT NULL,
      enabled_mcps_json TEXT NOT NULL DEFAULT '[]',
      is_custom INTEGER NOT NULL DEFAULT 0,
      version INTEGER NOT NULL DEFAULT 1,
      model TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(project_id, agent_key),
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_agent_overrides_project ON agent_overrides(project_id);
  `);
  return db;
}

const TOOLS: CliTool[] = ['Read', 'Edit', 'Write'];

/** Total entity_events row count (the BLOCKER assertion). */
function totalEntityEvents(db: Database.Database): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM entity_events').get() as { n: number }).n;
}

/** Seed a project workflow whose spec_json binds `agentKey` to a step. */
function seedWorkflowReferencing(db: Database.Database, name: string, agentKey: string): void {
  const spec = {
    id: name,
    phases: [
      {
        id: 'p1',
        label: 'Phase 1',
        color: '#3b6dd6',
        steps: [{ id: 's1', name: 'Step 1', agent: agentKey, mcps: [], retries: 0 }],
      },
    ],
  };
  db.prepare(
    `INSERT INTO workflows (id, project_id, name, spec_json) VALUES (?, 1, ?, ?)`,
  ).run(`wf-${name}`, name, JSON.stringify(spec));
}

describe('AgentOverrideRouter (agent_overrides chokepoint)', () => {
  afterEach(() => {
    AgentOverrideRouter._resetForTesting();
    agentOverrideChangeEvents.removeAllListeners();
  });

  // -------------------------------------------------------------------------
  // upsert
  // -------------------------------------------------------------------------

  it('upsert persists a builtin override (base_agent_key==agent_key, is_custom=0)', async () => {
    const db = buildDb();
    const router = AgentOverrideRouter.initialize(dbAdapter(db));

    const { agentKey } = await router.applyChange(1, {
      op: 'upsert',
      agentKey: 'implement',
      role: 'sprint',
      description: 'Custom implementer',
      systemPrompt: 'Do the work.',
      tools: TOOLS,
      enabledMcps: [],
    });
    expect(agentKey).toBe('implement');

    const row = router.getByKey(1, 'implement') as AgentOverrideRow;
    expect(row.id.startsWith('ago_')).toBe(true);
    expect(row.base_agent_key).toBe('implement');
    expect(row.is_custom).toBe(0);
    expect(row.name).toBe('cyboflow-implement');
    expect(row.version).toBe(1);
    expect(JSON.parse(row.tools_json)).toEqual(TOOLS);
    // ## Result section auto-appended.
    expect(row.system_prompt).toContain('## Result');
  });

  it('a second upsert bumps version', async () => {
    const db = buildDb();
    const router = AgentOverrideRouter.initialize(dbAdapter(db));

    await router.applyChange(1, {
      op: 'upsert',
      agentKey: 'implement',
      role: 'sprint',
      description: 'v1',
      systemPrompt: 'one',
      tools: TOOLS,
      enabledMcps: [],
    });
    await router.applyChange(1, {
      op: 'upsert',
      agentKey: 'implement',
      role: 'sprint',
      description: 'v2',
      systemPrompt: 'two',
      tools: TOOLS,
      enabledMcps: [],
    });

    const row = router.getByKey(1, 'implement') as AgentOverrideRow;
    expect(row.version).toBe(2);
    expect(row.description).toBe('v2');
  });

  it('round-trips enabled_mcps_json on upsert and createCustom', async () => {
    const db = buildDb();
    const router = AgentOverrideRouter.initialize(dbAdapter(db));

    await router.applyChange(1, {
      op: 'upsert',
      agentKey: 'implement',
      role: 'sprint',
      description: 'grants mcps',
      systemPrompt: 'do work',
      tools: TOOLS,
      enabledMcps: ['playwright', 'fal-ai'],
    });
    const overrideRow = router.getByKey(1, 'implement') as AgentOverrideRow;
    expect(JSON.parse(overrideRow.enabled_mcps_json)).toEqual(['playwright', 'fal-ai']);

    await router.applyChange(1, {
      op: 'createCustom',
      name: 'Mcp Helper',
      role: null,
      description: 'helps with mcp',
      systemPrompt: 'help',
      tools: TOOLS,
      enabledMcps: ['context7'],
    });
    const customRow = router.getByKey(1, 'mcp-helper') as AgentOverrideRow;
    expect(JSON.parse(customRow.enabled_mcps_json)).toEqual(['context7']);
  });

  it('upsert with an invalid mcp server name throws invalid_mcp', async () => {
    const db = buildDb();
    const router = AgentOverrideRouter.initialize(dbAdapter(db));

    await expect(
      router.applyChange(1, {
        op: 'upsert',
        agentKey: 'implement',
        role: 'sprint',
        description: 'x',
        systemPrompt: 'y',
        tools: TOOLS,
        enabledMcps: ['cyboflow'],
      }),
    ).rejects.toMatchObject({ code: 'invalid_mcp' });
  });

  it('upsert of a non-builtin key throws invalid_key', async () => {
    const db = buildDb();
    const router = AgentOverrideRouter.initialize(dbAdapter(db));

    await expect(
      router.applyChange(1, {
        op: 'upsert',
        agentKey: 'not-a-builtin',
        role: null,
        description: 'x',
        systemPrompt: 'y',
        tools: TOOLS,
        enabledMcps: [],
      }),
    ).rejects.toMatchObject({ code: 'invalid_key' });
  });

  it('upsert with a stale expectedVersion throws version_conflict', async () => {
    const db = buildDb();
    const router = AgentOverrideRouter.initialize(dbAdapter(db));

    await router.applyChange(1, {
      op: 'upsert',
      agentKey: 'implement',
      role: 'sprint',
      description: 'v1',
      systemPrompt: 'one',
      tools: TOOLS,
      enabledMcps: [],
    });

    await expect(
      router.applyChange(1, {
        op: 'upsert',
        agentKey: 'implement',
        role: 'sprint',
        description: 'v2',
        systemPrompt: 'two',
        tools: TOOLS,
        enabledMcps: [],
        expectedVersion: 0, // current is 1
      }),
    ).rejects.toMatchObject({ code: 'version_conflict' });
  });

  // -------------------------------------------------------------------------
  // updateCustom
  // -------------------------------------------------------------------------

  it('updateCustom edits an existing custom in place (key immutable, version bumps, is_custom stays 1)', async () => {
    const db = buildDb();
    const router = AgentOverrideRouter.initialize(dbAdapter(db));

    await router.applyChange(1, {
      op: 'createCustom',
      name: 'My Helper',
      role: null,
      description: 'first',
      systemPrompt: 'one',
      tools: TOOLS,
      enabledMcps: ['context7'],
    });
    const before = router.getByKey(1, 'my-helper') as AgentOverrideRow;
    expect(before.version).toBe(1);

    const { agentKey } = await router.applyChange(1, {
      op: 'updateCustom',
      agentKey: 'my-helper',
      role: 'reviewer',
      description: 'second',
      systemPrompt: 'two',
      tools: ['Read'],
      enabledMcps: ['playwright', 'fal-ai'],
    });
    expect(agentKey).toBe('my-helper');

    const after = router.getByKey(1, 'my-helper') as AgentOverrideRow;
    expect(after.is_custom).toBe(1);
    expect(after.base_agent_key).toBeNull();
    expect(after.name).toBe('cyboflow-my-helper'); // name derived from immutable key
    expect(after.description).toBe('second');
    expect(after.role).toBe('reviewer');
    expect(JSON.parse(after.tools_json)).toEqual(['Read']);
    expect(JSON.parse(after.enabled_mcps_json)).toEqual(['playwright', 'fal-ai']);
    expect(after.version).toBe(2); // bumped
  });

  it('updateCustom on a non-existent key throws invalid_key', async () => {
    const db = buildDb();
    const router = AgentOverrideRouter.initialize(dbAdapter(db));

    await expect(
      router.applyChange(1, {
        op: 'updateCustom',
        agentKey: 'ghost',
        role: null,
        description: 'x',
        systemPrompt: 'y',
        tools: TOOLS,
        enabledMcps: [],
      }),
    ).rejects.toMatchObject({ code: 'invalid_key' });
  });

  it('updateCustom on a builtin override throws invalid_key (use upsert)', async () => {
    const db = buildDb();
    const router = AgentOverrideRouter.initialize(dbAdapter(db));

    await router.applyChange(1, {
      op: 'upsert',
      agentKey: 'implement',
      role: 'sprint',
      description: 'x',
      systemPrompt: 'y',
      tools: TOOLS,
      enabledMcps: [],
    });

    await expect(
      router.applyChange(1, {
        op: 'updateCustom',
        agentKey: 'implement',
        role: null,
        description: 'x',
        systemPrompt: 'y',
        tools: TOOLS,
        enabledMcps: [],
      }),
    ).rejects.toMatchObject({ code: 'invalid_key' });
  });

  // -------------------------------------------------------------------------
  // reset
  // -------------------------------------------------------------------------

  it('reset deletes the builtin override row', async () => {
    const db = buildDb();
    const router = AgentOverrideRouter.initialize(dbAdapter(db));

    await router.applyChange(1, {
      op: 'upsert',
      agentKey: 'implement',
      role: 'sprint',
      description: 'x',
      systemPrompt: 'y',
      tools: TOOLS,
      enabledMcps: [],
    });
    expect(router.getByKey(1, 'implement')).not.toBeNull();

    await router.applyChange(1, { op: 'reset', agentKey: 'implement' });
    expect(router.getByKey(1, 'implement')).toBeNull();
  });

  it('reset of a non-existent override throws invalid_key', async () => {
    const db = buildDb();
    const router = AgentOverrideRouter.initialize(dbAdapter(db));

    await expect(router.applyChange(1, { op: 'reset', agentKey: 'implement' })).rejects.toMatchObject({
      code: 'invalid_key',
    });
  });

  it('reset of a custom agent throws (use deleteCustom)', async () => {
    const db = buildDb();
    const router = AgentOverrideRouter.initialize(dbAdapter(db));

    await router.applyChange(1, {
      op: 'createCustom',
      name: 'My Helper',
      role: null,
      description: 'helps',
      systemPrompt: 'help out',
      tools: TOOLS,
      enabledMcps: [],
    });

    await expect(router.applyChange(1, { op: 'reset', agentKey: 'my-helper' })).rejects.toBeInstanceOf(
      AgentOverrideError,
    );
    // still present
    expect(router.getByKey(1, 'my-helper')).not.toBeNull();
  });

  // -------------------------------------------------------------------------
  // createCustom
  // -------------------------------------------------------------------------

  it('createCustom mints an is_custom=1 row (base_agent_key NULL, cyboflow- name)', async () => {
    const db = buildDb();
    const router = AgentOverrideRouter.initialize(dbAdapter(db));

    const { agentKey } = await router.applyChange(1, {
      op: 'createCustom',
      name: 'Doc Writer',
      role: null,
      description: 'writes docs',
      systemPrompt: 'write docs well',
      tools: TOOLS,
      enabledMcps: [],
    });
    expect(agentKey).toBe('doc-writer');

    const row = router.getByKey(1, 'doc-writer') as AgentOverrideRow;
    expect(row.is_custom).toBe(1);
    expect(row.base_agent_key).toBeNull();
    expect(row.name).toBe('cyboflow-doc-writer');
    expect(row.version).toBe(1);
  });

  it('createCustom with a builtin key throws reserved_key', async () => {
    const db = buildDb();
    const router = AgentOverrideRouter.initialize(dbAdapter(db));

    await expect(
      router.applyChange(1, {
        op: 'createCustom',
        name: 'implement',
        role: null,
        description: 'shadow',
        systemPrompt: 'x',
        tools: TOOLS,
        enabledMcps: [],
      }),
    ).rejects.toMatchObject({ code: 'reserved_key' });
  });

  it('a duplicate createCustom throws duplicate_key', async () => {
    const db = buildDb();
    const router = AgentOverrideRouter.initialize(dbAdapter(db));

    await router.applyChange(1, {
      op: 'createCustom',
      name: 'Doc Writer',
      role: null,
      description: 'writes docs',
      systemPrompt: 'x',
      tools: TOOLS,
      enabledMcps: [],
    });

    await expect(
      router.applyChange(1, {
        op: 'createCustom',
        name: 'Doc Writer',
        role: null,
        description: 'again',
        systemPrompt: 'y',
        tools: TOOLS,
        enabledMcps: [],
      }),
    ).rejects.toMatchObject({ code: 'duplicate_key' });
  });

  // -------------------------------------------------------------------------
  // deleteCustom
  // -------------------------------------------------------------------------

  it('deleteCustom removes an unreferenced custom agent', async () => {
    const db = buildDb();
    const router = AgentOverrideRouter.initialize(dbAdapter(db));

    await router.applyChange(1, {
      op: 'createCustom',
      name: 'Doc Writer',
      role: null,
      description: 'x',
      systemPrompt: 'y',
      tools: TOOLS,
      enabledMcps: [],
    });

    await router.applyChange(1, { op: 'deleteCustom', agentKey: 'doc-writer' });
    expect(router.getByKey(1, 'doc-writer')).toBeNull();
  });

  it('deleteCustom of a workflow-referenced key throws with the workflow names', async () => {
    const db = buildDb();
    const router = AgentOverrideRouter.initialize(dbAdapter(db));

    await router.applyChange(1, {
      op: 'createCustom',
      name: 'Doc Writer',
      role: null,
      description: 'x',
      systemPrompt: 'y',
      tools: TOOLS,
      enabledMcps: [],
    });
    seedWorkflowReferencing(db, 'My Flow', 'doc-writer');

    let caught: AgentOverrideError | null = null;
    try {
      await router.applyChange(1, { op: 'deleteCustom', agentKey: 'doc-writer' });
    } catch (e) {
      caught = e as AgentOverrideError;
    }
    expect(caught).toBeInstanceOf(AgentOverrideError);
    expect(caught?.message).toContain('My Flow');
    // not deleted
    expect(router.getByKey(1, 'doc-writer')).not.toBeNull();
  });

  it('deleteCustom of a builtin override throws (use reset)', async () => {
    const db = buildDb();
    const router = AgentOverrideRouter.initialize(dbAdapter(db));

    await router.applyChange(1, {
      op: 'upsert',
      agentKey: 'implement',
      role: 'sprint',
      description: 'x',
      systemPrompt: 'y',
      tools: TOOLS,
      enabledMcps: [],
    });

    await expect(
      router.applyChange(1, { op: 'deleteCustom', agentKey: 'implement' }),
    ).rejects.toBeInstanceOf(AgentOverrideError);
    expect(router.getByKey(1, 'implement')).not.toBeNull();
  });

  // -------------------------------------------------------------------------
  // model pin (migration 036)
  // -------------------------------------------------------------------------

  it('upsert without a model leaves model NULL (inherit run model)', async () => {
    const db = buildDb();
    const router = AgentOverrideRouter.initialize(dbAdapter(db));

    await router.applyChange(1, {
      op: 'upsert',
      agentKey: 'implement',
      role: 'sprint',
      description: 'x',
      systemPrompt: 'y',
      tools: TOOLS,
    });
    expect((router.getByKey(1, 'implement') as AgentOverrideRow).model).toBeNull();
  });

  it('upsert persists a pinned model, and a later upsert can clear it', async () => {
    const db = buildDb();
    const router = AgentOverrideRouter.initialize(dbAdapter(db));

    await router.applyChange(1, {
      op: 'upsert',
      agentKey: 'implement',
      role: 'sprint',
      description: 'x',
      systemPrompt: 'y',
      tools: TOOLS,
      model: 'sonnet',
    });
    expect((router.getByKey(1, 'implement') as AgentOverrideRow).model).toBe('sonnet');

    await router.applyChange(1, {
      op: 'upsert',
      agentKey: 'implement',
      role: 'sprint',
      description: 'x2',
      systemPrompt: 'y2',
      tools: TOOLS,
      model: null,
    });
    expect((router.getByKey(1, 'implement') as AgentOverrideRow).model).toBeNull();
  });

  it('createCustom persists a pinned model', async () => {
    const db = buildDb();
    const router = AgentOverrideRouter.initialize(dbAdapter(db));

    await router.applyChange(1, {
      op: 'createCustom',
      name: 'Helper',
      role: null,
      description: 'x',
      systemPrompt: 'y',
      tools: TOOLS,
      model: 'haiku',
    });
    expect((router.getByKey(1, 'helper') as AgentOverrideRow).model).toBe('haiku');
  });

  it('upsert with an unknown model throws invalid_model', async () => {
    const db = buildDb();
    const router = AgentOverrideRouter.initialize(dbAdapter(db));

    await expect(
      router.applyChange(1, {
        op: 'upsert',
        agentKey: 'implement',
        role: 'sprint',
        description: 'x',
        systemPrompt: 'y',
        tools: TOOLS,
        // Bypass the static type to exercise the runtime guard (the tRPC zod
        // would normally reject this before it reaches the chokepoint).
        model: 'gpt-4' as unknown as 'opus',
      }),
    ).rejects.toMatchObject({ code: 'invalid_model' });
  });

  // -------------------------------------------------------------------------
  // BLOCKER: NO entity_events write
  // -------------------------------------------------------------------------

  it('an upsert writes ZERO entity_events rows (entity_events count unchanged)', async () => {
    const db = buildDb();
    const router = AgentOverrideRouter.initialize(dbAdapter(db));

    const before = totalEntityEvents(db);
    await router.applyChange(1, {
      op: 'upsert',
      agentKey: 'implement',
      role: 'sprint',
      description: 'x',
      systemPrompt: 'y',
      tools: TOOLS,
      enabledMcps: [],
    });
    expect(totalEntityEvents(db)).toBe(before);
  });

  // -------------------------------------------------------------------------
  // emit
  // -------------------------------------------------------------------------

  it('emits AgentChangedEvent on both the per-project and all channels', async () => {
    const db = buildDb();
    const router = AgentOverrideRouter.initialize(dbAdapter(db));

    const perProject: AgentChangedEvent[] = [];
    const all: AgentChangedEvent[] = [];
    agentOverrideChangeEvents.on(agentOverrideProjectChannel(1), (e: AgentChangedEvent) =>
      perProject.push(e),
    );
    agentOverrideChangeEvents.on(AGENT_OVERRIDE_ALL_CHANNEL, (e: AgentChangedEvent) => all.push(e));

    await router.applyChange(1, {
      op: 'upsert',
      agentKey: 'implement',
      role: 'sprint',
      description: 'x',
      systemPrompt: 'y',
      tools: TOOLS,
      enabledMcps: [],
    });

    expect(perProject).toEqual([{ projectId: 1, agentKey: 'implement' }]);
    expect(all).toEqual([{ projectId: 1, agentKey: 'implement' }]);
  });

  // -------------------------------------------------------------------------
  // listByProject scoping
  // -------------------------------------------------------------------------

  it('listByProject returns only the project rows, sorted by agent_key', async () => {
    const db = buildDb();
    const router = AgentOverrideRouter.initialize(dbAdapter(db));

    await router.applyChange(1, {
      op: 'upsert',
      agentKey: 'implement',
      role: 'sprint',
      description: 'x',
      systemPrompt: 'y',
      tools: TOOLS,
      enabledMcps: [],
    });
    await router.applyChange(1, {
      op: 'createCustom',
      name: 'Aardvark',
      role: null,
      description: 'first',
      systemPrompt: 'y',
      tools: TOOLS,
      enabledMcps: [],
    });
    await router.applyChange(2, {
      op: 'upsert',
      agentKey: 'context',
      role: 'planner',
      description: 'other proj',
      systemPrompt: 'y',
      tools: TOOLS,
      enabledMcps: [],
    });

    const rows = router.listByProject(1);
    expect(rows.map((r) => r.agent_key)).toEqual(['aardvark', 'implement']);
  });
});
