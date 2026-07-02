/**
 * Unit tests for useArtifactData — the per-atype content-derivation switch.
 *
 * Focus: the atype→source routing itself (the ArtifactTabRenderer tests mock
 * this hook wholesale, so nothing else asserts these branches):
 *   1. 'arch-design' fetches the idea via tasks.get (NOT ideaDecomposition)
 *      and yields kind 'arch' — the historical landmine was the final ternary
 *      silently routing new templated atypes into the 'stories' shape.
 *   2. 'idea-spec' fetches via tasks.get and yields kind 'idea'.
 *   3. 'decomposed-stories' fetches via ideaDecomposition and yields 'stories'.
 *   4. A templated atype without sourceRef yields the graceful error state.
 *   5. Canvas ('ui-prototype'/'generic') + 'screenshots' resolve synchronously
 *      from payload_json with no fetch.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import type { Artifact } from '../../../../shared/types/artifacts';
import type { BacklogTaskItem } from '../../../../shared/types/tasks';

const getQuerySpy = vi.fn();
const decompositionQuerySpy = vi.fn();

vi.mock('../../trpc/client', () => ({
  trpc: {
    cyboflow: {
      tasks: {
        get: {
          query: (...args: unknown[]) => getQuerySpy(...args) as Promise<BacklogTaskItem | null>,
        },
        ideaDecomposition: {
          query: (...args: unknown[]) =>
            decompositionQuerySpy(...args) as Promise<BacklogTaskItem | null>,
        },
      },
    },
  },
}));

import { useArtifactData } from '../useArtifactData';

const IDEA = { id: 'idea-1', title: 'Idea', body: '## Architecture design\n\nx' } as unknown as BacklogTaskItem;

function makeArtifact(overrides: Partial<Artifact>): Artifact {
  return {
    id: 'art-1',
    runId: 'run-1',
    sessionId: null,
    atype: 'idea-spec',
    label: 'label',
    stepOrigin: null,
    mode: 'template',
    committed: false,
    sessionOnly: true,
    isNew: false,
    payloadJson: null,
    sourceRef: 'idea-1',
    createdAt: '2026-01-01T00:00:00.000Z',
    committedAt: null,
    ...overrides,
  };
}

beforeEach(() => {
  getQuerySpy.mockReset().mockResolvedValue(IDEA);
  decompositionQuerySpy.mockReset().mockResolvedValue(IDEA);
});

describe('useArtifactData', () => {
  it("routes 'arch-design' through tasks.get and yields kind 'arch' (not 'stories')", async () => {
    const { result } = renderHook(() => useArtifactData(makeArtifact({ atype: 'arch-design' })));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(getQuerySpy).toHaveBeenCalledWith({ taskId: 'idea-1' });
    expect(decompositionQuerySpy).not.toHaveBeenCalled();
    expect(result.current.error).toBeNull();
    expect(result.current.data).toEqual({ kind: 'arch', idea: IDEA });
  });

  it("routes 'idea-spec' through tasks.get and yields kind 'idea'", async () => {
    const { result } = renderHook(() => useArtifactData(makeArtifact({ atype: 'idea-spec' })));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(getQuerySpy).toHaveBeenCalledWith({ taskId: 'idea-1' });
    expect(result.current.data).toEqual({ kind: 'idea', idea: IDEA });
  });

  it("routes 'decomposed-stories' through ideaDecomposition and yields kind 'stories'", async () => {
    const { result } = renderHook(() =>
      useArtifactData(makeArtifact({ atype: 'decomposed-stories' })),
    );

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(decompositionQuerySpy).toHaveBeenCalledWith({ ideaId: 'idea-1' });
    expect(getQuerySpy).not.toHaveBeenCalled();
    expect(result.current.data).toEqual({ kind: 'stories', idea: IDEA });
  });

  it("yields the graceful no-source error for a templated atype without sourceRef", async () => {
    const { result } = renderHook(() =>
      useArtifactData(makeArtifact({ atype: 'arch-design', sourceRef: null })),
    );

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(getQuerySpy).not.toHaveBeenCalled();
    expect(result.current.error).toBe('No source entity linked to this artifact.');
    expect(result.current.data).toBeNull();
  });

  it("yields the not-found error when the source entity is gone", async () => {
    getQuerySpy.mockResolvedValue(null);
    const { result } = renderHook(() => useArtifactData(makeArtifact({ atype: 'arch-design' })));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBe('Source entity not found.');
    expect(result.current.data).toBeNull();
  });

  it("resolves canvas atypes synchronously from payload_json (no fetch)", () => {
    const { result } = renderHook(() =>
      useArtifactData(
        makeArtifact({ atype: 'ui-prototype', payloadJson: '{"url":"http://localhost:8123/"}' }),
      ),
    );

    expect(result.current.loading).toBe(false);
    expect(result.current.data).toEqual({ kind: 'canvas', payload: { url: 'http://localhost:8123/' } });
    expect(getQuerySpy).not.toHaveBeenCalled();
    expect(decompositionQuerySpy).not.toHaveBeenCalled();
  });

  it("resolves 'screenshots' synchronously from payload_json (no fetch)", () => {
    const { result } = renderHook(() =>
      useArtifactData(
        makeArtifact({ atype: 'screenshots', payloadJson: '{"fileNames":["home.png"]}' }),
      ),
    );

    expect(result.current.loading).toBe(false);
    expect(result.current.data).toEqual({ kind: 'screenshots', payload: { fileNames: ['home.png'] } });
    expect(getQuerySpy).not.toHaveBeenCalled();
  });
});
