/**
 * Integration tests for the orchestrator tRPC agents router (AC-P1-3 / AC-P1-9).
 *
 * Exercises the live agentsRouter via createCaller against an in-memory SQLite
 * database carrying REGISTRY_SCHEMA (workflows) + a projects table + the
 * agent_overrides table (migration 028), a real WorkflowRegistry (so the project's
 * built-in workflows reconcile + resolve for usage), and a real
 * AgentOverrideRouter wired as the chokepoint.
 *
 * Locks:
 *  - list returns the 15 builtins, each source 'builtin', isOverridden:false,
 *    stats.costUsd null.
 *  - EVERY canonical key is step-BOUND (workflowCount >= 1) — both planes now
 *    honor `step.fanOut` as the single source of truth for stage parallelism
 *    (shared/types/workflows.ts FanOutSpec), so `computeAgentUsage` counts a
 *    fan-out inner-chain reference the same as an outer step.agent binding;
 *    no canonical key is step-unbound anymore.
 *  - the 5 fan-out inner-chain keys (implement/write-tests/code-review/
 *    task-verify/visual-verify) are ALSO `dispatchedBy` both 'sprint' and
 *    'ship' (both built-ins carry the identical execute-tasks fanOut block).
 *  - upsertOverride / resetOverride round-trip; createCustom / deleteCustom;
 *    duplicate seeds from the source.
 *  - every procedure throws PRECONDITION_FAILED when deps are unwired.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { TRPCError } from '@trpc/server';
import { appRouter } from '../../router';
import { createContext } from '../../context';
import { WorkflowRegistry } from '../../../workflowRegistry';
import { AgentOverrideRouter } from '../../../agentOverrideRouter';
import { dbAdapter } from '../../../__test_fixtures__/dbAdapter';
import { REGISTRY_SCHEMA } from '../../../../database/__test_fixtures__/registrySchema';
import { buildBuiltInWorkflows } from '../../../workflows/builtInWorkflows';

const PROJECT_ID = 1;

const silentLogger = {
  info: () => undefined,
  error: () => undefined,
  warn: () => undefined,
  debug: () => undefined,
};

/**
 * Fresh in-memory DB: REGISTRY_SCHEMA (workflows + workflow_runs) + a minimal
 * projects table + the agent_overrides table (migration 028 shape) + spec-capture
 * additive columns the WorkflowRegistry writes. Seeds one project row so the
 * agent_overrides FK is satisfiable.
 */
function createAgentsTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(REGISTRY_SCHEMA);
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
  db.exec(`
    CREATE TABLE projects (
      id   INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL
    )
  `);
  db.exec(`
    CREATE TABLE agent_overrides (
      id             TEXT PRIMARY KEY,
      project_id     INTEGER NOT NULL,
      agent_key      TEXT NOT NULL,
      base_agent_key TEXT,
      name           TEXT NOT NULL,
      role           TEXT,
      description    TEXT NOT NULL,
      system_prompt  TEXT NOT NULL,
      tools_json     TEXT NOT NULL,
      enabled_mcps_json TEXT NOT NULL DEFAULT '[]',
      is_custom      INTEGER NOT NULL DEFAULT 0,
      version        INTEGER NOT NULL DEFAULT 1,
      model          TEXT,
      created_at     DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at     DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (project_id, agent_key),
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    )
  `);
  db.exec('CREATE INDEX idx_agent_overrides_project ON agent_overrides(project_id)');
  db.prepare('INSERT INTO projects (id, name) VALUES (?, ?)').run(PROJECT_ID, 'Test Project');
  return db;
}

/** A caller wired with the registry + override chokepoint + db (the full deps). */
function makeWiredCaller(rawDb: Database.Database): ReturnType<typeof appRouter.createCaller> {
  const adapter = dbAdapter(rawDb);
  const registry = new WorkflowRegistry(adapter, silentLogger);
  // Seed the built-in workflows as ONE GLOBAL set (migration 030) so usage
  // resolves their step bindings — they surface for PROJECT_ID via the
  // project_id-IS-NULL union in listByProject.
  registry.ensureGlobalBuiltIns(buildBuiltInWorkflows());
  AgentOverrideRouter._resetForTesting();
  AgentOverrideRouter.initialize(adapter);
  return appRouter.createCaller(
    createContext({
      db: adapter,
      workflowRegistry: registry,
      agentOverrideRouter: AgentOverrideRouter.getInstance(),
    }),
  );
}

