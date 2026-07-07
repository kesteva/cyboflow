import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'events';
import { parseGateVerdict, ReviewQueueHumanGate, type HumanGateOpener } from '../humanGate';
import type { WorkflowStep } from '../../../../../shared/types/workflows';

function step(p: Partial<WorkflowStep> & { id: string }): WorkflowStep {
  return { name: p.id, agent: 'human', mcps: [], retries: 0, human: true, ...p };
}

describe('parseGateVerdict', () => {
  it("maps an explicit 'reject' / 'revise' resolution, defaulting everything else to approve", () => {
    expect(parseGateVerdict('reject — out of scope')).toBe('reject');
    expect(parseGateVerdict('please revise the epics')).toBe('revise');
    expect(parseGateVerdict('approve')).toBe('approve');
    expect(parseGateVerdict('looks good')).toBe('approve'); // resolving == approving
    expect(parseGateVerdict('')).toBe('approve');
    expect(parseGateVerdict(null)).toBe('approve');
    expect(parseGateVerdict(undefined)).toBe('approve');
  });

  it('is case-insensitive and prioritizes reject over revise', () => {
    expect(parseGateVerdict('REJECT')).toBe('reject');
    expect(parseGateVerdict('reject then revise')).toBe('reject');
  });

  it("treats 'retry' as an alias for 'revise' (re-run, never approve-and-skip)", () => {
    expect(parseGateVerdict('please retry')).toBe('revise');
    expect(parseGateVerdict('RETRY')).toBe('revise');
    // reject still wins over a retry mention in the same note.
    expect(parseGateVerdict('reject — do not retry')).toBe('reject');
  });
});

