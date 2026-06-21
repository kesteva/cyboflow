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
});

describe('ReviewQueueHumanGate', () => {
  const channelFor = (projectId: number) => `review-project-${projectId}`;

  function makeOpener(id: string | null): HumanGateOpener {
    return { openHumanGate: vi.fn<HumanGateOpener['openHumanGate']>().mockResolvedValue(id) };
  }

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
