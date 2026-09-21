import { describe, it, expect } from 'vitest';
import {
  parseLaunchRunResult,
  parseReprioritizeResult,
  parseEditWorkflowResult,
  parseCreateBacklogResult,
  parseCreateWorkflowResult,
  parseTriageFindingsResult,
  parseWorkflowDefinitionSummary,
} from './proposalResultTypes';

describe('parseLaunchRunResult', () => {
  it('parses an executed result', () => {
    const result = parseLaunchRunResult({
      kind: 'launch-run',
      status: 'executed',
      sessionId: 's1',
      runId: 'run-1',
      branchName: 'agent/foo',
      worktreePath: '/tmp/wt',
    });
    expect(result).toEqual({
      kind: 'launch-run',
      status: 'executed',
      sessionId: 's1',
      worktreePath: '/tmp/wt',
      runId: 'run-1',
      branchName: 'agent/foo',
      ignoredSeeds: undefined,
      error: undefined,
      compensations: undefined,
      reconciled: undefined,
      verified: undefined,
    });
  });

  it('keeps the known ignoredSeeds entries and drops unknown ones; an empty list reads as absent', () => {
    expect(
      parseLaunchRunResult({ kind: 'launch-run', status: 'executed', runId: 'r', ignoredSeeds: ['findingIds', 'bogus', 'taskIds'] })
        ?.ignoredSeeds,
    ).toEqual(['findingIds', 'taskIds']);
    expect(parseLaunchRunResult({ kind: 'launch-run', status: 'executed', runId: 'r', ignoredSeeds: ['bogus'] })?.ignoredSeeds).toBeUndefined();
  });

  it('parses a failed result with compensations', () => {
    const result = parseLaunchRunResult({
      kind: 'launch-run',
      status: 'failed',
      error: 'boom',
      compensations: [
        { step: 'cancel-run', ok: true },
        { step: 'dismiss-session', ok: false, error: 'nope' },
      ],
    });
    expect(result?.status).toBe('failed');
    expect(result?.error).toBe('boom');
    expect(result?.compensations).toEqual([
      { step: 'cancel-run', ok: true },
      { step: 'dismiss-session', ok: false, error: 'nope' },
    ]);
  });

  it('filters malformed compensation entries defensively', () => {
    const result = parseLaunchRunResult({
      kind: 'launch-run',
      status: 'failed',
      compensations: [{ step: 'cancel-run', ok: true }, { step: 'not-a-step', ok: true }, 'garbage'],
    });
    expect(result?.compensations).toEqual([{ step: 'cancel-run', ok: true }]);
  });

  it('returns null for a mismatched kind', () => {
    expect(parseLaunchRunResult({ kind: 'edit-workflow', status: 'executed' })).toBeNull();
  });

  it('returns null for non-object / null / malformed status', () => {
    expect(parseLaunchRunResult(null)).toBeNull();
    expect(parseLaunchRunResult('nope')).toBeNull();
    expect(parseLaunchRunResult({ kind: 'launch-run', status: 'bogus' })).toBeNull();
  });
});

describe('parseReprioritizeResult', () => {
  it('parses executed + failed items', () => {
    const result = parseReprioritizeResult({
      kind: 'reprioritize-backlog',
      status: 'failed',
      items: [
        { taskId: 'TASK-001', ok: true },
        { taskId: 'TASK-002', ok: false, error: 'stale version' },
      ],
    });
    expect(result).toEqual({
      kind: 'reprioritize-backlog',
      status: 'failed',
      items: [
        { taskId: 'TASK-001', ok: true },
        { taskId: 'TASK-002', ok: false, error: 'stale version' },
      ],
      reconciled: undefined,
    });
  });

  it('filters malformed item entries defensively', () => {
    const result = parseReprioritizeResult({
      kind: 'reprioritize-backlog',
      status: 'executed',
      items: [{ taskId: 'TASK-001', ok: true }, { ok: true }, 'garbage', null],
    });
    expect(result?.items).toEqual([{ taskId: 'TASK-001', ok: true }]);
  });

  it('returns null when items is not an array', () => {
    expect(parseReprioritizeResult({ kind: 'reprioritize-backlog', status: 'executed' })).toBeNull();
  });

  it('returns null for a mismatched kind or malformed input', () => {
    expect(parseReprioritizeResult({ kind: 'launch-run', status: 'executed', items: [] })).toBeNull();
    expect(parseReprioritizeResult(undefined)).toBeNull();
  });
});

