/**
 * RunQueueRegistry — per-run serialization registry.
 *
 * Each workflow run gets its own PQueue({ concurrency: 1 }) so that state
 * mutations within a run are serialized while different runs proceed
 * concurrently.
 *
 * -----------------------------------------------------------------------
 * no-recursive-enqueue rule
 * -----------------------------------------------------------------------
 * Status-change events flow via EventEmitter, NOT by re-entering the queue.
 * Calling registry.getOrCreate(runId).add(...) from inside a task already
 * enqueued on the same runId is a self-deadlock — see p-queue README warning.
 * -----------------------------------------------------------------------
 */
import PQueue from 'p-queue';

/**
 * How long drainAll waits for one busy queue whose task it cannot identify.
 * State mutations are sub-second database writes, so this is a backstop for an
 * unknown long task, not the mechanism for the known one — see `shouldWait`.
 * It sits inside the quit-drain ceiling in services/quitDrain.ts.
 */
const DRAIN_CAP_MS = 5_000;

export class RunQueueRegistry {
  private queues = new Map<string, PQueue>();

  /**
   * Returns the existing queue for `runId`, or lazily creates one with
   * { concurrency: 1 } and stores it.
   *
   * NOTE: do not call this from inside a task already running on the same
   * runId — that violates the no-recursive-enqueue rule and will deadlock.
   */
  getOrCreate(runId: string): PQueue {
    let q = this.queues.get(runId);
    if (!q) {
      q = new PQueue({ concurrency: 1 });
      this.queues.set(runId, q);
    }
    return q;
  }

  /** Returns true when a queue for `runId` is currently tracked. */
  has(runId: string): boolean {
    return this.queues.has(runId);
  }

  /**
   * Drains the queue for `runId` and removes it from the registry.
   *
   * Callers must ensure any pending tasks for this run have been
   * aborted/cancelled before invoking delete; this method only waits for
   * already-started tasks to finish (onIdle), it does not abort them.
   *
   * NOTE: Do not enqueue new tasks for `runId` after calling delete — that
   * would re-create the queue and violate the no-recursive-enqueue rule if
   * done from a task still winding down on the same runId.
   */
  async delete(runId: string): Promise<void> {
    const q = this.queues.get(runId);
    if (!q) {
      return;
    }
    await q.onIdle();
    this.queues.delete(runId);
  }

  /**
   * Waits for every tracked queue to become idle, then clears the registry.
   * Intended for clean shutdown.
   *
   * Two kinds of queue reach this point.
   *
   * A queue holding only state mutations goes idle in milliseconds, and waiting
   * for it is what stops a database write from being lost at quit.
   *
   * A queue whose run has a live execute() task is different. That task holds
   * the head of a concurrency-1 queue and settles only when its session ends —
   * for a run parked at a human review gate, never. Nothing behind it can run
   * either. Waiting on one of those flushes nothing and only spends the quit
   * budget, which is what once left the database close and the MCP stop unrun.
   *
   * `shouldWait` is how the caller tells the two apart; it answers false for a
   * run with a live execution. A queue that is skipped, or that is still busy
   * at the cap, is logged and abandoned. Its run row keeps whatever
   * non-terminal status it holds, which is what boot recovery looks for, so the
   * run resumes on the next launch.
   */
  async drainAll(opts?: {
    capMs?: number;
    /** False for a queue whose task cannot finish; defaults to waiting. */
    shouldWait?: (runId: string) => boolean;
  }): Promise<void> {
    const capMs = opts?.capMs ?? DRAIN_CAP_MS;
    const entries = [...this.queues.entries()];
    await Promise.allSettled(
      entries.map(async ([runId, q]) => {
        if (opts?.shouldWait && !opts.shouldWait(runId)) {
          console.warn(
            `[RunQueueRegistry] run ${runId} holds a task that cannot finish at shutdown — not waiting on its queue`,
          );
          return;
        }
        let timer: ReturnType<typeof setTimeout> | undefined;
        const settled = await Promise.race([
          q
            .onIdle()
            .then(() => true)
            .catch(() => false),
          new Promise<boolean>((resolve) => {
            timer = setTimeout(() => resolve(false), capMs);
          }),
        ]);
        if (timer) clearTimeout(timer);
        if (!settled) {
          console.warn(
            `[RunQueueRegistry] run ${runId} was still busy at shutdown — abandoning its queue`,
          );
        }
      }),
    );
    this.queues.clear();
  }

  /** Returns a snapshot of queue depth across all tracked runs. */
  stats(): { runs: number; totalPending: number; totalActive: number } {
    let totalPending = 0;
    let totalActive = 0;
    for (const q of this.queues.values()) {
      totalPending += q.size;
      totalActive += q.pending;
    }
    return { runs: this.queues.size, totalPending, totalActive };
  }
}
