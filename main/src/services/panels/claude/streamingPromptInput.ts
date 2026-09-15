import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { AgentThreadImageAttachment } from '../../../../../shared/types/agentThread';

/**
 * The `message.content` shape an `SDKUserMessage` accepts — a plain string, or
 * an array of Anthropic content blocks. Derived from the SDK type rather than
 * re-declared so a future SDK widening/narrowing fails the build here.
 */
type UserMessageContent = SDKUserMessage['message']['content'];
type UserMessageBlocks = Exclude<UserMessageContent, string>;

/** Per-message options shared by every builder/push seam. */
export interface PromptMessageOptions {
  /** Stamp `priority: 'now'` — the CLI steering queue's mid-turn interjection. */
  steering?: boolean;
  /**
   * Image attachments to send as REAL content blocks alongside the text. Absent
   * or empty ⇒ `message.content` stays the plain string it has always been (the
   * byte-identical normal turn); present ⇒ content becomes a block array with
   * the text block first, then one `image`/`base64` block per attachment.
   */
  images?: readonly AgentThreadImageAttachment[];
}

/**
 * Build a turn's `message.content`.
 *
 * NO images ⇒ the bare string, byte-identical to every pre-attachment turn.
 * With images ⇒ `[text?, ...image]` blocks. An EMPTY text is omitted rather
 * than sent as an empty text block (the API rejects those), which is what makes
 * an image-only turn legal.
 */
function buildUserContent(text: string, images?: readonly AgentThreadImageAttachment[]): UserMessageContent {
  if (images === undefined || images.length === 0) return text;
  const blocks: UserMessageBlocks = [];
  if (text !== '') blocks.push({ type: 'text', text });
  for (const image of images) {
    blocks.push({
      type: 'image',
      source: { type: 'base64', media_type: image.mediaType, data: image.base64 },
    });
  }
  return blocks;
}

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
 * TWO variants share the SAME drain-then-park engine (createPushablePromptInput)
 * but differ in how the DRIVER treats the input's lifetime:
 *
 *   - {@link createStreamingPromptInput} — SINGLE-SHOT. Yields the prompt once,
 *     then parks until {@link StreamingPromptInput.close}. Used for the lane-spawn
 *     path (programmatic fan-out), where every turn is a fresh single-item query()
 *     that tears the subprocess down at turn end. It is now ALSO pushable
 *     ({@link StreamingPromptInput.push}) so an operator can interject a MID-TURN
 *     steering message into a running step agent — a `priority: 'now'` user message
 *     the CLI's steering queue delivers at the agent's next loop boundary within
 *     the CURRENT turn. This does NOT make the single-shot input multi-turn: it
 *     still closes at the turn's result event (the driver's shouldClose branch).
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
   * The `AsyncIterable` to hand to `query({ prompt })`. Yields one `SDKUserMessage`
   * carrying the prompt text, then parks until {@link close} — servicing any
   * {@link push}ed steering message in between.
   */
  readonly stream: AsyncGenerator<SDKUserMessage, void>;
  /**
   * Interject an ADDITIONAL user message into the still-open turn. Returns `true`
   * when accepted; `false` once {@link close} has been called (push-after-close —
   * the message would never be delivered). This exists for MID-TURN operator
   * steering: pass `{ steering: true }` to stamp `priority: 'now'` so the running
   * agent sees the message at its next loop boundary. Ordering is FIFO; a push
   * while the generator is parked wakes it. Because the single-shot input still
   * closes at the turn's result event, a push is only meaningful DURING the turn.
   */
  push(text: string, opts?: PromptMessageOptions): boolean;
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
   * is parked wakes it. Pass `{ steering: true }` to stamp `priority: 'now'` for a
   * mid-turn interjection (the operator-steer path) rather than a fresh turn.
   */
  push(text: string, opts?: PromptMessageOptions): boolean;
  /**
   * End the generator (stdin closes → CLI exits → the driving `for await`
   * drains). Idempotent — safe from the idle-TTL, process-death, and abort paths.
   */
  close(): void;
}

