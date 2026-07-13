/**
 * Unit tests for createStreamingPromptInput — the streaming-input prompt that
 * keeps the Agent SDK query()'s stdin open so can_use_tool control roundtrips
 * (AskUserQuestion + interactive permission "ask") can be answered. Covered:
 *   - yields the initial user message EXACTLY once, byte-identical content;
 *   - after the yield the generator PARKS (does not complete) until close();
 *   - close() releases the gate so the generator completes (done: true);
 *   - close() is idempotent (safe from the result / finally / abort paths).
 *
 * Plus the MID-TURN operator-steering push (live-steer plumbing): the single-shot
 * input is now pushable so a running step agent can be steered without respawn.
 * Covered:
 *   - a mid-stream push yields the pushed message (in FIFO order) after the initial;
 *   - `{ steering: true }` stamps priority 'now'; a plain push omits priority;
 *   - push after close() returns false (the message would never be delivered);
 *   - a push queued just before close() still drains before the generator returns;
 *   - the persistent variant's push accepts the same steering opt.
 */
import { describe, it, expect } from 'vitest';
import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { createStreamingPromptInput, createPersistentPromptInput } from '../streamingPromptInput';

/** A pending-state probe: has `promise` settled by the next microtask flush? */
async function isPending(promise: Promise<unknown>): Promise<boolean> {
  const sentinel = Symbol('pending');
  const race = await Promise.race([promise.then(() => 'settled'), Promise.resolve(sentinel)]);
  return race === sentinel;
}

describe('createStreamingPromptInput', () => {
  it('yields exactly one initial user message carrying the prompt verbatim', async () => {
    const { stream } = createStreamingPromptInput('do the thing');
    const first = await stream.next();
    expect(first.done).toBe(false);
    const message = first.value as SDKUserMessage;
    expect(message).toEqual({
      type: 'user',
      message: { role: 'user', content: 'do the thing' },
      parent_tool_use_id: null,
      session_id: '',
    });
  });

  it('parks after the initial yield and completes only once close() is called', async () => {
    const { stream, close } = createStreamingPromptInput('hello');
    await stream.next(); // consume the initial message

    // The second pull PARKS — the SDK is meant to hold stdin open for the turn.
    const parked = stream.next();
    expect(await isPending(parked)).toBe(true);

    // Releasing the gate lets the generator return (stdin closes → CLI exits).
    close();
    const settled = await parked;
    expect(settled.done).toBe(true);
    expect(settled.value).toBeUndefined();
  });

  it('close() before the parked pull still terminates the generator', async () => {
    const { stream, close } = createStreamingPromptInput('hi');
    await stream.next();
    close(); // e.g. result observed before we pulled again
    const settled = await stream.next();
    expect(settled.done).toBe(true);
  });

  it('close() is idempotent (result + finally + abort paths all call it)', async () => {
    const { stream, close } = createStreamingPromptInput('x');
    await stream.next();
    expect(() => {
      close();
      close();
      close();
    }).not.toThrow();
    const settled = await stream.next();
    expect(settled.done).toBe(true);
  });
});

describe('createStreamingPromptInput — mid-turn steering push', () => {
  it('a mid-stream push yields the pushed message after the initial (FIFO order)', async () => {
    const { stream, push } = createStreamingPromptInput('initial');
    const first = await stream.next();
    expect((first.value as SDKUserMessage).message.content).toBe('initial');

    // Two pushes while the generator is parked — delivered in FIFO order.
    expect(push('steer one')).toBe(true);
    expect(push('steer two')).toBe(true);

    const second = await stream.next();
    expect(second.done).toBe(false);
    expect((second.value as SDKUserMessage).message.content).toBe('steer one');
    const third = await stream.next();
    expect((third.value as SDKUserMessage).message.content).toBe('steer two');
  });

  it("push({ steering: true }) stamps priority 'now'; a plain push omits priority", async () => {
    const { stream, push } = createStreamingPromptInput('initial');
    await stream.next(); // consume the initial message

    push('plain follow');
    push('steer now', { steering: true });

    const plain = (await stream.next()).value as SDKUserMessage;
    expect(plain.message.content).toBe('plain follow');
    expect(plain.priority).toBeUndefined();

    const steered = (await stream.next()).value as SDKUserMessage;
    expect(steered.message.content).toBe('steer now');
    expect(steered.priority).toBe('now');
  });

  it('push after close() returns false and enqueues nothing', async () => {
    const { stream, push, close } = createStreamingPromptInput('initial');
    await stream.next();
    close();
    expect(push('too late')).toBe(false);
    // The rejected push added nothing, so the generator still terminates cleanly.
    const settled = await stream.next();
    expect(settled.done).toBe(true);
  });

  it('a push queued just before close() still drains before the generator returns', async () => {
    const { stream, push, close } = createStreamingPromptInput('initial');
    await stream.next();
    // Push then immediately close: the queued push must still be yielded (the loop
    // drains the queue before honoring the closed flag), and only THEN completes.
    expect(push('pending steer')).toBe(true);
    close();

    const drained = await stream.next();
    expect(drained.done).toBe(false);
    expect((drained.value as SDKUserMessage).message.content).toBe('pending steer');

    const settled = await stream.next();
    expect(settled.done).toBe(true);
  });
});

describe('createPersistentPromptInput — steering opt parity', () => {
  it("a persistent push with { steering: true } also stamps priority 'now'", async () => {
    const { stream, push } = createPersistentPromptInput('initial');
    await stream.next(); // consume the initial message

    expect(push('steer', { steering: true })).toBe(true);
    const steered = (await stream.next()).value as SDKUserMessage;
    expect(steered.message.content).toBe('steer');
    expect(steered.priority).toBe('now');
  });
});
