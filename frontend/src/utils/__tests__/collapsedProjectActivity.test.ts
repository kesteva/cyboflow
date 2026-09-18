/**
 * deriveCollapsedProjectActivity — parity with LandingHome's Working section
 * (TASK-223): flow runs by classifyRun, run > dynamic > session dedup, and
 * active dynamic workflows counted for their project.
 */
import { describe, it, expect } from 'vitest';
import { deriveCollapsedProjectActivity } from '../collapsedProjectActivity';

describe('deriveCollapsedProjectActivity', () => {
  it('counts active runs as running and blocked runs as blocked; terminal runs count nothing', () => {
    const out = deriveCollapsedProjectActivity({
      projectId: 1,
      runs: [
        { status: 'running', session_id: 's1' },
        { status: 'queued', session_id: null },
        { status: 'awaiting_review', session_id: 's2' },
        { status: 'completed', session_id: 's3' },
      ],
      sessions: [],
      activeDynamicWorkflows: [],
    });
    expect(out).toEqual({ running: 2, blocked: 1 });
  });

  it('a session spoken for by its own non-terminal run is not double-counted off its raw status', () => {
    const out = deriveCollapsedProjectActivity({
      projectId: 1,
      runs: [{ status: 'awaiting_review', session_id: 's1' }],
      sessions: [{ id: 's1', status: 'running' }],
      activeDynamicWorkflows: [],
    });
    expect(out).toEqual({ running: 0, blocked: 1 });
  });

  it('a session whose only run is terminal speaks for itself again', () => {
    const out = deriveCollapsedProjectActivity({
      projectId: 1,
      runs: [{ status: 'completed', session_id: 's1' }],
      sessions: [{ id: 's1', status: 'running' }, { id: 's2', status: 'waiting' }],
      activeDynamicWorkflows: [],
    });
    expect(out).toEqual({ running: 1, blocked: 1 });
  });

  it('a detached dynamic workflow counts as running even though its session reads completed (Landing parity)', () => {
    const out = deriveCollapsedProjectActivity({
      projectId: 1,
      runs: [],
      sessions: [{ id: 's1', status: 'stopped' }],
      activeDynamicWorkflows: [{ sessionId: 's1', projectId: 1 }],
    });
    expect(out).toEqual({ running: 1, blocked: 0 });
  });

  it('a dynamic workflow is one row per session, never stacked on a running session status or a flow run', () => {
    const out = deriveCollapsedProjectActivity({
      projectId: 1,
      runs: [{ status: 'running', session_id: 's-run' }],
      sessions: [
        { id: 's-run', status: 'running' },
        { id: 's-dyn', status: 'running' },
      ],
      activeDynamicWorkflows: [
        { sessionId: 's-run', projectId: 1 }, // spoken for by the flow run
        { sessionId: 's-dyn', projectId: 1 },
        { sessionId: 's-dyn', projectId: 1 }, // second workflow in the same session
      ],
    });
    expect(out).toEqual({ running: 2, blocked: 0 });
  });

  it('ignores dynamic workflows belonging to another project', () => {
    const out = deriveCollapsedProjectActivity({
      projectId: 1,
      runs: [],
      sessions: [],
      activeDynamicWorkflows: [{ sessionId: 's-other', projectId: 2 }],
    });
    expect(out).toEqual({ running: 0, blocked: 0 });
  });

  it('a blocked session still counts as blocked while a dynamic workflow stands in for it (both surface on Landing)', () => {
    const out = deriveCollapsedProjectActivity({
      projectId: 1,
      runs: [],
      sessions: [{ id: 's1', status: 'waiting' }],
      activeDynamicWorkflows: [{ sessionId: 's1', projectId: 1 }],
    });
    expect(out).toEqual({ running: 1, blocked: 1 });
  });
});
