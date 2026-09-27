import type Database from 'better-sqlite3';
import type { AgentUsage } from '../../../../../shared/types/agentStream';
import type { Logger } from '../../../utils/logger';
import type { AppServerNotification } from './appServer/client';
import type {
  RawResponseCompletedNotification,
  ThreadTokenUsageUpdatedNotification,
  TokenUsageBreakdown,
} from './appServer/protocol';
import { CodexTurnUsageAccumulator, CodexUsageTotals } from './appServer/usageAccumulator';
import {
  CodexDescendantRegistry,
  CodexResponsePairingLedger,
  sameUsage,
  type CodexDescendantRecord,
} from './appServer/usageLedger';
import { parseCodexUsageSignals, type CodexUsageSignal } from './appServer/usageNotifications';

/**
 * How long a finished root turn keeps its app-server alive for late descendant
 * responses. The drain ends earlier once every registered descendant is
 * terminal and no counted update still waits for its response.
 */
export const CODEX_USAGE_DRAIN_TIMEOUT_MS = 30_000;

/**
 * One invocation's usage identity. `active` — its root turn is running and
 * counts root + descendant responses; `draining` — the root reached terminal
 * (its `agent_result` is written) and only descendants still count; `sealed` —
 * nothing more is attributed to it, so a late response goes unattributed.
 */
export interface CodexUsageOwner {
  readonly invocationId: string;
  readonly runId: string;
  readonly accumulator: CodexTurnUsageAccumulator;
  /** Display model of the root thread — the inferred model of a model-less child. */
  readonly model: string;
  /** Set when `turn/start` returns; a root response of another turn is not this invocation's. */
  codexTurnId: string | null;
  state: 'active' | 'draining' | 'sealed';
}

export function createCodexUsageOwner(input: {
  invocationId: string;
  runId: string;
  model: string;
  rootThreadId: string | null;
}): CodexUsageOwner {
  return {
    invocationId: input.invocationId,
    runId: input.runId,
    accumulator: new CodexTurnUsageAccumulator(input.rootThreadId),
    model: input.model,
    codexTurnId: null,
    state: 'active',
  };
}

/** The `subagent_usage` payload every Codex usage row carries (see the usage contract). */
export interface CodexSubagentUsagePayload {
  type: 'subagent_usage';
  provider: 'codex';
  thread_id: string;
  parent_thread_id: string | null;
  invocation_id: string | null;
  model_inferred: boolean;
  message: {
    model: string;
    usage: Required<AgentUsage>;
  };
}

const USAGE_FIELDS = [
  'input_tokens',
  'output_tokens',
  'cache_read_input_tokens',
  'cache_creation_input_tokens',
  'reasoning_output_tokens',
] as const;

export function completeUsage(usage: AgentUsage | undefined): Required<AgentUsage> {
  return {
    input_tokens: usage?.input_tokens ?? 0,
    output_tokens: usage?.output_tokens ?? 0,
    cache_read_input_tokens: usage?.cache_read_input_tokens ?? 0,
    cache_creation_input_tokens: usage?.cache_creation_input_tokens ?? 0,
    reasoning_output_tokens: usage?.reasoning_output_tokens ?? 0,
  };
}