describe('parseEditWorkflowResult', () => {
  it('parses an executed result', () => {
    const result = parseEditWorkflowResult({
      kind: 'edit-workflow',
      status: 'executed',
      workflowId: 'wf-1',
      appliedHash: 'abc123',
    });
    expect(result?.status).toBe('executed');
    expect(result?.appliedHash).toBe('abc123');
  });

  it('parses a superseded result with hash fields', () => {
    const result = parseEditWorkflowResult({
      kind: 'edit-workflow',
      status: 'superseded',
      workflowId: 'wf-1',
      reason: 'spec-hash-mismatch',
      expectedHash: 'aaa',
      actualHash: 'bbb',
    });
    expect(result?.status).toBe('superseded');
    expect(result?.reason).toBe('spec-hash-mismatch');
    expect(result?.expectedHash).toBe('aaa');
    expect(result?.actualHash).toBe('bbb');
  });

  it('parses a validation-failed result with issues', () => {
    const result = parseEditWorkflowResult({
      kind: 'edit-workflow',
      status: 'failed',
      workflowId: 'wf-1',
      reason: 'validation-failed',
      issues: ['phases.0.id: required', 'oops'],
    });
    expect(result?.reason).toBe('validation-failed');
    expect(result?.issues).toEqual(['phases.0.id: required', 'oops']);
  });

  it('drops an unrecognized reason string rather than trusting it', () => {
    const result = parseEditWorkflowResult({
      kind: 'edit-workflow',
      status: 'failed',
      workflowId: 'wf-1',
      reason: 'made-up-reason',
    });
    expect(result?.reason).toBeUndefined();
  });

  it('returns null when workflowId is missing', () => {
    expect(parseEditWorkflowResult({ kind: 'edit-workflow', status: 'executed' })).toBeNull();
  });

  it('returns null for a mismatched kind or malformed input', () => {
    expect(parseEditWorkflowResult({ kind: 'launch-run' })).toBeNull();
    expect(parseEditWorkflowResult(42)).toBeNull();
  });
});

describe('parseWorkflowDefinitionSummary', () => {
  it('counts phases and steps', () => {
    const definitionJson = JSON.stringify({
      id: 'wf-1',
      phases: [
        { id: 'plan', label: 'Plan', color: '#3b6dd6', steps: [{ id: 's1' }, { id: 's2' }] },
        { id: 'execute', label: 'Execute', color: '#c96442', steps: [{ id: 's3' }] },
      ],
    });
    expect(parseWorkflowDefinitionSummary(definitionJson)).toEqual({ phaseCount: 2, stepCount: 3 });
  });

  it('returns null for invalid JSON', () => {
    expect(parseWorkflowDefinitionSummary('{not json')).toBeNull();
  });

  it('returns null when phases is missing or not an array', () => {
    expect(parseWorkflowDefinitionSummary(JSON.stringify({ id: 'wf-1' }))).toBeNull();
    expect(parseWorkflowDefinitionSummary(JSON.stringify({ phases: 'nope' }))).toBeNull();
  });

  it('returns null for a JSON scalar/array root', () => {
    expect(parseWorkflowDefinitionSummary('42')).toBeNull();
    expect(parseWorkflowDefinitionSummary('[]')).toBeNull();
  });

  it('treats a phase with no steps as zero steps', () => {
    const definitionJson = JSON.stringify({ phases: [{ id: 'plan' }] });
    expect(parseWorkflowDefinitionSummary(definitionJson)).toEqual({ phaseCount: 1, stepCount: 0 });
  });
});

describe('parseCreateBacklogResult', () => {
  it('parses a mixed executed/failed batch, keeping index / ref / error', () => {
    expect(
      parseCreateBacklogResult({
        kind: 'create-backlog-items',
        status: 'failed',
        items: [
          { index: 0, title: 'An idea', taskType: 'idea', ok: true, taskId: 'idea_1', ref: 'IDEA-012' },
          { index: 1, title: 'A task', taskType: 'task', ok: false, error: 'idea_needs_epic' },
        ],
      }),
    ).toEqual({
      kind: 'create-backlog-items',
      status: 'failed',
      items: [
        { index: 0, title: 'An idea', taskType: 'idea', ok: true, taskId: 'idea_1', ref: 'IDEA-012' },
        { index: 1, title: 'A task', taskType: 'task', ok: false, error: 'idea_needs_epic' },
      ],
      reconciled: undefined,
    });
  });

  it('returns null for another kind, a bad status, or a non-array items', () => {
    expect(parseCreateBacklogResult({ kind: 'launch-run', status: 'executed', items: [] })).toBeNull();
    expect(parseCreateBacklogResult({ kind: 'create-backlog-items', status: 'superseded', items: [] })).toBeNull();
    expect(parseCreateBacklogResult({ kind: 'create-backlog-items', status: 'executed', items: 'nope' })).toBeNull();
    expect(parseCreateBacklogResult(null)).toBeNull();
  });

  it('drops malformed item entries rather than throwing', () => {
    const parsed = parseCreateBacklogResult({
      kind: 'create-backlog-items',
      status: 'executed',
      items: [
        { index: 0, title: 'Good', taskType: 'task', ok: true },
        { index: 1, title: 'No type', ok: true },
        'nonsense',
      ],
    });
    expect(parsed?.items).toEqual([{ index: 0, title: 'Good', taskType: 'task', ok: true }]);
  });

  it('carries the reconciled flag through', () => {
    const parsed = parseCreateBacklogResult({
      kind: 'create-backlog-items',
      status: 'failed',
      items: [],
      reconciled: true,
    });
    expect(parsed?.reconciled).toBe(true);
  });
});

