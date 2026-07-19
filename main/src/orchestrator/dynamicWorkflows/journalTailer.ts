/**
 * JournalTailer — polls a dynamic workflow's on-disk artifacts:
 *
 *   - `<transcriptDir>/journal.jsonl` — append-only `{type:'started'|'result',
 *     agentId}` lines; tailed incrementally (byte offset + partial-trailing-line
 *     buffer) to derive per-agent lifecycle ('started' => running, 'result' =>
 *     done) in stable first-seen order.
 *   - `<transcriptDir>/agent-<agentId>.jsonl` — per-subagent transcript, tailed
 *     with the same offset + remainder strategy (ONLY for agents already known
 *     from the journal — no directory scans) to accumulate the optional live
 *     stats on DynamicWorkflowAgent (model / token usage / toolUses / startedAt /
 *     lastActivityAt / promptExcerpt). The transcript landing a
 *     beat after the journal `started` line is normal — ENOENT is silent and
 *     retried next tick.
 *   - `<sessionDir>/workflows/wf_<id>.json` — the terminal record written ONCE
 *     at completion. Its appearance is the authoritative completion signal:
 *     onComplete fires and the tailer stops.
 *
 * If NO file shows activity (journal/transcript growth / record presence) for
 * `idleTimeoutMs`, onStalled fires and the tailer stops — a workflow whose
 * hosting CLI process died never completes on its own.
 *
 * All fs errors are fail-soft: logged at WARN, retried next tick. The journal
 * not existing yet is normal (it appears shortly after launch).
 */
import { existsSync, readFileSync } from 'node:fs';
import { open, stat } from 'node:fs/promises';
import * as path from 'node:path';
import type { DynamicWorkflowAgent, DynamicWorkflowTotals } from '../../../../shared/types/dynamicWorkflows';
import type { LoggerLike } from '../types';

/** Default poll cadence — the journal is small, a 1s stat/read is cheap. */
const DEFAULT_POLL_MS = 1000;
/** Default stall threshold — 1 hour with zero file activity. */
const DEFAULT_IDLE_TIMEOUT_MS = 60 * 60 * 1000;
/**
 * promptExcerpt truncation — bounded for IPC. Generous on purpose: fan-out
 * prompts open with a long SHARED prologue, and the frontend derives agent
 * display names from the text AFTER the common prefix — a tight cap leaves
 * only a few divergent chars (observed live: 200-char cap − ~170-char shared
 * prologue = every name clipped at exactly 30 chars).
 */
const PROMPT_EXCERPT_MAX_CHARS = 600;

const TOKEN_USAGE_FIELDS = [
  ['input_tokens', 'inputTokens'],
  ['output_tokens', 'outputTokens'],
  ['cache_read_input_tokens', 'cacheReadInputTokens'],
  ['cache_creation_input_tokens', 'cacheCreationInputTokens'],
] as const;

/** The optional live-stats slice of DynamicWorkflowAgent — keys set only when observed. */
type AgentTranscriptStats = Pick<
  DynamicWorkflowAgent,
  | 'model'
  | 'inputTokens'
  | 'outputTokens'
  | 'cacheReadInputTokens'
  | 'cacheCreationInputTokens'
  | 'toolUses'
  | 'startedAt'
  | 'lastActivityAt'
  | 'promptExcerpt'
>;

/** Per-agent transcript tail state: byte offset + torn-line buffer + accumulated stats. */
interface AgentTranscriptTail {
  /** Byte offset into agent-<agentId>.jsonl up to which lines have been consumed. */
  offset: number;
  /** Partial trailing line buffered until its newline arrives (mirrors the journal's lineBuffer). */
  remainder: string;
  /** The FIRST user line is the prompt; later user lines (tool results) must not overwrite it. */
  promptCaptured: boolean;
  stats: AgentTranscriptStats;
}

/** Parsed terminal record passed to onComplete. */
export interface DynamicWorkflowCompletionRecord {
  status: 'completed' | 'failed';
  summary?: string;
  totals?: DynamicWorkflowTotals;
}

