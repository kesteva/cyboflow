/**
 * Unit tests for useArtifactsList.
 *
 * Focus: the seed/subscription race (FINDING E-list-seed-race).
 *   1. Subscription event arriving BEFORE the seed resolves is preserved when
 *      the seed resolves (merge, not clobber).
 *   2. Seed rows are authoritative for ids they contain (seed value wins).
 *   3. Normal seed-then-subscription path still upserts.
 *   4. 'deleted' events remove by id.
 *   5. Events for OTHER runs on the shared project channel are ignored.
 *   6. The subscription is unsubscribed on unmount (no leaked listener).
 *   7. A null runId / projectId yields [] and never subscribes.
 *   8. A late seed resolution after unmount/dep-change is dropped (cancelled).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { Artifact, ArtifactChangedEvent } from '../../../../shared/types/artifacts';

// ---------------------------------------------------------------------------
// Controllable tRPC mock: hold the seed query pending, drive onData by hand.
// ---------------------------------------------------------------------------

type OnDataFn = (event: ArtifactChangedEvent) => void;

interface DeferredSeed {
  promise: Promise<Artifact[]>;
  resolve: (rows: Artifact[]) => void;
}

function deferSeed(): DeferredSeed {
  let resolve!: (rows: Artifact[]) => void;
  const promise = new Promise<Artifact[]>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

// Mutable handles the tests reach into.
let seedDeferred: DeferredSeed;
let lastOnData: OnDataFn | null;
let unsubscribeSpy: ReturnType<typeof vi.fn>;
let subscribeSpy: ReturnType<typeof vi.fn>;
let listQuerySpy: ReturnType<typeof vi.fn>;

vi.mock('../../trpc/client', () => {
  return {
    trpc: {
      cyboflow: {
        artifacts: {
          list: {
            query: (...args: unknown[]) => {
              listQuerySpy(...args);
              return seedDeferred.promise;
            },
          },
          onArtifactChanged: {
            subscribe: (
              input: { projectId: number },
              handlers: { onData: OnDataFn; onError: (e: unknown) => void },
            ) => {
              subscribeSpy(input);
              lastOnData = handlers.onData;
              return { unsubscribe: unsubscribeSpy };
            },
          },
        },
      },
    },
  };
});

const { useArtifactsList } = await import('../useArtifactsList');

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const RUN = 'run-aaa';
const PROJECT = 7;

function makeArtifact(overrides: Partial<Artifact> = {}): Artifact {
  return {
    id: 'art-1',
    runId: RUN,
    sessionId: null,
    atype: 'generic',
    label: 'Doc',
    stepOrigin: null,
    mode: 'template',
    committed: false,
    sessionOnly: false,
    isNew: true,
    payloadJson: null,
    sourceRef: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    committedAt: null,
    ...overrides,
  };
}

function changedEvent(overrides: Partial<ArtifactChangedEvent> = {}): ArtifactChangedEvent {
  const artifact = overrides.artifact ?? makeArtifact();
  return {
    projectId: PROJECT,
    runId: RUN,
    artifactId: artifact?.id ?? 'art-x',
    atype: 'generic',
    action: 'created',
    artifact,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  seedDeferred = deferSeed();
  lastOnData = null;
  unsubscribeSpy = vi.fn();
  subscribeSpy = vi.fn();
  listQuerySpy = vi.fn();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('useArtifactsList', () => {
  it('preserves a subscription event that arrives before the seed resolves (merge, not clobber)', async () => {
    const { result } = renderHook(() => useArtifactsList(RUN, PROJECT));

    // Subscription is live, but the seed query is still pending.
    expect(subscribeSpy).toHaveBeenCalledWith({ projectId: PROJECT });
    expect(result.current.artifacts).toEqual([]);

    // An artifact is minted mid-run and arrives over the subscription FIRST.
    const mintedMidRun = makeArtifact({ id: 'art-late', label: 'Minted mid-run' });
    act(() => {
      lastOnData?.(changedEvent({ artifact: mintedMidRun, artifactId: 'art-late' }));
    });
    expect(result.current.artifacts.map((a) => a.id)).toEqual(['art-late']);

    // Now the (older) seed snapshot resolves WITHOUT the mid-run artifact.
    const seedRow = makeArtifact({ id: 'art-seed', label: 'Seed row' });
    await act(async () => {
      seedDeferred.resolve([seedRow]);
      await seedDeferred.promise;
    });

    // The mid-run artifact MUST survive — merge, not replace.
    const ids = result.current.artifacts.map((a) => a.id).sort();
    expect(ids).toEqual(['art-late', 'art-seed']);
  });

  it('lets the seed value win for ids it contains (DB-authoritative)', async () => {
    const { result } = renderHook(() => useArtifactsList(RUN, PROJECT));

    // Subscription delivers a stale version of art-1 before the seed lands.
    act(() => {
      lastOnData?.(changedEvent({ artifact: makeArtifact({ id: 'art-1', label: 'stale' }) }));
    });
    expect(result.current.artifacts).toEqual([makeArtifact({ id: 'art-1', label: 'stale' })]);

    // Seed contains a fresher art-1 — it should win on the shared id.
    await act(async () => {
      seedDeferred.resolve([makeArtifact({ id: 'art-1', label: 'fresh' })]);
      await seedDeferred.promise;
    });

    expect(result.current.artifacts).toHaveLength(1);
    expect(result.current.artifacts[0].label).toBe('fresh');
  });

  it('upserts subscription events that arrive after the seed (normal path)', async () => {
    const { result } = renderHook(() => useArtifactsList(RUN, PROJECT));

    await act(async () => {
      seedDeferred.resolve([makeArtifact({ id: 'art-1', label: 'one' })]);
      await seedDeferred.promise;
    });
    expect(result.current.artifacts.map((a) => a.id)).toEqual(['art-1']);

    act(() => {
      lastOnData?.(changedEvent({ artifact: makeArtifact({ id: 'art-2', label: 'two' }) }));
    });
    expect(result.current.artifacts.map((a) => a.id)).toEqual(['art-1', 'art-2']);

    // updated event replaces in place.
    act(() => {
      lastOnData?.(
        changedEvent({ action: 'updated', artifact: makeArtifact({ id: 'art-1', label: 'one!' }) }),
      );
    });
    expect(result.current.artifacts.find((a) => a.id === 'art-1')?.label).toBe('one!');
    expect(result.current.artifacts).toHaveLength(2);
  });

  it("removes an artifact on a 'deleted' event", async () => {
    const { result } = renderHook(() => useArtifactsList(RUN, PROJECT));
    await act(async () => {
      seedDeferred.resolve([makeArtifact({ id: 'art-1' }), makeArtifact({ id: 'art-2' })]);
      await seedDeferred.promise;
    });

    act(() => {
      lastOnData?.({
        projectId: PROJECT,
        runId: RUN,
        artifactId: 'art-1',
        atype: 'generic',
        action: 'deleted',
        artifact: null,
      });
    });

    expect(result.current.artifacts.map((a) => a.id)).toEqual(['art-2']);
  });

  it('ignores events for a different run on the shared project channel', async () => {
    const { result } = renderHook(() => useArtifactsList(RUN, PROJECT));
    await act(async () => {
      seedDeferred.resolve([makeArtifact({ id: 'art-1' })]);
      await seedDeferred.promise;
    });

    act(() => {
      lastOnData?.(
        changedEvent({ runId: 'OTHER-run', artifact: makeArtifact({ id: 'art-other', runId: 'OTHER-run' }) }),
      );
    });

    // Foreign-run artifact must not leak in.
    expect(result.current.artifacts.map((a) => a.id)).toEqual(['art-1']);
  });

  it('unsubscribes on unmount (no leaked listener)', async () => {
    const { unmount } = renderHook(() => useArtifactsList(RUN, PROJECT));
    expect(subscribeSpy).toHaveBeenCalledTimes(1);
    expect(unsubscribeSpy).not.toHaveBeenCalled();

    unmount();
    expect(unsubscribeSpy).toHaveBeenCalledTimes(1);
  });

  it('returns [] and never subscribes when runId or projectId is null', () => {
    const { result, rerender } = renderHook(
      ({ r, p }: { r: string | null; p: number | null }) => useArtifactsList(r, p),
      { initialProps: { r: null as string | null, p: PROJECT as number | null } },
    );
    expect(result.current.artifacts).toEqual([]);
    expect(subscribeSpy).not.toHaveBeenCalled();
    expect(listQuerySpy).not.toHaveBeenCalled();

    rerender({ r: RUN, p: null });
    expect(subscribeSpy).not.toHaveBeenCalled();
    expect(listQuerySpy).not.toHaveBeenCalled();
  });

  it('drops a seed that resolves after unmount (cancelled guard)', async () => {
    const { result, unmount } = renderHook(() => useArtifactsList(RUN, PROJECT));
    unmount();

    await act(async () => {
      seedDeferred.resolve([makeArtifact({ id: 'art-1' })]);
      await seedDeferred.promise;
    });

    // No state update after unmount.
    expect(result.current.artifacts).toEqual([]);
  });

  it('re-seeds and re-subscribes when runId changes (cleanup then resubscribe)', async () => {
    const { rerender } = renderHook(
      ({ r }: { r: string }) => useArtifactsList(r, PROJECT),
      { initialProps: { r: RUN } },
    );
    expect(subscribeSpy).toHaveBeenCalledTimes(1);

    // Swap in a fresh deferred for the next run's seed.
    seedDeferred = deferSeed();
    rerender({ r: 'run-bbb' });

    expect(unsubscribeSpy).toHaveBeenCalledTimes(1); // old sub torn down
    expect(subscribeSpy).toHaveBeenCalledTimes(2); // resubscribed
    expect(listQuerySpy).toHaveBeenLastCalledWith({ runId: 'run-bbb' });
  });
});