/**
 * Build the SDKUserMessage the SDK expects for a plain-text user turn.
 *
 * `origin: { kind: 'human' }` is REQUIRED, not decorative. Through agent-sdk
 * 0.3.201 an absent `origin` meant "keyboard input from the user"; 0.3.224
 * inverted that — an unstamped user message is now treated as UNATTRIBUTED and
 * fails closed at the CLI's strict `isHuman()` trust gates, which is how the
 * cross-session peer-messaging work distinguishes a real operator turn from a
 * machine-injected one. Everything this factory builds is first-party host
 * input carrying the operator's authority (a composer message, or an
 * orchestrator prompt for a run the operator launched), so stamping `human`
 * PRESERVES the pre-bump semantics rather than granting new authority. Peer
 * traffic never reaches this path — the harness stamps `{ kind: 'peer' }` on
 * that itself, from kernel-verified credentials we cannot forge from here.
 *
 * `opts.steering` stamps `priority: 'now'` — the CLI's steering-queue priority
 * that interjects the message into the CURRENT in-flight turn at the agent's next
 * loop boundary (the same engine as typing while Claude works in the interactive
 * REPL). A normal turn omits `priority`, so its serialized bytes are unchanged.
 */
function buildUserMessage(text: string, opts?: PromptMessageOptions): SDKUserMessage {
  return {
    type: 'user',
    message: { role: 'user', content: buildUserContent(text, opts?.images) },
    parent_tool_use_id: null,
    session_id: '',
    origin: { kind: 'human' },
    // Spread nothing else on the normal path so the message stays byte-identical
    // to the pre-steering shape; only a steering push adds the priority
    // discriminator.
    ...(opts?.steering ? { priority: 'now' as const } : {}),
  };
}

/** A queued push: the text plus its (optional) steering flag, carried FIFO. */
interface PendingPush {
  text: string;
  opts?: PromptMessageOptions;
}

/**
 * Shared drain-then-park engine for BOTH prompt-input variants. The generator
 * yields `initialText`, then loops: drain the FIFO queue, and when it is empty
 * either return (closed) or park on a wake promise. The single-shot and
 * persistent variants are the SAME mechanism — they differ only in how the
 * DRIVER treats the input's lifetime (single-shot closes it at the turn's result
 * event; persistent keeps it open across turns). Factoring it here keeps the one
 * interleaving-safety argument (below) in a single place so the two cannot drift.
 */
function createPushablePromptInput(
  initialText: string,
  initialImages?: readonly AgentThreadImageAttachment[],
): {
  stream: AsyncGenerator<SDKUserMessage, void>;
  push: (text: string, opts?: PromptMessageOptions) => boolean;
  close: () => void;
} {
  const pending: PendingPush[] = [];
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
    yield buildUserMessage(initialText, initialImages === undefined ? undefined : { images: initialImages });
    // Drain-then-park loop. The drain, the closed check, and the wake assignment
    // are all synchronous (no await between them), so push()/close() — which run
    // only while this generator is parked at the awaited promise — cannot
    // interleave and be missed: whatever they enqueue is drained on the next wake.
    while (true) {
      const next = pending.shift();
      if (next !== undefined) {
        yield buildUserMessage(next.text, next.opts);
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
    push: (text: string, opts?: PromptMessageOptions): boolean => {
      if (closed) return false;
      pending.push({ text, opts });
      notify();
      return true;
    },
    close: (): void => {
      closed = true;
      notify();
    },
  };
}

/**
 * Build a {@link StreamingPromptInput} carrying `text` as the turn's initial user
 * message. The message content is byte-identical to `text`. The input parks after
 * that initial yield (keeping stdin open for can_use_tool roundtrips) and closes
 * on {@link StreamingPromptInput.close}. It is also PUSHABLE — a mid-turn
 * {@link StreamingPromptInput.push} interjects a steering message into the live
 * turn — but it remains conceptually single-shot: the driver closes it at the
 * turn's result event, so it never spans turns the way the persistent variant does.
 */
export function createStreamingPromptInput(
  text: string,
  images?: readonly AgentThreadImageAttachment[],
): StreamingPromptInput {
  return createPushablePromptInput(text, images);
}

/**
 * Build a {@link PersistentPromptInput} whose generator yields `initialText`, then
 * stays open across turns: each {@link PersistentPromptInput.push} enqueues a new
 * user message the generator yields (in FIFO order) as the next turn's input, and
 * {@link PersistentPromptInput.close} ends it. This keeps ONE `query()`/claude
 * subprocess alive for a warm session's whole lifetime.
 */
export function createPersistentPromptInput(
  initialText: string,
  images?: readonly AgentThreadImageAttachment[],
): PersistentPromptInput {
  return createPushablePromptInput(initialText, images);
}