const ALL_CANONICAL_KEYS = [
  'context',
  'research',
  'ui-prototype',
  'architecture',
  'epics',
  'tasks',
  'dependency-analyzer',
  'implement',
  'code-review',
  'write-tests',
  'task-verify',
  'sprint-verify',
  'visual-verify',
  'sprint-review',
  'compounder',
].sort();

/** The sprint/ship execute-tasks fanOut.inner ids — dispatched by BOTH built-ins. */
const FAN_OUT_INNER_KEYS = ['implement', 'write-tests', 'code-review', 'task-verify', 'visual-verify'].sort();

describe('cyboflow.agents.list', () => {
  beforeEach(() => AgentOverrideRouter._resetForTesting());

  it('returns the 15 builtins, all source "builtin", isOverridden:false, costUsd null', async () => {
    const caller = makeWiredCaller(createAgentsTestDb());
    const entries = await caller.cyboflow.agents.list({ projectId: PROJECT_ID });

    expect(entries).toHaveLength(15);
    for (const e of entries) {
      expect(e.source).toBe('builtin');
      expect(e.isOverridden).toBe(false);
      expect(e.isCustom).toBe(false);
      expect(e.stats.costUsd).toBeNull();
      expect(e.stats.model).toBe('inherits run model');
      expect(e.name).toBe(`cyboflow-${e.agentKey}`);
    }
  });

  it('every canonical key is step-bound (workflowCount >= 1); the fan-out inner keys are also dispatchedBy sprint + ship', async () => {
    const caller = makeWiredCaller(createAgentsTestDb());
    const entries = await caller.cyboflow.agents.list({ projectId: PROJECT_ID });
    const byKey = new Map(entries.map((e) => [e.agentKey, e]));

    // Both planes now honor step.fanOut as the single source of truth for
    // stage parallelism, so computeAgentUsage's usedBy walk covers a fan-out
    // inner-chain reference the same as an outer step.agent binding — no
    // canonical key is step-unbound anymore.
    const bound = entries
      .filter((e) => e.usage.workflowCount >= 1)
      .map((e) => e.agentKey)
      .sort();
    expect(bound).toEqual(ALL_CANONICAL_KEYS);

    // The 5 fan-out inner ids are dispatched by BOTH sprint and ship (each
    // built-in's execute-tasks step carries the identical fanOut block).
    for (const key of FAN_OUT_INNER_KEYS) {
      const entry = byKey.get(key);
      expect(entry, key).toBeDefined();
      expect(entry?.usage.dispatchedBy, key).toEqual(expect.arrayContaining(['sprint', 'ship']));
    }
  });
});

describe('cyboflow.agents.get', () => {
  beforeEach(() => AgentOverrideRouter._resetForTesting());

  it('returns a single builtin entry', async () => {
    const caller = makeWiredCaller(createAgentsTestDb());
    const entry = await caller.cyboflow.agents.get({ projectId: PROJECT_ID, agentKey: 'implement' });
    expect(entry.agentKey).toBe('implement');
    expect(entry.name).toBe('cyboflow-implement');
    expect(entry.source).toBe('builtin');
  });

  it('throws NOT_FOUND for an unknown agent key', async () => {
    const caller = makeWiredCaller(createAgentsTestDb());
    await expect(
      caller.cyboflow.agents.get({ projectId: PROJECT_ID, agentKey: 'no-such-agent' }),
    ).rejects.toSatisfy((err: unknown) => err instanceof TRPCError && err.code === 'NOT_FOUND');
  });
});

