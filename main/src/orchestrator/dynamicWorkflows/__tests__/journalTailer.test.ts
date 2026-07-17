/**
 * Unit tests for JournalTailer — incremental journal.jsonl tailing, terminal
 * record handling, and stall detection. Uses fake timers (mirroring
 * stuckDetector.test.ts) over a real tmp directory; all file IO inside ticks
 * is synchronous, so advancing timers drives the polls deterministically.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JournalTailer, readCompletionRecord } from '../journalTailer';
import type { DynamicWorkflowAgent } from '../../../../../shared/types/dynamicWorkflows';

const POLL_MS = 50;

describe('JournalTailer', () => {
  let dir: string;
  let journalPath: string;
  let recordPath: string;
  let tailer: JournalTailer | null;

  beforeEach(() => {
    vi.useFakeTimers();
    dir = mkdtempSync(join(tmpdir(), 'cyboflow-journal-'));
    journalPath = join(dir, 'journal.jsonl');
    recordPath = join(dir, 'wf_test.json');
    tailer = null;
  });

  afterEach(() => {
    tailer?.stop();
    vi.useRealTimers();
    rmSync(dir, { recursive: true, force: true });
  });

  function buildTailer(overrides?: { idleTimeoutMs?: number }) {
    const onAgents = vi.fn<(agents: DynamicWorkflowAgent[]) => void>();
    const onComplete = vi.fn();
    const onStalled = vi.fn();
    tailer = new JournalTailer({
      journalPath,
      recordPath,
      pollMs: POLL_MS,
      idleTimeoutMs: overrides?.idleTimeoutMs,
      onAgents,
      onComplete,
      onStalled,
    });
    return { onAgents, onComplete, onStalled };
  }

  it('tolerates a missing journal, then reports agents in first-seen order', async () => {
    const { onAgents, onComplete } = buildTailer();
    tailer!.start();

    // Journal does not exist yet — no callbacks, no errors.
    await vi.advanceTimersByTimeAsync(POLL_MS * 2);
    expect(onAgents).not.toHaveBeenCalled();

    writeFileSync(
      journalPath,
      '{"type":"started","agentId":"a1"}\n{"type":"started","agentId":"a2"}\n',
    );
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(onAgents).toHaveBeenCalledTimes(1);
    expect(onAgents).toHaveBeenLastCalledWith([
      { agentId: 'a1', status: 'running' },
      { agentId: 'a2', status: 'running' },
    ]);

    appendFileSync(journalPath, '{"type":"result","agentId":"a1"}\n');
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(onAgents).toHaveBeenLastCalledWith([
      { agentId: 'a1', status: 'done' },
      { agentId: 'a2', status: 'running' },
    ]);
    expect(onComplete).not.toHaveBeenCalled();
  });

  it('buffers a partial trailing line until its newline arrives', async () => {
    const { onAgents } = buildTailer();
    tailer!.start();

    // Second line is incomplete — only a1 should surface.
    writeFileSync(journalPath, '{"type":"started","agentId":"a1"}\n{"type":"result","agentId":"a1"');
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(onAgents).toHaveBeenCalledTimes(1);
    expect(onAgents).toHaveBeenLastCalledWith([{ agentId: 'a1', status: 'running' }]);

    appendFileSync(journalPath, '}\n');
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(onAgents).toHaveBeenLastCalledWith([{ agentId: 'a1', status: 'done' }]);
  });

  it('does not re-emit when no new journal lines arrive', async () => {
    const { onAgents } = buildTailer();
    tailer!.start();
    writeFileSync(journalPath, '{"type":"started","agentId":"a1"}\n');
    await vi.advanceTimersByTimeAsync(POLL_MS * 3);
    expect(onAgents).toHaveBeenCalledTimes(1);
  });

  it('invokes onComplete from the terminal record (totals mapped) and stops', async () => {
    const { onAgents, onComplete } = buildTailer();
    tailer!.start();

    writeFileSync(
      recordPath,
      JSON.stringify({
        status: 'completed',
        summary: 'All tasks shipped',
        agentCount: 2,
        totalTokens: 1234,
        totalToolCalls: 56,
        durationMs: 7890,
      }),
    );
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(onComplete).toHaveBeenCalledWith({
      status: 'completed',
      summary: 'All tasks shipped',
      totals: { agentCount: 2, totalTokens: 1234, totalToolCalls: 56, durationMs: 7890 },
    });

    // Stopped: later journal appends are ignored.
    writeFileSync(journalPath, '{"type":"started","agentId":"late"}\n');
    await vi.advanceTimersByTimeAsync(POLL_MS * 3);
    expect(onAgents).not.toHaveBeenCalled();
  });

  it('maps a failed record status to onComplete failed', async () => {
    const { onComplete } = buildTailer();
    tailer!.start();
    writeFileSync(recordPath, JSON.stringify({ status: 'failed' }));
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(onComplete).toHaveBeenCalledWith({ status: 'failed', summary: undefined, totals: {} });
  });

  it('fail-soft on a mid-write (unparseable) record: retries until it parses', async () => {
    const { onComplete } = buildTailer();
    tailer!.start();
    writeFileSync(recordPath, '{"status":'); // mid-write
    await vi.advanceTimersByTimeAsync(POLL_MS * 2);
    expect(onComplete).not.toHaveBeenCalled();

    writeFileSync(recordPath, JSON.stringify({ status: 'completed' }));
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it('calls onStalled (and stops) after idleTimeoutMs with no file activity', async () => {
    const { onStalled, onComplete } = buildTailer({ idleTimeoutMs: 500 });
    tailer!.start();
    await vi.advanceTimersByTimeAsync(600);
    expect(onStalled).toHaveBeenCalledTimes(1);
    expect(onComplete).not.toHaveBeenCalled();
    // Stopped — no second stall fires.
    await vi.advanceTimersByTimeAsync(1000);
    expect(onStalled).toHaveBeenCalledTimes(1);
  });

  it('journal activity resets the idle clock', async () => {
    const { onStalled } = buildTailer({ idleTimeoutMs: 500 });
    tailer!.start();
    await vi.advanceTimersByTimeAsync(300);
    writeFileSync(journalPath, '{"type":"started","agentId":"a1"}\n');
    await vi.advanceTimersByTimeAsync(400); // 700ms total, but only 400ms since activity
    expect(onStalled).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(200); // now >=500ms idle
    expect(onStalled).toHaveBeenCalledTimes(1);
  });

  // ---------------------------------------------------------------------------
  // agent transcript stats (agent-<agentId>.jsonl in the journal's directory)
  // ---------------------------------------------------------------------------

  function transcriptLine(entry: Record<string, unknown>): string {
    return `${JSON.stringify(entry)}\n`;
  }

  it('accumulates transcript stats across polls (offset respected) and merges them into onAgents', async () => {
    const { onAgents } = buildTailer();
    tailer!.start();
    const transcriptPath = join(dir, 'agent-a1.jsonl');
    writeFileSync(journalPath, '{"type":"started","agentId":"a1"}\n');
    writeFileSync(
      transcriptPath,
      transcriptLine({
        type: 'user',
        message: { role: 'user', content: 'Refactor the API layer' },
        timestamp: '2026-06-11T10:00:00.000Z',
      }) +
        transcriptLine({
          type: 'assistant',
          message: {
            role: 'assistant',
            model: 'claude-fable-5',
            usage: {
              input_tokens: 3,
              output_tokens: 10,
              cache_read_input_tokens: 4,
              cache_creation_input_tokens: 5,
            },
            content: [
              { type: 'tool_use', id: 't1', name: 'Read', input: {} },
              { type: 'text', text: 'hi' },
            ],
          },
          timestamp: '2026-06-11T10:00:05.000Z',
        }),
    );
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(onAgents).toHaveBeenCalledTimes(1);
    expect(onAgents).toHaveBeenLastCalledWith([
      {
        agentId: 'a1',
        status: 'running',
        model: 'claude-fable-5',
        inputTokens: 3,
        outputTokens: 10,
        cacheReadInputTokens: 4,
        cacheCreationInputTokens: 5,
        toolUses: 1,
        startedAt: '2026-06-11T10:00:00.000Z',
        lastActivityAt: '2026-06-11T10:00:05.000Z',
        promptExcerpt: 'Refactor the API layer',
      },
    ]);

    // Append: ONLY the new bytes are parsed — a full re-parse would double-count
    // the first assistant line (27 tokens instead of 17).
    appendFileSync(
      transcriptPath,
      transcriptLine({
        type: 'assistant',
        message: {
          role: 'assistant',
          model: 'claude-other-model',
          usage: {
            input_tokens: 11,
            output_tokens: 7,
            cache_read_input_tokens: 13,
            cache_creation_input_tokens: 17,
          },
          content: [
            { type: 'tool_use', id: 't2', name: 'Edit', input: {} },
            { type: 'tool_use', id: 't3', name: 'Bash', input: {} },
          ],
        },
        timestamp: '2026-06-11T10:00:09.000Z',
      }),
    );
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(onAgents).toHaveBeenCalledTimes(2); // a stats-only change still emits
    expect(onAgents).toHaveBeenLastCalledWith([
      {
        agentId: 'a1',
        status: 'running',
        model: 'claude-fable-5', // first assistant model wins
        inputTokens: 14,
        outputTokens: 17,
        cacheReadInputTokens: 17,
        cacheCreationInputTokens: 22,
        toolUses: 3,
        startedAt: '2026-06-11T10:00:00.000Z',
        lastActivityAt: '2026-06-11T10:00:09.000Z',
        promptExcerpt: 'Refactor the API layer',
      },
    ]);

    tailer!.drainToEof();
    expect(onAgents).toHaveBeenCalledTimes(2); // unchanged EOF is not re-read or re-emitted
  });

  it('drains every tracked transcript synchronously to EOF before the next poll', async () => {
    const { onAgents } = buildTailer();
    tailer!.start();
    writeFileSync(
      journalPath,
      '{"type":"started","agentId":"a1"}\n{"type":"started","agentId":"a2"}\n',
    );
    await vi.advanceTimersByTimeAsync(POLL_MS);

    writeFileSync(
      join(dir, 'agent-a1.jsonl'),
      transcriptLine({
        type: 'assistant',
        message: {
          model: 'claude-a',
          usage: { input_tokens: 2, output_tokens: 3, cache_read_input_tokens: 5 },
          content: [],
        },
        timestamp: '2026-06-11T14:00:00.000Z',
      }) +
        transcriptLine({
          type: 'assistant',
          message: {
            model: 'claude-a',
            usage: { input_tokens: 7, output_tokens: 11, cache_creation_input_tokens: 13 },
            content: [],
          },
          timestamp: '2026-06-11T14:00:01.000Z',
        }),
    );
    writeFileSync(
      join(dir, 'agent-a2.jsonl'),
      transcriptLine({
        type: 'assistant',
        message: {
          model: 'claude-b',
          usage: {
            input_tokens: 17,
            output_tokens: 19,
            cache_read_input_tokens: 23,
            cache_creation_input_tokens: 29,
          },
          content: [],
        },
        timestamp: '2026-06-11T14:00:02.000Z',
      }),
    );

    tailer!.drainToEof();

    expect(onAgents).toHaveBeenCalledTimes(2);
    expect(onAgents).toHaveBeenLastCalledWith([
      {
        agentId: 'a1',
        status: 'running',
        model: 'claude-a',
        inputTokens: 9,
        outputTokens: 14,
        cacheReadInputTokens: 5,
        cacheCreationInputTokens: 13,
        startedAt: '2026-06-11T14:00:00.000Z',
        lastActivityAt: '2026-06-11T14:00:01.000Z',
      },
      {
        agentId: 'a2',
        status: 'running',
        model: 'claude-b',
        inputTokens: 17,
        outputTokens: 19,
        cacheReadInputTokens: 23,
        cacheCreationInputTokens: 29,
        startedAt: '2026-06-11T14:00:02.000Z',
        lastActivityAt: '2026-06-11T14:00:02.000Z',
      },
    ]);
  });

  it('skips malformed transcript lines during a synchronous drain without throwing', async () => {
    const warn = vi.fn();
    const onAgents = vi.fn<(agents: DynamicWorkflowAgent[]) => void>();
    tailer = new JournalTailer({
      journalPath,
      recordPath,
      pollMs: POLL_MS,
      onAgents,
      onComplete: vi.fn(),
      onStalled: vi.fn(),
      logger: { warn },
    });
    tailer.start();
    writeFileSync(journalPath, '{"type":"started","agentId":"a1"}\n');
    await vi.advanceTimersByTimeAsync(POLL_MS);
    writeFileSync(
      join(dir, 'agent-a1.jsonl'),
      '{"type":"assistant","message":\n' +
        transcriptLine({
          type: 'assistant',
          message: { usage: { input_tokens: 31, output_tokens: 37 }, content: [] },
          timestamp: '2026-06-11T15:00:00.000Z',
        }),
    );

    expect(() => tailer!.drainToEof()).not.toThrow();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('unparseable transcript line skipped'));
    expect(onAgents).toHaveBeenLastCalledWith([
      {
        agentId: 'a1',
        status: 'running',
        inputTokens: 31,
        outputTokens: 37,
        startedAt: '2026-06-11T15:00:00.000Z',
        lastActivityAt: '2026-06-11T15:00:00.000Z',
      },
    ]);
  });

  it('carries a torn transcript line over to the next poll', async () => {
    const { onAgents } = buildTailer();
    tailer!.start();
    const transcriptPath = join(dir, 'agent-a1.jsonl');
    writeFileSync(journalPath, '{"type":"started","agentId":"a1"}\n');
    const full = transcriptLine({
      type: 'assistant',
      message: { role: 'assistant', model: 'claude-fable-5', usage: { output_tokens: 5 }, content: [] },
      timestamp: '2026-06-11T11:00:00.000Z',
    });
    writeFileSync(transcriptPath, full.slice(0, 25)); // torn mid-JSON, no newline yet
    await vi.advanceTimersByTimeAsync(POLL_MS);
    // The journal change emits, but the torn line contributes no stats (and no warn-skip).
    expect(onAgents).toHaveBeenCalledTimes(1);
    expect(onAgents).toHaveBeenLastCalledWith([{ agentId: 'a1', status: 'running' }]);

    appendFileSync(transcriptPath, full.slice(25));
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(onAgents).toHaveBeenLastCalledWith([
      {
        agentId: 'a1',
        status: 'running',
        model: 'claude-fable-5',
        outputTokens: 5,
        startedAt: '2026-06-11T11:00:00.000Z',
        lastActivityAt: '2026-06-11T11:00:00.000Z',
      },
    ]);
  });

  it('tolerates a missing agent transcript, then picks it up when it appears', async () => {
    const { onAgents } = buildTailer();
    tailer!.start();
    writeFileSync(journalPath, '{"type":"started","agentId":"a1"}\n');
    await vi.advanceTimersByTimeAsync(POLL_MS * 3); // transcript absent — no errors, no re-emits
    expect(onAgents).toHaveBeenCalledTimes(1);
    expect(onAgents).toHaveBeenLastCalledWith([{ agentId: 'a1', status: 'running' }]);

    writeFileSync(
      join(dir, 'agent-a1.jsonl'),
      transcriptLine({ type: 'user', message: { role: 'user', content: 'Go' }, timestamp: '2026-06-11T12:00:00.000Z' }),
    );
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(onAgents).toHaveBeenLastCalledWith([
      {
        agentId: 'a1',
        status: 'running',
        startedAt: '2026-06-11T12:00:00.000Z',
        lastActivityAt: '2026-06-11T12:00:00.000Z',
        promptExcerpt: 'Go',
      },
    ]);
  });

  it('extracts promptExcerpt from array content (first text part), truncated to the excerpt cap', async () => {
    const { onAgents } = buildTailer();
    tailer!.start();
    writeFileSync(journalPath, '{"type":"started","agentId":"a1"}\n');
    const longPrompt = 'p'.repeat(700);
    writeFileSync(
      join(dir, 'agent-a1.jsonl'),
      transcriptLine({
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text: longPrompt }] },
        timestamp: '2026-06-11T13:00:00.000Z',
      }) +
        transcriptLine({
          // A LATER user line (tool result) must NOT overwrite the prompt.
          type: 'user',
          message: { role: 'user', content: [{ type: 'text', text: 'NOT THE PROMPT' }] },
          timestamp: '2026-06-11T13:00:01.000Z',
        }),
    );
    await vi.advanceTimersByTimeAsync(POLL_MS);
    const agents = onAgents.mock.calls.at(-1)?.[0];
    expect(agents?.[0]?.promptExcerpt).toBe('p'.repeat(600));
    expect(agents?.[0]?.lastActivityAt).toBe('2026-06-11T13:00:01.000Z');
  });

  it('stop() is idempotent and start() after stop() is a fresh poll loop', async () => {
    const { onAgents } = buildTailer();
    tailer!.start();
    tailer!.stop();
    tailer!.stop(); // no throw
    writeFileSync(journalPath, '{"type":"started","agentId":"a1"}\n');
    await vi.advanceTimersByTimeAsync(POLL_MS * 2);
    expect(onAgents).not.toHaveBeenCalled();

    tailer!.start();
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(onAgents).toHaveBeenCalledTimes(1);
  });
});

describe('readCompletionRecord', () => {
  it('returns null for a missing file', () => {
    expect(readCompletionRecord(join(tmpdir(), 'definitely-missing', 'wf_x.json'))).toBeNull();
  });

  it('returns null (and warns) for malformed JSON', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cyboflow-record-'));
    try {
      const p = join(dir, 'wf_x.json');
      writeFileSync(p, 'not json');
      const warn = vi.fn();
      expect(readCompletionRecord(p, { warn })).toBeNull();
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
