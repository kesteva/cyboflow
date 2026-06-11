/**
 * JournalTailer — polls a dynamic workflow's on-disk artifacts:
 *
 *   - `<transcriptDir>/journal.jsonl` — append-only `{type:'started'|'result',
 *     agentId}` lines; tailed incrementally (byte offset + partial-trailing-line
 *     buffer) to derive per-agent lifecycle ('started' => running, 'result' =>
 *     done) in stable first-seen order.
 *   - `<sessionDir>/workflows/wf_<id>.json` — the terminal record written ONCE
 *     at completion. Its appearance is the authoritative completion signal:
 *     onComplete fires and the tailer stops.
 *
 * If NEITHER file shows activity (journal growth / record presence) for
 * `idleTimeoutMs`, onStalled fires and the tailer stops — a workflow whose
 * hosting CLI process died never completes on its own.
 *
 * All fs errors are fail-soft: logged at WARN, retried next tick. The journal
 * not existing yet is normal (it appears shortly after launch).
 */
import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from 'node:fs';
import type { DynamicWorkflowAgent, DynamicWorkflowTotals } from '../../../../shared/types/dynamicWorkflows';
import type { LoggerLike } from '../types';

/** Default poll cadence — the journal is small, a 1s stat/read is cheap. */
const DEFAULT_POLL_MS = 1000;
/** Default stall threshold — 1 hour with zero file activity. */
const DEFAULT_IDLE_TIMEOUT_MS = 60 * 60 * 1000;

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
  /** Byte offset into the journal up to which lines have been consumed. */
  private offset = 0;
  /** Partial trailing line buffered until its newline arrives. */
  private lineBuffer = '';
  /** agentId -> status, in first-seen insertion order (Map preserves it). */
  private readonly agents = new Map<string, DynamicWorkflowAgent['status']>();
  private lastActivityAt = Date.now();

  constructor(private readonly opts: JournalTailerOptions) {
    this.pollMs = opts.pollMs ?? DEFAULT_POLL_MS;
    this.idleTimeoutMs = opts.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  }

  /** Begin polling. No-op when already started. */
  start(): void {
    if (this.timer !== null) return;
    this.lastActivityAt = Date.now();
    this.timer = setInterval(() => this.tick(), this.pollMs);
  }

  /** Stop polling. Idempotent. */
  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private tick(): void {
    try {
      // (a) Journal growth — live agent progress.
      let activity = this.pollJournal();

      // (b) Terminal record — authoritative completion.
      if (existsSync(this.opts.recordPath)) {
        const record = readCompletionRecord(this.opts.recordPath, this.opts.logger);
        if (record !== null) {
          this.stop();
          this.opts.onComplete(record);
          return;
        }
        // The record exists but is unreadable/mid-write — that still counts as
        // activity; the parse is retried next tick.
        activity = true;
      }

      // (c) Stall detection — nothing changed for idleTimeoutMs.
      if (activity) {
        this.lastActivityAt = Date.now();
      } else if (Date.now() - this.lastActivityAt >= this.idleTimeoutMs) {
        this.stop();
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
   * Returns true iff the journal grew this tick.
   */
  private pollJournal(): boolean {
    try {
      if (!existsSync(this.opts.journalPath)) return false; // appears shortly after launch
      const size = statSync(this.opts.journalPath).size;
      if (size <= this.offset) return false;

      this.lineBuffer += this.readAppendedSlice(size);
      this.offset = size;

      const lines = this.lineBuffer.split('\n');
      this.lineBuffer = lines.pop() ?? ''; // tolerate a partial trailing line

      let changed = false;
      for (const line of lines) {
        if (line.trim() === '') continue;
        if (this.applyJournalLine(line)) changed = true;
      }
      if (changed) {
        this.opts.onAgents(this.snapshotAgents());
      }
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.opts.logger?.warn(`[journalTailer] journal poll failed for ${this.opts.journalPath}: ${message}`);
      return false;
    }
  }

  /** Read [offset, size) from the journal — the file is small, one alloc is fine. */
  private readAppendedSlice(size: number): string {
    const length = size - this.offset;
    const buf = Buffer.alloc(length);
    const fd = openSync(this.opts.journalPath, 'r');
    try {
      readSync(fd, buf, 0, length, this.offset);
    } finally {
      closeSync(fd);
    }
    return buf.toString('utf8');
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

  /** The full agent array in stable first-seen order. */
  private snapshotAgents(): DynamicWorkflowAgent[] {
    return [...this.agents].map(([agentId, status]) => ({ agentId, status }));
  }
}
