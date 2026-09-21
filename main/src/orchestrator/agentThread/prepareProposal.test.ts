/**
 * Unit tests for prepareProposal — the shared server-side proposal preparation
 * extracted from mcpQueryHandler.handleProposeAction
 * (docs/proposals/CUSTOM-VIEWS.md §4.5).
 *
 * The MCP tool's OBSERVABLE replies are pinned end-to-end by
 * mcpServer/__tests__/mcpAgentTools.test.ts, which is unchanged by the move.
 * What this file pins is the module boundary the widget action service now
 * shares: each error string, and the two enrichments a caller must not be able
 * to supply itself (the navigation's owning projectId, and backlog links
 * normalized from a display ref to an opaque id).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { dbAdapter } from '../__test_fixtures__/dbAdapter';
import { computeSpecHash } from './specHash';
import { parseAgentProposalPayload, prepareProposal, type PrepareProposalDeps } from './prepareProposal';
import type { WorkflowRow } from '../../../../shared/types/workflows';
import type { TaskType } from '../../../../shared/types/tasks';

const DEFINITION = {
  id: 'my-custom-flow',
  phases: [
    {
      id: 'p1',
      label: 'Phase',
      color: 'blue',
      steps: [{ id: 's1', name: 'Step', agent: 'implement', prompt: 'do it' }],
    },
  ],
};

let rawDb: Database.Database;
let deps: PrepareProposalDeps;
let workflows: Map<string, WorkflowRow>;
let identities: Map<string, { ref: string; stage_id: string; version: number; type: TaskType }>;
let existing: Map<string, string>;
let takenWorkflowNames: Set<string>;
let customAgents: Set<string>;
/** Launchable flows keyed by id — `projectId` null = global. */
let launchable: Map<string, { id: string; name: string; projectId: number | null }>;

beforeEach(() => {
  rawDb = new Database(':memory:');
  rawDb.exec(`
    CREATE TABLE projects (id INTEGER PRIMARY KEY);
    CREATE TABLE workflow_runs (id TEXT PRIMARY KEY, project_id INTEGER);
    CREATE TABLE sessions (id TEXT PRIMARY KEY, project_id INTEGER);
  `);
  rawDb.prepare('INSERT INTO projects (id) VALUES (1)').run();
  rawDb.prepare('INSERT INTO workflow_runs (id, project_id) VALUES (?, ?)').run('run-1', 4);
  rawDb.prepare('INSERT INTO sessions (id, project_id) VALUES (?, ?)').run('sess-1', 5);

  workflows = new Map();
  identities = new Map();
  existing = new Map();
  takenWorkflowNames = new Set();
  customAgents = new Set();
  launchable = new Map();

  deps = {
    db: dbAdapter(rawDb),
    readWorkflowRow: (workflowId) => workflows.get(workflowId) ?? null,
    readTaskIdentity: (taskId) => identities.get(taskId),
    resolveExistingEntity: (projectId, refOrId, type) => existing.get(`${projectId}:${refOrId}:${type}`) ?? null,
    workflowNameTaken: (projectId, name) => takenWorkflowNames.has(`${projectId ?? 'global'}:${name}`),
    customAgentExists: (projectId, agentKey) => customAgents.has(`${projectId}:${agentKey}`),
    resolveLaunchWorkflow: (projectId, ref) => {
      const visible = [...launchable.values()].filter((w) => w.projectId === null || w.projectId === projectId);
      if (ref.workflowId !== undefined) return visible.find((w) => w.id === ref.workflowId) ?? null;
      const byName = visible.filter((w) => w.name === ref.workflowName);
      return byName.find((w) => w.projectId !== null) ?? byName[0] ?? null;
    },
  };
});

// ---------------------------------------------------------------------------
// Payload parsing
// ---------------------------------------------------------------------------

