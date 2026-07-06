/**
 * useArtifactTabsSync tests.
 *
 * This hook was extracted verbatim out of RunCenterPane (see that file's history)
 * so RunCenterPane.test.tsx already exercises most of this behavior through the
 * component; these tests drive the hook directly (via renderHook) to pin down
 * its contract independent of either host (RunCenterPane / QuickSessionCenterPane):
 *   1. The INITIAL seed opens tabs for every artifact WITHOUT stealing focus —
 *      whatever tab was active before the sync stays active.
 *   2. An artifact id that first appears in a LATER sync (after the initial seed)
 *      is genuinely fresh and FLIPS focus to its tab.
 *   3. A vanished row closes its tab AND clears the seen-id, so a later re-mint
 *      of the same id is treated as fresh again (focuses).
 *   4. Nothing happens while `loaded` is false (no tabs opened/closed) — the seed
 *      pass must wait for the resolved list.
 *   5. (F2 regression) A SESSION-WIDE artifacts list spanning TWO DIFFERENT
 *      runIds (the shape useSessionArtifactsList now feeds both center-pane
 *      hosts) keeps both tabs alive across a re-sync — this hook has no notion
 *      of "run", so a session-scoped list never strands the OTHER run's tabs
 *      as "vanished" the way a run-scoped list would when the host switches.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useArtifactTabsSync } from '../useArtifactTabsSync';
import { useCenterPaneStore } from '../../stores/centerPaneStore';
import { FLOW_TAB_ID } from '../../../../shared/types/centerPane';
import type { Artifact } from '../../../../shared/types/artifacts';

const SESSION_KEY = 'sess-1';

/** Minimal Artifact row, mirroring RunCenterPane.test.tsx's fixture. */
function makeArtifact(overrides: Partial<Artifact> = {}): Artifact {
  return {
    id: 'art-1',
    runId: 'run-1',
    sessionId: 'sess-1',
    atype: 'idea-spec',
    label: 'IDEA-018',
    stepOrigin: null,
    mode: 'template',
    committed: false,
    sessionOnly: true,
    isNew: true,
    payloadJson: null,
    sourceRef: null,
    createdAt: '',
    committedAt: null,
    ...overrides,
  };
}

