import type {
  RawResponseCompletedNotification,
  ThreadTokenUsageUpdatedNotification,
  TokenUsageBreakdown,
} from './protocol';

/**
 * Pure (no DB, no timers) building blocks for per-response Codex usage
 * accounting, shared by the live manager and the historical replay:
 *
 *   - CodexDescendantRegistry maps a collab child thread to the invocation that
 *     owns it, transitively (a grandchild belongs to its grandparent's owner).
 *   - CodexResponsePairingLedger pairs `thread/tokenUsage/updated` with
 *     `rawResponse/completed` per (process, thread), so a request whose response
 *     never arrived (or carried `usage: null`) can be topped up exactly once.
 */

export interface CodexDescendantRecord<TOwner> {
  threadId: string;
  parentThreadId: string;
  owner: TOwner;
  /** The spawn's authoritative model, or null until (unless) one is seen. */
  model: string | null;
}

export interface CodexResolvedModel {
  model: string;
  inferred: boolean;
}

interface PendingChild {
  threadId: string;
  model: string | null;
}

export class CodexDescendantRegistry<TOwner> {
  private readonly records = new Map<string, CodexDescendantRecord<TOwner>>();
  // Children announced by a sender that is not (yet) registered — a grandchild
  // whose parent's own spawn item has not arrived. Registered transitively the
  // moment the parent is.
  private readonly pendingChildren = new Map<string, PendingChild[]>();
  private readonly terminalThreads = new Set<string>();

  /**
   * @param resolveRootOwner the owner of a ROOT thread's spawn at `turnId`, or
   *   null when the sender is not a root thread with a live owner.
   */
  constructor(
    private readonly resolveRootOwner: (threadId: string, turnId: string) => TOwner | null,
  ) {}

  get(threadId: string): CodexDescendantRecord<TOwner> | undefined {
    return this.records.get(threadId);
  }

  /**
   * Registers `children` of `parentThreadId` (spawnAgent.receiverThreadIds or a
   * subAgentActivity started item). Returns every NEWLY registered record,
   * including transitively released grandchildren. An already-registered thread
   * keeps its owner; it only gains a model it did not have.
   */
  register(
    parentThreadId: string,
    turnId: string,
    children: ReadonlyArray<PendingChild>,
  ): Array<CodexDescendantRecord<TOwner>> {
    const owner = this.records.get(parentThreadId)?.owner
      ?? this.resolveRootOwner(parentThreadId, turnId);
    if (owner === null) {
      for (const child of children) {
        const existing = this.records.get(child.threadId);
        if (existing) {
          if (existing.model === null && child.model !== null) existing.model = child.model;
          continue;
        }
        const queue = this.pendingChildren.get(parentThreadId) ?? [];
        queue.push(child);
        this.pendingChildren.set(parentThreadId, queue);
      }
      return [];
    }
    const added: Array<CodexDescendantRecord<TOwner>> = [];
    const work: Array<{ parentThreadId: string; child: PendingChild }> = children.map(
      (child) => ({ parentThreadId, child }),
    );
    while (work.length > 0) {
      const { parentThreadId: parent, child } = work.shift() as { parentThreadId: string; child: PendingChild };
      const existing = this.records.get(child.threadId);
      if (existing) {
        if (existing.model === null && child.model !== null) existing.model = child.model;
        continue;
      }
      const record: CodexDescendantRecord<TOwner> = {
        threadId: child.threadId,
        parentThreadId: parent,
        owner,
        model: child.model,
      };
      this.records.set(child.threadId, record);
      added.push(record);
      const released = this.pendingChildren.get(child.threadId);
      if (released) {
        this.pendingChildren.delete(child.threadId);
        for (const grandchild of released) work.push({ parentThreadId: child.threadId, child: grandchild });
      }
    }
    return added;
  }

  descendantsOf(owner: TOwner): Array<CodexDescendantRecord<TOwner>> {
    return [...this.records.values()].filter((record) => record.owner === owner);
  }