function addUsage(a: Required<AgentUsage>, b: Required<AgentUsage>): Required<AgentUsage> {
  const out = { ...a };
  for (const field of USAGE_FIELDS) out[field] = a[field] + b[field];
  return out;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The one Codex usage-row upsert, bound as (run_id, payload_json, created_at,
 * dedup_key) — shared by the live writer below and the historical replay
 * (codexUsageReplay.ts).
 */
export const CODEX_USAGE_ROW_UPSERT_SQL = `
  INSERT INTO raw_events (run_id, event_type, payload_json, created_at, dedup_key)
  VALUES (?, 'subagent_usage', ?, ?, ?)
  ON CONFLICT(dedup_key) WHERE dedup_key IS NOT NULL DO UPDATE SET
    payload_json = excluded.payload_json,
    created_at = excluded.created_at
`;

/**
 * Upserts Codex `subagent_usage` rows under their dedup key — the same
 * partial-unique-index upsert as RawEventsSink.persistSubagentUsage. Fail-soft:
 * usage accounting must never break a turn.
 *
 * `additive` keys (`codex-unattributed:` / `codex-usage-topup:`) are run-scoped,
 * so a later app-server process of the same run may write the same key: its
 * first write reads the stored usage as a base and every write stores base +
 * this process's cumulative total, so one process never overwrites another's.
 */
export class CodexUsageRowWriter {
  private upsertStmt: Database.Statement | null = null;
  private readonly bases = new Map<string, Required<AgentUsage>>();

  constructor(
    private readonly db: Database.Database,
    private readonly logger?: Logger,
  ) {}

  write(
    runId: string,
    dedupKey: string,
    payload: CodexSubagentUsagePayload,
    mode: 'replace' | 'additive',
  ): void {
    try {
      let stored = payload;
      if (mode === 'additive') {
        let base = this.bases.get(dedupKey);
        if (!base) {
          base = this.readStoredUsage(dedupKey);
          this.bases.set(dedupKey, base);
        }
        stored = { ...payload, message: { ...payload.message, usage: addUsage(base, payload.message.usage) } };
      }
      this.upsertStmt ??= this.db.prepare(CODEX_USAGE_ROW_UPSERT_SQL);
      this.upsertStmt.run(runId, JSON.stringify(stored), new Date().toISOString(), dedupKey);
    } catch (error) {
      this.logger?.warn(
        `[CodexUsageRowWriter] usage row upsert failed for ${dedupKey}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private readStoredUsage(dedupKey: string): Required<AgentUsage> {
    const row = this.db
      .prepare('SELECT payload_json AS payloadJson FROM raw_events WHERE dedup_key = ?')
      .get(dedupKey) as { payloadJson: string } | undefined;
    if (!row) return completeUsage(undefined);
    try {
      const payload: unknown = JSON.parse(row.payloadJson);
      if (isRecord(payload) && isRecord(payload.message) && isRecord(payload.message.usage)) {
        const usage = payload.message.usage;
        const read = (field: typeof USAGE_FIELDS[number]): number =>
          typeof usage[field] === 'number' ? usage[field] : 0;
        return {
          input_tokens: read('input_tokens'),
          output_tokens: read('output_tokens'),
          cache_read_input_tokens: read('cache_read_input_tokens'),
          cache_creation_input_tokens: read('cache_creation_input_tokens'),
          reasoning_output_tokens: read('reasoning_output_tokens'),
        };
      }
    } catch {
      // A corrupt stored row restarts from zero rather than blocking the write.
    }
    return completeUsage(undefined);
  }
}

interface PendingDrain {
  resolvers: Array<() => void>;
  timer: ReturnType<typeof setTimeout>;
}

export interface CodexProcessUsageTrackerOptions {
  runId: string;
  /** Null for a hermetic spawn, whose run-less id has no `workflow_runs` row to key rows to. */
  writer: CodexUsageRowWriter | null;
  logger?: Logger;
  drainTimeoutMs?: number;
  /**
   * Called at settlement when this process wrote a usage row after some root
   * had already reached terminal — rows the run's terminal `run_usage` fold may
   * have missed, because a drain can outlive the run's last step.
   */
  onLateRows?: (runId: string) => void;
  /**
   * `config.agents` role name → the model its role file pins, or null when the
   * role inherits its spawner's model. Names the model of a child whose spawn
   * item carries none (0.156.1 `subAgentActivity`).
   */
  roleModels?: Readonly<Record<string, string | null>>;
}

/**
 * The per-app-server-process half of Codex usage accounting, fed EVERY
 * notification before TurnSession's root-only filter:
 *
 *   - root-thread responses → the active invocation's accumulator (its
 *     `agent_result`);
 *   - registered descendants → their owning invocation's
 *     `codex-subagent:<invocationId>:<threadId>` row, re-upserted per response;
 *   - never-registered threads (after buffering) and responses that arrive once
 *     their owner is sealed → `codex-unattributed:<runId>:<threadId>`;
 *   - at settlement, updates no response matched →
 *     `codex-usage-topup:<runId>:<threadId>`.
 *
 * A thread's usage never moves between keys once written.
 *
 * RAW-EVENTS SOURCE. Only `thread/start` accepts `experimentalRawEvents`
 * (0.156.1's ThreadResumeParams has no such field), so a thread RESUMED in this
 * process emits no `rawResponse/completed`. Such a thread is UPDATE-SOURCED:
 * each counted (total-moved) `tokenUsage/updated` `last` is its request's usage,
 * routed exactly as a response would be — never paired, never topped up, never
 * drift. Threads the process started are response-sourced. Threads with no
 * origin of their own (collab descendants) inherit the root's source.
 *
 * Switch rule (an update-sourced thread whose responses DO arrive): on its first
 * response it becomes response-sourced for good. Every request before that was
 * counted from its update. The first response can only answer the request in
 * flight, whose update may already have been counted — so if it equals the
 * thread's LAST update-counted `last`, it is recorded (id only) and skipped.
 * Anything else takes the normal pairing path from then on; an update that
 * later finds no response is topped up. So each request is counted exactly once
 * whichever of its update or response arrives first. (A mis-skip of a previous
 * identical request is still safe: its own update then goes unmatched and is
 * topped up.)
 */
export class CodexProcessUsageTracker {
  private readonly ledger = new CodexResponsePairingLedger();
  private readonly registry: CodexDescendantRegistry<CodexUsageOwner>;
  private readonly unattributed = new Map<string, CodexUsageTotals>();
  private readonly topups = new Map<string, CodexUsageTotals>();
  private readonly buffered = new Map<string, RawResponseCompletedNotification[]>();
  private readonly owners = new Set<CodexUsageOwner>();
  private readonly drains = new Map<CodexUsageOwner, PendingDrain>();
  private activeOwner: CodexUsageOwner | null = null;
  private rootThreadId: string | null = null;
  private rootModel: string | null = null;
  private settled = false;
  private anyRootSealed = false;
  private wroteAfterSeal = false;
  /** Source of threads with no origin of their own: the root's. */
  private defaultSource: 'responses' | 'updates' = 'responses';
  private readonly threadSources = new Map<string, 'responses' | 'updates'>();
  /** Per update-sourced thread, the last request counted from an update. */
  private readonly lastUpdateCounted = new Map<string, TokenUsageBreakdown>();
  private updateSequence = 0;
  /** `spawn_agent` calls by call id, until their child's started item arrives. */
  private readonly spawnCalls = new Map<string, { agentType: string | null; model: string | null }>();

  constructor(private readonly options: CodexProcessUsageTrackerOptions) {
    this.registry = new CodexDescendantRegistry<CodexUsageOwner>((threadId) => {
      const owner = this.activeOwner;
      return threadId === this.rootThreadId && owner !== null && owner.state === 'active' ? owner : null;
    });
  }

  setRootThread(threadId: string): void {
    this.rootThreadId = threadId;
    this.activeOwner?.accumulator.setRootThread(threadId);
  }

  /**
   * How this process opened `threadId`: `started` threads emit
   * `rawResponse/completed`; `resumed` ones do not, so they (and their
   * descendants) count from `tokenUsage/updated` instead.
   */
  markThreadOrigin(threadId: string, origin: 'started' | 'resumed'): void {
    const source = origin === 'resumed' ? 'updates' : 'responses';
    this.threadSources.set(threadId, source);
    if (threadId === this.rootThreadId || this.rootThreadId === null) this.defaultSource = source;
  }

  /** Binds the invocation a new root turn belongs to. */
  bindOwner(owner: CodexUsageOwner): void {
    this.owners.add(owner);
    this.activeOwner = owner;
    this.rootModel = owner.model;
    if (this.rootThreadId !== null) owner.accumulator.setRootThread(this.rootThreadId);
  }

  /** The root reached terminal: its `agent_result` is written, so no further root response is its. */
  sealRoot(owner: CodexUsageOwner): void {
    this.anyRootSealed = true;
    if (owner.state === 'active') owner.state = 'draining';
    if (this.activeOwner === owner) this.activeOwner = null;
  }

  observe(notification: AppServerNotification): void {
    if (this.settled) return;
    const signals = parseCodexUsageSignals(notification);
    if (signals.length === 0) return;
    for (const signal of signals) this.observeSignal(signal);
    this.checkDrains();
  }

  /**
   * Keeps `owner`'s descendants attributable after its root terminal, until
   * each registered descendant is terminal with no response pending, or the
   * timeout. Then the owner is sealed. Resolves at once when nothing is owed.
   */
  drain(owner: CodexUsageOwner): Promise<void> {
    this.sealRoot(owner);
    if (owner.state === 'sealed') return Promise.resolve();
    return new Promise((resolve) => {
      const existing = this.drains.get(owner);
      if (existing) {
        existing.resolvers.push(resolve);
        return;
      }
      if (this.drainComplete(owner)) {
        this.finishDrain(owner);
        resolve();
        return;
      }
      const timer = setTimeout(() => {
        this.options.logger?.warn(
          `[CodexUsage] drain timed out after ${this.drainTimeoutMs}ms for invocation ${owner.invocationId}; late descendant usage goes unattributed`,
        );
        this.finishDrain(owner);
      }, this.drainTimeoutMs);
      timer.unref?.();
      this.drains.set(owner, { resolvers: [resolve], timer });
    });
  }

  /** True while `owner` has a drain still waiting. */
  isDraining(owner: CodexUsageOwner): boolean {
    return this.drains.has(owner);
  }

  /** Ends every pending drain now (cancellation, shutdown, a dead process). */
  cancelDrains(): void {
    for (const owner of [...this.drains.keys()]) this.finishDrain(owner);
  }

  /**
   * Called once the process's client has stopped (after the drain, on
   * cancellation, on warm-entry close, at shutdown): seals every owner, sends
   * still-unregistered buffered usage to the unattributed row, and tops up
   * updates no response matched.
   */
  settle(): void {
    if (this.settled) return;
    this.cancelDrains();
    for (const owner of this.owners) owner.state = 'sealed';
    this.owners.clear();
    this.activeOwner = null;
    this.flushBuffered();
    this.settled = true;
    const settlement = this.ledger.settle();
    for (const [threadId, usages] of settlement.topups) {
      let totals = this.topups.get(threadId);
      if (!totals) {
        totals = new CodexUsageTotals();
        this.topups.set(threadId, totals);
      }
      for (const usage of usages) totals.add(usage);
      this.options.logger?.warn(
        `[CodexUsage] response_usage_missing: ${usages.length} request(s) on thread ${threadId} (run ${this.options.runId}) had no response usage; topped up from thread/tokenUsage/updated`,
      );
      this.writeRunScopedRow('codex-usage-topup', threadId, totals.snapshot());
    }
    for (const mismatch of settlement.oracleMismatches) {
      this.options.logger?.warn(
        `[CodexUsage] oracle_mismatch on thread ${mismatch.threadId} (run ${this.options.runId}): total reports input=${mismatch.oracleInput} output=${mismatch.oracleOutput}, stored input=${mismatch.storedInput} output=${mismatch.storedOutput}`,
      );
    }
    for (const drift of settlement.driftTurns) {
      this.options.logger?.error(
        `[CodexUsage] PROTOCOL DRIFT: turn ${drift.turnId} on thread ${drift.threadId} (run ${this.options.runId}) had thread/tokenUsage/updated but no rawResponse/completed — the per-response usage source has changed`,
      );
    }
    if (this.wroteAfterSeal) {
      try {
        this.options.onLateRows?.(this.options.runId);
      } catch (error) {
        this.options.logger?.warn(
          `[CodexUsage] late-row re-rollup failed for run ${this.options.runId}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  private get drainTimeoutMs(): number {
    return this.options.drainTimeoutMs ?? CODEX_USAGE_DRAIN_TIMEOUT_MS;
  }

  private observeSignal(signal: CodexUsageSignal): void {
    switch (signal.kind) {
      case 'response':
        this.observeResponse(signal.notification);
        return;
      case 'tokenUsage':
        this.observeTokenUsage(signal.notification);
        return;
      case 'spawn':
        this.registerChildren(
          signal.senderThreadId,
          signal.turnId,
          signal.receiverThreadIds.map((threadId) => ({ threadId, model: signal.model })),
        );
        return;
      case 'spawnCall':
        this.spawnCalls.set(signal.callId, { agentType: signal.agentType, model: signal.model });
        return;
      case 'subAgentStarted':
        this.registerChildren(signal.threadId, signal.turnId, [
          { threadId: signal.agentThreadId, model: this.spawnCallModel(signal.threadId, signal.callId) },
        ]);
        return;
      case 'agentStates':
        for (const state of signal.states) {
          if (state.terminal) this.registry.markTerminal(state.threadId);
        }
        return;
      case 'turnStarted':
      case 'threadActive':
        this.registry.markRunning(signal.threadId);
        return;
      case 'turnCompleted':
      case 'threadIdle':
        this.registry.markTerminal(signal.threadId);
        return;
      case 'compaction':
        this.ledger.observeCompaction(signal.threadId);
        return;
    }
  }

  /**
   * The model a `spawn_agent` call runs its child on: an explicit `model`
   * argument, else the role file's pinned model, else — for a role that pins
   * none, or no role at all — the spawner's own model, which Codex children
   * inherit. Null (the child is then flagged model-inferred) when the call was
   * not seen (a resumed thread emits no raw items), names a role this process
   * did not register, or the spawner's own model is only inferred.
   */
  private spawnCallModel(senderThreadId: string, callId: string | null): string | null {
    const call = callId === null ? undefined : this.spawnCalls.get(callId);
    if (call === undefined) return null;
    if (call.model !== null) return call.model;
    if (call.agentType !== null) {
      const roleModels = this.options.roleModels;
      if (roleModels === undefined || !Object.hasOwn(roleModels, call.agentType)) return null;
      const pinned = roleModels[call.agentType];
      if (pinned !== null) return pinned;
    }
    if (senderThreadId === this.rootThreadId) return this.activeOwner?.model ?? this.rootModel;
    const sender = this.registry.resolveModel(senderThreadId, '');
    return sender.inferred ? null : sender.model;
  }

  private registerChildren(
    parentThreadId: string,
    turnId: string,
    children: Array<{ threadId: string; model: string | null }>,
  ): void {
    const added = this.registry.register(parentThreadId, turnId, children);
    for (const record of added) {
      const pending = this.buffered.get(record.threadId);
      if (!pending) continue;
      this.buffered.delete(record.threadId);
      for (const notification of pending) this.attributeDescendant(record, notification);
    }
  }

  private sourceOf(threadId: string): 'responses' | 'updates' {
    return this.threadSources.get(threadId) ?? this.defaultSource;
  }

  private observeTokenUsage(notification: ThreadTokenUsageUpdatedNotification): void {
    const { threadId, turnId } = notification;
    if (this.sourceOf(threadId) === 'responses') {
      this.ledger.observeTokenUsage(notification);
      return;
    }
    if (!this.ledger.observeTokenUsage(notification, false)) return; // duplicate emission
    const { last } = notification.tokenUsage;
    if (last.totalTokens === 0 && last.inputTokens === 0 && last.outputTokens === 0) return;
    this.lastUpdateCounted.set(threadId, last);
    this.updateSequence += 1;
    // A synthetic, never-colliding id: the request routes exactly as a response.
    this.routeUsage({
      threadId,
      turnId,
      responseId: `token-usage:${threadId}:${this.updateSequence}`,
      usage: last,
      usageMetadata: null,
    });
  }

  private observeResponse(notification: RawResponseCompletedNotification): void {
    const { threadId } = notification;
    if (this.sourceOf(threadId) === 'updates') {
      // The switch rule (class doc): response-sourced from here on.
      this.threadSources.set(threadId, 'responses');
      const inFlight = this.lastUpdateCounted.get(threadId);
      this.lastUpdateCounted.delete(threadId);
      if (inFlight && notification.usage !== null && sameUsage(inFlight, notification.usage)) {
        this.ledger.observeResponse(notification, false);
        return;
      }
    }
    if (!this.ledger.observeResponse(notification)) return; // replayed response id
    if (notification.usage === null) return; // topped up from its update at settlement
    this.routeUsage(notification);
  }

  /** Routes one counted request's usage to its owner, a buffer, or the unattributed row. */
  private routeUsage(notification: RawResponseCompletedNotification): void {
    const { threadId } = notification;
    if (threadId === this.rootThreadId) {
      const owner = this.activeOwner;
      if (
        owner !== null
        && owner.state === 'active'
        && (owner.codexTurnId === null || owner.codexTurnId === notification.turnId)
      ) {
        owner.accumulator.observeResponse(threadId, notification.responseId, notification.usage);
      } else {
        this.addUnattributed(notification);
      }
      return;
    }
    if (this.unattributed.has(threadId)) {
      this.addUnattributed(notification);
      return;
    }
    const record = this.registry.get(threadId);
    if (record) {
      this.attributeDescendant(record, notification);
      return;
    }
    const queue = this.buffered.get(threadId) ?? [];
    queue.push(notification);
    this.buffered.set(threadId, queue);
  }

  private attributeDescendant(
    record: CodexDescendantRecord<CodexUsageOwner>,
    notification: RawResponseCompletedNotification,
  ): void {
    const owner = record.owner;
    if (owner.state === 'sealed' || this.unattributed.has(record.threadId) || notification.usage === null) {
      this.addUnattributed(notification);
      return;
    }
    owner.accumulator.observeResponse(record.threadId, notification.responseId, notification.usage);
    const usage = owner.accumulator.threadSnapshot(record.threadId);
    if (!usage || !this.options.writer) return;
    if (this.anyRootSealed) this.wroteAfterSeal = true;
    const model = this.registry.resolveModel(record.threadId, owner.model);
    this.options.writer.write(
      owner.runId,
      `codex-subagent:${owner.invocationId}:${record.threadId}`,
      {
        type: 'subagent_usage',
        provider: 'codex',
        thread_id: record.threadId,
        parent_thread_id: record.parentThreadId,
        invocation_id: owner.invocationId,
        model_inferred: model.inferred,
        message: { model: model.model, usage: completeUsage(usage) },
      },
      'replace',
    );
  }

  private addUnattributed(notification: RawResponseCompletedNotification): void {
    if (notification.usage === null) return;
    const { threadId } = notification;
    let totals = this.unattributed.get(threadId);
    if (!totals) {
      totals = new CodexUsageTotals();
      this.unattributed.set(threadId, totals);
      this.options.logger?.warn(
        `[CodexUsage] descendant_usage_unattributed: thread ${threadId} (run ${this.options.runId}) has no live owning invocation; its usage is counted run-level`,
      );
    }
    totals.add(notification.usage);
    this.writeRunScopedRow('codex-unattributed', threadId, totals.snapshot());
  }

  private writeRunScopedRow(
    prefix: 'codex-unattributed' | 'codex-usage-topup',
    threadId: string,
    usage: AgentUsage | undefined,
  ): void {
    if (!usage || !this.options.writer) return;
    if (this.anyRootSealed) this.wroteAfterSeal = true;
    const rootModel = this.rootModel ?? 'codex-default';
    const record = this.registry.get(threadId);
    const model = threadId === this.rootThreadId
      ? { model: rootModel, inferred: false }
      : this.registry.resolveModel(threadId, record?.owner.model ?? rootModel);
    this.options.writer.write(
      this.options.runId,
      `${prefix}:${this.options.runId}:${threadId}`,
      {
        type: 'subagent_usage',
        provider: 'codex',
        thread_id: threadId,
        parent_thread_id: record?.parentThreadId ?? null,
        invocation_id: null,
        model_inferred: model.inferred,
        message: { model: model.model, usage: completeUsage(usage) },
      },
      'additive',
    );
  }

  private flushBuffered(): void {
    const pending = [...this.buffered.values()].flat();
    this.buffered.clear();
    for (const notification of pending) this.addUnattributed(notification);
  }

  private drainComplete(owner: CodexUsageOwner): boolean {
    return this.registry.descendantsOf(owner).every(
      (record) => this.registry.isTerminal(record.threadId) && !this.ledger.hasPendingResponse(record.threadId),
    );
  }

  private checkDrains(): void {
    for (const owner of [...this.drains.keys()]) {
      if (this.drainComplete(owner)) this.finishDrain(owner);
    }
  }

  private finishDrain(owner: CodexUsageOwner): void {
    const pending = this.drains.get(owner);
    this.drains.delete(owner);
    owner.state = 'sealed';
    this.owners.delete(owner);
    if (pending) {
      clearTimeout(pending.timer);
      for (const resolve of pending.resolvers) resolve();
    }
    // With no invocation left to claim them, still-unregistered threads' buffered
    // usage is final: it goes to the unattributed row.
    if (this.owners.size === 0) this.flushBuffered();
  }
}
