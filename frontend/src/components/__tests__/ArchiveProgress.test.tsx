/**
 * Unit tests for ArchiveProgress (Sidebar footer archive-task panel).
 *
 * Verifies:
 *   - Renders nothing when the progress payload is empty (totalCount: 0).
 *   - Pauses the 2s archive-progress poll (API.sessions.getArchiveProgress —
 *     the cyboflow.sessions tRPC query, formerly `archive:get-progress`) while
 *     the document is hidden,
 *     resumes with an immediate catch-up load on re-show (mirrors the
 *     visibility-gate pattern in useSessionMetrics.ts / LiveCanvasEmbed).
 */
import '@testing-library/jest-dom';
import { render, screen, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ArchiveProgress } from '../ArchiveProgress';
import { API } from '../../utils/api';

// The poll rides API.sessions.getArchiveProgress (tRPC).
vi.mock('../../utils/api', () => ({
  API: { sessions: { getArchiveProgress: vi.fn() } },
}));

const getArchiveProgress = vi.mocked(API.sessions.getArchiveProgress);

interface ArchiveTaskFixture {
  sessionId: string;
  sessionName: string;
  worktreeName: string;
  projectName: string;
  status: 'pending' | 'queued' | 'removing-worktree' | 'cleaning-artifacts' | 'completed' | 'failed';
  startTime: string;
}

function progress(activeCount: number, tasks: ArchiveTaskFixture[] = []) {
  return { tasks, activeCount, totalCount: tasks.length };
}

beforeEach(() => {
  vi.useFakeTimers();
  getArchiveProgress.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('ArchiveProgress', () => {
  it('renders nothing when there are no archive tasks', async () => {
    getArchiveProgress.mockResolvedValue({ success: true, data: progress(0) });

    const { container } = render(<ArchiveProgress />);
    await act(async () => {
      await Promise.resolve();
    });

    expect(container).toBeEmptyDOMElement();
  });

  it('pauses the 2s poll while hidden, resumes with an immediate catch-up load on re-show', async () => {
    const task: ArchiveTaskFixture = {
      sessionId: 's1',
      sessionName: 'archiving-session',
      worktreeName: 'wt-1',
      projectName: 'proj',
      status: 'removing-worktree',
      startTime: new Date().toISOString(),
    };
    getArchiveProgress.mockResolvedValue({ success: true, data: progress(1, [task]) });

    const hiddenSpy = vi.spyOn(document, 'hidden', 'get');
    hiddenSpy.mockReturnValue(false);

    try {
      render(<ArchiveProgress />);
      await act(async () => {
        await Promise.resolve();
      });
      expect(screen.getByText('Archive Tasks')).toBeInTheDocument();
      const callsAfterMount = getArchiveProgress.mock.calls.length;

      // Hide the document — the 2s poll must stop firing.
      hiddenSpy.mockReturnValue(true);
      act(() => {
        document.dispatchEvent(new Event('visibilitychange'));
      });
      await act(async () => {
        vi.advanceTimersByTime(10_000);
        await Promise.resolve();
      });
      expect(getArchiveProgress.mock.calls.length).toBe(callsAfterMount);

      // Re-show — an immediate catch-up load fires, then the 2s cadence resumes.
      hiddenSpy.mockReturnValue(false);
      await act(async () => {
        document.dispatchEvent(new Event('visibilitychange'));
        await Promise.resolve();
      });
      expect(getArchiveProgress.mock.calls.length).toBeGreaterThan(callsAfterMount);
    } finally {
      hiddenSpy.mockRestore();
    }
  });
});
