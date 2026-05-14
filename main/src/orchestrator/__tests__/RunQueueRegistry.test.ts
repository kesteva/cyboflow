/**
 * Unit tests for RunQueueRegistry.
 *
 * Timing is controlled with explicit await checkpoints (Promise resolution
 * boundaries), not wall-clock sleeps.
 */
import { describe, it, expect } from 'vitest';
import { RunQueueRegistry } from '../RunQueueRegistry';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Deferred promise — lets tests control when a queued task resolves. */
function deferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('RunQueueRegistry', () => {
  // (a) Two enqueues for the same runId run sequentially
  it('two tasks enqueued on the same runId run sequentially, not concurrently', async () => {
    const registry = new RunQueueRegistry();
    const q = registry.getOrCreate('run-1');

    const order: number[] = [];
    const gate = deferred();

    // First task: blocks on gate, then records itself
    const t1 = q.add(async () => {
      await gate.promise;
      order.push(1);
    });

    // Second task: would run concurrently if concurrency > 1
    const t2 = q.add(async () => {
      order.push(2);
    });

    // While gate is still blocking, task 2 cannot have started
    expect(q.size).toBe(1); // t2 is waiting
    expect(q.pending).toBe(1); // t1 is active

    // Unblock t1
    gate.resolve();
    await t1;
    await t2;

    expect(order).toEqual([1, 2]);
  });

  // (b) Two enqueues for different runIds run concurrently
  it('tasks on different runIds are not serialized against each other', async () => {
    const registry = new RunQueueRegistry();
    const q1 = registry.getOrCreate('run-A');
    const q2 = registry.getOrCreate('run-B');

    const started: string[] = [];
    const gateA = deferred();
    const gateB = deferred();

    // Enqueue a blocking task on each queue
    const tA = q1.add(async () => {
      started.push('A');
      await gateA.promise;
    });
    const tB = q2.add(async () => {
      started.push('B');
      await gateB.promise;
    });

    // Both tasks should start immediately (different queues, each concurrency:1)
    // Yield once to let microtasks flush
    await Promise.resolve();
    await Promise.resolve();

    expect(started).toContain('A');
    expect(started).toContain('B');

    // Clean up
    gateA.resolve();
    gateB.resolve();
    await tA;
    await tB;
  });

  // (c) delete(runId) drains the queue before removing it from the map
  it('delete() waits for in-flight tasks before removing the queue', async () => {
    const registry = new RunQueueRegistry();
    const q = registry.getOrCreate('run-X');

    let taskFinished = false;
    const gate = deferred();

    // Enqueue a task that won't finish until we resolve the gate
    void q.add(async () => {
      await gate.promise;
      taskFinished = true;
    });

    // Start delete (it should await onIdle internally)
    const deletePromise = registry.delete('run-X');

    // Task has not finished yet
    expect(taskFinished).toBe(false);
    // run-X is still in the map while draining
    expect(registry.has('run-X')).toBe(true);

    // Unblock the task
    gate.resolve();
    await deletePromise;

    expect(taskFinished).toBe(true);
    // Queue removed after idle
    expect(registry.has('run-X')).toBe(false);
  });

  // (e) getOrCreate() is idempotent — same PQueue instance on repeated calls
  it('getOrCreate() returns the same queue instance on repeated calls for the same runId', () => {
    const registry = new RunQueueRegistry();
    const q1 = registry.getOrCreate('run-idem');
    const q2 = registry.getOrCreate('run-idem');
    expect(q1).toBe(q2);
    expect(registry.stats().runs).toBe(1);
  });

  // (f) stats() reports correct totalPending and totalActive counts
  it('stats() reflects pending and active counts across queues', async () => {
    const registry = new RunQueueRegistry();

    const gateA = deferred();
    const gateB = deferred();

    const qA = registry.getOrCreate('run-S1');
    const qB = registry.getOrCreate('run-S2');

    // qA: one active task + one pending task
    void qA.add(async () => { await gateA.promise; });
    void qA.add(async () => { /* immediate */ });
    // qB: one active task
    void qB.add(async () => { await gateB.promise; });

    // Yield to let the active tasks start
    await Promise.resolve();
    await Promise.resolve();

    const s = registry.stats();
    expect(s.runs).toBe(2);
    expect(s.totalActive).toBe(2); // one active in each queue
    expect(s.totalPending).toBe(1); // second task in qA is waiting

    gateA.resolve();
    gateB.resolve();
    await qA.onIdle();
    await qB.onIdle();
  });

  // (g) delete() on an unknown runId is a no-op (does not throw)
  it('delete() on a runId that does not exist resolves without error', async () => {
    const registry = new RunQueueRegistry();
    await expect(registry.delete('nonexistent')).resolves.toBeUndefined();
    expect(registry.has('nonexistent')).toBe(false);
  });

  // (d) drainAll() resolves only after every queue is idle
  it('drainAll() resolves only after all queues are idle', async () => {
    const registry = new RunQueueRegistry();

    const gateA = deferred();
    const gateB = deferred();
    const finished: string[] = [];

    const qA = registry.getOrCreate('run-P');
    const qB = registry.getOrCreate('run-Q');

    void qA.add(async () => {
      await gateA.promise;
      finished.push('P');
    });
    void qB.add(async () => {
      await gateB.promise;
      finished.push('Q');
    });

    const drainPromise = registry.drainAll();

    // Neither task has finished yet
    expect(finished).toHaveLength(0);

    // Unblock both
    gateA.resolve();
    gateB.resolve();

    await drainPromise;

    expect(finished).toContain('P');
    expect(finished).toContain('Q');
    // Registry is cleared after drainAll
    expect(registry.stats().runs).toBe(0);
  });
});