describe('parseCreateWorkflowResult', () => {
  it('parses an executed result with its workflow id and per-agent keys', () => {
    expect(
      parseCreateWorkflowResult({
        kind: 'create-workflow',
        status: 'executed',
        name: 'Docs Review',
        workflowId: 'wf-1',
        agents: [{ index: 0, name: 'Docs Writer', ok: true, agentKey: 'docs-writer' }],
      }),
    ).toEqual({
      kind: 'create-workflow',
      status: 'executed',
      name: 'Docs Review',
      workflowId: 'wf-1',
      agents: [{ index: 0, name: 'Docs Writer', ok: true, agentKey: 'docs-writer' }],
      error: undefined,
      compensations: undefined,
      reconciled: undefined,
    });
  });

  it('keeps the error + compensations of a failed result and drops malformed entries', () => {
    const parsed = parseCreateWorkflowResult({
      kind: 'create-workflow',
      status: 'failed',
      name: 'Docs Review',
      error: 'boom',
      agents: [{ index: 0, name: 'Docs Writer', ok: true }, { nope: true }],
      compensations: [{ agentKey: 'docs-writer', ok: false, error: 'referenced' }, 'junk'],
      reconciled: true,
    });
    expect(parsed?.error).toBe('boom');
    expect(parsed?.agents).toEqual([{ index: 0, name: 'Docs Writer', ok: true }]);
    expect(parsed?.compensations).toEqual([{ agentKey: 'docs-writer', ok: false, error: 'referenced' }]);
    expect(parsed?.reconciled).toBe(true);
  });

  it('returns null for another kind, a bad status, a missing name, or a non-array agents', () => {
    expect(parseCreateWorkflowResult({ kind: 'edit-workflow', status: 'executed', name: 'x', agents: [] })).toBeNull();
    expect(parseCreateWorkflowResult({ kind: 'create-workflow', status: 'superseded', name: 'x', agents: [] })).toBeNull();
    expect(parseCreateWorkflowResult({ kind: 'create-workflow', status: 'executed', agents: [] })).toBeNull();
    expect(parseCreateWorkflowResult({ kind: 'create-workflow', status: 'executed', name: 'x', agents: 'none' })).toBeNull();
  });
});

describe('parseTriageFindingsResult', () => {
  it('parses an executed result, keeping skipped/error per row', () => {
    expect(
      parseTriageFindingsResult({
        kind: 'triage-findings',
        status: 'executed',
        applied: 1,
        skipped: 1,
        items: [
          { reviewItemId: 'r1', op: 'dismiss', ok: true },
          { reviewItemId: 'r2', op: 'set-selected', ok: false, skipped: 'already resolved' },
        ],
      }),
    ).toEqual({
      kind: 'triage-findings',
      status: 'executed',
      applied: 1,
      skipped: 1,
      items: [
        { reviewItemId: 'r1', op: 'dismiss', ok: true, skipped: undefined, error: undefined },
        { reviewItemId: 'r2', op: 'set-selected', ok: false, skipped: 'already resolved', error: undefined },
      ],
      reconciled: undefined,
    });
  });

  it('drops malformed rows (unknown op / missing ok) and derives the counts when absent', () => {
    const result = parseTriageFindingsResult({
      kind: 'triage-findings',
      status: 'failed',
      items: [
        { reviewItemId: 'r1', op: 'dismiss', ok: true },
        { reviewItemId: 'r2', op: 'promote', ok: true },
        { reviewItemId: 'r3', op: 'approve' },
        { reviewItemId: 'r4', op: 'resolve', ok: false, skipped: 'gone' },
        { reviewItemId: 'r5', op: 'resolve', ok: false, error: 'boom' },
      ],
    });
    expect(result?.items.map((i) => i.reviewItemId)).toEqual(['r1', 'r4', 'r5']);
    expect(result?.applied).toBe(1);
    expect(result?.skipped).toBe(1);
  });

  it('returns null for a mismatched kind, a bad status, or missing items', () => {
    expect(parseTriageFindingsResult({ kind: 'launch-run', status: 'executed' })).toBeNull();
    expect(parseTriageFindingsResult({ kind: 'triage-findings', status: 'superseded', items: [] })).toBeNull();
    expect(parseTriageFindingsResult({ kind: 'triage-findings', status: 'executed' })).toBeNull();
  });
});
