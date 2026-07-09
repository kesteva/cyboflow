/**
 * Unit tests for useArtifactData — the per-atype content-derivation switch, plus
 * the live-refresh contract for the entity-backed atypes.
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
 *   6. Live refresh: a relevant `onTaskChanged` event silently re-fetches (no
 *      loading flash); an unrelated event does not; the subscription tears down
 *      on unmount. Passing projectId=null keeps the tab one-shot (no subscribe).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import type { Artifact } from '../../../../shared/types/artifacts';
import type { BacklogTaskItem, TaskChangedEvent } from '../../../../shared/types/tasks';

const getQuerySpy = vi.fn();
const decompositionQuerySpy = vi.fn();
const unsubscribeSpy = vi.fn();
// Captured `onData` handler of the most recent onTaskChanged.subscribe call, so
// a test can push a TaskChangedEvent through the live path.
let taskChangedHandler: ((event: TaskChangedEvent) => void) | null = null;

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
        onTaskChanged: {
          subscribe: (_input: unknown, handlers: { onData: (e: TaskChangedEvent) => void }) => {
            taskChangedHandler = handlers.onData;
            return { unsubscribe: unsubscribeSpy };
          },
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

/** A minimal TaskChangedEvent for the live-refresh tests. */
function taskEvent(task: Partial<BacklogTaskItem>): TaskChangedEvent {
  return {
    projectId: 7,
    taskId: (task.id as string) ?? 't',
    action: 'created',
    task: task as unknown as BacklogTaskItem,
  };
}

beforeEach(() => {
  getQuerySpy.mockReset().mockResolvedValue(IDEA);
  decompositionQuerySpy.mockReset().mockResolvedValue(IDEA);
  unsubscribeSpy.mockReset();
  taskChangedHandler = null;
});