describe('ReviewQueueHumanGate', () => {
  const channelFor = (projectId: number) => `review-project-${projectId}`;

  function makeOpener(id: string | null): HumanGateOpener {
    return { openHumanGate: vi.fn<HumanGateOpener['openHumanGate']>().mockResolvedValue(id) };
  }

  /** A promise whose settlement the test drives by hand (ordering assertions). */
  function makeDeferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
    let resolve!: (v: T) => void;
    let reject!: (e: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  }

  /** Flush the full microtask queue (and any 0ms macrotask) so chained .finally() lands. */
  const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

  it('opens a gate then resolves the parsed verdict when the matching item is resolved', async () => {
    const events = new EventEmitter();
    const opener = makeOpener('ri-1');
    const gate = new ReviewQueueHumanGate(opener, events, channelFor);

    const pending = gate.resolve({ runId: 'r', projectId: 1, step: step({ id: 'approve-plan', name: 'Approve plan' }) });

    // Let openHumanGate resolve so the target id is registered.
    await Promise.resolve();
    expect(opener.openHumanGate).toHaveBeenCalledWith('r', 'approve-plan', 'Approve plan');

    // A resolution for a DIFFERENT item is ignored…
    events.emit('review-project-1', { reviewItemId: 'other', action: 'resolved', item: { resolution: 'reject' } });
    // …the matching one drives the verdict.
    events.emit('review-project-1', { reviewItemId: 'ri-1', action: 'resolved', item: { resolution: 'revise this' } });

    await expect(pending).resolves.toBe('revise');
    // Listener is cleaned up (no leak).
    expect(events.listenerCount('review-project-1')).toBe(0);
  });

  it("treats a dismissed gate item as a 'reject'", async () => {
    const events = new EventEmitter();
    const gate = new ReviewQueueHumanGate(makeOpener('ri-2'), events, channelFor);
    const pending = gate.resolve({ runId: 'r', projectId: 1, step: step({ id: 'g' }) });
    await Promise.resolve();
    events.emit('review-project-1', { reviewItemId: 'ri-2', action: 'dismissed', item: {} });
    await expect(pending).resolves.toBe('reject');
  });

  it('rejects when the gate cannot be opened (null id)', async () => {
    const events = new EventEmitter();
    const gate = new ReviewQueueHumanGate(makeOpener(null), events, channelFor);
    await expect(gate.resolve({ runId: 'r', projectId: 1, step: step({ id: 'g' }) })).rejects.toThrow('could not open human gate');
    expect(events.listenerCount('review-project-1')).toBe(0);
  });

  // ── crash-safe resume: re-attach to an already-open gate ─────────────────────
  it('re-attaches to an already-open gate when openHumanGate returns null (resume)', async () => {
    const events = new EventEmitter();
    const opener: HumanGateOpener = {
      openHumanGate: vi.fn().mockResolvedValue(null), // already open
      findPendingGate: vi.fn().mockResolvedValue('ri-existing'),
    };
    const gate = new ReviewQueueHumanGate(opener, events, channelFor);

    const pending = gate.resolve({ runId: 'r', projectId: 1, step: step({ id: 'approve-plan' }) });
    await Promise.resolve();
    await Promise.resolve(); // let openHumanGate.then + the async findPendingGate settle

    events.emit('review-project-1', { reviewItemId: 'ri-existing', action: 'resolved', item: { resolution: 'approve' } });

    await expect(pending).resolves.toBe('approve');
    expect(opener.findPendingGate).toHaveBeenCalledWith('r', 'approve-plan');
    expect(events.listenerCount('review-project-1')).toBe(0);
  });

  it('still rejects when the gate is null AND no pending gate exists', async () => {
    const events = new EventEmitter();
    const opener: HumanGateOpener = {
      openHumanGate: vi.fn().mockResolvedValue(null),
      findPendingGate: vi.fn().mockResolvedValue(null),
    };
    const gate = new ReviewQueueHumanGate(opener, events, channelFor);
    await expect(gate.resolve({ runId: 'r', projectId: 1, step: step({ id: 'g' }) })).rejects.toThrow('could not open human gate');
    expect(events.listenerCount('review-project-1')).toBe(0);
  });

  // ── ordering fix: the gate OWNS the run-resume (maybeResumeRun) BEFORE waking
  //    the walk, so the run row is back in 'running' before the controller
  //    proceeds — the end-of-walk drained-rest never fires against a stale
  //    'awaiting_review' row and the router's trailing resume is a no-op ───────
  it('resumes the run (maybeResumeRun) BEFORE waking the walk on a resolved gate', async () => {
    const events = new EventEmitter();
    const resume = makeDeferred<boolean>();
    const maybeResumeRun = vi.fn((_runId: string): Promise<boolean> => resume.promise);
    const opener: HumanGateOpener = { openHumanGate: vi.fn().mockResolvedValue('ri-1'), maybeResumeRun };
    const gate = new ReviewQueueHumanGate(opener, events, channelFor);

    let settledVerdict: string | undefined;
    const pending = gate.resolve({ runId: 'r', projectId: 1, step: step({ id: 'approve-plan' }) });
    void pending.then((v) => {
      settledVerdict = v;
    });

    await flush(); // openHumanGate resolves; targetId registered
    events.emit('review-project-1', { reviewItemId: 'ri-1', action: 'resolved', item: { resolution: 'approve' } });
    await flush();

    // The gate asked to resume the run…
    expect(maybeResumeRun).toHaveBeenCalledWith('r');
    // …but the walk has NOT woken yet — the resume promise is still pending.
    expect(settledVerdict).toBeUndefined();

    // Only once the run row is back in 'running' does the walk wake, with the verdict.
    resume.resolve(true);
    await flush();
    expect(settledVerdict).toBe('approve');
    await expect(pending).resolves.toBe('approve');
    expect(events.listenerCount('review-project-1')).toBe(0);
  });

  it("resumes the run BEFORE waking the walk on a dismissed gate (verdict 'reject')", async () => {
    const events = new EventEmitter();
    const resume = makeDeferred<boolean>();
    const maybeResumeRun = vi.fn((_runId: string): Promise<boolean> => resume.promise);
    const opener: HumanGateOpener = { openHumanGate: vi.fn().mockResolvedValue('ri-d'), maybeResumeRun };
    const gate = new ReviewQueueHumanGate(opener, events, channelFor);

    let settledVerdict: string | undefined;
    const pending = gate.resolve({ runId: 'r', projectId: 1, step: step({ id: 'g' }) });
    void pending.then((v) => {
      settledVerdict = v;
    });

    await flush();
    events.emit('review-project-1', { reviewItemId: 'ri-d', action: 'dismissed', item: {} });
    await flush();

    expect(maybeResumeRun).toHaveBeenCalledWith('r');
    expect(settledVerdict).toBeUndefined(); // walk parked behind the pending resume

    resume.resolve(false);
    await flush();
    expect(settledVerdict).toBe('reject');
    await expect(pending).resolves.toBe('reject');
  });

  it('settles immediately on a resolved gate when the opener has no maybeResumeRun (back-compat)', async () => {
    const events = new EventEmitter();
    const opener = makeOpener('ri-bc'); // no maybeResumeRun
    const gate = new ReviewQueueHumanGate(opener, events, channelFor);

    const pending = gate.resolve({ runId: 'r', projectId: 1, step: step({ id: 'g' }) });
    await flush();
    events.emit('review-project-1', { reviewItemId: 'ri-bc', action: 'resolved', item: { resolution: 'looks good' } });

    // No resume primitive to await — the walk wakes directly (as before this fix).
    await expect(pending).resolves.toBe('approve');
    expect(events.listenerCount('review-project-1')).toBe(0);
  });

  it('still settles the verdict when maybeResumeRun REJECTS (walk can never hang on a resume failure)', async () => {
    const events = new EventEmitter();
    const maybeResumeRun = vi.fn((_runId: string): Promise<boolean> => Promise.reject(new Error('resume boom')));
    const opener: HumanGateOpener = { openHumanGate: vi.fn().mockResolvedValue('ri-x'), maybeResumeRun };
    const gate = new ReviewQueueHumanGate(opener, events, channelFor);

    const pending = gate.resolve({ runId: 'r', projectId: 1, step: step({ id: 'g' }) });
    await flush();
    events.emit('review-project-1', { reviewItemId: 'ri-x', action: 'resolved', item: { resolution: 'revise it' } });

    // .catch swallows the resume failure; .finally still wakes the walk with the verdict.
    await expect(pending).resolves.toBe('revise');
    expect(maybeResumeRun).toHaveBeenCalledWith('r');
    expect(events.listenerCount('review-project-1')).toBe(0);
  });

  // ── cancellation: a canceled run must settle the gate to 'abort' and remove
  //    the listener (no hang, no leak) — fix #1/#4/#12/#15 ─────────────────────
  it("settles to 'abort' and removes its listener when the signal aborts while awaiting", async () => {
    const events = new EventEmitter();
    const gate = new ReviewQueueHumanGate(makeOpener('ri-3'), events, channelFor);
    const ac = new AbortController();

    const pending = gate.resolve({ runId: 'r', projectId: 1, step: step({ id: 'g' }), signal: ac.signal });
    await Promise.resolve(); // let openHumanGate resolve + register the id
    expect(events.listenerCount('review-project-1')).toBe(1);

    ac.abort();

    await expect(pending).resolves.toBe('abort');
    expect(events.listenerCount('review-project-1')).toBe(0); // listener removed
  });

  it("short-circuits to 'abort' without opening a gate when already aborted", async () => {
    const events = new EventEmitter();
    const opener = makeOpener('ri-4');
    const gate = new ReviewQueueHumanGate(opener, events, channelFor);
    const ac = new AbortController();
    ac.abort();

    await expect(
      gate.resolve({ runId: 'r', projectId: 1, step: step({ id: 'g' }), signal: ac.signal }),
    ).resolves.toBe('abort');
    expect(opener.openHumanGate).not.toHaveBeenCalled();
    expect(events.listenerCount('review-project-1')).toBe(0);
  });
});