export interface JournalTailerOptions {
  journalPath: string;
  recordPath: string;
  /** Poll cadence in ms; defaults to {@link DEFAULT_POLL_MS}. */
  pollMs?: number;
  /** Stall threshold in ms; defaults to {@link DEFAULT_IDLE_TIMEOUT_MS}. */
  idleTimeoutMs?: number;
  /** Invoked with the FULL agent array (stable first-seen order) on every change. */
  onAgents: (agents: DynamicWorkflowAgent[]) => void;
  /** Invoked once when the terminal record is read; the tailer stops itself first. */
  onComplete: (record: DynamicWorkflowCompletionRecord) => void;
  /** Invoked once when idleTimeoutMs elapses with no activity; the tailer stops itself first. */
  onStalled: () => void;
  logger?: Pick<LoggerLike, 'warn'>;
}

/**
 * Read + map the wf_<id>.json terminal record. Returns null when the file is
 * absent OR unreadable/mid-write (fail-soft warn) — callers retry or fall back.
 *
 * Exported so the tracker's `<task-notification>` accelerator path can attempt
 * one immediate record read before falling back to the notification status.
 */
export function readCompletionRecord(
  recordPath: string,
  logger?: Pick<LoggerLike, 'warn'>,
): DynamicWorkflowCompletionRecord | null {
  try {
    if (!existsSync(recordPath)) return null;
    const parsed: unknown = JSON.parse(readFileSync(recordPath, 'utf8'));
    if (parsed === null || typeof parsed !== 'object') return null;
    const rec = parsed as Record<string, unknown>;

    const totals: DynamicWorkflowTotals = {};
    if (typeof rec.agentCount === 'number') totals.agentCount = rec.agentCount;
    if (typeof rec.totalTokens === 'number') totals.totalTokens = rec.totalTokens;
    if (typeof rec.totalToolCalls === 'number') totals.totalToolCalls = rec.totalToolCalls;
    if (typeof rec.durationMs === 'number') totals.durationMs = rec.durationMs;

    return {
      status: rec.status === 'failed' ? 'failed' : 'completed',
      summary: typeof rec.summary === 'string' ? rec.summary : undefined,
      totals,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger?.warn(`[journalTailer] failed to read completion record ${recordPath}: ${message}`);
    return null;
  }
}

export class JournalTailer {
  private readonly pollMs: number;
  private readonly idleTimeoutMs: number;

  private timer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;
  /** Byte offset into the journal up to which lines have been consumed. */
  private offset = 0;
  /** Partial trailing line buffered until its newline arrives. */
  private lineBuffer = '';
  /** agentId -> status, in first-seen insertion order (Map preserves it). */
  private readonly agents = new Map<string, DynamicWorkflowAgent['status']>();
  /** agentId -> transcript tail state. Same lifetime as the agents map (per-run; dropped with the tailer). */
  private readonly transcriptTails = new Map<string, AgentTranscriptTail>();
  private lastActivityAt = Date.now();

  /**
   * Per-tailer serialized task chain. Every operation that touches the shared
   * offset / lineBuffer / transcript-tail state — the periodic {@link tick}, an
   * on-demand {@link drainToEof}, and {@link stop}'s buffer release — runs
   * through this chain, so no two ever interleave. drainToEof (which the tracker
   * fires immediately before its terminal usage snapshot) therefore cannot race
   * a tick mid-read: it queues behind any in-flight tick and the caller awaits
   * it. Async fs IO inside a task no longer makes that ordering implicit.
   */
  private queue: Promise<void> = Promise.resolve();
  /** True while a periodic tick is queued or running — coalesces a burst to one pending tick. */
  private tickScheduled = false;

  constructor(private readonly opts: JournalTailerOptions) {
    this.pollMs = opts.pollMs ?? DEFAULT_POLL_MS;
    this.idleTimeoutMs = opts.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  }

  /** Begin polling. No-op when already started. */
  start(): void {
    if (this.timer !== null) return;
    this.stopped = false;
    this.lastActivityAt = Date.now();
    this.timer = setInterval(() => this.scheduleTick(), this.pollMs);
  }

  /**
   * Halt scheduling ONLY — clear the interval and set the stopped flag so no
   * further tick runs. Deliberately does NOT touch the partial-line buffers.
   * The terminal-record / stall paths inside {@link tick} call this (not
   * {@link stop}) so a torn line this tick buffered survives the immediately
   * following awaited terminal drainToEof — the tracker's finalize()/
   * handleStalled() then call stop() AFTER that drain to release the buffers.
   * Idempotent.
   */
  private haltScheduling(): void {
    this.stopped = true;
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Stop polling AND release the heavy partial-line buffers. Idempotent.
   *
   * Buffer release is a SEPARATE concern from halting scheduling (see
   * {@link haltScheduling}): the terminal-tick path halts scheduling but keeps
   * the buffers so the awaited terminal drainToEof can still reassemble a torn
   * line; only the non-drain callers here — the tracker's dismiss(),
   * cap-eviction, dispose(), plus finalize()/handleStalled() AFTER their drain —
   * need the release. It runs through the queue so the reset never lands
   * mid-parse of an in-flight tick/drain. Stopped tailers are retained in the
   * tracker until session-cap eviction/dispose, and a torn transcript line can
   * be multi-KB (tool results). The accumulated per-agent `stats` are
   * deliberately KEPT — snapshotAgents() may still be read for the final
   * terminal-state emission after stop().
   */
  stop(): void {
    this.haltScheduling();
    void this.enqueue(async () => {
      this.lineBuffer = '';
      for (const tail of this.transcriptTails.values()) {
        tail.remainder = '';
      }
    });
  }

  /**
   * Consume every currently tracked agent transcript through its present EOF.
   * Terminal paths await this to close the final poll-window race before
   * snapshotting cumulative usage; it runs through the serialized queue, so it
   * waits for any in-flight tick and no tick can interleave it. A single
   * onAgents emission covers all transcript changes, matching the per-tick
   * throttle. Always drains even after scheduling has halted — the tracker's
   * finalize()/handleStalled() call it on the terminal path (behind the
   * terminal tick's haltScheduling()) to capture the last usage before stop()
   * releases the buffers.
   */
  async drainToEof(): Promise<void> {
    await this.enqueue(async () => {
      let statsChanged = false;
      for (const agentId of this.agents.keys()) {
        if ((await this.pollAgentTranscript(agentId)).statsChanged) statsChanged = true;
      }
      if (statsChanged) {
        this.opts.onAgents(this.snapshotAgents());
      }
    });
  }

  /** Coalesce interval fires: enqueue a tick only when none is already pending. */
  private scheduleTick(): void {
    if (this.tickScheduled) return;
    this.tickScheduled = true;
    void this.enqueue(() => this.tick());
  }

  /**
   * Append `task` to the serialized chain. The chain is kept alive across a
   * task rejection (so one bad task doesn't poison later ones); the returned
   * promise still carries this task's own result/rejection for the caller.
   */
  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task);
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async tick(): Promise<void> {
    // Cleared as the tick actually begins running: a burst of interval fires
    // during this run enqueues at most one successor.
    this.tickScheduled = false;
    if (this.stopped) return; // a stop() landed after this tick was queued
    // Sample the stall clock synchronously at tick start, before any await: the
    // idle window is anchored to when this poll began, not to when its async fs
    // reads happen to resolve (which the interleaving of real IO makes
    // nondeterministic). One poll interval of skew on a stall stamp is immaterial.
    const now = Date.now();
    try {
      // (a) Journal growth — live agent lifecycle.
      const journal = await this.pollJournal();

      // (b) Agent transcript growth — live per-agent stats. Capped to agents
      //     already tracked from the journal; a transcript that has not landed
      //     yet (ENOENT) is silently retried next tick.
      let transcriptsGrew = false;
      let statsChanged = false;
      for (const agentId of this.agents.keys()) {
        const result = await this.pollAgentTranscript(agentId);
        if (result.grew) transcriptsGrew = true;
        if (result.statsChanged) statsChanged = true;
      }

      // ONE emission per tick covers lifecycle and stats changes alike — the
      // poll cadence is the throttle.
      if (journal.changed || statsChanged) {
        this.opts.onAgents(this.snapshotAgents());
      }

      let activity = journal.grew || transcriptsGrew;

      // (c) Terminal record — authoritative completion. A tiny terminal-only
      //     JSON read; kept synchronous so the exported readCompletionRecord
      //     stays a plain sync helper for the tracker's accelerator path.
      if (existsSync(this.opts.recordPath)) {
        const record = readCompletionRecord(this.opts.recordPath, this.opts.logger);
        if (record !== null) {
          // Halt scheduling but KEEP the partial-line buffers: onComplete leads
          // synchronously into the tracker's finalize(), whose awaited
          // drainToEof() must still see any torn line this tick buffered so it
          // can reassemble the concurrently-appended suffix. finalize() calls
          // stop() (the buffer release) AFTER that drain.
          this.haltScheduling();
          this.opts.onComplete(record);
          return;
        }
        // The record exists but is unreadable/mid-write — that still counts as
        // activity; the parse is retried next tick.
        activity = true;
      }

      // (d) Stall detection — nothing changed for idleTimeoutMs.
      if (activity) {
        this.lastActivityAt = now;
      } else if (now - this.lastActivityAt >= this.idleTimeoutMs) {
        // Same as the completion path: halt scheduling but keep the buffers for
        // handleStalled()'s awaited drain; its stop() releases them afterward.
        this.haltScheduling();
        this.opts.onStalled();
      }
    } catch (err) {
      // Fail-soft: a single bad tick must not kill the interval.
      const message = err instanceof Error ? err.message : String(err);
      this.opts.logger?.warn(`[journalTailer] tick failed for ${this.opts.journalPath}: ${message}`);
    }
  }

  /**
   * Read bytes appended since the last consumed offset, split complete lines
   * (buffering any partial trailing line), and fold them into the agent map.
   * `grew` is true iff the journal gained bytes this tick; `changed` is true
   * iff any agent's lifecycle moved (the caller emits onAgents once per tick).
   */
  private async pollJournal(): Promise<{ grew: boolean; changed: boolean }> {
    try {
      let size: number;
      try {
        size = (await stat(this.opts.journalPath)).size;
      } catch (err) {
        if (isENOENT(err)) return { grew: false, changed: false }; // appears shortly after launch
        throw err; // other fs errors fall through to the warn below
      }
      if (size <= this.offset) return { grew: false, changed: false };

      this.lineBuffer += await readAppendedSlice(this.opts.journalPath, this.offset, size);
      this.offset = size;

      const lines = this.lineBuffer.split('\n');
      this.lineBuffer = lines.pop() ?? ''; // tolerate a partial trailing line

      let changed = false;
      for (const line of lines) {
        if (line.trim() === '') continue;
        if (this.applyJournalLine(line)) changed = true;
      }
      return { grew: true, changed };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.opts.logger?.warn(`[journalTailer] journal poll failed for ${this.opts.journalPath}: ${message}`);
      return { grew: false, changed: false };
    }
  }

  /** Fold one complete journal line into the agent map. Returns true on change. */
  private applyJournalLine(line: string): boolean {
    try {
      const parsed: unknown = JSON.parse(line);
      if (parsed === null || typeof parsed !== 'object') return false;
      const entry = parsed as Record<string, unknown>;
      if (typeof entry.agentId !== 'string') return false;

      if (entry.type === 'started') {
        if (!this.agents.has(entry.agentId)) {
          this.agents.set(entry.agentId, 'running');
          return true;
        }
        return false;
      }
      if (entry.type === 'result') {
        if (this.agents.get(entry.agentId) !== 'done') {
          this.agents.set(entry.agentId, 'done');
          return true;
        }
        return false;
      }
      return false; // unknown line type — ignore
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.opts.logger?.warn(`[journalTailer] unparseable journal line skipped: ${message}`);
      return false;
    }
  }

  /**
   * Read bytes appended to one agent's transcript since its last consumed
   * offset and fold the complete lines into that agent's stats accumulator.
   * Mirrors pollJournal's offset + remainder strategy — the file is NEVER
   * re-parsed from the start. ENOENT is silent (the transcript lands after
   * the journal `started` line); other fs errors warn and retry next tick.
   */
  private async pollAgentTranscript(agentId: string): Promise<{ grew: boolean; statsChanged: boolean }> {
    let tail = this.transcriptTails.get(agentId);
    if (tail === undefined) {
      tail = { offset: 0, remainder: '', promptCaptured: false, stats: {} };
      this.transcriptTails.set(agentId, tail);
    }
    const transcriptPath = path.join(path.dirname(this.opts.journalPath), `agent-${agentId}.jsonl`);
    try {
      let size: number;
      try {
        size = (await stat(transcriptPath)).size;
      } catch (err) {
        if (isENOENT(err)) return { grew: false, statsChanged: false }; // lands after the journal `started` line
        throw err;
      }
      if (size <= tail.offset) return { grew: false, statsChanged: false };

      tail.remainder += await readAppendedSlice(transcriptPath, tail.offset, size);
      tail.offset = size;

      const lines = tail.remainder.split('\n');
      tail.remainder = lines.pop() ?? ''; // torn trailing line carries over to the next poll

      let statsChanged = false;
      for (const line of lines) {
        if (line.trim() === '') continue;
        if (this.applyTranscriptLine(tail, line)) statsChanged = true;
      }
      return { grew: true, statsChanged };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.opts.logger?.warn(`[journalTailer] transcript poll failed for ${transcriptPath}: ${message}`);
      return { grew: false, statsChanged: false };
    }
  }

  /** Fold one complete transcript line into the agent's stats. Returns true on change. */
  private applyTranscriptLine(tail: AgentTranscriptTail, line: string): boolean {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.opts.logger?.warn(`[journalTailer] unparseable transcript line skipped: ${message}`);
      return false;
    }
    if (parsed === null || typeof parsed !== 'object') return false;
    const entry = parsed as Record<string, unknown>;
    const stats = tail.stats;
    let changed = false;

    // Every transcript line carries an ISO timestamp — first seen is startedAt,
    // newest seen is lastActivityAt.
    if (typeof entry.timestamp === 'string') {
      if (stats.startedAt === undefined) {
        stats.startedAt = entry.timestamp;
        changed = true;
      }
      if (stats.lastActivityAt !== entry.timestamp) {
        stats.lastActivityAt = entry.timestamp;
        changed = true;
      }
    }

    const message =
      entry.message !== null && typeof entry.message === 'object'
        ? (entry.message as Record<string, unknown>)
        : undefined;

    if (entry.type === 'user' && !tail.promptCaptured) {
      // Only the FIRST user line is the prompt — later user lines are tool results.
      tail.promptCaptured = true;
      const text = extractFirstUserText(message?.content);
      if (text !== undefined) {
        stats.promptExcerpt = text.slice(0, PROMPT_EXCERPT_MAX_CHARS);
        changed = true;
      }
    }

    if (entry.type === 'assistant' && message !== undefined) {
      if (stats.model === undefined && typeof message.model === 'string') {
        stats.model = message.model;
        changed = true;
      }
      const usage =
        message.usage !== null && typeof message.usage === 'object'
          ? (message.usage as Record<string, unknown>)
          : undefined;
      if (usage !== undefined) {
        for (const [usageKey, statsKey] of TOKEN_USAGE_FIELDS) {
          const value = usage[usageKey];
          if (typeof value !== 'number') continue;
          stats[statsKey] = (stats[statsKey] ?? 0) + value;
          changed = true;
        }
      }
      if (Array.isArray(message.content)) {
        const toolUseCount = message.content.filter((block: unknown) => {
          return block !== null && typeof block === 'object' && (block as Record<string, unknown>).type === 'tool_use';
        }).length;
        if (toolUseCount > 0) {
          stats.toolUses = (stats.toolUses ?? 0) + toolUseCount;
          changed = true;
        }
      }
    }
    return changed;
  }

  /**
   * The full agent array in stable first-seen order, with each agent's
   * accumulated transcript stats merged in (absent until first parsed —
   * receivers must tolerate the bare {agentId, status} shape).
   */
  private snapshotAgents(): DynamicWorkflowAgent[] {
    return [...this.agents].map(([agentId, status]) => ({
      agentId,
      status,
      ...this.transcriptTails.get(agentId)?.stats,
    }));
  }
}

/** Read [start, end) bytes of a file as utf8 — appended slices are small, one alloc is fine. */
async function readAppendedSlice(filePath: string, start: number, end: number): Promise<string> {
  const length = end - start;
  const buf = Buffer.alloc(length);
  const fh = await open(filePath, 'r');
  try {
    await fh.read(buf, 0, length, start);
  } finally {
    await fh.close();
  }
  return buf.toString('utf8');
}

/** True for a Node fs "file not found" error — a missing journal/transcript is normal. */
function isENOENT(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as NodeJS.ErrnoException).code === 'ENOENT'
  );
}

/**
 * Prompt text from a transcript user line's `message.content` — a plain string
 * in practice; when it is an array, the first `{type:'text'}` part wins.
 */
function extractFirstUserText(content: unknown): string | undefined {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    for (const part of content) {
      if (part === null || typeof part !== 'object') continue;
      const candidate = part as Record<string, unknown>;
      if (candidate.type === 'text' && typeof candidate.text === 'string') {
        return candidate.text;
      }
    }
  }
  return undefined;
}
