/**
 * Unit tests for JournalTailer — incremental journal.jsonl tailing, terminal
 * record handling, and stall detection. Uses fake timers (mirroring
 * stuckDetector.test.ts) over a real tmp directory.
 *
 * The tailer's ticks/drains run async fs/promises IO through a serialized queue,
 * and fake timers do NOT advance the libuv poll phase — so after firing the fake
 * interval we must turn the real event loop to let that IO settle. `advance()`
 * bundles the fake-timer advance with a bounded real-fs `flushIo()`; direct
 * `await tailer.drainToEof()` naturally awaits its own queued IO.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { stat } from 'node:fs/promises';
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

  /** Turn the real event loop so queued async-IO tasks settle under fake timers. */
  async function flushIo(): Promise<void> {
    for (let i = 0; i < 40; i++) await stat(dir);
  }

  /** Advance the fake interval, then drain the real fs IO the ticks kicked off. */
  async function advance(ms: number): Promise<void> {
    await vi.advanceTimersByTimeAsync(ms);
    await flushIo();
  }

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
    await advance(POLL_MS * 2);
    expect(onAgents).not.toHaveBeenCalled();

    writeFileSync(
      journalPath,
      '{"type":"started","agentId":"a1"}\n{"type":"started","agentId":"a2"}\n',
    );
    await advance(POLL_MS);
    expect(onAgents).toHaveBeenCalledTimes(1);
    expect(onAgents).toHaveBeenLastCalledWith([
      { agentId: 'a1', status: 'running' },
      { agentId: 'a2', status: 'running' },
    ]);

    appendFileSync(journalPath, '{"type":"result","agentId":"a1"}\n');
    await advance(POLL_MS);
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
    await advance(POLL_MS);
    expect(onAgents).toHaveBeenCalledTimes(1);
    expect(onAgents).toHaveBeenLastCalledWith([{ agentId: 'a1', status: 'running' }]);

    appendFileSync(journalPath, '}\n');
    await advance(POLL_MS);
    expect(onAgents).toHaveBeenLastCalledWith([{ agentId: 'a1', status: 'done' }]);
  });

  it('does not re-emit when no new journal lines arrive', async () => {
    const { onAgents } = buildTailer();
    tailer!.start();
    writeFileSync(journalPath, '{"type":"started","agentId":"a1"}\n');
    await advance(POLL_MS * 3);
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
    await advance(POLL_MS);
    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(onComplete).toHaveBeenCalledWith({
      status: 'completed',
      summary: 'All tasks shipped',
      totals: { agentCount: 2, totalTokens: 1234, totalToolCalls: 56, durationMs: 7890 },
    });

    // Stopped: later journal appends are ignored.
    writeFileSync(journalPath, '{"type":"started","agentId":"late"}\n');
    await advance(POLL_MS * 3);
    expect(onAgents).not.toHaveBeenCalled();
  });

  it('maps a failed record status to onComplete failed', async () => {
    const { onComplete } = buildTailer();
    tailer!.start();
    writeFileSync(recordPath, JSON.stringify({ status: 'failed' }));
    await advance(POLL_MS);
    expect(onComplete).toHaveBeenCalledWith({ status: 'failed', summary: undefined, totals: {} });
  });

  it('fail-soft on a mid-write (unparseable) record: retries until it parses', async () => {
    const { onComplete } = buildTailer();
    tailer!.start();
    writeFileSync(recordPath, '{"status":'); // mid-write
    await advance(POLL_MS * 2);
    expect(onComplete).not.toHaveBeenCalled();

    writeFileSync(recordPath, JSON.stringify({ status: 'completed' }));
    await advance(POLL_MS);
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it('calls onStalled (and stops) after idleTimeoutMs with no file activity', async () => {
    const { onStalled, onComplete } = buildTailer({ idleTimeoutMs: 500 });
    tailer!.start();
    await advance(600);
    expect(onStalled).toHaveBeenCalledTimes(1);
    expect(onComplete).not.toHaveBeenCalled();
    // Stopped — no second stall fires.
    await advance(1000);
    expect(onStalled).toHaveBeenCalledTimes(1);
  });

  it('journal activity resets the idle clock', async () => {
    const { onStalled } = buildTailer({ idleTimeoutMs: 500 });
    tailer!.start();
    await advance(300);
    writeFileSync(journalPath, '{"type":"started","agentId":"a1"}\n');
    await advance(400); // 700ms total, but only 400ms since activity
    expect(onStalled).not.toHaveBeenCalled();
    await advance(200); // now >=500ms idle
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
    await advance(POLL_MS);
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
    await advance(POLL_MS);
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

    await tailer!.drainToEof();
    expect(onAgents).toHaveBeenCalledTimes(2); // unchanged EOF is not re-read or re-emitted
  });

  it('drains every tracked transcript to EOF before the next poll', async () => {
    const { onAgents } = buildTailer();
    tailer!.start();
    writeFileSync(
      journalPath,
      '{"type":"started","agentId":"a1"}\n{"type":"started","agentId":"a2"}\n',
    );
    await advance(POLL_MS);

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

    await tailer!.drainToEof();

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

  it('skips malformed transcript lines during a drain without throwing', async () => {
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
    await advance(POLL_MS);
    writeFileSync(
      join(dir, 'agent-a1.jsonl'),
      '{"type":"assistant","message":\n' +
        transcriptLine({
          type: 'assistant',
          message: { usage: { input_tokens: 31, output_tokens: 37 }, content: [] },
          timestamp: '2026-06-11T15:00:00.000Z',
        }),
    );

    await expect(tailer!.drainToEof()).resolves.toBeUndefined();
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

  it('buffers a partial transcript line across drains until it reaches EOF complete', async () => {
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
    await advance(POLL_MS);

    const transcriptPath = join(dir, 'agent-a1.jsonl');
    const line = transcriptLine({
      type: 'assistant',
      message: {
        model: 'claude-fable-5',
        usage: {
          input_tokens: 41,
          output_tokens: 43,
          cache_read_input_tokens: 47,
          cache_creation_input_tokens: 53,
        },
        content: [],
      },
      timestamp: '2026-06-11T15:30:00.000Z',
    });
    writeFileSync(transcriptPath, line.slice(0, -2));

    await expect(tailer!.drainToEof()).resolves.toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
    expect(onAgents).toHaveBeenCalledTimes(1);

    appendFileSync(transcriptPath, line.slice(-2));
    await tailer.drainToEof();

    expect(onAgents).toHaveBeenCalledTimes(2);
    expect(onAgents).toHaveBeenLastCalledWith([
      {
        agentId: 'a1',
        status: 'running',
        model: 'claude-fable-5',
        inputTokens: 41,
        outputTokens: 43,
        cacheReadInputTokens: 47,
        cacheCreationInputTokens: 53,
        startedAt: '2026-06-11T15:30:00.000Z',
        lastActivityAt: '2026-06-11T15:30:00.000Z',
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
    await advance(POLL_MS);
    // The journal change emits, but the torn line contributes no stats (and no warn-skip).
    expect(onAgents).toHaveBeenCalledTimes(1);
    expect(onAgents).toHaveBeenLastCalledWith([{ agentId: 'a1', status: 'running' }]);

    appendFileSync(transcriptPath, full.slice(25));
    await advance(POLL_MS);
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
    await advance(POLL_MS * 3); // transcript absent — no errors, no re-emits
    expect(onAgents).toHaveBeenCalledTimes(1);
    expect(onAgents).toHaveBeenLastCalledWith([{ agentId: 'a1', status: 'running' }]);

    writeFileSync(
      join(dir, 'agent-a1.jsonl'),
      transcriptLine({ type: 'user', message: { role: 'user', content: 'Go' }, timestamp: '2026-06-11T12:00:00.000Z' }),
    );
    await advance(POLL_MS);
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
    await advance(POLL_MS);
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
    await advance(POLL_MS * 2);
    expect(onAgents).not.toHaveBeenCalled();

    tailer!.start();
    await advance(POLL_MS);
    expect(onAgents).toHaveBeenCalledTimes(1);
  });

  // ---------------------------------------------------------------------------
  // Serialization: the periodic tick, drainToEof, and stop's buffer release all
  // run through one queue, so none can interleave another mid-read (F22).
  // ---------------------------------------------------------------------------

  it('a drain queued behind an in-flight tick reads each transcript slice once (no double-count)', async () => {
    const { onAgents } = buildTailer();
    tailer!.start();
    writeFileSync(journalPath, '{"type":"started","agentId":"a1"}\n');
    await advance(POLL_MS);

    writeFileSync(
      join(dir, 'agent-a1.jsonl'),
      transcriptLine({
        type: 'assistant',
        message: { model: 'm', usage: { input_tokens: 10, output_tokens: 20 }, content: [] },
        timestamp: '2026-06-11T20:00:00.000Z',
      }),
    );
    // Fire the periodic tick (its transcript read is now in-flight under fake
    // timers) and queue a drain behind it WITHOUT flushing in between. If the two
    // could interleave from offset 0 the usage would double to 20/40.
    await vi.advanceTimersByTimeAsync(POLL_MS);
    await tailer!.drainToEof(); // serialized behind the tick; awaiting settles both

    const agents = onAgents.mock.calls.at(-1)?.[0];
    expect(agents?.[0]).toMatchObject({ agentId: 'a1', inputTokens: 10, outputTokens: 20 });
  });

  it('stop() during an in-flight tick does not corrupt the read (buffer release is serialized)', async () => {
    const { onAgents } = buildTailer();
    tailer!.start();
    writeFileSync(
      journalPath,
      '{"type":"started","agentId":"a1"}\n{"type":"started","agentId":"a2"}\n',
    );
    // Tick enqueued with its journal read in-flight; stop() lands mid-flight.
    await vi.advanceTimersByTimeAsync(POLL_MS);
    tailer!.stop(); // stopped=true + buffer release queued BEHIND the running tick
    await flushIo();

    // The in-flight tick still finished its journal read cleanly — both agents
    // surfaced, no partial-line corruption from a concurrent buffer reset.
    expect(onAgents).toHaveBeenLastCalledWith([
      { agentId: 'a1', status: 'running' },
      { agentId: 'a2', status: 'running' },
    ]);
  });

  it('an append between a tick and a drain is consumed exactly once (offset carried across the queue)', async () => {
    const { onAgents } = buildTailer();
    tailer!.start();
    writeFileSync(journalPath, '{"type":"started","agentId":"a1"}\n');
    writeFileSync(
      join(dir, 'agent-a1.jsonl'),
      transcriptLine({
        type: 'assistant',
        message: { model: 'm', usage: { input_tokens: 10, output_tokens: 20 }, content: [] },
        timestamp: '2026-06-11T21:00:00.000Z',
      }),
    );
    await advance(POLL_MS); // tick consumes line 1 -> 10/20

    appendFileSync(
      join(dir, 'agent-a1.jsonl'),
      transcriptLine({
        type: 'assistant',
        message: { model: 'm', usage: { input_tokens: 3, output_tokens: 4 }, content: [] },
        timestamp: '2026-06-11T21:00:01.000Z',
      }),
    );
    await tailer!.drainToEof(); // reads ONLY the appended line -> cumulative 13/24

    const agents = onAgents.mock.calls.at(-1)?.[0];
    expect(agents?.[0]).toMatchObject({ agentId: 'a1', inputTokens: 13, outputTokens: 24 });
  });

  it('tolerates a mid-sequence journal truncation without crashing or re-reading', async () => {
    const { onAgents } = buildTailer({ idleTimeoutMs: 10 * 60 * 1000 });
    tailer!.start();
    writeFileSync(
      journalPath,
      '{"type":"started","agentId":"a1"}\n{"type":"started","agentId":"a2"}\n',
    );
    await advance(POLL_MS);
    const callsAfterFirst = onAgents.mock.calls.length;
    expect(callsAfterFirst).toBe(1);

    // Rewrite the journal shorter than the bytes already consumed (rotation).
    // size <= offset is treated as no growth: no crash, no spurious re-emit.
    writeFileSync(journalPath, '{"type":"started","agentId":"a1"}\n');
    await advance(POLL_MS);
    expect(onAgents).toHaveBeenCalledTimes(callsAfterFirst);
    expect(onAgents.mock.calls.at(-1)?.[0]).toEqual([
      { agentId: 'a1', status: 'running' },
      { agentId: 'a2', status: 'running' },
    ]);
  });

  it('drainToEof settles its onAgents emission before the awaited promise resolves', async () => {
    const { onAgents } = buildTailer();
    tailer!.start();
    writeFileSync(journalPath, '{"type":"started","agentId":"a1"}\n');
    await advance(POLL_MS);
    writeFileSync(
      join(dir, 'agent-a1.jsonl'),
      transcriptLine({
        type: 'assistant',
        message: { model: 'm', usage: { input_tokens: 5, output_tokens: 7 }, content: [] },
        timestamp: '2026-06-11T22:00:00.000Z',
      }),
    );

    // A finalize reads state.agents right after awaiting the drain — the final
    // usage emission must already have landed by the time the promise resolves.
    let usageAtResolve: DynamicWorkflowAgent | undefined;
    await tailer!.drainToEof().then(() => {
      usageAtResolve = onAgents.mock.calls.at(-1)?.[0]?.[0];
    });
    expect(usageAtResolve).toMatchObject({ agentId: 'a1', inputTokens: 5, outputTokens: 7 });
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