describe('cyboflow.agents.upsertOverride / resetOverride', () => {
  beforeEach(() => AgentOverrideRouter._resetForTesting());

  it('upsert shadows a builtin (source builtin-override, isOverridden true) then reset restores it', async () => {
    const rawDb = createAgentsTestDb();
    const caller = makeWiredCaller(rawDb);

    const overridden = await caller.cyboflow.agents.upsertOverride({
      projectId: PROJECT_ID,
      agentKey: 'implement',
      name: 'cyboflow-implement',
      description: 'My overridden implement description.',
      systemPrompt: 'You are my implement.',
      tools: ['Read', 'Edit', 'Bash'],
    });
    expect(overridden.source).toBe('builtin-override');
    expect(overridden.isOverridden).toBe(true);
    expect(overridden.description).toBe('My overridden implement description.');
    expect(overridden.tools).toEqual(['Read', 'Edit', 'Bash']);
    expect(overridden.stats.lastEditedAt).not.toBeNull();
    // Usage is preserved across an override (implement stays step-bound).
    expect(overridden.usage.workflowCount).toBeGreaterThanOrEqual(1);

    const reset = await caller.cyboflow.agents.resetOverride({
      projectId: PROJECT_ID,
      agentKey: 'implement',
    });
    expect(reset.source).toBe('builtin');
    expect(reset.isOverridden).toBe(false);
  });

  it('resetOverride throws NOT_FOUND when no override exists', async () => {
    const caller = makeWiredCaller(createAgentsTestDb());
    await expect(
      caller.cyboflow.agents.resetOverride({ projectId: PROJECT_ID, agentKey: 'implement' }),
    ).rejects.toSatisfy((err: unknown) => err instanceof TRPCError && err.code === 'NOT_FOUND');
  });

  it('upsert with a pinned model surfaces it on the entry + stats; reset clears it', async () => {
    const caller = makeWiredCaller(createAgentsTestDb());

    const pinned = await caller.cyboflow.agents.upsertOverride({
      projectId: PROJECT_ID,
      agentKey: 'implement',
      name: 'cyboflow-implement',
      description: 'Pin sonnet.',
      systemPrompt: 'You are my implement.',
      tools: ['Read', 'Edit'],
      model: 'sonnet',
    });
    expect(pinned.model).toBe('sonnet');
    expect(pinned.stats.model).toBe('Sonnet 5');

    const reset = await caller.cyboflow.agents.resetOverride({
      projectId: PROJECT_ID,
      agentKey: 'implement',
    });
    // Reset drops the override → back to inheriting the run model.
    expect(reset.model).toBeNull();
    expect(reset.stats.model).toBe('inherits run model');
  });
});

describe('cyboflow.agents.createCustom / duplicate / deleteCustom', () => {
  beforeEach(() => AgentOverrideRouter._resetForTesting());

  it('creates a custom agent, surfaces it in list, and deletes it', async () => {
    const caller = makeWiredCaller(createAgentsTestDb());

    const custom = await caller.cyboflow.agents.createCustom({
      projectId: PROJECT_ID,
      name: 'My Helper',
      description: 'A custom helper agent.',
      systemPrompt: 'You help.',
      tools: ['Read'],
    });
    expect(custom.agentKey).toBe('my-helper');
    expect(custom.source).toBe('custom');
    expect(custom.isCustom).toBe(true);
    expect(custom.name).toBe('cyboflow-my-helper');

    const listed = await caller.cyboflow.agents.list({ projectId: PROJECT_ID });
    expect(listed).toHaveLength(16);
    expect(listed.find((e) => e.agentKey === 'my-helper')).toBeDefined();

    const deleted = await caller.cyboflow.agents.deleteCustom({
      projectId: PROJECT_ID,
      agentKey: 'my-helper',
    });
    expect(deleted).toEqual({ ok: true });

    const afterDelete = await caller.cyboflow.agents.list({ projectId: PROJECT_ID });
    expect(afterDelete).toHaveLength(15);
  });

  it('createCustom CONFLICTs on a reserved builtin key', async () => {
    const caller = makeWiredCaller(createAgentsTestDb());
    await expect(
      caller.cyboflow.agents.createCustom({
        projectId: PROJECT_ID,
        name: 'implement',
        description: 'collides with builtin',
        systemPrompt: 'x',
        tools: ['Read'],
      }),
    ).rejects.toSatisfy((err: unknown) => err instanceof TRPCError && err.code === 'CONFLICT');
  });

  it('duplicate seeds a custom agent from the source builtin', async () => {
    const caller = makeWiredCaller(createAgentsTestDb());

    const dup = await caller.cyboflow.agents.duplicate({
      projectId: PROJECT_ID,
      agentKey: 'implement',
      newName: 'Implement Copy',
    });
    expect(dup.agentKey).toBe('implement-copy');
    expect(dup.source).toBe('custom');

    // Seeded from the source's tools/description.
    const builtin = await caller.cyboflow.agents.get({ projectId: PROJECT_ID, agentKey: 'implement' });
    expect(dup.tools).toEqual(builtin.tools);
    expect(dup.description).toBe(builtin.description);
  });

  it('deleteCustom on a builtin key is BAD_REQUEST', async () => {
    const caller = makeWiredCaller(createAgentsTestDb());
    await expect(
      caller.cyboflow.agents.deleteCustom({ projectId: PROJECT_ID, agentKey: 'implement' }),
    ).rejects.toSatisfy((err: unknown) => err instanceof TRPCError && err.code === 'BAD_REQUEST');
  });

  it('updateCustom edits a custom agent in place (key immutable, fields + mcps replaced)', async () => {
    const caller = makeWiredCaller(createAgentsTestDb());

    await caller.cyboflow.agents.createCustom({
      projectId: PROJECT_ID,
      name: 'My Helper',
      description: 'first',
      systemPrompt: 'one',
      tools: ['Read'],
    });

    const updated = await caller.cyboflow.agents.updateCustom({
      projectId: PROJECT_ID,
      agentKey: 'my-helper',
      description: 'second',
      systemPrompt: 'two',
      tools: ['Read', 'Edit'],
      enabledMcps: ['peekaboo'],
      role: 'reviewer',
    });
    expect(updated.agentKey).toBe('my-helper');
    expect(updated.source).toBe('custom');
    expect(updated.isCustom).toBe(true);
    expect(updated.description).toBe('second');
    expect(updated.tools).toEqual(['Read', 'Edit']);
    expect(updated.enabledMcps).toEqual(['peekaboo']);

    // Still a single custom agent (an in-place edit, not a new row).
    const listed = await caller.cyboflow.agents.list({ projectId: PROJECT_ID });
    expect(listed.filter((e) => e.agentKey === 'my-helper')).toHaveLength(1);
  });

  it('updateCustom on a builtin key is BAD_REQUEST (use upsertOverride)', async () => {
    const caller = makeWiredCaller(createAgentsTestDb());
    await expect(
      caller.cyboflow.agents.updateCustom({
        projectId: PROJECT_ID,
        agentKey: 'implement',
        description: 'x',
        systemPrompt: 'y',
        tools: ['Read'],
        enabledMcps: [],
      }),
    ).rejects.toSatisfy((err: unknown) => err instanceof TRPCError && err.code === 'BAD_REQUEST');
  });
});