  /**
   * A descendant's model: its own spawn model, else its nearest ancestor's —
   * ending at `rootModel` — flagged inferred.
   */
  resolveModel(threadId: string, rootModel: string): CodexResolvedModel {
    let inferred = false;
    let cursor = this.records.get(threadId);
    const visited = new Set<string>();
    while (cursor && !visited.has(cursor.threadId)) {
      if (cursor.model !== null) return { model: cursor.model, inferred };
      visited.add(cursor.threadId);
      inferred = true;
      cursor = this.records.get(cursor.parentThreadId);
    }
    return { model: rootModel, inferred: true };
  }

  markRunning(threadId: string): void {
    this.terminalThreads.delete(threadId);
  }

  markTerminal(threadId: string): void {
    this.terminalThreads.add(threadId);
  }

  isTerminal(threadId: string): boolean {
    return this.terminalThreads.has(threadId);
  }
}

function usageKey(usage: TokenUsageBreakdown): string {
  return [
    usage.totalTokens,
    usage.inputTokens,
    usage.cachedInputTokens,
    usage.cacheWriteInputTokens,
    usage.outputTokens,
    usage.reasoningOutputTokens,
  ].join(':');
}

export function sameUsage(a: TokenUsageBreakdown, b: TokenUsageBreakdown): boolean {
  return usageKey(a) === usageKey(b);
}

function isZeroUsage(usage: TokenUsageBreakdown): boolean {
  return usage.totalTokens === 0
    && usage.inputTokens === 0
    && usage.cachedInputTokens === 0
    && usage.cacheWriteInputTokens === 0
    && usage.outputTokens === 0
    && usage.reasoningOutputTokens === 0;
}

/** A counted multiset of usage breakdowns, matched on every token field. */
class UsageMultiset {
  private readonly entries = new Map<string, { usage: TokenUsageBreakdown; count: number }>();
  private total = 0;

  get size(): number {
    return this.total;
  }

  add(usage: TokenUsageBreakdown): void {
    const key = usageKey(usage);
    const entry = this.entries.get(key);
    if (entry) entry.count += 1;
    else this.entries.set(key, { usage, count: 1 });
    this.total += 1;
  }

  /** Removes one equal breakdown; false when none is present. */
  take(usage: TokenUsageBreakdown): boolean {
    const key = usageKey(usage);
    const entry = this.entries.get(key);
    if (!entry) return false;
    entry.count -= 1;
    if (entry.count === 0) this.entries.delete(key);
    this.total -= 1;
    return true;
  }

  drain(): TokenUsageBreakdown[] {
    const out: TokenUsageBreakdown[] = [];
    for (const { usage, count } of this.entries.values()) {
      for (let i = 0; i < count; i += 1) out.push(usage);
    }
    this.entries.clear();
    this.total = 0;
    return out;
  }
}

interface ThreadPairingState {
  /** Last `total` seen in this process; a thread first seen here starts at 0. */
  baseline: TokenUsageBreakdown | null;
  unmatchedUpdates: UsageMultiset;
  unmatchedResponses: UsageMultiset;
  nullResponses: number;
  /**
   * Raw Codex input/output of every counted response, plus every update counted
   * as the primary source (a resumed thread) — the oracle's comparand.
   */
  responseInput: number;
  responseOutput: number;
  compacted: boolean;
}

export interface CodexOracleMismatch {
  threadId: string;
  oracleInput: number;
  oracleOutput: number;
  storedInput: number;
  storedOutput: number;
}

export interface CodexUsageSettlement {
  /** Per thread: the `last` of every counted update no response ever matched. */
  topups: Map<string, TokenUsageBreakdown[]>;
  /** `total(end) − total(start)` disagreeing with the stored figure, compaction excluded. */
  oracleMismatches: CodexOracleMismatch[];
  /** (thread, turn) pairs that carried tokenUsage snapshots but no rawResponse/completed. */
  driftTurns: Array<{ threadId: string; turnId: string }>;
}

export class CodexResponsePairingLedger {
  private readonly seenResponseIds = new Set<string>();
  private readonly threads = new Map<string, ThreadPairingState>();
  private readonly turnSources = new Map<string, { threadId: string; turnId: string; updates: boolean; responses: boolean }>();
  private settled = false;

  private thread(threadId: string): ThreadPairingState {
    let state = this.threads.get(threadId);
    if (!state) {
      state = {
        baseline: null,
        unmatchedUpdates: new UsageMultiset(),
        unmatchedResponses: new UsageMultiset(),
        nullResponses: 0,
        responseInput: 0,
        responseOutput: 0,
        compacted: false,
      };
      this.threads.set(threadId, state);
    }
    return state;
  }

