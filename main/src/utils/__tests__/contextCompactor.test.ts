/**
 * Behavioral tests for ProgrammaticCompactor (main/src/utils/contextCompactor.ts).
 *
 * NOTE (spec deviation): the B8 plan describes contextCompactor as a
 * "preserve most-recent N turns / token-estimate threshold" transcript
 * truncator. The actual module is a deterministic SESSION-SUMMARY generator
 * (prompt outcomes, file-modification rollup, todo status, git status,
 * interruption detection). These tests pin that real behavior — the highest-
 * value being: malformed JSON entries never throw, an empty transcript yields a
 * well-formed minimal summary, and Write→Created / Edit→Modified classification.
 *
 * generateSummary() never touches `this.db`, so a trivial stub is passed.
 */
import { describe, it, expect } from 'vitest';
import { ProgrammaticCompactor } from '../contextCompactor';
import type { DatabaseService } from '../../database/database';
import type { Session, PromptMarker, ExecutionDiff } from '../../database/models';
import type { SessionOutput } from '../../types/session';

const dbStub = {} as unknown as DatabaseService;

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 's1',
    name: 'Test',
    initial_prompt: 'do it',
    worktree_name: 'wt',
    worktree_path: '/tmp/wt',
    status: 'stopped',
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    project_id: 1,
    ...overrides,
  } as unknown as Session;
}

/** A single assistant tool_use SessionOutput (already-parsed json). */
function toolUse(name: string, input: Record<string, unknown>): SessionOutput {
  return {
    sessionId: 's1',
    type: 'json',
    timestamp: new Date(),
    data: {
      type: 'assistant',
      message: { content: [{ type: 'tool_use', name, input }] },
    },
  };
}

function assistantText(text: string): SessionOutput {
  return {
    sessionId: 's1',
    type: 'json',
    timestamp: new Date(),
    data: {
      type: 'assistant',
      message: { content: [{ type: 'text', text }] },
    },
  };
}

async function summarize(
  outputs: SessionOutput[],
  prompts: PromptMarker[] = [],
  diffs: ExecutionDiff[] = [],
  session: Session = makeSession(),
): Promise<string> {
  const compactor = new ProgrammaticCompactor(dbStub);
  return compactor.generateSummary('s1', {
    session,
    conversationMessages: [],
    promptMarkers: prompts,
    executionDiffs: diffs,
    sessionOutputs: outputs,
  });
}

