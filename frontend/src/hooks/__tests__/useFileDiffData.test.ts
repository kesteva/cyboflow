/**
 * Unit tests for useFileDiffData — resolving a single file's parsed diff for a
 * center-pane file tab.
 *
 * Focus: the base-propagation refetch contract (TASK-213). The hook must
 * refetch when `comparisonRef` or `scope` change, passing BOTH through to
 * `API.sessions.getCombinedDiff` — this is the actual bug this task exists to
 * fix (a base-ref flip on the owning tab silently never refetching without the
 * widened effect deps).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

const { mockGetCombinedDiff } = vi.hoisted(() => ({
  mockGetCombinedDiff: vi.fn(),
}));

vi.mock('../../utils/api', () => ({
  API: {
    sessions: {
      getCombinedDiff: mockGetCombinedDiff,
    },
  },
}));

import { useFileDiffData } from '../useFileDiffData';
import type { DiffGroupScope } from '../../../../shared/types/runFiles';

const DIFF = `diff --git a/src/a.ts b/src/a.ts
index 111..222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,1 +1,1 @@
-old line
+new line
`;

beforeEach(() => {
  mockGetCombinedDiff.mockReset();
  mockGetCombinedDiff.mockResolvedValue({
    success: true,
    data: { diff: DIFF, stats: { additions: 1, deletions: 1, filesChanged: 1 }, changedFiles: ['src/a.ts'] },
  });
});

describe('useFileDiffData', () => {
  it('fetches on mount, forwarding sessionId/filePath and the comparisonRef/scope', async () => {
    const { result } = renderHook(() => useFileDiffData('s1', 'src/a.ts', 'main', 'unstaged'));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(mockGetCombinedDiff).toHaveBeenCalledTimes(1);
    expect(mockGetCombinedDiff).toHaveBeenCalledWith('s1', undefined, 'main', 'unstaged');
    expect(result.current.fileDiff).not.toBeNull();
  });

  it('refetches with the new comparisonRef when it changes', async () => {
    const { result, rerender } = renderHook(
      ({ comparisonRef }) => useFileDiffData('s1', 'src/a.ts', comparisonRef, 'unstaged'),
      { initialProps: { comparisonRef: 'main' } },
    );
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(mockGetCombinedDiff).toHaveBeenCalledTimes(1);

    rerender({ comparisonRef: 'feature-branch' });
    await waitFor(() => expect(mockGetCombinedDiff).toHaveBeenCalledTimes(2));
    expect(mockGetCombinedDiff).toHaveBeenNthCalledWith(2, 's1', undefined, 'feature-branch', 'unstaged');
  });

  it('refetches with the new scope when it changes', async () => {
    const { result, rerender } = renderHook(
      ({ scope }: { scope: DiffGroupScope }) => useFileDiffData('s1', 'src/a.ts', 'main', scope),
      { initialProps: { scope: 'unstaged' } },
    );
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(mockGetCombinedDiff).toHaveBeenCalledTimes(1);

    rerender({ scope: 'staged' });
    await waitFor(() => expect(mockGetCombinedDiff).toHaveBeenCalledTimes(2));
    expect(mockGetCombinedDiff).toHaveBeenNthCalledWith(2, 's1', undefined, 'main', 'staged');
  });

  it('does NOT refetch on a rerender with unchanged args', async () => {
    const { result, rerender } = renderHook(() => useFileDiffData('s1', 'src/a.ts', 'main', 'unstaged'));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(mockGetCombinedDiff).toHaveBeenCalledTimes(1);

    rerender();
    expect(mockGetCombinedDiff).toHaveBeenCalledTimes(1);
  });
});
