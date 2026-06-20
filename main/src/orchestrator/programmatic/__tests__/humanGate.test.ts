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
});