describe('useArtifactData', () => {
  it("routes 'arch-design' through tasks.get and yields kind 'arch' (not 'stories')", async () => {
    const { result } = renderHook(() => useArtifactData(makeArtifact({ atype: 'arch-design' }), null));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(getQuerySpy).toHaveBeenCalledWith({ taskId: 'idea-1' });
    expect(decompositionQuerySpy).not.toHaveBeenCalled();
    expect(result.current.error).toBeNull();
    expect(result.current.data).toEqual({ kind: 'arch', idea: IDEA });
  });

  it("routes 'idea-spec' through tasks.get and yields kind 'idea'", async () => {
    const { result } = renderHook(() => useArtifactData(makeArtifact({ atype: 'idea-spec' }), null));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(getQuerySpy).toHaveBeenCalledWith({ taskId: 'idea-1' });
    expect(result.current.data).toEqual({ kind: 'idea', idea: IDEA });
  });

  it("routes 'decomposed-stories' through ideaDecomposition and yields kind 'stories'", async () => {
    const { result } = renderHook(() =>
      useArtifactData(makeArtifact({ atype: 'decomposed-stories' }), null),
    );

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(decompositionQuerySpy).toHaveBeenCalledWith({ ideaId: 'idea-1' });
    expect(getQuerySpy).not.toHaveBeenCalled();
    expect(result.current.data).toEqual({ kind: 'stories', idea: IDEA });
  });

  it("yields the graceful no-source error for a templated atype without sourceRef", async () => {
    const { result } = renderHook(() =>
      useArtifactData(makeArtifact({ atype: 'arch-design', sourceRef: null }), null),
    );

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(getQuerySpy).not.toHaveBeenCalled();
    expect(result.current.error).toBe('No source entity linked to this artifact.');
    expect(result.current.data).toBeNull();
  });

  it("yields the not-found error when the source entity is gone", async () => {
    getQuerySpy.mockResolvedValue(null);
    const { result } = renderHook(() => useArtifactData(makeArtifact({ atype: 'arch-design' }), null));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBe('Source entity not found.');
    expect(result.current.data).toBeNull();
  });

  it("resolves canvas atypes synchronously from payload_json (no fetch)", () => {
    const { result } = renderHook(() =>
      useArtifactData(
        makeArtifact({ atype: 'ui-prototype', payloadJson: '{"url":"http://localhost:8123/"}' }),
        null,
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
        null,
      ),
    );

    expect(result.current.loading).toBe(false);
    expect(result.current.data).toEqual({ kind: 'screenshots', payload: { fileNames: ['home.png'] } });
    expect(getQuerySpy).not.toHaveBeenCalled();
  });

  it("resolves 'compound-recommendations' synchronously from payload_json (no fetch, no source entity)", () => {
    const { result } = renderHook(() =>
      useArtifactData(
        // sourceRef null: unlike the entity-backed templated atypes, this must NOT
        // hit the no-source error path — it is payload-backed.
        makeArtifact({
          atype: 'compound-recommendations',
          sourceRef: null,
          payloadJson: '{"markdown":"## Recommendations\\n\\n- do the thing"}',
        }),
        null,
      ),
    );

    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeNull();
    expect(result.current.data).toEqual({
      kind: 'recommendations',
      payload: { markdown: '## Recommendations\n\n- do the thing' },
    });
    expect(getQuerySpy).not.toHaveBeenCalled();
    expect(decompositionQuerySpy).not.toHaveBeenCalled();
  });

  // --- live refresh ---------------------------------------------------------

  it("does NOT subscribe when projectId is null (one-shot tab)", async () => {
    const { result } = renderHook(() =>
      useArtifactData(makeArtifact({ atype: 'decomposed-stories' }), null),
    );
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(taskChangedHandler).toBeNull();
  });

  it("live-refreshes decomposed-stories on a task under this idea, with no loading flash", async () => {
    const ONE = { ...IDEA, children: [{ id: 't1', type: 'task' }] } as unknown as BacklogTaskItem;
    const TWO = {
      ...IDEA,
      children: [{ id: 't1', type: 'task' }, { id: 't2', type: 'task' }],
    } as unknown as BacklogTaskItem;
    decompositionQuerySpy.mockReset().mockResolvedValueOnce(ONE).mockResolvedValueOnce(TWO);

    const { result } = renderHook(() =>
      useArtifactData(makeArtifact({ atype: 'decomposed-stories' }), 7),
    );

    await waitFor(() => expect(result.current.data).toEqual({ kind: 'stories', idea: ONE }));
    expect(decompositionQuerySpy).toHaveBeenCalledTimes(1);
    expect(taskChangedHandler).not.toBeNull();

    // A task created under THIS idea (originating_idea_id === sourceRef).
    act(() => {
      taskChangedHandler?.(taskEvent({ id: 't2', originating_idea_id: 'idea-1' }));
    });

    // Silent: loading never flips back to true and the prior content stays put
    // until the fresh decomposition resolves.
    expect(result.current.loading).toBe(false);
    expect(result.current.data).toEqual({ kind: 'stories', idea: ONE });

    await waitFor(() => expect(result.current.data).toEqual({ kind: 'stories', idea: TWO }));
    expect(decompositionQuerySpy).toHaveBeenCalledTimes(2);
  });

  it("live-refreshes idea-spec when the idea itself changes (id === sourceRef)", async () => {
    const { result } = renderHook(() => useArtifactData(makeArtifact({ atype: 'idea-spec' }), 7));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(getQuerySpy).toHaveBeenCalledTimes(1);

    act(() => {
      taskChangedHandler?.(taskEvent({ id: 'idea-1', originating_idea_id: null }));
    });

    await waitFor(() => expect(getQuerySpy).toHaveBeenCalledTimes(2));
  });

  it("ignores an onTaskChanged event for an unrelated idea", async () => {
    const { result } = renderHook(() =>
      useArtifactData(makeArtifact({ atype: 'decomposed-stories' }), 7),
    );
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(decompositionQuerySpy).toHaveBeenCalledTimes(1);

    act(() => {
      taskChangedHandler?.(taskEvent({ id: 'other-task', originating_idea_id: 'other-idea' }));
    });

    // No relevant match → no re-fetch.
    expect(decompositionQuerySpy).toHaveBeenCalledTimes(1);
  });

  it("keeps last-good data when a live refetch fails after a successful load", async () => {
    const ONE = { ...IDEA, children: [{ id: 't1', type: 'task' }] } as unknown as BacklogTaskItem;
    let rejectSilent: (e: unknown) => void = () => {};
    decompositionQuerySpy
      .mockReset()
      .mockResolvedValueOnce(ONE)
      .mockImplementationOnce(() => new Promise((_res, rej) => { rejectSilent = rej; }));

    const { result } = renderHook(() =>
      useArtifactData(makeArtifact({ atype: 'decomposed-stories' }), 7),
    );
    await waitFor(() => expect(result.current.data).toEqual({ kind: 'stories', idea: ONE }));

    act(() => {
      taskChangedHandler?.(taskEvent({ id: 't2', originating_idea_id: 'idea-1' }));
    });
    await act(async () => {
      rejectSilent(new Error('boom'));
      await Promise.resolve();
    });

    // The failed live refresh preserves the last-good content — no error, no blank.
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeNull();
    expect(result.current.data).toEqual({ kind: 'stories', idea: ONE });
  });

  it("surfaces an error (not a stuck spinner) when a live refetch supersedes the initial load and fails", async () => {
    // Regression for the adversarial-review finding: a relevant event fires while
    // the initial load is still in flight (never settles here), bumping the fetch
    // id so the initial success would be discarded; the superseding silent refetch
    // then fails. Without the guard-clear this stranded the tab on {loading:true}.
    let rejectSilent: (e: unknown) => void = () => {};
    decompositionQuerySpy
      .mockReset()
      .mockImplementationOnce(() => new Promise(() => {})) // initial: never settles
      .mockImplementationOnce(() => new Promise((_res, rej) => { rejectSilent = rej; }));

    const { result } = renderHook(() =>
      useArtifactData(makeArtifact({ atype: 'decomposed-stories' }), 7),
    );
    expect(result.current.loading).toBe(true);

    act(() => {
      taskChangedHandler?.(taskEvent({ id: 't2', originating_idea_id: 'idea-1' }));
    });
    expect(decompositionQuerySpy).toHaveBeenCalledTimes(2);

    await act(async () => {
      rejectSilent(new Error('ipc boom'));
      await Promise.resolve();
    });

    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBe('ipc boom');
    expect(result.current.data).toBeNull();
  });

  it("tears down the subscription on unmount", async () => {
    const { result, unmount } = renderHook(() =>
      useArtifactData(makeArtifact({ atype: 'decomposed-stories' }), 7),
    );
    await waitFor(() => expect(result.current.loading).toBe(false));
    unmount();
    expect(unsubscribeSpy).toHaveBeenCalled();
  });
});
