// @vitest-environment jsdom
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
import { renderHook, act } from '@testing-library/react';
import { fireEvent } from '@testing-library/dom';
import type { Approval } from '../../../../shared/types/approvals';

// ---------------------------------------------------------------------------
// tRPC mock — use vi.hoisted so variables are available before vi.mock hoisting
// ---------------------------------------------------------------------------

const { mockApproveMutate, mockRejectMutate } = vi.hoisted(() => ({
  mockApproveMutate: vi.fn().mockResolvedValue(undefined),
  mockRejectMutate:  vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../trpc/client', () => ({
  trpc: {
    cyboflow: {
      approvals: {
        approve: { mutate: mockApproveMutate },
        reject:  { mutate: mockRejectMutate  },
      },
    },
  },
}));

// Import AFTER mock is registered.
import { useReviewQueueKeyboard } from '../useReviewQueueKeyboard';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeApproval(id: string): Approval {
  return {
    id,
    runId: 'run-1',
    workflowName: 'Test Workflow',
    toolName: 'Bash',
    payloadPreview: 'echo hello',
    rationale: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    status: 'pending',
  };
}

const QUEUE_3 = [makeApproval('a'), makeApproval('b'), makeApproval('c')];

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

describe('useReviewQueueKeyboard — y/n mutations', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('y calls approve.mutate with the focused approval id', () => {
    const { result } = renderHook(() => useReviewQueueKeyboard(QUEUE_3));
    // focusedIndex = 0 → approval 'a'
    act(() => { press('y'); });
    expect(mockApproveMutate).toHaveBeenCalledTimes(1);
    expect(mockApproveMutate).toHaveBeenCalledWith({ approvalId: 'a' });
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

    // Fire keydown on the input itself — the event bubbles to window, and the
    // hook reads event.target which will be the input element.
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
