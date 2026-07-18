/**
 * PromptNavigation ongoing-duration timer tests.
 *
 * The uncontrolled mode drives a periodic re-render for the ongoing prompt's
 * elapsed-duration display. This used to be a recursive requestAnimationFrame
 * loop that woke at display cadence (60-120Hz) just to compare timestamps —
 * now it's a 5s setInterval gated on document.visibilityState, pausing while
 * hidden and doing one immediate catch-up update on becoming visible. These
 * tests exercise that timer/visibility contract directly rather than the rAF
 * internals it replaced.
 *
 * Fake timers are used throughout, so we flush the initial async fetchPrompts
 * with a plain `await act(async () => {...})` rather than testing-library's
 * `waitFor` — waitFor polls via real setTimeout, which never fires once the
 * global timer functions are faked.
 */
import '@testing-library/jest-dom';
import { render, screen, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PromptNavigation, type PromptMarker } from '../PromptNavigation';

const ongoingPrompt: PromptMarker = {
  id: 1,
  panel_id: 'panel-1',
  prompt_text: 'do the thing',
  output_index: 0,
  timestamp: new Date(Date.now() - 1000).toISOString(),
  // no completion_timestamp — this is the "ongoing" prompt that drives the timer
};

function setVisibility(state: DocumentVisibilityState) {
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => state,
  });
}

async function renderAndFlush() {
  render(<PromptNavigation panelId="panel-1" onNavigateToPrompt={vi.fn()} />);
  // Flush the microtask-resolved getPrompts() fetch that seeds the ongoing prompt.
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('PromptNavigation ongoing-duration timer', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    setVisibility('visible');

    Object.defineProperty(window, 'electronAPI', {
      writable: true,
      configurable: true,
      value: {
        panels: {
          getPrompts: vi.fn().mockResolvedValue({ success: true, data: [ongoingPrompt] }),
        },
        events: {
          onPanelPromptAdded: vi.fn().mockReturnValue(() => {}),
          onPanelResponseAdded: vi.fn().mockReturnValue(() => {}),
        },
      },
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not tick faster than the 5s interval while visible', async () => {
    await renderAndFlush();

    expect(screen.getByText(/do the thing/)).toBeInTheDocument();
    expect(screen.getByText(/waiting/)).toBeInTheDocument();
    const before = screen.getByText(/waiting/).textContent;

    act(() => {
      vi.advanceTimersByTime(2000); // under the 5s threshold — no forced update yet
    });
    expect(screen.getByText(/waiting/).textContent).toBe(before);

    act(() => {
      vi.advanceTimersByTime(3000); // crosses the 5s mark
    });
    expect(screen.getByText(/waiting/).textContent).not.toBe(before);
  });

  it('pauses the timer while hidden and catches up immediately on becoming visible', async () => {
    await renderAndFlush();

    const before = screen.getByText(/waiting/).textContent;

    setVisibility('hidden');
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });

    act(() => {
      vi.advanceTimersByTime(20000); // well past 5s, but hidden — no forced update
    });
    expect(screen.getByText(/waiting/).textContent).toBe(before);

    setVisibility('visible');
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });

    // Catch-up update fires synchronously from the visibilitychange handler.
    expect(screen.getByText(/waiting/).textContent).not.toBe(before);
  });

  it('clears the interval and listener on unmount', async () => {
    const removeListenerSpy = vi.spyOn(document, 'removeEventListener');

    const { unmount } = render(<PromptNavigation panelId="panel-1" onNavigateToPrompt={vi.fn()} />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByText(/waiting/)).toBeInTheDocument();

    const pendingBefore = vi.getTimerCount();
    expect(pendingBefore).toBeGreaterThan(0); // the 5s interval is scheduled

    unmount();

    expect(vi.getTimerCount()).toBe(0);
    expect(removeListenerSpy).toHaveBeenCalledWith('visibilitychange', expect.any(Function));
  });
});