  private markTurn(threadId: string, turnId: string, source: 'updates' | 'responses'): void {
    const key = `${threadId}\u0000${turnId}`;
    const entry = this.turnSources.get(key) ?? { threadId, turnId, updates: false, responses: false };
    entry[source] = true;
    this.turnSources.set(key, entry);
  }

  /**
   * Returns false for a response id already seen in this process (a replay).
   * `pair: false` only records the id — for a response whose request was
   * already counted from its update (see CodexProcessUsageTracker's source switch).
   */
  observeResponse(notification: RawResponseCompletedNotification, pair = true): boolean {
    if (this.settled || this.seenResponseIds.has(notification.responseId)) return false;
    this.seenResponseIds.add(notification.responseId);
    this.markTurn(notification.threadId, notification.turnId, 'responses');
    if (!pair) return true;
    const state = this.thread(notification.threadId);
    if (notification.usage === null) {
      state.nullResponses += 1;
      return true;
    }
    state.responseInput += notification.usage.inputTokens;
    state.responseOutput += notification.usage.outputTokens;
    if (!state.unmatchedUpdates.take(notification.usage)) {
      state.unmatchedResponses.add(notification.usage);
    }
    return true;
  }

  /**
   * Returns false for a duplicate emission — an update whose `total` did not
   * move from the thread's baseline, whatever its `last` says (defect A2).
   * `pair: false` is an UPDATE-SOURCED thread (resumed in this process, so it
   * emits no responses): the caller counts `last` itself, so it is neither
   * paired, nor topped up, nor evidence of protocol drift.
   */
  observeTokenUsage(notification: ThreadTokenUsageUpdatedNotification, pair = true): boolean {
    if (this.settled) return false;
    const state = this.thread(notification.threadId);
    const { total, last } = notification.tokenUsage;
    if (state.baseline !== null ? sameUsage(state.baseline, total) : isZeroUsage(total)) return false;
    state.baseline = total;
    if (!pair) {
      state.responseInput += last.inputTokens;
      state.responseOutput += last.outputTokens;
      return true;
    }
    this.markTurn(notification.threadId, notification.turnId, 'updates');
    if (isZeroUsage(last)) return true;
    if (!state.unmatchedResponses.take(last)) {
      state.unmatchedUpdates.add(last);
    }
    return true;
  }

  observeCompaction(threadId: string): void {
    this.thread(threadId).compacted = true;
  }

  /**
   * True while a counted update still waits for its response — beyond those a
   * `usage: null` response already answered, which no response will ever match.
   */
  hasPendingResponse(threadId: string): boolean {
    const state = this.threads.get(threadId);
    if (!state) return false;
    return state.unmatchedUpdates.size > state.nullResponses;
  }

  /**
   * Called once, when the process's client stops. Unmatched updates become
   * top-ups; nothing is observed afterwards.
   */
  settle(): CodexUsageSettlement {
    const settlement: CodexUsageSettlement = { topups: new Map(), oracleMismatches: [], driftTurns: [] };
    if (this.settled) return settlement;
    this.settled = true;
    for (const [threadId, state] of this.threads) {
      const topups = state.unmatchedUpdates.drain();
      if (topups.length > 0) settlement.topups.set(threadId, topups);
      if (state.baseline === null || state.compacted) continue;
      const storedInput = state.responseInput + topups.reduce((sum, usage) => sum + usage.inputTokens, 0);
      const storedOutput = state.responseOutput + topups.reduce((sum, usage) => sum + usage.outputTokens, 0);
      if (storedInput !== state.baseline.inputTokens || storedOutput !== state.baseline.outputTokens) {
        settlement.oracleMismatches.push({
          threadId,
          oracleInput: state.baseline.inputTokens,
          oracleOutput: state.baseline.outputTokens,
          storedInput,
          storedOutput,
        });
      }
    }
    for (const entry of this.turnSources.values()) {
      if (entry.updates && !entry.responses) {
        settlement.driftTurns.push({ threadId: entry.threadId, turnId: entry.turnId });
      }
    }
    return settlement;
  }
}
