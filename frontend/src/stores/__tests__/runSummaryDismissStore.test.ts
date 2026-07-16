import { describe, it, expect, beforeEach } from 'vitest';
import { useRunSummaryDismissStore } from '../runSummaryDismissStore';

beforeEach(() => {
  useRunSummaryDismissStore.setState({ dismissed: {} });
});

describe('runSummaryDismissStore', () => {
  it('dismiss marks a run and restore clears it', () => {
    const { dismiss, restore } = useRunSummaryDismissStore.getState();
    dismiss('run-1');
    expect(useRunSummaryDismissStore.getState().dismissed['run-1']).toBe(true);
    restore('run-1');
    expect(useRunSummaryDismissStore.getState().dismissed['run-1']).toBeUndefined();
  });

  it('tracks runs independently', () => {
    const { dismiss } = useRunSummaryDismissStore.getState();
    dismiss('run-1');
    expect(useRunSummaryDismissStore.getState().dismissed['run-2']).toBeUndefined();
  });

  it('dismiss is idempotent — a second call keeps the same state reference', () => {
    const { dismiss } = useRunSummaryDismissStore.getState();
    dismiss('run-1');
    const first = useRunSummaryDismissStore.getState().dismissed;
    dismiss('run-1');
    expect(useRunSummaryDismissStore.getState().dismissed).toBe(first);
  });

  it('restore of an un-dismissed run is a no-op (same reference)', () => {
    const { restore } = useRunSummaryDismissStore.getState();
    const first = useRunSummaryDismissStore.getState().dismissed;
    restore('never-dismissed');
    expect(useRunSummaryDismissStore.getState().dismissed).toBe(first);
  });
});
