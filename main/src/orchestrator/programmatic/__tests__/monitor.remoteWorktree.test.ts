/**
 * A REMOTE run's monitor (MonitorContext.remoteWorktree, spec M2 §5 D3): its SDK queries carry NO cwd (the
 * worktree path names a directory on the environment, not this Mac — monitorQuery then uses a local temp dir)
 * and the prompt says the files cannot be read. A This-Mac run is unchanged: cwd = the worktree, no note.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  DefaultMonitorSession,
  REMOTE_WORKTREE_PROMPT_NOTE,
  type HistoryReader,
  type MonitorContext,
  type MonitorHistory,
} from '../monitor';
import type { StructuredQueryFn, TextQueryFn } from '../monitorQuery';
import type { WorkflowStep } from '../../../../../shared/types/workflows';

const local: MonitorContext = { runId: 'run-1', projectId: 1, workflowName: 'sprint', worktreePath: '/wt' };
const remote: MonitorContext = { ...local, worktreePath: '/home/k/cf-remote/h1/wt/s1', remoteWorktree: true };

const history: HistoryReader = {
  read: async (): Promise<MonitorHistory> => ({ conversation: [], steps: [] }),
};
const failed: WorkflowStep = { id: 'a', name: 'A', agent: 'executor', mcps: [], retries: 0 } as WorkflowStep;

function session(ctx: MonitorContext): {
  s: DefaultMonitorSession;
  structuredQuery: ReturnType<typeof vi.fn>;
  textQuery: ReturnType<typeof vi.fn>;
} {
  const structuredQuery = vi.fn().mockResolvedValue({ decision: 'fail', rationale: 'r' });
  const textQuery = vi.fn().mockResolvedValue('answer');
  const s = new DefaultMonitorSession({
    ctx,
    history,
    structuredQuery: structuredQuery as unknown as StructuredQueryFn,
    textQuery: textQuery as unknown as TextQueryFn,
  });
  return { s, structuredQuery, textQuery };
}

describe('DefaultMonitorSession — remote worktree', () => {
  it('a remote run triages without a cwd and says the worktree cannot be read', async () => {
    const { s, structuredQuery } = session(remote);
    await s.triage(failed, 'boom');
    const args = structuredQuery.mock.calls[0][0] as { prompt: string; cwd?: string };
    expect('cwd' in args).toBe(false);
    expect(args.prompt.endsWith(REMOTE_WORKTREE_PROMPT_NOTE)).toBe(true);
  });

  it('a remote run answers without a cwd and with the note', async () => {
    const { s, textQuery } = session(remote);
    await s.answer('what broke?');
    const args = textQuery.mock.calls[0][0] as { prompt: string; cwd?: string };
    expect('cwd' in args).toBe(false);
    expect(args.prompt).toContain(REMOTE_WORKTREE_PROMPT_NOTE);
  });

  it('a This-Mac run keeps the worktree cwd and no note', async () => {
    const { s, structuredQuery, textQuery } = session(local);
    await s.triage(failed, 'boom');
    await s.answer('what broke?');
    const t = structuredQuery.mock.calls[0][0] as { prompt: string; cwd?: string };
    const a = textQuery.mock.calls[0][0] as { prompt: string; cwd?: string };
    expect(t.cwd).toBe('/wt');
    expect(a.cwd).toBe('/wt');
    expect(t.prompt).not.toContain(REMOTE_WORKTREE_PROMPT_NOTE);
    expect(a.prompt).not.toContain(REMOTE_WORKTREE_PROMPT_NOTE);
  });
});
