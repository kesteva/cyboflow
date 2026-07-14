import type { AgentUsage } from '../../../../../../shared/types/agentStream';
import type { TokenUsageBreakdown } from './protocol';

export class CodexTurnUsageAccumulator {
  private inputTokens = 0;
  private cachedInputTokens = 0;
  private outputTokens = 0;
  private reasoningOutputTokens = 0;
  private updateCount = 0;

  addLastUsage(usage: TokenUsageBreakdown): void {
    this.inputTokens += Math.max(0, usage.inputTokens - usage.cachedInputTokens);
    this.cachedInputTokens += usage.cachedInputTokens;
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
      reasoning_output_tokens: this.reasoningOutputTokens,
    };
  }
}
