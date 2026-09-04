import type { AgentUsage } from '../../../../../../shared/types/agentStream';
import type { TokenUsageBreakdown } from './protocol';

export class CodexTurnUsageAccumulator {
  private inputTokens = 0;
  private cachedInputTokens = 0;
  private cacheWriteInputTokens = 0;
  private outputTokens = 0;
  private reasoningOutputTokens = 0;
  private updateCount = 0;

  addLastUsage(usage: TokenUsageBreakdown): void {
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
    this.updateCount += 1;
  }

  snapshot(): AgentUsage | undefined {
    if (this.updateCount === 0) return undefined;
    return {
      input_tokens: this.inputTokens,
      output_tokens: this.outputTokens,
      cache_read_input_tokens: this.cachedInputTokens,
      cache_creation_input_tokens: this.cacheWriteInputTokens,
      reasoning_output_tokens: this.reasoningOutputTokens,
    };
  }
}
