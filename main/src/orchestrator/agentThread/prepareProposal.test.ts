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

  deps = {
    db: dbAdapter(rawDb),
    readWorkflowRow: (workflowId) => workflows.get(workflowId) ?? null,
    readTaskIdentity: (taskId) => identities.get(taskId),
    resolveExistingEntity: (projectId, refOrId, type) => existing.get(`${projectId}:${refOrId}:${type}`) ?? null,
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
  it('launch-run carries no preconditions', () => {
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
