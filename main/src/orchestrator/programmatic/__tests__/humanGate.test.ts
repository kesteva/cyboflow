import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'events';
import {
  parseGateVerdict,
  ReviewQueueHumanGate,
  type HumanGateItemSnapshot,
  type HumanGateOpenedSnapshot,
  type HumanGateOpener,
} from '../humanGate';
import type { WorkflowStep } from '../../../../../shared/types/workflows';
import type { LoggerLike } from '../../types';

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

  it('reads the anchored verdict prefix without sniffing the note', () => {
    // THE bug the grammar fixes: 'rejects' inside the human's note used to win
    // the substring sniff and END the run instead of looping the design back.
    expect(parseGateVerdict('revise: the architecture rejects empty input')).toBe('revise');
    expect(parseGateVerdict('approve: reject nothing, this is fine')).toBe('approve');
    expect(parseGateVerdict('reject')).toBe('reject');
    expect(parseGateVerdict('approve[no-findings]')).toBe('approve');
    expect(parseGateVerdict('Revise: mixed case verdict')).toBe('revise');
  });

  it('still falls back to the legacy sniff for a pre-grammar row', () => {
    expect(parseGateVerdict('please revise this')).toBe('revise');
    expect(parseGateVerdict('approved')).toBe('approve');
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
  it('AWAITS onGateResolved before the gate promise settles, passing the raw resolution', async () => {
    // The ordering this hook exists for: ReviewItemRouter emits 'resolved'
    // synchronously, this resolver settles the controller's gate promise off that
    // emit, and the walk then spawns the next step. Anything the resumed step must
    // SEE (a design bound to its ideas, a level stamped on the project) has to land
    // before the promise resolves or it is a race that only SDK-spawn latency wins.
    const events = new EventEmitter();
    const sideEffects = makeDeferred<void>();
    const order: string[] = [];
    const seen: Array<{ runId: string; stepId: string; resolution: string | null; dismissed: boolean }> = [];
    const opener: HumanGateOpener = {
      openHumanGate: vi.fn<HumanGateOpener['openHumanGate']>().mockResolvedValue('ri-se'),
      onGateResolved: vi.fn(async (args) => {
        seen.push(args);
        order.push('side-effects:start');
        await sideEffects.promise;
        order.push('side-effects:done');
      }),
      maybeResumeRun: vi.fn(async () => {
        order.push('resume');
        return true;
      }),
    };
    const gate = new ReviewQueueHumanGate(opener, events, channelFor);

    const pending = gate
      .resolve({ runId: 'r', projectId: 1, step: step({ id: 'approve-design' }) })
      .then((verdict) => {
        order.push('settled');
        return verdict;
      });
    await Promise.resolve();

    events.emit('review-project-1', {
      reviewItemId: 'ri-se',
      action: 'resolved',
      item: { resolution: 'revise — the spend screen has no way back to Home' },
    });
    await flush();

    // Still parked: the hook has not finished, so neither the resume nor the
    // verdict has happened.
    expect(order).toEqual(['side-effects:start']);

    sideEffects.resolve();
    await expect(pending).resolves.toBe('revise');
    expect(order).toEqual(['side-effects:start', 'side-effects:done', 'resume', 'settled']);
    // The RAW resolution, not the reduced verdict — the free text is the only
    // thing a side-effect (or a later revision) can act on.
    expect(seen).toEqual([
      {
        runId: 'r',
        stepId: 'approve-design',
        resolution: 'revise — the spend screen has no way back to Home',
        dismissed: false,
      },
    ]);
  });

  it('still settles the gate when onGateResolved rejects (fail-soft)', async () => {
    // Stranding a run at a gate the human already answered is worse than a missing
    // side-effect, so a throwing hook must not hold the walk.
    const events = new EventEmitter();
    const opener: HumanGateOpener = {
      openHumanGate: vi.fn<HumanGateOpener['openHumanGate']>().mockResolvedValue('ri-boom'),
      onGateResolved: vi.fn().mockRejectedValue(new Error('bind failed')),
    };
    const warn = vi.fn();
    const logger: LoggerLike = { info: vi.fn(), warn, error: vi.fn(), debug: vi.fn() };
    const gate = new ReviewQueueHumanGate(opener, events, channelFor, logger);

    const pending = gate.resolve({ runId: 'r', projectId: 1, step: step({ id: 'approve-design' }) });
    await Promise.resolve();
    events.emit('review-project-1', {
      reviewItemId: 'ri-boom',
      action: 'resolved',
      item: { resolution: 'approve' },
    });

    await expect(pending).resolves.toBe('approve');
    expect(warn).toHaveBeenCalled();
  });

  it('fires onGateResolved for a DISMISSED gate too, with a null resolution', async () => {
    // A dismissal is a rejection, and a rejection still has to unwind whatever the
    // gate armed — so the hook runs on both terminal actions, not just 'resolved'.
    const events = new EventEmitter();
    const calls: Array<{ resolution: string | null; dismissed: boolean }> = [];
    const opener: HumanGateOpener = {
      openHumanGate: vi.fn<HumanGateOpener['openHumanGate']>().mockResolvedValue('ri-dis'),
      onGateResolved: vi.fn(async (args) => {
        calls.push({ resolution: args.resolution, dismissed: args.dismissed });
      }),
    };
    const gate = new ReviewQueueHumanGate(opener, events, channelFor);

    const pending = gate.resolve({ runId: 'r', projectId: 1, step: step({ id: 'g' }) });
    await Promise.resolve();
    events.emit('review-project-1', { reviewItemId: 'ri-dis', action: 'dismissed' });

    await expect(pending).resolves.toBe('reject');
    // `dismissed` is the discriminant the side-effects need: a null resolution alone
    // also describes a note-less resolve, which is an APPROVE.
    expect(calls).toEqual([{ resolution: null, dismissed: true }]);
  });

  // ── post-arming read-back: the lost-event window ────────────────────────────
  //
  // The listener is armed before openHumanGate, but the `targetId` filter every
  // event is matched against is only set after it resolves. A human who answers
  // in that gap fires the ONLY event for this gate while targetId is still null.
  // `readGateItem` after arming is what closes the window.

  /** An opener whose readGateItem answers with one fixed snapshot (or null). */
  function openerReading(
    id: string,
    item: HumanGateItemSnapshot | null,
    extra: Partial<HumanGateOpener> = {},
  ): HumanGateOpener {
    return {
      openHumanGate: vi.fn<HumanGateOpener['openHumanGate']>().mockResolvedValue(id),
      readGateItem: vi.fn<NonNullable<HumanGateOpener['readGateItem']>>().mockReturnValue(item),
      ...extra,
    };
  }

  it('settles with the stored verdict when the item was RESOLVED before the target was armed', async () => {
    const events = new EventEmitter();
    const opener = openerReading('ri-lost', {
      title: 'Approve plan',
      body: 'body',
      status: 'resolved',
      resolution: 'revise: only AR-2 matters',
    });
    const gate = new ReviewQueueHumanGate(opener, events, channelFor);

    // No event is ever emitted — the read-back is the only signal.
    await expect(gate.resolve({ runId: 'r', projectId: 1, step: step({ id: 'g' }) })).resolves.toBe('revise');
    expect(opener.readGateItem).toHaveBeenCalledWith('ri-lost');
    expect(events.listenerCount('review-project-1')).toBe(0);
  });

  it('settles as a reject when the item was DISMISSED before the target was armed', async () => {
    const events = new EventEmitter();
    const calls: Array<{ resolution: string | null; dismissed: boolean }> = [];
    const opener = openerReading(
      'ri-lost-dis',
      { title: 't', body: 'b', status: 'dismissed', resolution: null },
      {
        onGateResolved: vi.fn(async (args) => {
          calls.push({ resolution: args.resolution, dismissed: args.dismissed });
        }),
      },
    );
    const gate = new ReviewQueueHumanGate(opener, events, channelFor);

    await expect(gate.resolve({ runId: 'r', projectId: 1, step: step({ id: 'g' }) })).resolves.toBe('reject');
    expect(calls).toEqual([{ resolution: null, dismissed: true }]);
  });

  it('keeps awaiting the change event when the read-back says pending (or cannot answer)', async () => {
    for (const snapshot of [
      { title: 't', body: 'b', status: 'pending' as const, resolution: null },
      null,
    ]) {
      const events = new EventEmitter();
      const gate = new ReviewQueueHumanGate(openerReading('ri-p', snapshot), events, channelFor);
      const pending = gate.resolve({ runId: 'r', projectId: 1, step: step({ id: 'g' }) });
      await Promise.resolve();
      events.emit('review-project-1', { reviewItemId: 'ri-p', action: 'resolved', item: { resolution: 'approve' } });
      await expect(pending).resolves.toBe('approve');
    }
  });

  // ── onOpened: fire-and-forget gate-open hook ────────────────────────────────

  it('fires onOpened AFTER the target is armed, with the item snapshot, and still settles', async () => {
    const events = new EventEmitter();
    const seen: HumanGateOpenedSnapshot[] = [];
    const gate = new ReviewQueueHumanGate(
      openerReading('ri-open', { title: 'Approve design', body: 'the real body', status: 'pending', resolution: null }),
      events,
      channelFor,
    );

    const pending = gate.resolve({
      runId: 'r',
      projectId: 1,
      step: step({ id: 'approve-design', name: 'Approve design' }),
      onOpened: (snapshot) => {
        seen.push(snapshot);
      },
    });
    await flush();

    expect(seen).toEqual([
      { reviewItemId: 'ri-open', title: 'Approve design', body: 'the real body', resumed: false },
    ]);
    // A change event arriving AFTER the hook still settles the gate normally.
    events.emit('review-project-1', { reviewItemId: 'ri-open', action: 'resolved', item: { resolution: 'approve' } });
    await expect(pending).resolves.toBe('approve');
  });

  it('marks the snapshot resumed when it re-attached to an already-open gate, and falls back to the step name', async () => {
    const events = new EventEmitter();
    const seen: HumanGateOpenedSnapshot[] = [];
    const opener: HumanGateOpener = {
      openHumanGate: vi.fn().mockResolvedValue(null), // already open
      findPendingGate: vi.fn().mockResolvedValue('ri-existing'),
      // No readGateItem -> the snapshot falls back to the step name + empty body.
    };
    const gate = new ReviewQueueHumanGate(opener, events, channelFor);

    const pending = gate.resolve({
      runId: 'r',
      projectId: 1,
      step: step({ id: 'approve-plan', name: 'Approve plan' }),
      onOpened: (snapshot) => {
        seen.push(snapshot);
      },
    });
    await flush();

    expect(seen).toEqual([
      { reviewItemId: 'ri-existing', title: 'Approve plan', body: '', resumed: true },
    ]);
    events.emit('review-project-1', { reviewItemId: 'ri-existing', action: 'resolved', item: { resolution: 'approve' } });
    await expect(pending).resolves.toBe('approve');
  });

  it('never rejects the gate when onOpened throws (fail-soft, logged)', async () => {
    const events = new EventEmitter();
    const logger: LoggerLike = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    const gate = new ReviewQueueHumanGate(
      openerReading('ri-throw', { title: 't', body: 'b', status: 'pending', resolution: null }),
      events,
      channelFor,
      logger,
    );

    const pending = gate.resolve({
      runId: 'r',
      projectId: 1,
      step: step({ id: 'g' }),
      onOpened: () => {
        throw new Error('consult exploded');
      },
    });
    await flush();

    expect(logger.warn).toHaveBeenCalledWith(
      '[ReviewQueueHumanGate] onOpened hook failed (fail-soft)',
      expect.objectContaining({ error: 'consult exploded' }),
    );
    events.emit('review-project-1', { reviewItemId: 'ri-throw', action: 'resolved', item: { resolution: 'approve' } });
    await expect(pending).resolves.toBe('approve');
  });

  it('does NOT await onOpened — a never-settling hook cannot delay the verdict', async () => {
    const events = new EventEmitter();
    const gate = new ReviewQueueHumanGate(
      openerReading('ri-hang', { title: 't', body: 'b', status: 'pending', resolution: null }),
      events,
      channelFor,
    );

    const pending = gate.resolve({
      runId: 'r',
      projectId: 1,
      step: step({ id: 'g' }),
      onOpened: () => new Promise<void>(() => undefined), // never resolves
    });
    await flush();

    events.emit('review-project-1', { reviewItemId: 'ri-hang', action: 'resolved', item: { resolution: 'reject' } });
    await expect(pending).resolves.toBe('reject');
  });

  it('does not fire onOpened when the gate was already settled before arming', async () => {
    const events = new EventEmitter();
    const onOpened = vi.fn();
    const gate = new ReviewQueueHumanGate(
      openerReading('ri-done', { title: 't', body: 'b', status: 'resolved', resolution: 'approve' }),
      events,
      channelFor,
    );

    await expect(
      gate.resolve({ runId: 'r', projectId: 1, step: step({ id: 'g' }), onOpened }),
    ).resolves.toBe('approve');
    await flush();
    expect(onOpened).not.toHaveBeenCalled();
  });
});