describe('ProgrammaticCompactor.generateSummary', () => {
  it('produces a well-formed minimal summary for an empty transcript', async () => {
    const summary = await summarize([]);
    expect(summary.startsWith('<session_context>')).toBe(true);
    expect(summary.endsWith('</session_context>')).toBe(true);
    // Git status always renders; with no diffs everything is zero.
    expect(summary).toContain('**Files Changed**: 0');
    expect(summary).toContain('**Additions**: +0');
    expect(summary).toContain('**Deletions**: -0');
  });

  it('does not throw on malformed / non-assistant json entries', async () => {
    const malformed: SessionOutput[] = [
      { sessionId: 's1', type: 'json', timestamp: new Date(), data: null },
      { sessionId: 's1', type: 'json', timestamp: new Date(), data: 'not-an-object' },
      { sessionId: 's1', type: 'json', timestamp: new Date(), data: { type: 'user' } },
      { sessionId: 's1', type: 'stdout', timestamp: new Date(), data: 'plain text' },
    ];
    await expect(summarize(malformed)).resolves.toContain('<session_context>');
  });

  it('classifies Write as Created and Edit as Modified, sorted by change count', async () => {
    const outputs: SessionOutput[] = [
      toolUse('Write', { file_path: '/a.ts' }),
      toolUse('Edit', { file_path: '/b.ts' }),
      toolUse('Edit', { file_path: '/b.ts' }),
    ];
    const summary = await summarize(outputs);
    expect(summary).toContain('### Files Modified (2 total)');
    // /b.ts has 2 edits → sorts first, rendered "Modified (2 changes)".
    expect(summary).toContain('`/b.ts` - Modified (2 changes)');
    expect(summary).toContain('`/a.ts` - Created (1 changes)');
    const bIdx = summary.indexOf('/b.ts');
    const aIdx = summary.indexOf('/a.ts');
    expect(bIdx).toBeLessThan(aIdx);
  });

  it('counts MultiEdit sub-edits toward the change count', async () => {
    const outputs: SessionOutput[] = [
      toolUse('MultiEdit', { file_path: '/m.ts', edits: [{}, {}, {}] }),
    ];
    const summary = await summarize(outputs);
    // 1 base + (3 - 1) extra edits = 3 changes.
    expect(summary).toContain('`/m.ts` - Modified (3 changes)');
  });

  it('reflects only the latest TodoWrite state, bucketed by status', async () => {
    const outputs: SessionOutput[] = [
      toolUse('TodoWrite', { todos: [{ id: '1', content: 'old', status: 'pending' }] }),
      toolUse('TodoWrite', {
        todos: [
          { id: '1', content: 'ship it', status: 'in_progress' },
          { id: '2', content: 'write tests', status: 'pending' },
          { id: '3', content: 'design', status: 'completed' },
        ],
      }),
    ];
    const summary = await summarize(outputs);
    expect(summary).toContain('**Completed**: 1');
    expect(summary).toContain('**In Progress**: 1');
    expect(summary).toContain('**Pending**: 1');
    expect(summary).toContain('- ship it');
    expect(summary).toContain('- write tests');
    // The superseded 'old' todo must not survive.
    expect(summary).not.toContain('old');
  });

  it('summarizes each prompt with its final assistant message and completion status', async () => {
    const prompts: PromptMarker[] = [
      {
        id: 1,
        session_id: 's1',
        prompt_text: 'first task',
        output_index: 0,
        timestamp: '2026-01-01T00:00:00Z',
        completion_timestamp: '2026-01-01T00:01:00Z',
      },
    ];
    const outputs: SessionOutput[] = [assistantText('all done')];
    const summary = await summarize(outputs, prompts);
    expect(summary).toContain('Call #1:');
    expect(summary).toContain('User Prompt: first task');
    expect(summary).toContain('Final Assistant Message: all done');
    expect(summary).toContain('Status: Completed');
  });

  it('flags the final incomplete prompt as Interrupted when the session is no longer running', async () => {
    const prompts: PromptMarker[] = [
      {
        id: 1,
        session_id: 's1',
        prompt_text: 'unfinished',
        output_index: 0,
        timestamp: '2026-01-01T00:00:00Z',
        // no completion_timestamp → ongoing
      },
    ];
    const summary = await summarize([], prompts, [], makeSession({ status: 'stopped' }));
    expect(summary).toContain('Status: Interrupted');
    expect(summary).toContain('Session Interrupted');
  });

  it('does not flag interruption for an ongoing prompt while the session is still running', async () => {
    const prompts: PromptMarker[] = [
      {
        id: 1,
        session_id: 's1',
        prompt_text: 'in flight',
        output_index: 0,
        timestamp: '2026-01-01T00:00:00Z',
      },
    ];
    const summary = await summarize([], prompts, [], makeSession({ status: 'running' }));
    expect(summary).not.toContain('Session Interrupted');
    expect(summary).toContain('Status: In Progress');
  });

  it('reports git status from the latest execution diff', async () => {
    const diffs: ExecutionDiff[] = [
      {
        id: 1,
        session_id: 's1',
        execution_sequence: 1,
        stats_additions: 3,
        stats_deletions: 1,
        stats_files_changed: 2,
        timestamp: '2026-01-01T00:00:00Z',
      },
      {
        id: 2,
        session_id: 's1',
        execution_sequence: 2,
        git_diff: 'diff --git a b',
        stats_additions: 10,
        stats_deletions: 4,
        stats_files_changed: 5,
        timestamp: '2026-01-01T00:02:00Z',
      },
    ];
    const summary = await summarize([], [], diffs);
    // Latest diff wins.
    expect(summary).toContain('**Files Changed**: 5');
    expect(summary).toContain('**Additions**: +10');
    expect(summary).toContain('**Deletions**: -4');
    expect(summary).toContain('**Uncommitted Changes**: Yes');
  });
});