describe('parseAgentProposalPayload', () => {
  it('returns null for a non-object, an unknown kind and a malformed body', () => {
    expect(parseAgentProposalPayload('nope')).toBeNull();
    expect(parseAgentProposalPayload({ kind: 'not-a-kind' })).toBeNull();
    expect(parseAgentProposalPayload({ kind: 'launch-run', projectId: 'one', workflowName: 'sprint' })).toBeNull();
  });

  it('narrows a launch-run payload with its optional arrays', () => {
    expect(
      parseAgentProposalPayload({ kind: 'launch-run', projectId: 1, workflowName: 'sprint', taskIds: ['t1'] }),
    ).toEqual({ kind: 'launch-run', projectId: 1, workflowName: 'sprint', taskIds: ['t1'] });
  });

  it('launch-run accepts a custom workflowName or a workflowId, but not neither (TASK-294)', () => {
    expect(parseAgentProposalPayload({ kind: 'launch-run', projectId: 1, workflowName: 'dash' })).toEqual({
      kind: 'launch-run',
      projectId: 1,
      workflowName: 'dash',
    });
    expect(parseAgentProposalPayload({ kind: 'launch-run', projectId: 1, workflowId: 'wf-global-custom-e253eb7b' })).toEqual({
      kind: 'launch-run',
      projectId: 1,
      workflowName: '',
      workflowId: 'wf-global-custom-e253eb7b',
    });
    expect(parseAgentProposalPayload({ kind: 'launch-run', projectId: 1 })).toBeNull();
    expect(parseAgentProposalPayload({ kind: 'launch-run', projectId: 1, workflowName: '  ' })).toBeNull();
    expect(parseAgentProposalPayload({ kind: 'launch-run', projectId: 1, workflowId: '' })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Error strings
// ---------------------------------------------------------------------------

describe('prepareProposal — error strings', () => {
  it('invalid_payload for anything the parser rejects', () => {
    expect(prepareProposal(deps, { kind: 'launch-run' })).toEqual({ ok: false, error: 'invalid_payload' });
  });

  it('workflow_not_found for an edit-workflow naming no row', () => {
    expect(
      prepareProposal(deps, { kind: 'edit-workflow', workflowId: 'wf-x', definitionJson: '{}' }),
    ).toEqual({ ok: false, error: 'workflow_not_found' });
  });

  it('workflow_unresolvable for a custom flow with no resolvable definition', () => {
    workflows.set('wf-x', { id: 'wf-x', name: 'my-custom-flow', spec_json: '', tuning_level: 'custom' } as WorkflowRow);
    expect(
      prepareProposal(deps, { kind: 'edit-workflow', workflowId: 'wf-x', definitionJson: '{}' }),
    ).toEqual({ ok: false, error: 'workflow_unresolvable' });
  });

  it('task_not_found:<id> for a reprioritize entry with no row', () => {
    expect(
      prepareProposal(deps, {
        kind: 'reprioritize-backlog',
        projectId: 1,
        items: [{ taskId: 'tsk_missing', priority: 'P1' }],
      }),
    ).toEqual({ ok: false, error: 'task_not_found:tsk_missing' });
  });

  it('run_not_found for an open-session run target with no row', () => {
    expect(
      prepareProposal(deps, { kind: 'open-session', navigation: { target: 'run', runId: 'run-x' } }),
    ).toEqual({ ok: false, error: 'run_not_found' });
  });

  it('session_not_found for an open-session quick-session target with no row', () => {
    expect(
      prepareProposal(deps, { kind: 'open-session', navigation: { target: 'quick-session', sessionId: 'sess-x' } }),
    ).toEqual({ ok: false, error: 'session_not_found' });
  });

  it('project_not_found for a create-backlog-items batch naming no project', () => {
    expect(
      prepareProposal(deps, {
        kind: 'create-backlog-items',
        projectId: 99,
        items: [{ taskType: 'task', title: 'x' }],
      }),
    ).toEqual({ ok: false, error: 'project_not_found' });
  });

  it('parent_epic_not_found:<ref> for an unresolvable parent link', () => {
    expect(
      prepareProposal(deps, {
        kind: 'create-backlog-items',
        projectId: 1,
        items: [{ taskType: 'task', title: 'x', parentEpicId: 'EPIC-404' }],
      }),
    ).toEqual({ ok: false, error: 'parent_epic_not_found:EPIC-404' });
  });

  it('originating_idea_not_found:<ref> for an unresolvable lineage link', () => {
    expect(
      prepareProposal(deps, {
        kind: 'create-backlog-items',
        projectId: 1,
        items: [{ taskType: 'task', title: 'x', originatingIdeaId: 'IDEA-404' }],
      }),
    ).toEqual({ ok: false, error: 'originating_idea_not_found:IDEA-404' });
  });
});

// ---------------------------------------------------------------------------
// Preconditions + enrichment
// ---------------------------------------------------------------------------

describe('prepareProposal — preconditions captured server-side', () => {
  it('launch-run carries no preconditions (a built-in name with no row yet passes through unstamped)', () => {
    const result = prepareProposal(deps, { kind: 'launch-run', projectId: 1, workflowName: 'sprint' });
    expect(result).toEqual({
      ok: true,
      payload: { kind: 'launch-run', projectId: 1, workflowName: 'sprint' },
      preconditions: null,
    });
  });

  it('edit-workflow captures the EFFECTIVE definition hash', () => {
    workflows.set('wf-x', {
      id: 'wf-x',
      name: 'my-custom-flow',
      spec_json: JSON.stringify(DEFINITION),
      tuning_level: 'custom',
    } as WorkflowRow);
    const result = prepareProposal(deps, { kind: 'edit-workflow', workflowId: 'wf-x', definitionJson: '{}' });
    expect(result.ok).toBe(true);
    expect(result.ok === true && result.preconditions).toEqual({
      kind: 'edit-workflow',
      specHash: computeSpecHash(DEFINITION as never),
    });
  });

  it('reprioritize-backlog captures each row version', () => {
    identities.set('tsk_1', { ref: 'TASK-001', stage_id: 'backlog', version: 7, type: 'task' });
    const result = prepareProposal(deps, {
      kind: 'reprioritize-backlog',
      projectId: 1,
      items: [{ taskId: 'tsk_1', priority: 'P0' }],
    });
    expect(result.ok === true && result.preconditions).toEqual({
      kind: 'reprioritize-backlog',
      expectedVersions: { tsk_1: 7 },
    });
  });
});

describe('prepareProposal — server-side enrichment', () => {
  it("overwrites a caller-supplied projectId on a 'run' navigation", () => {
    const result = prepareProposal(deps, {
      kind: 'open-session',
      navigation: { target: 'run', runId: 'run-1', projectId: 999 },
    });
    expect(result.ok === true && result.payload).toEqual({
      kind: 'open-session',
      navigation: { target: 'run', runId: 'run-1', projectId: 4 },
    });
  });

  it("resolves the owning project of a 'quick-session' navigation, keeping its runId", () => {
    const result = prepareProposal(deps, {
      kind: 'open-session',
      navigation: { target: 'quick-session', sessionId: 'sess-1', runId: 'run-1', projectId: 999 },
    });
    expect(result.ok === true && result.payload).toEqual({
      kind: 'open-session',
      navigation: { target: 'quick-session', sessionId: 'sess-1', runId: 'run-1', projectId: 5 },
    });
  });

  it('normalizes create-backlog-items links from a display ref to an opaque id', () => {
    existing.set('1:EPIC-002:epic', 'epc_opaque');
    existing.set('1:IDEA-009:idea', 'ida_opaque');
    const result = prepareProposal(deps, {
      kind: 'create-backlog-items',
      projectId: 1,
      items: [{ taskType: 'task', title: 'x', parentEpicId: 'EPIC-002', originatingIdeaId: 'IDEA-009' }],
    });
    expect(result.ok === true && result.payload).toEqual({
      kind: 'create-backlog-items',
      projectId: 1,
      items: [{ taskType: 'task', title: 'x', parentEpicId: 'epc_opaque', originatingIdeaId: 'ida_opaque' }],
    });
  });
});

// ---------------------------------------------------------------------------
// create-workflow — propose-time validation (no preconditions)
// ---------------------------------------------------------------------------

/** A strict-schema-valid definition binding one builtin, the human gate, and one NEW agent. */
const NEW_FLOW = {
  id: 'docs-review',
  phases: [
    {
      id: 'review',
      label: 'Review',
      color: '#3b6dd6',
      steps: [
        { id: 'survey', name: 'Survey', agent: 'implement', mcps: [], retries: 0 },
        { id: 'write', name: 'Write', agent: 'docs-writer', mcps: [], retries: 1 },
        { id: 'approve', name: 'Approve', agent: 'human', mcps: [], retries: 0, human: true },
      ],
    },
  ],
};

const DOCS_WRITER = {
  name: 'Docs Writer',
  description: 'Writes the docs for a change.',
  systemPrompt: 'You write documentation. Return a summary.',
  tools: ['Read', 'Edit'],
};

function createWorkflowPayload(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: 'create-workflow',
    projectId: 1,
    name: 'Docs Review',
    definitionJson: JSON.stringify(NEW_FLOW),
    agents: [DOCS_WRITER],
    ...over,
  };
}

describe('parseAgentProposalPayload — create-workflow', () => {
  it('narrows a full payload, keeping the optional fields it was given', () => {
    const parsed = parseAgentProposalPayload(
      createWorkflowPayload({ scope: 'project', permissionMode: 'acceptEdits', summary: 'A docs flow' }),
    );
    expect(parsed).toEqual({
      kind: 'create-workflow',
      projectId: 1,
      name: 'Docs Review',
      definitionJson: JSON.stringify(NEW_FLOW),
      agents: [DOCS_WRITER],
      scope: 'project',
      permissionMode: 'acceptEdits',
      summary: 'A docs flow',
    });
  });

  it('rejects a malformed scope, permission mode, tool, model, or agent member', () => {
    expect(parseAgentProposalPayload(createWorkflowPayload({ scope: 'everywhere' }))).toBeNull();
    expect(parseAgentProposalPayload(createWorkflowPayload({ permissionMode: 'yolo' }))).toBeNull();
    expect(parseAgentProposalPayload(createWorkflowPayload({ agents: [{ ...DOCS_WRITER, tools: ['Task'] }] }))).toBeNull();
    expect(parseAgentProposalPayload(createWorkflowPayload({ agents: [{ ...DOCS_WRITER, model: 'gpt-5' }] }))).toBeNull();
    expect(parseAgentProposalPayload(createWorkflowPayload({ agents: [{ name: 'x' }] }))).toBeNull();
    expect(parseAgentProposalPayload(createWorkflowPayload({ agents: 'docs-writer' }))).toBeNull();
    expect(parseAgentProposalPayload(createWorkflowPayload({ definitionJson: '' }))).toBeNull();
  });

  // The live smoke's first attempt nested the definition as an object inside
  // payload_json (the natural way to compose it) and got 'invalid_payload' five
  // times running — an object is re-encoded, not rejected, on both arms.
  it('accepts definitionJson as a plain object and re-encodes it (create-workflow and edit-workflow)', () => {
    expect(parseAgentProposalPayload(createWorkflowPayload({ definitionJson: NEW_FLOW }))).toMatchObject({
      kind: 'create-workflow',
      definitionJson: JSON.stringify(NEW_FLOW),
    });
    expect(parseAgentProposalPayload({ kind: 'edit-workflow', workflowId: 'wf-1', definitionJson: NEW_FLOW })).toEqual({
      kind: 'edit-workflow',
      workflowId: 'wf-1',
      definitionJson: JSON.stringify(NEW_FLOW),
    });
    expect(parseAgentProposalPayload(createWorkflowPayload({ definitionJson: [NEW_FLOW] }))).toBeNull();
    expect(parseAgentProposalPayload(createWorkflowPayload({ definitionJson: null }))).toBeNull();
  });
});

describe('prepareProposal — create-workflow validation', () => {
  it('accepts a valid flow + agent, normalizing the definition and trimming the name', () => {
    const result = prepareProposal(deps, createWorkflowPayload({ name: '  Docs Review ' }));
    expect(result.ok).toBe(true);
    expect(result.ok === true && result.preconditions).toBeNull();
    expect(result.ok === true && result.payload).toMatchObject({ kind: 'create-workflow', name: 'Docs Review' });
    expect(result.ok === true && result.payload.kind === 'create-workflow' && JSON.parse(result.payload.definitionJson)).toEqual(
      NEW_FLOW,
    );
  });

  it('rejects an unknown project', () => {
    expect(prepareProposal(deps, createWorkflowPayload({ projectId: 42 }))).toEqual({ ok: false, error: 'project_not_found' });
  });

  it('rejects a Windows-unsafe, reserved, or already-taken name', () => {
    expect(prepareProposal(deps, createWorkflowPayload({ name: 'docs/review' }))).toMatchObject({
      ok: false,
      error: expect.stringMatching(/^workflow_name_invalid:/),
    });
    expect(prepareProposal(deps, createWorkflowPayload({ name: 'sprint' }))).toEqual({ ok: false, error: 'workflow_name_reserved' });
    expect(prepareProposal(deps, createWorkflowPayload({ name: '__quick__' }))).toEqual({ ok: false, error: 'workflow_name_reserved' });

    takenWorkflowNames.add('1:Docs Review');
    expect(prepareProposal(deps, createWorkflowPayload())).toEqual({ ok: false, error: 'workflow_name_taken' });
  });

  it('checks a global-scoped name against the global namespace, not the project', () => {
    takenWorkflowNames.add('1:Solo');
    const noAgentsFlow = { ...NEW_FLOW, phases: [{ ...NEW_FLOW.phases[0], steps: NEW_FLOW.phases[0].steps.filter((s) => s.agent !== 'docs-writer') }] };
    expect(
      prepareProposal(deps, createWorkflowPayload({ name: 'Solo', scope: 'global', agents: [], definitionJson: JSON.stringify(noAgentsFlow) })),
    ).toMatchObject({ ok: true });
    takenWorkflowNames.add('global:Solo');
    expect(
      prepareProposal(deps, createWorkflowPayload({ name: 'Solo', scope: 'global', agents: [], definitionJson: JSON.stringify(noAgentsFlow) })),
    ).toEqual({ ok: false, error: 'workflow_name_taken' });
  });

  it('refuses a global flow that mints project-scoped agents', () => {
    expect(prepareProposal(deps, createWorkflowPayload({ scope: 'global' }))).toEqual({
      ok: false,
      error: 'global_scope_with_agents',
    });
  });

  it('rejects a definition the strict write-path schema refuses, naming the field', () => {
    expect(prepareProposal(deps, createWorkflowPayload({ definitionJson: '{not json' }))).toEqual({
      ok: false,
      error: 'invalid_definition:definitionJson is not valid JSON',
    });
    const badColor = { ...NEW_FLOW, phases: [{ ...NEW_FLOW.phases[0], color: 'blue' }] };
    expect(prepareProposal(deps, createWorkflowPayload({ definitionJson: JSON.stringify(badColor) }))).toMatchObject({
      ok: false,
      error: expect.stringMatching(/^invalid_definition:phases\.0\.color: /),
    });
  });

  it('runs each new agent through the chokepoint draft checks and the reserved/duplicate key guards', () => {
    expect(
      prepareProposal(deps, createWorkflowPayload({ agents: [{ ...DOCS_WRITER, systemPrompt: 'Call cyboflow_create_task.' }] })),
    ).toMatchObject({ ok: false, error: expect.stringMatching(/^agent_invalid:docs-writer:/) });
    expect(prepareProposal(deps, createWorkflowPayload({ agents: [{ ...DOCS_WRITER, tools: [] }] }))).toMatchObject({
      ok: false,
      error: expect.stringMatching(/^agent_invalid:docs-writer:/),
    });
    expect(prepareProposal(deps, createWorkflowPayload({ agents: [{ ...DOCS_WRITER, name: 'Implement' }] }))).toEqual({
      ok: false,
      error: 'agent_key_reserved:implement',
    });
    expect(prepareProposal(deps, createWorkflowPayload({ agents: [DOCS_WRITER, { ...DOCS_WRITER, name: 'docs writer' }] }))).toEqual({
      ok: false,
      error: 'agent_key_taken:docs-writer',
    });
    customAgents.add('1:docs-writer');
    expect(prepareProposal(deps, createWorkflowPayload())).toEqual({ ok: false, error: 'agent_key_taken:docs-writer' });
  });

  it('rejects a step bound to an agent nothing provides, but accepts an EXISTING custom agent', () => {
    expect(prepareProposal(deps, createWorkflowPayload({ agents: [] }))).toEqual({
      ok: false,
      error: 'unknown_step_agent:docs-writer',
    });
    customAgents.add('1:docs-writer');
    expect(prepareProposal(deps, createWorkflowPayload({ agents: [] }))).toMatchObject({ ok: true });
  });

  it('checks fan-out inner step bindings too', () => {
    const fanOut = {
      ...NEW_FLOW,
      phases: [
        {
          ...NEW_FLOW.phases[0],
          steps: [
            {
              id: 'lanes',
              name: 'Lanes',
              agent: 'implement',
              mcps: [],
              retries: 0,
              fanOut: { over: 'tasks', inner: [{ id: 'lane-review', agent: 'ghost-reviewer' }] },
            },
          ],
        },
      ],
    };
    expect(prepareProposal(deps, createWorkflowPayload({ agents: [], definitionJson: JSON.stringify(fanOut) }))).toEqual({
      ok: false,
      error: 'unknown_step_agent:ghost-reviewer',
    });
  });
});

// ---------------------------------------------------------------------------
// launch-run — custom workflow resolution (TASK-294)
// ---------------------------------------------------------------------------

describe('prepareProposal — launch-run workflow resolution', () => {
  beforeEach(() => {
    launchable.set('wf-sprint', { id: 'wf-sprint', name: 'sprint', projectId: null });
    launchable.set('wf-global-custom-e253eb7b', { id: 'wf-global-custom-e253eb7b', name: 'dash', projectId: null });
    launchable.set('wf-p1-docs', { id: 'wf-p1-docs', name: 'docs-review', projectId: 1 });
    launchable.set('wf-p2-secret', { id: 'wf-p2-secret', name: 'secret', projectId: 2 });
  });

  it('accepts a custom flow by workflowId and stamps its name + scope', () => {
    const result = prepareProposal(deps, {
      kind: 'launch-run',
      projectId: 1,
      workflowId: 'wf-global-custom-e253eb7b',
      taskIds: ['tsk_1'],
    });
    expect(result).toEqual({
      ok: true,
      payload: {
        kind: 'launch-run',
        projectId: 1,
        workflowName: 'dash',
        workflowId: 'wf-global-custom-e253eb7b',
        workflowScope: 'global',
        taskIds: ['tsk_1'],
      },
      preconditions: null,
    });
  });

  it('accepts a custom flow by exact name and stamps its id + scope', () => {
    const result = prepareProposal(deps, { kind: 'launch-run', projectId: 1, workflowName: 'docs-review' });
    expect(result.ok === true && result.payload).toMatchObject({
      workflowName: 'docs-review',
      workflowId: 'wf-p1-docs',
      workflowScope: 'project',
    });
  });

  it('stamps a built-in that HAS a row with its id, but never a scope', () => {
    const result = prepareProposal(deps, { kind: 'launch-run', projectId: 1, workflowName: 'sprint' });
    expect(result.ok === true && result.payload).toEqual({
      kind: 'launch-run',
      projectId: 1,
      workflowName: 'sprint',
      workflowId: 'wf-sprint',
    });
  });

  it('rejects an unknown custom name or id with a NAMED error, not invalid_payload', () => {
    expect(prepareProposal(deps, { kind: 'launch-run', projectId: 1, workflowName: 'nope' })).toEqual({
      ok: false,
      error: 'unknown_workflow:nope',
    });
    expect(prepareProposal(deps, { kind: 'launch-run', projectId: 1, workflowId: 'wf-missing' })).toEqual({
      ok: false,
      error: 'unknown_workflow:wf-missing',
    });
  });

  it("rejects another project's scoped flow (invisible to this project)", () => {
    expect(prepareProposal(deps, { kind: 'launch-run', projectId: 1, workflowId: 'wf-p2-secret' })).toEqual({
      ok: false,
      error: 'unknown_workflow:wf-p2-secret',
    });
    expect(prepareProposal(deps, { kind: 'launch-run', projectId: 1, workflowName: 'secret' })).toEqual({
      ok: false,
      error: 'unknown_workflow:secret',
    });
  });

  it('workflowId wins over a conflicting workflowName', () => {
    const result = prepareProposal(deps, {
      kind: 'launch-run',
      projectId: 1,
      workflowId: 'wf-global-custom-e253eb7b',
      workflowName: 'docs-review',
    });
    expect(result.ok === true && result.payload).toMatchObject({ workflowId: 'wf-global-custom-e253eb7b', workflowName: 'dash' });
  });

  it('prefers the project-scoped row when a project name shadows a global one', () => {
    launchable.set('wf-global-dash2', { id: 'wf-global-dash2', name: 'shadow', projectId: null });
    launchable.set('wf-p1-dash2', { id: 'wf-p1-dash2', name: 'shadow', projectId: 1 });
    const result = prepareProposal(deps, { kind: 'launch-run', projectId: 1, workflowName: 'shadow' });
    expect(result.ok === true && result.payload).toMatchObject({ workflowId: 'wf-p1-dash2', workflowScope: 'project' });
  });
});

describe('createPrepareProposalDeps.resolveLaunchWorkflow', () => {
  it('reads visibility, archival, the quick sentinel and project-over-global shadowing off the workflows table', async () => {
    const { createPrepareProposalDeps } = await import('./prepareProposal');
    const db = new Database(':memory:');
    db.exec(`CREATE TABLE workflows (id TEXT PRIMARY KEY, project_id INTEGER, name TEXT NOT NULL, archived_at TEXT)`);
    const ins = db.prepare('INSERT INTO workflows (id, project_id, name, archived_at) VALUES (?, ?, ?, ?)');
    ins.run('wf-sprint', null, 'sprint', null);
    ins.run('wf-dash', null, 'dash', null);
    ins.run('wf-p1-dash', 1, 'dash', null);
    ins.run('wf-p2-only', 2, 'p2-only', null);
    ins.run('wf-archived', null, 'old', '2026-01-01T00:00:00.000Z');
    ins.run('wf-1-__quick__', 1, '__quick__', null);
    const real = createPrepareProposalDeps(dbAdapter(db));

    expect(real.resolveLaunchWorkflow(1, { workflowName: 'sprint' })).toEqual({ id: 'wf-sprint', name: 'sprint', projectId: null });
    expect(real.resolveLaunchWorkflow(1, { workflowName: 'dash' })).toEqual({ id: 'wf-p1-dash', name: 'dash', projectId: 1 });
    expect(real.resolveLaunchWorkflow(2, { workflowName: 'dash' })).toEqual({ id: 'wf-dash', name: 'dash', projectId: null });
    expect(real.resolveLaunchWorkflow(1, { workflowId: 'wf-p2-only' })).toBeNull();
    expect(real.resolveLaunchWorkflow(2, { workflowId: 'wf-p2-only' })).toMatchObject({ id: 'wf-p2-only' });
    expect(real.resolveLaunchWorkflow(1, { workflowName: 'old' })).toBeNull();
    expect(real.resolveLaunchWorkflow(1, { workflowId: 'wf-archived' })).toBeNull();
    expect(real.resolveLaunchWorkflow(1, { workflowName: '__quick__' })).toBeNull();
    expect(real.resolveLaunchWorkflow(1, {})).toBeNull();
    db.close();
  });
});
