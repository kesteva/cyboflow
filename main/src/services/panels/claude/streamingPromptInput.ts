import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';

/**
 * A single-turn streaming-input prompt for the Agent SDK `query()`.
 *
 * SDK 0.3.201 delivers interactive permission gates — AskUserQuestion and every
 * other `canUseTool` "ask" prompt — as `can_use_tool` control_requests whose
 * control_response must be written back over the query's INPUT stream. A bare
 * STRING prompt is single-shot: stdin closes after the first message, so those
 * control roundtrips fail with "Stream closed" and the gate seam
 * (`routeAskUserQuestion`) never runs. Driving `query()` with an
 * `AsyncIterable<SDKUserMessage>` keeps stdin open for the turn's lifetime,
 * which restores the gate.
 *
 * The contract of one cyboflow turn is one `query()`: the generator yields the
 * prompt EXACTLY once, then PARKS on a gate promise so the SDK keeps stdin open.
 * The caller releases the gate (via {@link close}) when the turn ends — on the
 * terminal `result` event, on any loop exit, and on abort — at which point the
 * generator returns, stdin closes, and the CLI exits. WITHOUT the close-on-result
 * the CLI sits waiting for more input and the `for await` never drains (verified
 * live against the 0.3.201 CLI).
 */
export interface StreamingPromptInput {
  /**
   * The single-use `AsyncIterable` to hand to `query({ prompt })`. Yields one
   * `SDKUserMessage` carrying the prompt text, then blocks until {@link close}.
   */
  readonly stream: AsyncGenerator<SDKUserMessage, void>;
  /**
   * Release the input gate so the generator returns (stdin closes → CLI exits).
   * Idempotent — safe to call from the result-event, loop-exit, and abort paths.
   */
  close(): void;
}

/**
 * Build a {@link StreamingPromptInput} carrying `text` as the turn's initial —
 * and only — user message. The message content is byte-identical to `text`.
 */
export function createStreamingPromptInput(text: string): StreamingPromptInput {
  // Resolved by close(); parks the generator after the initial yield. Assigned
  // synchronously inside the Promise executor, so it is defined before return.
  let releaseGate: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    releaseGate = resolve;
  });

  async function* generate(): AsyncGenerator<SDKUserMessage, void> {
    yield {
      type: 'user',
      message: { role: 'user', content: text },
      parent_tool_use_id: null,
      session_id: '',
    };
    // Park so the SDK keeps stdin open to service can_use_tool control
    // roundtrips. Promise resolution is idempotent, so a redundant close() no-ops.
    await gate;
  }

  return {
    stream: generate(),
    close: () => releaseGate(),
  };
}
