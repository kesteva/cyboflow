import type { AgentUsage } from '../../../../../../shared/types/agentStream';
import type { TokenUsageBreakdown } from './protocol';

/**
 * Additive usage for one scope (a thread, a turn): Codex breakdowns converted to
 * the four DISJOINT AgentUsage buckets plus reasoning.
 */
export class CodexUsageTotals {
  private inputTokens = 0;
  private cachedInputTokens = 0;
  private cacheWriteInputTokens = 0;
  private outputTokens = 0;
  private reasoningOutputTokens = 0;
  private addCount = 0;

  add(usage: TokenUsageBreakdown): void {
    // Codex's `inputTokens` is the WHOLE prompt: it already contains both the
    // cache reads and (since 0.153.3) the cache writes — the Responses parser
    // (`codex-api/src/sse/responses.rs`, `parses_cache_write_token_usage`)
    // fixes input=100 as cached=40 + cacheWrite=60. Subtract both so the four
    // AgentUsage buckets stay DISJOINT, exactly as they are for Claude and OMP;
    // consumers (runContextUsageListing, liveContextUsage) sum
    // input + cache_read + cache_creation back into the prompt size.
    this.inputTokens += Math.max(
      0,
      usage.inputTokens - usage.cachedInputTokens - usage.cacheWriteInputTokens,
    );
    this.cachedInputTokens += usage.cachedInputTokens;
    this.cacheWriteInputTokens += usage.cacheWriteInputTokens;
    this.outputTokens += usage.outputTokens;
    this.reasoningOutputTokens += usage.reasoningOutputTokens;
    this.addCount += 1;
  }

  get count(): number {
    return this.addCount;
  }

  snapshot(): AgentUsage | undefined {
    if (this.addCount === 0) return undefined;
    return {
      input_tokens: this.inputTokens,
      output_tokens: this.outputTokens,
      cache_read_input_tokens: this.cachedInputTokens,
      cache_creation_input_tokens: this.cacheWriteInputTokens,
      reasoning_output_tokens: this.reasoningOutputTokens,
    };
  }
}

/**
 * One invocation's Codex usage, counted per upstream response
 * (`rawResponse/completed`), with a separate total per thread. The root thread
 * feeds the invocation's `agent_result`; every other thread is a collab
 * descendant with its own `subagent_usage` row, so the two outputs are disjoint
 * by construction.
 */
export class CodexTurnUsageAccumulator {
  private readonly seenResponseIds = new Set<string>();
  private readonly threads = new Map<string, CodexUsageTotals>();

  constructor(private rootThreadId: string | null = null) {}

  /** Binds the lane's root thread (unknown until a cold spawn opens it). */
  setRootThread(threadId: string): void {
    this.rootThreadId = threadId;
  }

  /**
   * Counts one response. Idempotent per `responseId`: a replayed response adds
   * nothing. A response with `usage: null` is remembered (so its replay is still
   * a no-op) but adds no tokens — the tokenUsage fallback tops it up.
   * Returns false when the response was already counted.
   */
  observeResponse(threadId: string, responseId: string, usage: TokenUsageBreakdown | null): boolean {
    if (this.seenResponseIds.has(responseId)) return false;
    this.seenResponseIds.add(responseId);
    if (usage === null) return true;
    let totals = this.threads.get(threadId);
    if (!totals) {
      totals = new CodexUsageTotals();
      this.threads.set(threadId, totals);
    }
    totals.add(usage);
    return true;
  }

  /** The root thread only — the invocation's `agent_result` usage. */
  rootSnapshot(): AgentUsage | undefined {
    if (this.rootThreadId === null) return undefined;
    return this.threads.get(this.rootThreadId)?.snapshot();
  }

  /** One cumulative total per descendant thread; never the root. */
  descendantSnapshots(): Map<string, AgentUsage> {
    const out = new Map<string, AgentUsage>();
    for (const [threadId, totals] of this.threads) {
      if (threadId === this.rootThreadId) continue;
      const snapshot = totals.snapshot();
      if (snapshot) out.set(threadId, snapshot);
    }
    return out;
  }

  /** One descendant's cumulative total, or undefined before its first counted response. */
  threadSnapshot(threadId: string): AgentUsage | undefined {
    return this.threads.get(threadId)?.snapshot();
  }
}
