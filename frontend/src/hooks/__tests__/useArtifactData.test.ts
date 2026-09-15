/**
 * Unit tests for useArtifactData — the per-atype content-derivation switch, plus
 * the live-refresh contract for the entity-backed atypes.
 *
 * Focus: the atype→source routing itself (the ArtifactTabRenderer tests mock
 * this hook wholesale, so nothing else asserts these branches):
 *   1. 'arch-design' fetches the idea via tasks.get (NOT a decomposition read)
 *      and yields kind 'arch' — the historical landmine was the final ternary
 *      silently routing new templated atypes into the 'stories' shape.
 *   2. 'idea-spec' fetches via tasks.get and yields kind 'idea'.
 *   3. 'decomposed-stories' is RUN-scoped: it fetches via runDecomposition({
 *      runId }) (NOT sourceRef) and yields kind 'stories' with an idea ARRAY
 *      (one tree per idea the run owns).
 *   4. A single-idea templated atype without sourceRef yields the graceful error
 *      state; decomposed-stories does NOT require sourceRef.
 *   5. Canvas ('ui-prototype'/'generic') + 'screenshots' resolve synchronously
 *      from payload_json with no fetch.
 *   6. Live refresh: idea-spec/arch-design re-fetch only on a relevant
 *      `onTaskChanged` (id/originating_idea_id === sourceRef); decomposed-stories
 *      re-fetches on ANY event (the run's idea set isn't known cheaply here).
 *      Both are silent (no loading flash) and tear down on unmount. Passing
 *      projectId=null keeps the tab one-shot (no subscribe).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import type { Artifact } from '../../../../shared/types/artifacts';
import type { BacklogTaskItem, TaskChangedEvent } from '../../../../shared/types/tasks';
import type {
  IdeaComponentChangedEvent,
  IdeaComponentState,
  IdeaComponentsForIdea,
} from '../../../../shared/types/ideaComponents';

const getQuerySpy = vi.fn();
const runDecompositionQuerySpy = vi.fn();
const unsubscribeSpy = vi.fn();
// Captured `onData` handler of the most recent onTaskChanged.subscribe call, so
// a test can push a TaskChangedEvent through the live path.
let taskChangedHandler: ((event: TaskChangedEvent) => void) | null = null;

// idea-summary's second fetch (the ledger's merged hybrid view) + its own live
// channel — separate spies/handler from the task ones above.
const ideaComponentsGetQuerySpy = vi.fn();
const ideaComponentsGetManyQuerySpy = vi.fn();
const componentsUnsubscribeSpy = vi.fn();
let componentsChangedHandler: ((event: IdeaComponentChangedEvent) => void) | null = null;

vi.mock('../../trpc/client', () => ({
  trpc: {
    cyboflow: {
      tasks: {
        get: {
          query: (...args: unknown[]) => getQuerySpy(...args) as Promise<BacklogTaskItem | null>,
        },
        runDecomposition: {
          query: (...args: unknown[]) => runDecompositionQuerySpy(...args) as Promise<BacklogTaskItem[]>,
        },
        onTaskChanged: {
          subscribe: (_input: unknown, handlers: { onData: (e: TaskChangedEvent) => void }) => {
            taskChangedHandler = handlers.onData;
            return { unsubscribe: unsubscribeSpy };
          },
        },
      },
      ideaComponents: {
        get: {
          query: (...args: unknown[]) => ideaComponentsGetQuerySpy(...args) as Promise<IdeaComponentState[]>,
        },
        getMany: {
          query: (...args: unknown[]) =>
            ideaComponentsGetManyQuerySpy(...args) as Promise<IdeaComponentsForIdea[]>,
        },
        onComponentsChanged: {
          subscribe: (_input: unknown, handlers: { onData: (e: IdeaComponentChangedEvent) => void }) => {
            componentsChangedHandler = handlers.onData;
            return { unsubscribe: componentsUnsubscribeSpy };
          },
        },
      },
    },
  },
}));

import { useArtifactData } from '../useArtifactData';

const IDEA = {
  id: 'idea-1',
  title: 'Idea',
  body: '## Architecture design\n\nx',
  archived_at: null,
} as unknown as BacklogTaskItem;

/** A second owned idea, for the COMBINED multi-idea batch path. */
const IDEA_B = {
  id: 'idea-2',
  title: 'Second idea',
  body: null,
  archived_at: null,
} as unknown as BacklogTaskItem;

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

