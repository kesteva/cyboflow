/**
 * Unit tests for useReviewQueueKeyboard.
 *
 * Uses @testing-library/react's renderHook + fireEvent to exercise keyboard
 * navigation without a real Electron IPC bridge.  The tRPC client is mocked
 * at module level.
 *
 * Environment: jsdom (required for window.addEventListener and React hooks).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { renderHook, act } from '@testing-library/react';
import { fireEvent } from '@testing-library/dom';
import type { QueueItem } from '../../utils/reviewQueueSelectors';
import type { Approval } from '../../../../shared/types/approvals';

// ---------------------------------------------------------------------------
// tRPC mock — use vi.hoisted so variables are available before vi.mock hoisting
// ---------------------------------------------------------------------------

const { mockApproveMutate, mockRejectMutate, mockApproveRestOfRunMutate, mockRejectRestOfRunMutate } = vi.hoisted(() => ({
  mockApproveMutate:           vi.fn().mockResolvedValue(undefined),
  mockRejectMutate:            vi.fn().mockResolvedValue(undefined),
  mockApproveRestOfRunMutate:  vi.fn().mockResolvedValue({ decided: 0 }),
  mockRejectRestOfRunMutate:   vi.fn().mockResolvedValue({ decided: 0 }),
}));

vi.mock('../../trpc/client', () => ({
  trpc: {
    cyboflow: {
      approvals: {
        approve:           { mutate: mockApproveMutate           },
        reject:            { mutate: mockRejectMutate            },
        approveRestOfRun:  { mutate: mockApproveRestOfRunMutate  },
        rejectRestOfRun:   { mutate: mockRejectRestOfRunMutate   },
      },
    },
  },
}));

// Import AFTER mock is registered.
import { useReviewQueueKeyboard } from '../useReviewQueueKeyboard';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeApproval(id: string, runId = 'run-1'): Approval {
  return {
    id,
    runId,
    workflowName: 'Test Workflow',
    toolName: 'Bash',
    payloadPreview: 'echo hello',
    rationale: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    status: 'pending',
  };
}

function singleItem(id: string, isBlocking = false): QueueItem {
  return { kind: 'single', approval: makeApproval(id), isBlocking };
}

function groupItem(ids: string[], runId = 'run-1'): QueueItem {
  return {
    kind: 'group',
    runId,
    toolName: 'Bash',
    payloadSignature: 'npm test',
    items: ids.map(id => makeApproval(id, runId)),
    isBlocking: false,
  };
}

const QUEUE_3 = [singleItem('a'), singleItem('b'), singleItem('c')];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Fire a bare keydown on window (no modifier keys). */
function press(key: string): void {
  fireEvent.keyDown(window, { key, metaKey: false, ctrlKey: false, altKey: false });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('useReviewQueueKeyboard — j/k navigation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('starts at focusedIndex 0', () => {
    const { result } = renderHook(() => useReviewQueueKeyboard(QUEUE_3));
    expect(result.current.focusedIndex).toBe(0);
  });

  it('j advances focusedIndex from 0 → 1 → 2', () => {
    const { result } = renderHook(() => useReviewQueueKeyboard(QUEUE_3));

    act(() => { press('j'); });
    expect(result.current.focusedIndex).toBe(1);

    act(() => { press('j'); });
    expect(result.current.focusedIndex).toBe(2);
  });

  it('j clamps at last item (no-op on last)', () => {
    const { result } = renderHook(() => useReviewQueueKeyboard(QUEUE_3));

    act(() => { press('j'); }); // → 1
    act(() => { press('j'); }); // → 2
    act(() => { press('j'); }); // → 2 (clamp)
    expect(result.current.focusedIndex).toBe(2);
  });

  it('k is a no-op when already at first item', () => {
    const { result } = renderHook(() => useReviewQueueKeyboard(QUEUE_3));
    expect(result.current.focusedIndex).toBe(0);
    act(() => { press('k'); });
    expect(result.current.focusedIndex).toBe(0);
  });

  it('k moves focusedIndex backwards when not at first item', () => {
    const { result } = renderHook(() => useReviewQueueKeyboard(QUEUE_3));
    act(() => { press('j'); }); // → 1
    act(() => { press('k'); }); // → 0
    expect(result.current.focusedIndex).toBe(0);
  });
});

