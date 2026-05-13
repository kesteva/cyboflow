/**
 * Unit tests for EventRouter.
 *
 * Covers: per-runId fanout isolation; handler teardown via returned function;
 * clearRun removes all listeners; emitForRun does not cross-talk between runIds.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventRouter } from '../eventRouter';
import type { ClaudeStreamEvent } from '../../../../../shared/types/claudeStream';

// ---------------------------------------------------------------------------
// Fixture events — minimal inline variants
// ---------------------------------------------------------------------------

const systemEvent: ClaudeStreamEvent = {
  type: 'system',
  subtype: 'init',
  session_id: 'sess-001',
  cwd: '/tmp',
  model: 'claude-opus',
  tools: [],
  mcp_servers: [],
  permissionMode: 'default',
};

const assistantEvent: ClaudeStreamEvent = {
  type: 'assistant',
  message: {
    id: 'msg-001',
    model: 'claude-opus',
    role: 'assistant',
    content: [{ type: 'text', text: 'hello' }],
  },
};

const resultEvent: ClaudeStreamEvent = {
  type: 'result',
  subtype: 'success',
  is_error: false,
  duration_ms: 100,
  num_turns: 1,
};

describe('EventRouter', () => {
  let router: EventRouter;

  beforeEach(() => {
    router = new EventRouter();
  });

  // -------------------------------------------------------------------------
  // Basic fanout
  // -------------------------------------------------------------------------

  it('invokes handler when emitForRun is called with matching runId', () => {
    const handler = vi.fn();
    router.onRun('run-A', handler);
    router.emitForRun('run-A', systemEvent);
    expect(handler).toHaveBeenCalledOnce();
    expect(handler).toHaveBeenCalledWith(systemEvent);
  });

  // -------------------------------------------------------------------------
  // Per-runId isolation — core AC assertion
  //   Register two handlers on two runIds, dispatch three events,
  //   assert each handler received only its own.
  // -------------------------------------------------------------------------

  it('does NOT invoke runId-B handler when emitting to runId-A (isolation)', () => {
    const handlerA = vi.fn();
    const handlerB = vi.fn();

    router.onRun('run-A', handlerA);
    router.onRun('run-B', handlerB);

    // Three events: two for A, one for B
    router.emitForRun('run-A', systemEvent);
    router.emitForRun('run-A', assistantEvent);
    router.emitForRun('run-B', resultEvent);

    expect(handlerA).toHaveBeenCalledTimes(2);
    expect(handlerA).toHaveBeenNthCalledWith(1, systemEvent);
    expect(handlerA).toHaveBeenNthCalledWith(2, assistantEvent);

    expect(handlerB).toHaveBeenCalledOnce();
    expect(handlerB).toHaveBeenCalledWith(resultEvent);
  });

  // -------------------------------------------------------------------------
  // Multiple handlers on the same runId
  // -------------------------------------------------------------------------

  it('invokes multiple handlers registered for the same runId', () => {
    const h1 = vi.fn();
    const h2 = vi.fn();
    router.onRun('run-A', h1);
    router.onRun('run-A', h2);
    router.emitForRun('run-A', systemEvent);
    expect(h1).toHaveBeenCalledOnce();
    expect(h2).toHaveBeenCalledOnce();
  });

  // -------------------------------------------------------------------------
  // Teardown via returned function
  // -------------------------------------------------------------------------

  it('onRun returns a teardown function that removes the handler', () => {
    const handler = vi.fn();
    const teardown = router.onRun('run-A', handler);

    router.emitForRun('run-A', systemEvent);
    expect(handler).toHaveBeenCalledOnce();

    teardown(); // Remove handler

    router.emitForRun('run-A', assistantEvent);
    // Handler should NOT have been called a second time
    expect(handler).toHaveBeenCalledOnce();
  });

  it('teardown only removes the specific handler, not other handlers on the same runId', () => {
    const h1 = vi.fn();
    const h2 = vi.fn();
    const teardown1 = router.onRun('run-A', h1);
    router.onRun('run-A', h2);

    teardown1();

    router.emitForRun('run-A', systemEvent);
    expect(h1).not.toHaveBeenCalled();
    expect(h2).toHaveBeenCalledOnce();
  });

  // -------------------------------------------------------------------------
  // clearRun removes ALL handlers for a runId
  // -------------------------------------------------------------------------

  it('clearRun removes all handlers for a runId', () => {
    const h1 = vi.fn();
    const h2 = vi.fn();
    router.onRun('run-A', h1);
    router.onRun('run-A', h2);

    router.clearRun('run-A');
    router.emitForRun('run-A', systemEvent);

    expect(h1).not.toHaveBeenCalled();
    expect(h2).not.toHaveBeenCalled();
  });

  it('clearRun for run-A does not affect run-B handlers', () => {
    const handlerA = vi.fn();
    const handlerB = vi.fn();
    router.onRun('run-A', handlerA);
    router.onRun('run-B', handlerB);

    router.clearRun('run-A');
    router.emitForRun('run-B', resultEvent);

    expect(handlerA).not.toHaveBeenCalled();
    expect(handlerB).toHaveBeenCalledOnce();
  });

  // -------------------------------------------------------------------------
  // Emit with no handlers — no crash
  // -------------------------------------------------------------------------

  it('emitForRun with no registered handlers does not throw', () => {
    expect(() => router.emitForRun('nonexistent-run', systemEvent)).not.toThrow();
  });
});