/** The COMBINED multi-idea idea-summary artifact — payload marks the batch. */
const COMBINED_SUMMARY: Artifact = {
  id: 'art-sum',
  runId: 'run-1',
  sessionId: null,
  atype: 'idea-summary',
  label: 'Idea summaries · 2 ideas',
  stepOrigin: null,
  mode: 'template',
  committed: false,
  sessionOnly: true,
  isNew: false,
  payloadJson: JSON.stringify({ combined: true }),
  // An identity ANCHOR (the batch's first idea), never the data source.
  sourceRef: 'idea-1',
  createdAt: '2026-01-01T00:00:00.000Z',
  committedAt: null,
};

/** A minimal TaskChangedEvent for the live-refresh tests. */
function taskEvent(task: Partial<BacklogTaskItem>): TaskChangedEvent {
  return {
    projectId: 7,
    taskId: (task.id as string) ?? 't',
    action: 'created',
    task: task as unknown as BacklogTaskItem,
  };
}

const COMPONENTS: IdeaComponentState[] = [
  {
    component: 'idea-spec',
    state: 'complete',
    source: 'derived',
    sourceRunId: null,
    sourceSessionId: null,
    builtAgainstVersion: null,
    staleAt: null,
    staleReason: null,
    updatedAt: null,
  },
];

beforeEach(() => {
  getQuerySpy.mockReset().mockResolvedValue(IDEA);
  runDecompositionQuerySpy.mockReset().mockResolvedValue([IDEA]);
  unsubscribeSpy.mockReset();
  taskChangedHandler = null;
  ideaComponentsGetQuerySpy.mockReset().mockResolvedValue(COMPONENTS);
  ideaComponentsGetManyQuerySpy
    .mockReset()
    .mockResolvedValue([{ ideaId: 'idea-1', states: COMPONENTS }]);
  componentsUnsubscribeSpy.mockReset();
  componentsChangedHandler = null;
});

