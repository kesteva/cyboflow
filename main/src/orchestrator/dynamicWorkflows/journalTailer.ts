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
 *     stats on DynamicWorkflowAgent (model / outputTokens / toolUses /
 *     startedAt / lastActivityAt / promptExcerpt). The transcript landing a
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
import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from 'node:fs';
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

/** The optional live-stats slice of DynamicWorkflowAgent — keys set only when observed. */
type AgentTranscriptStats = Pick<
  DynamicWorkflowAgent,
  'model' | 'outputTokens' | 'toolUses' | 'startedAt' | 'lastActivityAt' | 'promptExcerpt'
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
  /** Byte offset into the journal up to which lines have been consumed. */
  private offset = 0;
  /** Partial trailing line buffered until its newline arrives. */
  private lineBuffer = '';
  /** agentId -> status, in first-seen insertion order (Map preserves it). */
  private readonly agents = new Map<string, DynamicWorkflowAgent['status']>();
  /** agentId -> transcript tail state. Same lifetime as the agents map (per-run; dropped with the tailer). */
  private readonly transcriptTails = new Map<string, AgentTranscriptTail>();
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
    // Release the heavy partial-line buffers: stopped tailers are retained in
    // the tracker until session-cap eviction/dispose, and a torn transcript
    // line can be multi-KB (tool results). The accumulated per-agent `stats`
    // are deliberately KEPT — snapshotAgents() may still be read for the final
    // terminal-state emission after stop().
    this.lineBuffer = '';
    for (const tail of this.transcriptTails.values()) {
      tail.remainder = '';
    }
  }

  private tick(): void {
    try {
      // (a) Journal growth — live agent lifecycle.
      const journal = this.pollJournal();

      // (b) Agent transcript growth — live per-agent stats. Capped to agents
      //     already tracked from the journal; a transcript that has not landed
      //     yet (ENOENT) is silently retried next tick.
      let transcriptsGrew = false;
      let statsChanged = false;
      for (const agentId of this.agents.keys()) {
        const result = this.pollAgentTranscript(agentId);
        if (result.grew) transcriptsGrew = true;
        if (result.statsChanged) statsChanged = true;
      }

      // ONE emission per tick covers lifecycle and stats changes alike — the
      // poll cadence is the throttle.
      if (journal.changed || statsChanged) {
        this.opts.onAgents(this.snapshotAgents());
      }

      let activity = journal.grew || transcriptsGrew;

      // (c) Terminal record — authoritative completion.
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

      // (d) Stall detection — nothing changed for idleTimeoutMs.
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
   * `grew` is true iff the journal gained bytes this tick; `changed` is true
   * iff any agent's lifecycle moved (the caller emits onAgents once per tick).
   */
  private pollJournal(): { grew: boolean; changed: boolean } {
    try {
      if (!existsSync(this.opts.journalPath)) return { grew: false, changed: false }; // appears shortly after launch
      const size = statSync(this.opts.journalPath).size;
      if (size <= this.offset) return { grew: false, changed: false };

      this.lineBuffer += readAppendedSlice(this.opts.journalPath, this.offset, size);
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
  private pollAgentTranscript(agentId: string): { grew: boolean; statsChanged: boolean } {
    let tail = this.transcriptTails.get(agentId);
    if (tail === undefined) {
      tail = { offset: 0, remainder: '', promptCaptured: false, stats: {} };
      this.transcriptTails.set(agentId, tail);
    }
    const transcriptPath = path.join(path.dirname(this.opts.journalPath), `agent-${agentId}.jsonl`);
    try {
      if (!existsSync(transcriptPath)) return { grew: false, statsChanged: false };
      const size = statSync(transcriptPath).size;
      if (size <= tail.offset) return { grew: false, statsChanged: false };

      tail.remainder += readAppendedSlice(transcriptPath, tail.offset, size);
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
      if (usage !== undefined && typeof usage.output_tokens === 'number') {
        stats.outputTokens = (stats.outputTokens ?? 0) + usage.output_tokens;
        changed = true;
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
function readAppendedSlice(filePath: string, start: number, end: number): string {
  const length = end - start;
  const buf = Buffer.alloc(length);
  const fd = openSync(filePath, 'r');
  try {
    readSync(fd, buf, 0, length, start);
  } finally {
    closeSync(fd);
  }
  return buf.toString('utf8');
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