describe('useReviewQueueKeyboard — y/n mutations on single items', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('y calls approve.mutate with the focused approval id', () => {
    const { result } = renderHook(() => useReviewQueueKeyboard(QUEUE_3));
    // focusedIndex = 0 → approval 'a'
    act(() => { press('y'); });
    expect(mockApproveMutate).toHaveBeenCalledTimes(1);
    expect(mockApproveMutate).toHaveBeenCalledWith({ approvalId: 'a' });
    expect(mockApproveRestOfRunMutate).not.toHaveBeenCalled();
    expect(result.current.focusedIndex).toBe(0); // index unchanged
  });

  it('n calls reject.mutate with the focused approval id', () => {
    renderHook(() => useReviewQueueKeyboard(QUEUE_3));
    act(() => { press('n'); });
    expect(mockRejectMutate).toHaveBeenCalledTimes(1);
    expect(mockRejectMutate).toHaveBeenCalledWith({ approvalId: 'a' });
  });

  it('y calls approve with the correct id after navigating to a later item', () => {
    const { result } = renderHook(() => useReviewQueueKeyboard(QUEUE_3));
    act(() => { press('j'); }); // → 1 (approval 'b')
    act(() => { press('y'); });
    expect(mockApproveMutate).toHaveBeenCalledWith({ approvalId: 'b' });
    expect(result.current.focusedIndex).toBe(1);
  });
});

describe('useReviewQueueKeyboard — y/n mutations on group items', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('y on a group item calls approveRestOfRun.mutate once with the group runId', () => {
    const queue: QueueItem[] = [groupItem(['g1', 'g2', 'g3'], 'run-42')];
    renderHook(() => useReviewQueueKeyboard(queue));
    act(() => { press('y'); });
    expect(mockApproveRestOfRunMutate).toHaveBeenCalledTimes(1);
    expect(mockApproveRestOfRunMutate).toHaveBeenCalledWith({ runId: 'run-42' });
    expect(mockApproveMutate).not.toHaveBeenCalled();
  });

  it('n on a group item calls rejectRestOfRun.mutate once with the group runId -- not per-member reject', () => {
    const queue: QueueItem[] = [groupItem(['r1', 'r2', 'r3'], 'run-42')];
    renderHook(() => useReviewQueueKeyboard(queue));
    act(() => { press('n'); });
    expect(mockRejectRestOfRunMutate).toHaveBeenCalledTimes(1);
    expect(mockRejectRestOfRunMutate).toHaveBeenCalledWith({ runId: 'run-42' });
    expect(mockRejectMutate).not.toHaveBeenCalled();
  });
});

describe('useReviewQueueKeyboard — input-element guard', () => {
  let inputEl: HTMLInputElement;

  beforeEach(() => {
    vi.clearAllMocks();
    inputEl = document.createElement('input');
    document.body.appendChild(inputEl);
  });

  afterEach(() => {
    document.body.removeChild(inputEl);
  });

  it('j does not change focusedIndex when an <input> has focus', () => {
    const { result } = renderHook(() => useReviewQueueKeyboard(QUEUE_3));
    inputEl.focus();

    act(() => {
      fireEvent.keyDown(inputEl, { key: 'j', bubbles: true });
    });

    expect(result.current.focusedIndex).toBe(0);
  });

  it('y does not call approve.mutate when an <input> has focus', () => {
    renderHook(() => useReviewQueueKeyboard(QUEUE_3));
    inputEl.focus();

    act(() => {
      fireEvent.keyDown(inputEl, { key: 'y', bubbles: true });
    });

    expect(mockApproveMutate).not.toHaveBeenCalled();
  });
});