describe('useArtifactData', () => {
  it("routes 'arch-design' through tasks.get and yields kind 'arch' (not 'stories')", async () => {
    const { result } = renderHook(() => useArtifactData(makeArtifact({ atype: 'arch-design' }), null));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(getQuerySpy).toHaveBeenCalledWith({ taskId: 'idea-1' });
    expect(runDecompositionQuerySpy).not.toHaveBeenCalled();
    expect(result.current.error).toBeNull();
    expect(result.current.data).toEqual({ kind: 'arch', idea: IDEA });
  });

  it("routes 'idea-spec' through tasks.get and yields kind 'idea'", async () => {
    const { result } = renderHook(() => useArtifactData(makeArtifact({ atype: 'idea-spec' }), null));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(getQuerySpy).toHaveBeenCalledWith({ taskId: 'idea-1' });
    expect(result.current.data).toEqual({ kind: 'idea', idea: IDEA });
  });

  it("routes a COMBINED 'idea-spec' (payload_json.combined) through runDecomposition and yields kind 'stories'", async () => {
    const IDEAS = [IDEA, { ...IDEA, id: 'idea-2' } as unknown as BacklogTaskItem];
    runDecompositionQuerySpy.mockReset().mockResolvedValue(IDEAS);
    const { result } = renderHook(() =>
      useArtifactData(
        makeArtifact({ atype: 'idea-spec', payloadJson: JSON.stringify({ combined: true }) }),
        null,
      ),
    );

    await waitFor(() => expect(result.current.loading).toBe(false));
    // Run-scoped like decomposed-stories: sourceRef is only the identity anchor.
    expect(runDecompositionQuerySpy).toHaveBeenCalledWith({ runId: 'run-1' });
    expect(getQuerySpy).not.toHaveBeenCalled();
    expect(result.current.data).toEqual({ kind: 'stories', ideas: IDEAS });
  });

  it("routes 'decomposed-stories' through runDecomposition({ runId }) and yields kind 'stories' with an idea array", async () => {
    const IDEAS = [IDEA, { ...IDEA, id: 'idea-2' } as unknown as BacklogTaskItem];
    runDecompositionQuerySpy.mockReset().mockResolvedValue(IDEAS);
    const { result } = renderHook(() =>
      useArtifactData(makeArtifact({ atype: 'decomposed-stories' }), null),
    );

    await waitFor(() => expect(result.current.loading).toBe(false));
    // Keyed by runId (NOT sourceRef); a run can own several ideas.
    expect(runDecompositionQuerySpy).toHaveBeenCalledWith({ runId: 'run-1' });
    expect(getQuerySpy).not.toHaveBeenCalled();
    expect(result.current.data).toEqual({ kind: 'stories', ideas: IDEAS });
  });

  it("resolves 'decomposed-stories' WITHOUT a sourceRef (run-scoped, uses runId)", async () => {
    const { result } = renderHook(() =>
      useArtifactData(makeArtifact({ atype: 'decomposed-stories', sourceRef: null }), null),
    );

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(runDecompositionQuerySpy).toHaveBeenCalledWith({ runId: 'run-1' });
    expect(result.current.error).toBeNull();
    expect(result.current.data).toEqual({ kind: 'stories', ideas: [IDEA] });
  });

  it("treats an empty decomposition as valid (empty ideas array, no error)", async () => {
    runDecompositionQuerySpy.mockReset().mockResolvedValue([]);
    const { result } = renderHook(() =>
      useArtifactData(makeArtifact({ atype: 'decomposed-stories' }), null),
    );

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBeNull();
    expect(result.current.data).toEqual({ kind: 'stories', ideas: [] });
  });

  it("yields the graceful no-source error for a SINGLE-idea templated atype without sourceRef", async () => {
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

  // --- idea-summary -----------------------------------------------------

  it("routes 'idea-summary' through BOTH tasks.get and ideaComponents.get, yielding kind 'idea-summary'", async () => {
    const { result } = renderHook(() => useArtifactData(makeArtifact({ atype: 'idea-summary' }), null));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(getQuerySpy).toHaveBeenCalledWith({ taskId: 'idea-1' });
    expect(ideaComponentsGetQuerySpy).toHaveBeenCalledWith({ ideaId: 'idea-1' });
    expect(result.current.error).toBeNull();
    expect(result.current.data).toEqual({ kind: 'idea-summary', idea: IDEA, components: COMPONENTS });
  });

  it("yields the graceful no-source error for 'idea-summary' without sourceRef", async () => {
    const { result } = renderHook(() =>
      useArtifactData(makeArtifact({ atype: 'idea-summary', sourceRef: null }), null),
    );

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(getQuerySpy).not.toHaveBeenCalled();
    expect(ideaComponentsGetQuerySpy).not.toHaveBeenCalled();
    expect(result.current.error).toBe('No source entity linked to this artifact.');
    expect(result.current.data).toBeNull();
  });

  it("yields the not-found error when idea-summary's source entity is gone", async () => {
    getQuerySpy.mockResolvedValue(null);
    const { result } = renderHook(() => useArtifactData(makeArtifact({ atype: 'idea-summary' }), null));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBe('Source entity not found.');
    expect(result.current.data).toBeNull();
  });

  // --- idea-summary, COMBINED multi-idea batch --------------------------

  it("routes a COMBINED 'idea-summary' through runDecomposition + getMany, yielding kind 'idea-summaries'", async () => {
    runDecompositionQuerySpy.mockResolvedValue([IDEA, IDEA_B]);
    ideaComponentsGetManyQuerySpy.mockResolvedValue([
      { ideaId: 'idea-1', states: COMPONENTS },
      { ideaId: 'idea-2', states: [] },
    ]);
    const { result } = renderHook(() => useArtifactData(COMBINED_SUMMARY, null));

    await waitFor(() => expect(result.current.loading).toBe(false));
    // RUN-scoped: keyed by runId, NOT the sourceRef identity anchor.
    expect(runDecompositionQuerySpy).toHaveBeenCalledWith({ runId: 'run-1' });
    expect(ideaComponentsGetManyQuerySpy).toHaveBeenCalledWith({ ideaIds: ['idea-1', 'idea-2'] });
    // The per-idea reads must NOT fire on this path.
    expect(getQuerySpy).not.toHaveBeenCalled();
    expect(ideaComponentsGetQuerySpy).not.toHaveBeenCalled();
    expect(result.current.data).toEqual({
      kind: 'idea-summaries',
      entries: [
        { idea: IDEA, components: COMPONENTS },
        { idea: IDEA_B, components: [] },
      ],
    });
  });

  it("drops ARCHIVED ideas BEFORE the getMany call, so ideas and ledgers stay aligned", async () => {
    const archived = { ...IDEA_B, archived_at: '2026-01-02T00:00:00.000Z' } as BacklogTaskItem;
    runDecompositionQuerySpy.mockResolvedValue([archived, IDEA]);
    ideaComponentsGetManyQuerySpy.mockResolvedValue([{ ideaId: 'idea-1', states: COMPONENTS }]);
    const { result } = renderHook(() => useArtifactData(COMBINED_SUMMARY, null));

    await waitFor(() => expect(result.current.loading).toBe(false));
    // Filtering AFTER the call would have zipped idea-1 against the ARCHIVED
    // idea's ledger row — the silent misalignment the ordering guards against.
    expect(ideaComponentsGetManyQuerySpy).toHaveBeenCalledWith({ ideaIds: ['idea-1'] });
    expect(result.current.data).toEqual({
      kind: 'idea-summaries',
      entries: [{ idea: IDEA, components: COMPONENTS }],
    });
  });

  it('resolves a COMBINED tab whose run owns no idea to an empty entry list, not an error', async () => {
    runDecompositionQuerySpy.mockResolvedValue([]);
    const { result } = renderHook(() => useArtifactData(COMBINED_SUMMARY, null));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(ideaComponentsGetManyQuerySpy).not.toHaveBeenCalled();
    expect(result.current.error).toBeNull();
    expect(result.current.data).toEqual({ kind: 'idea-summaries', entries: [] });
  });

  it('a COMBINED tab does NOT require sourceRef (its anchor is not the data source)', async () => {
    runDecompositionQuerySpy.mockResolvedValue([IDEA]);
    const { result } = renderHook(() =>
      useArtifactData({ ...COMBINED_SUMMARY, sourceRef: null }, null),
    );

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBeNull();
    expect(result.current.data).toEqual({
      kind: 'idea-summaries',
      entries: [{ idea: IDEA, components: COMPONENTS }],
    });
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
    expect(runDecompositionQuerySpy).not.toHaveBeenCalled();
  });

  it("passes a static ui-prototype fileName pointer through synchronously (no fetch)", () => {
    const { result } = renderHook(() =>
      useArtifactData(
        makeArtifact({ atype: 'ui-prototype', payloadJson: '{"fileName":"prototype/index.html"}' }),
        null,
      ),
    );

    expect(result.current.loading).toBe(false);
    // The HTML is NOT in the payload — only the fileName pointer (useArtifactHtml
    // fetches the document separately).
    expect(result.current.data).toEqual({
      kind: 'canvas',
      payload: { fileName: 'prototype/index.html' },
    });
    expect(getQuerySpy).not.toHaveBeenCalled();
    expect(runDecompositionQuerySpy).not.toHaveBeenCalled();
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
    expect(runDecompositionQuerySpy).not.toHaveBeenCalled();
  });

  it("resolves 'eval-report' synchronously from payload_json (no fetch, no source entity)", () => {
    const { result } = renderHook(() =>
      useArtifactData(
        // System-minted by EvalWorker with sourceRef null — payload-backed, so it
        // must NOT hit the no-source error path the entity-backed atypes take.
        makeArtifact({
          atype: 'eval-report',
          sourceRef: null,
          payloadJson: '{"markdown":"# Ad-hoc code-review eval\\n\\n**82/100 — Good**"}',
        }),
        null,
      ),
    );

    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeNull();
    expect(result.current.data).toEqual({
      kind: 'eval-report',
      payload: { markdown: '# Ad-hoc code-review eval\n\n**82/100 — Good**' },
    });
    expect(getQuerySpy).not.toHaveBeenCalled();
    expect(runDecompositionQuerySpy).not.toHaveBeenCalled();
  });

  it("resolves 'adversarial-review' synchronously from payload_json (no fetch, no source entity)", () => {
    const { result } = renderHook(() =>
      useArtifactData(
        // sourceRef null: payload-backed like verify-runbook/eval-report, so it
        // must NOT hit the no-source error path.
        makeArtifact({
          atype: 'adversarial-review',
          sourceRef: null,
          payloadJson: '{"markdown":"### AR-1 — Blocking finding"}',
        }),
        null,
      ),
    );

    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeNull();
    expect(result.current.data).toEqual({
      kind: 'adversarial-review',
      payload: { markdown: '### AR-1 — Blocking finding' },
    });
    expect(getQuerySpy).not.toHaveBeenCalled();
    expect(runDecompositionQuerySpy).not.toHaveBeenCalled();
  });

  it("resolves 'project-brief' synchronously from payload_json (no fetch, no source entity)", () => {
    const { result } = renderHook(() =>
      useArtifactData(
        // sourceRef null: unlike the entity-backed templated atypes, this must NOT
        // hit the no-source error path — it is payload-backed, mirroring
        // compound-recommendations.
        makeArtifact({
          atype: 'project-brief',
          sourceRef: null,
          payloadJson: '{"markdown":"## Project brief\\n\\n- ship the thing"}',
        }),
        null,
      ),
    );

    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeNull();
    expect(result.current.data).toEqual({
      kind: 'brief',
      payload: { markdown: '## Project brief\n\n- ship the thing' },
    });
    expect(getQuerySpy).not.toHaveBeenCalled();
    expect(runDecompositionQuerySpy).not.toHaveBeenCalled();
  });

  // --- live refresh ---------------------------------------------------------

  it("does NOT subscribe when projectId is null (one-shot tab)", async () => {
    const { result } = renderHook(() =>
      useArtifactData(makeArtifact({ atype: 'decomposed-stories' }), null),
    );
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(taskChangedHandler).toBeNull();
  });

  it("live-refreshes decomposed-stories on ANY task change, with no loading flash", async () => {
    const ONE = [IDEA];
    const TWO = [IDEA, { ...IDEA, id: 'idea-2' } as unknown as BacklogTaskItem];
    runDecompositionQuerySpy.mockReset().mockResolvedValueOnce(ONE).mockResolvedValueOnce(TWO);

    const { result } = renderHook(() =>
      useArtifactData(makeArtifact({ atype: 'decomposed-stories' }), 7),
    );

    await waitFor(() => expect(result.current.data).toEqual({ kind: 'stories', ideas: ONE }));
    expect(runDecompositionQuerySpy).toHaveBeenCalledTimes(1);
    expect(taskChangedHandler).not.toBeNull();

    // ANY task change re-fetches — the run's idea set is not known cheaply here,
    // so the event carries NO originating_idea_id relation to this artifact.
    act(() => {
      taskChangedHandler?.(taskEvent({ id: 'unrelated', originating_idea_id: 'some-other-idea' }));
    });

    // Silent: loading never flips back to true and the prior content stays put
    // until the fresh decomposition resolves.
    expect(result.current.loading).toBe(false);
    expect(result.current.data).toEqual({ kind: 'stories', ideas: ONE });

    await waitFor(() => expect(result.current.data).toEqual({ kind: 'stories', ideas: TWO }));
    expect(runDecompositionQuerySpy).toHaveBeenCalledTimes(2);
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

  it("idea-spec IGNORES an onTaskChanged event for an unrelated idea", async () => {
    const { result } = renderHook(() => useArtifactData(makeArtifact({ atype: 'idea-spec' }), 7));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(getQuerySpy).toHaveBeenCalledTimes(1);

    act(() => {
      taskChangedHandler?.(taskEvent({ id: 'other-task', originating_idea_id: 'other-idea' }));
    });

    // No relevant match → no re-fetch (the single-idea filter still applies).
    expect(getQuerySpy).toHaveBeenCalledTimes(1);
  });

  it("keeps last-good data when a live refetch fails after a successful load", async () => {
    const ONE = [IDEA];
    let rejectSilent: (e: unknown) => void = () => {};
    runDecompositionQuerySpy
      .mockReset()
      .mockResolvedValueOnce(ONE)
      .mockImplementationOnce(() => new Promise((_res, rej) => { rejectSilent = rej; }));

    const { result } = renderHook(() =>
      useArtifactData(makeArtifact({ atype: 'decomposed-stories' }), 7),
    );
    await waitFor(() => expect(result.current.data).toEqual({ kind: 'stories', ideas: ONE }));

    act(() => {
      taskChangedHandler?.(taskEvent({ id: 't2' }));
    });
    await act(async () => {
      rejectSilent(new Error('boom'));
      await Promise.resolve();
    });

    // The failed live refresh preserves the last-good content — no error, no blank.
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeNull();
    expect(result.current.data).toEqual({ kind: 'stories', ideas: ONE });
  });

  it("surfaces an error (not a stuck spinner) when a live refetch supersedes the initial load and fails", async () => {
    // Regression for the adversarial-review finding: a relevant event fires while
    // the initial load is still in flight (never settles here), bumping the fetch
    // id so the initial success would be discarded; the superseding silent refetch
    // then fails. Without the guard-clear this stranded the tab on {loading:true}.
    let rejectSilent: (e: unknown) => void = () => {};
    runDecompositionQuerySpy
      .mockReset()
      .mockImplementationOnce(() => new Promise(() => {})) // initial: never settles
      .mockImplementationOnce(() => new Promise((_res, rej) => { rejectSilent = rej; }));

    const { result } = renderHook(() =>
      useArtifactData(makeArtifact({ atype: 'decomposed-stories' }), 7),
    );
    expect(result.current.loading).toBe(true);

    act(() => {
      taskChangedHandler?.(taskEvent({ id: 't2' }));
    });
    expect(runDecompositionQuerySpy).toHaveBeenCalledTimes(2);

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

  // --- idea-summary live refresh ---------------------------------------

  it("does NOT subscribe idea-summary's channels when projectId is null (one-shot tab)", async () => {
    const { result } = renderHook(() => useArtifactData(makeArtifact({ atype: 'idea-summary' }), null));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(taskChangedHandler).toBeNull();
    expect(componentsChangedHandler).toBeNull();
  });

  it("live-refreshes idea-summary (both halves) when the idea itself changes (id === sourceRef)", async () => {
    const { result } = renderHook(() => useArtifactData(makeArtifact({ atype: 'idea-summary' }), 7));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(getQuerySpy).toHaveBeenCalledTimes(1);
    expect(ideaComponentsGetQuerySpy).toHaveBeenCalledTimes(1);

    act(() => {
      taskChangedHandler?.(taskEvent({ id: 'idea-1', originating_idea_id: null }));
    });

    await waitFor(() => expect(getQuerySpy).toHaveBeenCalledTimes(2));
    expect(ideaComponentsGetQuerySpy).toHaveBeenCalledTimes(2);
  });

  it("idea-summary IGNORES an onTaskChanged event for an unrelated idea", async () => {
    const { result } = renderHook(() => useArtifactData(makeArtifact({ atype: 'idea-summary' }), 7));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(getQuerySpy).toHaveBeenCalledTimes(1);

    act(() => {
      taskChangedHandler?.(taskEvent({ id: 'other-task', originating_idea_id: 'other-idea' }));
    });

    expect(getQuerySpy).toHaveBeenCalledTimes(1);
    expect(ideaComponentsGetQuerySpy).toHaveBeenCalledTimes(1);
  });

  it("live-refreshes idea-summary when the LEDGER changes for this idea (onComponentsChanged)", async () => {
    const { result } = renderHook(() => useArtifactData(makeArtifact({ atype: 'idea-summary' }), 7));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(ideaComponentsGetQuerySpy).toHaveBeenCalledTimes(1);

    act(() => {
      componentsChangedHandler?.({ projectId: 7, ideaId: 'idea-1', states: COMPONENTS });
    });

    await waitFor(() => expect(ideaComponentsGetQuerySpy).toHaveBeenCalledTimes(2));
    // Both halves re-fetch together, even though only the ledger changed.
    expect(getQuerySpy).toHaveBeenCalledTimes(2);
  });

  it("idea-summary IGNORES an onComponentsChanged event for a different idea", async () => {
    const { result } = renderHook(() => useArtifactData(makeArtifact({ atype: 'idea-summary' }), 7));
    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => {
      componentsChangedHandler?.({ projectId: 7, ideaId: 'some-other-idea', states: COMPONENTS });
    });

    expect(ideaComponentsGetQuerySpy).toHaveBeenCalledTimes(1);
    expect(getQuerySpy).toHaveBeenCalledTimes(1);
  });

  // --- COMBINED idea-summary live refresh --------------------------------

  it('live-refreshes the COMBINED tab on ANY task change (the run\'s idea set can move)', async () => {
    runDecompositionQuerySpy.mockResolvedValue([IDEA]);
    const { result } = renderHook(() => useArtifactData(COMBINED_SUMMARY, 7));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(runDecompositionQuerySpy).toHaveBeenCalledTimes(1);

    // An UNRELATED idea — the single-idea path filters this out, the combined
    // path must not: a new idea joining the run arrives exactly like this.
    act(() => {
      taskChangedHandler?.(taskEvent({ id: 'some-other-idea' }));
    });

    await waitFor(() => expect(runDecompositionQuerySpy).toHaveBeenCalledTimes(2));
  });

  it('live-refreshes the COMBINED tab on a ledger change to ANY idea', async () => {
    runDecompositionQuerySpy.mockResolvedValue([IDEA, IDEA_B]);
    const { result } = renderHook(() => useArtifactData(COMBINED_SUMMARY, 7));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(ideaComponentsGetManyQuerySpy).toHaveBeenCalledTimes(1);

    // idea-2 is in the batch but is NOT the tab's sourceRef anchor; the
    // single-idea path would ignore this event, the combined path must not.
    act(() => {
      componentsChangedHandler?.({ projectId: 7, ideaId: 'idea-2', states: COMPONENTS });
    });

    await waitFor(() => expect(ideaComponentsGetManyQuerySpy).toHaveBeenCalledTimes(2));
  });

  it('tears down BOTH COMBINED subscriptions on unmount', async () => {
    runDecompositionQuerySpy.mockResolvedValue([IDEA]);
    const { result, unmount } = renderHook(() => useArtifactData(COMBINED_SUMMARY, 7));
    await waitFor(() => expect(result.current.loading).toBe(false));
    unmount();
    expect(unsubscribeSpy).toHaveBeenCalled();
    expect(componentsUnsubscribeSpy).toHaveBeenCalled();
  });

  it("tears down BOTH idea-summary subscriptions on unmount", async () => {
    const { result, unmount } = renderHook(() =>
      useArtifactData(makeArtifact({ atype: 'idea-summary' }), 7),
    );
    await waitFor(() => expect(result.current.loading).toBe(false));
    unmount();
    expect(unsubscribeSpy).toHaveBeenCalled();
    expect(componentsUnsubscribeSpy).toHaveBeenCalled();
  });
});
