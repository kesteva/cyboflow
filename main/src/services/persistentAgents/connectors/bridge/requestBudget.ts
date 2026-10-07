/**
 * Client-side token bucket for every Bridge relay request of this device: `capacity` burst, continuous
 * refill of `refillPerMinute`, two priorities ('high' waiters are served before 'normal'), and a global
 * block (429/503) that grants nothing before it ends. One internal timer, armed only while waiters exist.
 */

const EPSILON = 1e-9;

export type BudgetPriority = 'high' | 'normal';

/** The wait exceeded maxWaitMs. */
export class BudgetWaitTimeoutError extends Error {
  constructor() {
    super('Request budget wait timed out');
    this.name = 'BudgetWaitTimeoutError';
  }
}

/** The wait was cancelled: by the caller's signal ('signal') or because the budget was disposed ('disposed'). */
export class BudgetAbortError extends Error {
  readonly cause_: 'signal' | 'disposed';
  constructor(cause: 'signal' | 'disposed') {
    super(cause === 'signal' ? 'Request budget wait aborted' : 'Request budget disposed');
    this.name = 'AbortError';
    this.cause_ = cause;
  }
}

interface Waiter {
  priority: BudgetPriority;
  deadline: number;
  resolve: () => void;
  reject: (err: Error) => void;
  cleanup: () => void;
}

function unrefTimer(t: ReturnType<typeof setTimeout>): void {
  (t as { unref?: () => void }).unref?.();
}

export class RequestBudget {
  private tokens: number;
  private lastRefill: number;
  private blocked = 0;
  private disposed = false;
  private readonly waiters: Waiter[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly capacity: number,
    private readonly refillPerMinute: number,
    private readonly now: () => number = Date.now,
  ) {
    this.tokens = capacity;
    this.lastRefill = now();
  }

  /** Resolves when a token is taken. Rejects with BudgetWaitTimeoutError after maxWaitMs, BudgetAbortError on abort/dispose. */
  acquire(priority: BudgetPriority, maxWaitMs: number, signal?: AbortSignal): Promise<void> {
    if (this.disposed) return Promise.reject(new BudgetAbortError('disposed'));
    if (signal?.aborted) return Promise.reject(new BudgetAbortError('signal'));
    return new Promise<void>((resolve, reject) => {
      const waiter: Waiter = {
        priority,
        deadline: this.now() + Math.max(0, maxWaitMs),
        resolve,
        reject,
        cleanup: () => undefined,
      };
      if (signal) {
        const onAbort = (): void => {
          const idx = this.waiters.indexOf(waiter);
          if (idx === -1) return;
          this.waiters.splice(idx, 1);
          waiter.cleanup();
          reject(new BudgetAbortError('signal'));
          this.arm();
        };
        signal.addEventListener('abort', onAbort, { once: true });
        waiter.cleanup = () => signal.removeEventListener('abort', onAbort);
      }
      this.waiters.push(waiter);
      this.drain();
    });
  }

  /** ms until the next token can be granted (0 when one is available now and not blocked). */
  msUntilToken(): number {
    this.refill();
    const t = this.now();
    const blockWait = Math.max(0, this.blocked - t);
    const tokenWait = this.tokens >= 1 - EPSILON
      ? 0
      : Math.ceil(((1 - this.tokens) * 60_000) / this.refillPerMinute);
    return Math.max(blockWait, tokenWait);
  }

  /** Global block (429/503): no token is granted before `untilMs`. Extends, never shortens. */
  blockUntil(untilMs: number): void {
    if (this.disposed) return;
    if (untilMs > this.blocked) this.blocked = untilMs;
    this.arm();
  }

  /** Lifts any global block (sign-out). */
  clearBlock(): void {
    this.blocked = 0;
    if (!this.disposed) this.drain();
  }

  /** Block end (epoch ms), or 0 when not blocked. */
  blockedUntil(): number {
    return this.blocked > this.now() ? this.blocked : 0;
  }

  isDisposed(): boolean {
    return this.disposed;
  }

  /** Rejects every waiter; clears the timer. Terminal. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const pending = this.waiters.splice(0, this.waiters.length);
    for (const w of pending) {
      w.cleanup();
      w.reject(new BudgetAbortError('disposed'));
    }
  }

  private refill(): void {
    const t = this.now();
    if (t > this.lastRefill) {
      this.tokens = Math.min(this.capacity, this.tokens + ((t - this.lastRefill) * this.refillPerMinute) / 60_000);
    }
    this.lastRefill = t;
  }

  private drain(): void {
    if (this.disposed) return;
    this.refill();
    const t = this.now();
    for (let i = this.waiters.length - 1; i >= 0; i -= 1) {
      const w = this.waiters[i];
      if (t >= w.deadline && !(t >= this.blocked && this.tokens >= 1 - EPSILON)) {
        this.waiters.splice(i, 1);
        w.cleanup();
        w.reject(new BudgetWaitTimeoutError());
      }
    }
    while (this.waiters.length > 0 && t >= this.blocked && this.tokens >= 1 - EPSILON) {
      const highIdx = this.waiters.findIndex((w) => w.priority === 'high');
      const idx = highIdx === -1 ? 0 : highIdx;
      const [w] = this.waiters.splice(idx, 1);
      this.tokens = Math.max(0, this.tokens - 1);
      w.cleanup();
      w.resolve();
    }
    this.arm();
  }

  private arm(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.disposed || this.waiters.length === 0) return;
    const t = this.now();
    let nextAt = Math.min(...this.waiters.map((w) => w.deadline));
    if (t < this.blocked) nextAt = Math.min(nextAt, this.blocked);
    else nextAt = Math.min(nextAt, t + this.msUntilToken());
    this.timer = setTimeout(() => {
      this.timer = null;
      this.drain();
    }, Math.max(0, nextAt - t));
    unrefTimer(this.timer);
  }
}
