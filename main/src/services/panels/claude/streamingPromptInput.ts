import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';

/**
 * Streaming-input prompts for the Agent SDK `query()`.
 *
 * SDK 0.3.201 delivers interactive permission gates — AskUserQuestion and every
 * other `canUseTool` "ask" prompt — as `can_use_tool` control_requests whose
 * control_response must be written back over the query's INPUT stream. A bare
 * STRING prompt is single-shot: stdin closes after the first message, so those
 * control roundtrips fail with "Stream closed" and the gate seam
 * (`routeAskUserQuestion`) never runs. Driving `query()` with an
 * `AsyncIterable<SDKUserMessage>` keeps stdin open, which restores the gate.
 *
 * TWO variants share the same stdin-keepalive mechanism but differ in lifetime:
 *
 *   - {@link createStreamingPromptInput} — SINGLE-SHOT. Yields the prompt once,
 *     then parks until {@link StreamingPromptInput.close}. Used for the lane-spawn
 *     path (programmatic fan-out), where every turn is a fresh single-item query()
 *     that tears the subprocess down at turn end.
 *   - {@link createPersistentPromptInput} — MULTI-TURN (warm sessions). Yields the
 *     initial prompt, then loops: each {@link PersistentPromptInput.push} feeds a
 *     new user message into the SAME live `query()` (a new cyboflow turn) without
 *     respawning the claude subprocess; {@link PersistentPromptInput.close} ends the
 *     generator so the CLI exits. This is what makes a warm SDK session skip the
 *     ~5s per-turn bootstrap: one `query()` spans many cyboflow turns.
 *
 * The former "one cyboflow turn is one query()" contract now holds only for the
 * single-shot/lane path; a persistent input's `query()` outlives its turns.
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
 * A multi-turn streaming input for a WARM SDK session. The generator yields the
 * initial message, then services {@link push}ed messages in FIFO order — each is
 * one further cyboflow turn on the same live `query()` — until {@link close}.
 */
export interface PersistentPromptInput {
  /**
   * The long-lived `AsyncIterable` handed to `query({ prompt })`. It stays open
   * across turns: after the initial message it parks, waking on each {@link push}
   * to yield the next turn's message, and returning on {@link close}.
   */
  readonly stream: AsyncGenerator<SDKUserMessage, void>;
  /**
   * Feed the next turn's user message into the live query. Returns `true` when the
   * message was accepted; `false` once {@link close} has been called (the input is
   * closing / closed — the caller must NOT commit a turn, since the message will
   * never be delivered). Ordering is preserved (FIFO); a push while the generator
   * is parked wakes it.
   */
  push(text: string): boolean;
  /**
   * End the generator (stdin closes → CLI exits → the driving `for await`
   * drains). Idempotent — safe from the idle-TTL, process-death, and abort paths.
   */
  close(): void;
}

/** Build the SDKUserMessage the SDK expects for a plain-text user turn. */
function buildUserMessage(text: string): SDKUserMessage {
  return {
    type: 'user',
    message: { role: 'user', content: text },
    parent_tool_use_id: null,
    session_id: '',
  };
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
    yield buildUserMessage(text);
    // Park so the SDK keeps stdin open to service can_use_tool control
    // roundtrips. Promise resolution is idempotent, so a redundant close() no-ops.
    await gate;
  }

  return {
    stream: generate(),
    close: () => releaseGate(),
  };
}

/**
 * Build a {@link PersistentPromptInput} whose generator yields `initialText`, then
 * stays open across turns: each {@link PersistentPromptInput.push} enqueues a new
 * user message the generator yields (in FIFO order) as the next turn's input, and
 * {@link PersistentPromptInput.close} ends it. This keeps ONE `query()`/claude
 * subprocess alive for a warm session's whole lifetime.
 */
export function createPersistentPromptInput(initialText: string): PersistentPromptInput {
  const pending: string[] = [];
  let closed = false;
  // Resolves the generator's park so it re-checks the queue / closed flag. Null
  // while the generator is not parked; set only around the awaited promise.
  let wake: (() => void) | null = null;
  const notify = (): void => {
    const w = wake;
    wake = null;
    if (w) w();
  };

  async function* generate(): AsyncGenerator<SDKUserMessage, void> {
    yield buildUserMessage(initialText);
    // Drain-then-park loop. The drain, the closed check, and the wake assignment
    // are all synchronous (no await between them), so push()/close() — which run
    // only while this generator is parked at the awaited promise — cannot
    // interleave and be missed: whatever they enqueue is drained on the next wake.
    while (true) {
      const next = pending.shift();
      if (next !== undefined) {
        yield buildUserMessage(next);
        continue;
      }
      if (closed) return;
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
    }
  }

  return {
    stream: generate(),
    push: (text: string): boolean => {
      if (closed) return false;
      pending.push(text);
      notify();
      return true;
    },
    close: () => {
      closed = true;
      notify();
    },
  };
}
