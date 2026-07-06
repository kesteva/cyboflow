/**
 * Unit tests for createStreamingPromptInput — the streaming-input prompt that
 * keeps the Agent SDK query()'s stdin open so can_use_tool control roundtrips
 * (AskUserQuestion + interactive permission "ask") can be answered. Covered:
 *   - yields the initial user message EXACTLY once, byte-identical content;
 *   - after the yield the generator PARKS (does not complete) until close();
 *   - close() releases the gate so the generator completes (done: true);
 *   - close() is idempotent (safe from the result / finally / abort paths).
 */
import { describe, it, expect } from 'vitest';
import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { createStreamingPromptInput } from '../streamingPromptInput';

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
