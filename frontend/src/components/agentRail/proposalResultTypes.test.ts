import { describe, it, expect } from 'vitest';
import {
  parseLaunchRunResult,
  parseReprioritizeResult,
  parseEditWorkflowResult,
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
      error: undefined,
      compensations: undefined,
      reconciled: undefined,
      verified: undefined,
    });
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