describe('useArtifactTabsSync', () => {
  beforeEach(() => {
    useCenterPaneStore.setState({ bySession: {} });
  });

  it('opens the INITIAL seed for every artifact WITHOUT stealing focus (restores the prior active tab)', () => {
    // A pre-existing tab is active (e.g. the user has a file open) before the
    // sync ever runs — the seed pass must not yank focus off it.
    useCenterPaneStore.setState({
      bySession: {
        [SESSION_KEY]: {
          tabs: [
            { id: FLOW_TAB_ID, kind: 'flow', label: 'Flow', pinned: true },
            { id: 'file:src/x.ts', kind: 'file', label: 'x.ts', filePath: 'src/x.ts' },
          ],
          activeTabId: 'file:src/x.ts',
          terminalOpen: true,
          rightTab: 'steps',
        },
      },
    });

    const artifacts = [makeArtifact({ id: 'art-seed', atype: 'idea-spec', isNew: true })];
    renderHook(() => useArtifactTabsSync(SESSION_KEY, artifacts, true));

    const session = useCenterPaneStore.getState().bySession[SESSION_KEY];
    // The artifact tab was registered…
    expect(session.tabs.some((t) => t.id === 'art:idea-spec')).toBe(true);
    // …but focus stayed on the pre-existing file tab, not the flow tab and not
    // the freshly-registered artifact tab.
    expect(session.activeTabId).toBe('file:src/x.ts');
    expect(session.tabs.find((t) => t.id === 'art:idea-spec')?.isNew).toBe(false);
  });

  it('focuses an artifact id that first appears in a LATER sync (genuinely fresh mint)', () => {
    const { rerender } = renderHook(
      ({ artifacts, loaded }: { artifacts: Artifact[]; loaded: boolean }) =>
        useArtifactTabsSync(SESSION_KEY, artifacts, loaded),
      { initialProps: { artifacts: [] as Artifact[], loaded: true } },
    );
    // Initial seed is empty → nothing to open, still no session artifact tabs.
    expect(
      useCenterPaneStore.getState().bySession[SESSION_KEY]?.tabs.some((t) => t.kind === 'artifact'),
    ).toBeFalsy();

    // A new artifact streams in on a LATER sync (same session key, after the
    // initial seed already ran) — it is genuinely fresh and should flip focus.
    rerender({ artifacts: [makeArtifact({ id: 'art-fresh', atype: 'screenshots' })], loaded: true });

    const session = useCenterPaneStore.getState().bySession[SESSION_KEY];
    expect(session.tabs.some((t) => t.id === 'art:screenshots')).toBe(true);
    expect(session.activeTabId).toBe('art:screenshots');
    expect(session.tabs.find((t) => t.id === 'art:screenshots')?.isNew).toBe(false);
  });

  it('closes a tab whose backing row vanished and clears the seen-id so a re-mint refocuses', () => {
    const { rerender } = renderHook(
      ({ artifacts, loaded }: { artifacts: Artifact[]; loaded: boolean }) =>
        useArtifactTabsSync(SESSION_KEY, artifacts, loaded),
      {
        initialProps: {
          artifacts: [makeArtifact({ id: 'art-x', atype: 'idea-spec' })] as Artifact[],
          loaded: true,
        },
      },
    );
    expect(
      useCenterPaneStore.getState().bySession[SESSION_KEY].tabs.some((t) => t.id === 'art:idea-spec'),
    ).toBe(true);

    // The artifact is pruned/deleted from the live list.
    rerender({ artifacts: [], loaded: true });
    let session = useCenterPaneStore.getState().bySession[SESSION_KEY];
    expect(session.tabs.some((t) => t.id === 'art:idea-spec')).toBe(false);
    // Flow tab survives + becomes active.
    expect(session.tabs.some((t) => t.id === FLOW_TAB_ID)).toBe(true);
    expect(session.activeTabId).toBe(FLOW_TAB_ID);

    // The SAME artifact id re-mints (e.g. re-created) — because the close path
    // dropped its id from the seen-set, this sync treats it as fresh again and
    // flips focus to it (rather than silently re-opening it in the background).
    rerender({ artifacts: [makeArtifact({ id: 'art-x', atype: 'idea-spec' })], loaded: true });
    session = useCenterPaneStore.getState().bySession[SESSION_KEY];
    expect(session.tabs.some((t) => t.id === 'art:idea-spec')).toBe(true);
    expect(session.activeTabId).toBe('art:idea-spec');
  });

  it('(F2 regression) a session-wide list spanning two different runIds keeps both tabs alive across a re-sync', () => {
    // The whole point of session-scoping: these two artifacts belong to
    // DIFFERENT runs (e.g. the '__quick__' chat sentinel and a past flow run)
    // but arrive together in ONE session-scoped list. Before the fix, a host
    // switch (RunCenterPane <-> QuickSessionCenterPane) fed a RUN-scoped list
    // that only ever contained ONE of these two runs' rows, so the effect
    // pruned the other run's tab as "vanished" even though its DB row still
    // existed. A session-scoped list must never do that.
    const fromSentinel = makeArtifact({ id: 'art-sentinel', runId: 'run-quick-chat-1', atype: 'idea-spec' });
    const fromPastRun = makeArtifact({ id: 'art-past-run', runId: 'run-past-flow-1', atype: 'decomposed-stories' });

    const { rerender } = renderHook(
      ({ artifacts, loaded }: { artifacts: Artifact[]; loaded: boolean }) =>
        useArtifactTabsSync(SESSION_KEY, artifacts, loaded),
      { initialProps: { artifacts: [fromSentinel, fromPastRun], loaded: true } },
    );

    let session = useCenterPaneStore.getState().bySession[SESSION_KEY];
    expect(session.tabs.some((t) => t.id === 'art:idea-spec')).toBe(true);
    expect(session.tabs.some((t) => t.id === 'art:decomposed-stories')).toBe(true);

    // Re-sync with the SAME session-wide list (e.g. the center-pane host
    // switched but the session-scoped list is unchanged) — neither tab is
    // pruned, because both artifacts are still present in the list.
    rerender({ artifacts: [fromSentinel, fromPastRun], loaded: true });

    session = useCenterPaneStore.getState().bySession[SESSION_KEY];
    expect(session.tabs.some((t) => t.id === 'art:idea-spec')).toBe(true);
    expect(session.tabs.some((t) => t.id === 'art:decomposed-stories')).toBe(true);
  });

  it('does nothing while loaded is false — no tabs opened, no session created', () => {
    const artifacts = [makeArtifact({ id: 'art-1', atype: 'idea-spec' })];
    renderHook(() => useArtifactTabsSync(SESSION_KEY, artifacts, false));

    // Neither effect ran (both gate on `loaded`), so the session was never
    // seeded by this hook at all.
    expect(useCenterPaneStore.getState().bySession[SESSION_KEY]).toBeUndefined();
  });
});