describe('cyboflow.agents — PRECONDITION_FAILED when deps unwired', () => {
  beforeEach(() => AgentOverrideRouter._resetForTesting());

  it('every procedure throws PRECONDITION_FAILED with an empty context', async () => {
    const caller = appRouter.createCaller(createContext());

    const isPrecond = (err: unknown): boolean =>
      err instanceof TRPCError && err.code === 'PRECONDITION_FAILED';

    await expect(caller.cyboflow.agents.list({ projectId: PROJECT_ID })).rejects.toSatisfy(isPrecond);
    await expect(
      caller.cyboflow.agents.get({ projectId: PROJECT_ID, agentKey: 'implement' }),
    ).rejects.toSatisfy(isPrecond);
    await expect(
      caller.cyboflow.agents.upsertOverride({
        projectId: PROJECT_ID,
        agentKey: 'implement',
        name: 'cyboflow-implement',
        description: 'd',
        systemPrompt: 's',
        tools: ['Read'],
      }),
    ).rejects.toSatisfy(isPrecond);
    await expect(
      caller.cyboflow.agents.resetOverride({ projectId: PROJECT_ID, agentKey: 'implement' }),
    ).rejects.toSatisfy(isPrecond);
    await expect(
      caller.cyboflow.agents.createCustom({
        projectId: PROJECT_ID,
        name: 'X',
        description: 'd',
        systemPrompt: 's',
        tools: ['Read'],
      }),
    ).rejects.toSatisfy(isPrecond);
    await expect(
      caller.cyboflow.agents.duplicate({ projectId: PROJECT_ID, agentKey: 'implement', newName: 'Y' }),
    ).rejects.toSatisfy(isPrecond);
    await expect(
      caller.cyboflow.agents.updateCustom({
        projectId: PROJECT_ID,
        agentKey: 'my-helper',
        description: 'd',
        systemPrompt: 's',
        tools: ['Read'],
        enabledMcps: [],
      }),
    ).rejects.toSatisfy(isPrecond);
    await expect(
      caller.cyboflow.agents.deleteCustom({ projectId: PROJECT_ID, agentKey: 'my-helper' }),
    ).rejects.toSatisfy(isPrecond);
  });
});