describe('useReviewQueueKeyboard — empty queue edge cases', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('j on empty queue does not throw and does not change focusedIndex', () => {
    const { result } = renderHook(() => useReviewQueueKeyboard([]));
    expect(() => {
      act(() => { press('j'); });
    }).not.toThrow();
    expect(result.current.focusedIndex).toBe(0);
  });

  it('k on empty queue does not throw', () => {
    const { result } = renderHook(() => useReviewQueueKeyboard([]));
    expect(() => {
      act(() => { press('k'); });
    }).not.toThrow();
    expect(result.current.focusedIndex).toBe(0);
  });

  it('y on empty queue does not throw and does not call approve', () => {
    renderHook(() => useReviewQueueKeyboard([]));
    expect(() => {
      act(() => { press('y'); });
    }).not.toThrow();
    expect(mockApproveMutate).not.toHaveBeenCalled();
  });

  it('n on empty queue does not throw and does not call reject', () => {
    renderHook(() => useReviewQueueKeyboard([]));
    expect(() => {
      act(() => { press('n'); });
    }).not.toThrow();
    expect(mockRejectMutate).not.toHaveBeenCalled();
  });
});

describe('useReviewQueueKeyboard — modifier key guard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('Cmd+J does not advance focusedIndex', () => {
    const { result } = renderHook(() => useReviewQueueKeyboard(QUEUE_3));
    act(() => {
      fireEvent.keyDown(window, { key: 'j', metaKey: true });
    });
    expect(result.current.focusedIndex).toBe(0);
  });

  it('Ctrl+N does not call reject', () => {
    renderHook(() => useReviewQueueKeyboard(QUEUE_3));
    act(() => {
      fireEvent.keyDown(window, { key: 'n', ctrlKey: true });
    });
    expect(mockRejectMutate).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Focus guard for non-input focusable elements (e.g. Radix focus traps)
// ---------------------------------------------------------------------------

describe('useReviewQueueKeyboard — focus guard for non-input focusable elements', () => {
  let focusableDiv: HTMLDivElement;

  beforeEach(() => {
    vi.clearAllMocks();
    focusableDiv = document.createElement('div');
    focusableDiv.tabIndex = 0;
    document.body.appendChild(focusableDiv);
  });

  afterEach(() => {
    document.body.removeChild(focusableDiv);
    // Restore focus to body so other tests are not affected.
    document.body.focus();
  });

  it('j is a no-op when a Radix-style focusable <div> holds focus', () => {
    const { result } = renderHook(() => useReviewQueueKeyboard(QUEUE_3));
    focusableDiv.focus();
    expect(document.activeElement).toBe(focusableDiv);

    act(() => {
      fireEvent.keyDown(window, { key: 'j', metaKey: false, ctrlKey: false, altKey: false });
    });

    expect(result.current.focusedIndex).toBe(0);
  });

  it('y is a no-op when a Radix-style focusable <div> holds focus (no mutation fires)', () => {
    renderHook(() => useReviewQueueKeyboard(QUEUE_3));
    focusableDiv.focus();
    expect(document.activeElement).toBe(focusableDiv);

    act(() => {
      fireEvent.keyDown(window, { key: 'y', metaKey: false, ctrlKey: false, altKey: false });
    });

    expect(mockApproveMutate).not.toHaveBeenCalled();
    expect(mockApproveRestOfRunMutate).not.toHaveBeenCalled();
  });

  it('j still advances focusedIndex when document.activeElement is document.body', () => {
    const { result } = renderHook(() => useReviewQueueKeyboard(QUEUE_3));
    // jsdom starts with body as activeElement; call focus() explicitly to be certain.
    document.body.focus();
    expect(document.activeElement).toBe(document.body);

    act(() => {
      press('j');
    });

    expect(result.current.focusedIndex).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// onDecide callback (TASK-625)
// ---------------------------------------------------------------------------

describe('useReviewQueueKeyboard — onDecide callback', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('y dispatches approve mutation AND calls onDecide once', () => {
    const onDecide = vi.fn();
    renderHook(() => useReviewQueueKeyboard(QUEUE_3, onDecide));
    act(() => { press('y'); });
    expect(mockApproveMutate).toHaveBeenCalledTimes(1);
    expect(onDecide).toHaveBeenCalledTimes(1);
  });

  it('n dispatches reject mutation AND calls onDecide once', () => {
    const onDecide = vi.fn();
    renderHook(() => useReviewQueueKeyboard(QUEUE_3, onDecide));
    act(() => { press('n'); });
    expect(mockRejectMutate).toHaveBeenCalledTimes(1);
    expect(onDecide).toHaveBeenCalledTimes(1);
  });

  it('y on a group item calls approveRestOfRun AND calls onDecide once', () => {
    const onDecide = vi.fn();
    const queue = [groupItem(['g1', 'g2'], 'run-grp')];
    renderHook(() => useReviewQueueKeyboard(queue, onDecide));
    act(() => { press('y'); });
    expect(mockApproveRestOfRunMutate).toHaveBeenCalledTimes(1);
    expect(onDecide).toHaveBeenCalledTimes(1);
  });

  it('y on an empty queue does not call onDecide', () => {
    const onDecide = vi.fn();
    renderHook(() => useReviewQueueKeyboard([], onDecide));
    act(() => { press('y'); });
    expect(onDecide).not.toHaveBeenCalled();
  });

  it('modifier-key combos (Cmd-y) do not call onDecide', () => {
    const onDecide = vi.fn();
    renderHook(() => useReviewQueueKeyboard(QUEUE_3, onDecide));
    act(() => {
      fireEvent.keyDown(window, { key: 'y', metaKey: true });
    });
    expect(onDecide).not.toHaveBeenCalled();
  });

  it('onDecide is not called when no onDecide is provided (no errors thrown)', () => {
    // Omit onDecide — just ensure y/n work without it
    renderHook(() => useReviewQueueKeyboard(QUEUE_3));
    expect(() => {
      act(() => { press('y'); });
    }).not.toThrow();
    expect(mockApproveMutate).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// React.StrictMode regression — state updaters must not fire side effects
// ---------------------------------------------------------------------------

describe('useReviewQueueKeyboard — StrictMode double-invocation regression', () => {
  /**
   * React.StrictMode intentionally invokes state updater functions twice in
   * dev to surface impure updaters.  This test mounts the hook inside
   * StrictMode and asserts that pressing y/n fires each mutation exactly once,
   * not twice (which would happen if mutations were placed inside setFocusedIndex
   * updater callbacks instead of directly in the event handler).
   */
  const strictWrapper = ({ children }: { children: React.ReactNode }) =>
    React.createElement(React.StrictMode, null, children);

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('y fires approve.mutate exactly once under StrictMode (not twice)', () => {
    renderHook(() => useReviewQueueKeyboard(QUEUE_3), { wrapper: strictWrapper });
    act(() => { press('y'); });
    expect(mockApproveMutate).toHaveBeenCalledTimes(1);
    expect(mockApproveMutate).toHaveBeenCalledWith({ approvalId: 'a' });
  });

  it('n fires reject.mutate exactly once under StrictMode (not twice)', () => {
    renderHook(() => useReviewQueueKeyboard(QUEUE_3), { wrapper: strictWrapper });
    act(() => { press('n'); });
    expect(mockRejectMutate).toHaveBeenCalledTimes(1);
    expect(mockRejectMutate).toHaveBeenCalledWith({ approvalId: 'a' });
  });

  it('j/k navigation still works correctly under StrictMode', () => {
    const { result } = renderHook(() => useReviewQueueKeyboard(QUEUE_3), {
      wrapper: strictWrapper,
    });
    act(() => { press('j'); });
    expect(result.current.focusedIndex).toBe(1);
    act(() => { press('k'); });
    expect(result.current.focusedIndex).toBe(0);
  });
});
