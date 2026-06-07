/**
 * Unit tests for useSessionMetrics (QuickSessionCanvas live node).
 *
 * The pure formatters are tested directly; the hook is exercised with
 * renderHook + a mocked API.sessions.getStatistics (no real Electron IPC).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

const { mockGetStatistics } = vi.hoisted(() => ({
  mockGetStatistics: vi.fn(),
}));

vi.mock('../../utils/api', () => ({
  API: {
    sessions: {
      getStatistics: mockGetStatistics,
    },
  },
}));

import { useSessionMetrics, formatElapsed, formatTokenCount } from '../useSessionMetrics';
import type { Session } from '../../types/session';

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 's1',
    name: 'tester-mctest',
    worktreePath: '/repo/.cyboflow/worktrees/quick-20260607-120000',
    prompt: '',
    status: 'running',
    createdAt: new Date(Date.now() - 252_000).toISOString(), // ~4m 12s ago
    output: [],
    jsonMessages: [],
    ...overrides,
  } as Session;
}

const STATS = {
  success: true,
  data: {
    session: { model: 'sonnet 4.5', branch: 'quick-20260607-120000' },
    tokens: { totalInputTokens: 10_000, totalOutputTokens: 2_400 },
    files: { totalFilesChanged: 18, totalLinesAdded: 5, totalLinesDeleted: 2 },
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  mockGetStatistics.mockResolvedValue(STATS);
});

describe('formatElapsed', () => {
  it.each([
    [0, '0s'],
    [12_000, '12s'],
    [252_000, '4m 12s'],
    [3_600_000, '1h 0m'],
    [3_725_000, '1h 2m'],
  ])('formats %ims as %s', (ms, expected) => {
    expect(formatElapsed(ms)).toBe(expected);
  });

  it('never renders negative time', () => {
    expect(formatElapsed(-5000)).toBe('0s');
  });
});

describe('formatTokenCount', () => {
  it.each([
    [0, '0'],
    [936, '936'],
    [1_000, '1k'],
    [12_400, '12.4k'],
    [18_000, '18k'],
    [1_200_000, '1.2M'],
  ])('formats %i as %s', (n, expected) => {
    expect(formatTokenCount(n)).toBe(expected);
  });
});

describe('useSessionMetrics', () => {
  it('returns zeroed metrics and does not query when session is null', () => {
    const { result } = renderHook(() => useSessionMetrics(null));
    expect(result.current.tokens).toBe('0');
    expect(result.current.filesSeen).toBe(0);
    expect(result.current.diff).toEqual({ plus: 0, minus: 0 });
    expect(mockGetStatistics).not.toHaveBeenCalled();
  });

  it('surfaces tokens / files / diff / model / branch from getStatistics', async () => {
    const { result } = renderHook(() => useSessionMetrics(makeSession()));

    await waitFor(() => {
      expect(result.current.tokens).toBe('12.4k');
    });
    expect(mockGetStatistics).toHaveBeenCalledWith('s1');
    expect(result.current.filesSeen).toBe(18);
    expect(result.current.diff).toEqual({ plus: 5, minus: 2 });
    expect(result.current.model).toBe('sonnet 4.5');
    expect(result.current.branch).toBe('quick-20260607-120000');
  });

  it('ticks a non-empty elapsed string derived from createdAt', () => {
    const { result } = renderHook(() => useSessionMetrics(makeSession()));
    // createdAt is ~4m 12s ago; the exact second may drift, so just assert shape.
    expect(result.current.elapsed).toMatch(/^\d+m \d+s$/);
  });

  it('falls back to the worktree basename for the branch when stats omit it', async () => {
    mockGetStatistics.mockResolvedValue({
      success: true,
      data: { session: {}, tokens: {}, files: {} },
    });
    const { result } = renderHook(() => useSessionMetrics(makeSession()));
    await waitFor(() => {
      expect(result.current.branch).toBe('quick-20260607-120000');
    });
  });
});
