/**
 * QuickSessionCenterPane tests — the artifact-tab rendering added alongside the
 * pre-existing file-tab / resting-canvas shell (see QuickSessionCanvas.test.tsx
 * for the resting canvas's own behavior; this suite stubs it out).
 *
 * Mirrors RunCenterPane.test.tsx's harness: useSessionArtifactsList and
 * ArtifactTabRenderer are mocked so the artifact-tab-resolution logic is
 * exercised without dragging in the tRPC artifacts client or the real markdown /
 * canvas renderers. The component queries the SESSION's artifacts (across ALL
 * its runs, not just the '__quick__' chat sentinel) — see the F2 regression
 * test below.
 *
 * Behaviors verified:
 *   1. With no artifact/file tab open, renders the resting QuickSessionCanvas
 *      (unchanged default).
 *   2. (F2 regression) An artifact tab whose backing row belongs to a PAST FLOW
 *      RUN (a runId different from session.chatRunId) still resolves and
 *      renders via the session-scoped list — proving the tab store's session
 *      key and the artifact list's scope agree, so a deliverable from an
 *      earlier flow run never reads as "vanished" here.
 *   3. An 'artifact' tab whose backing row IS in the live list renders
 *      ArtifactTabRenderer.
 *   4. An 'artifact' tab whose backing row is NOT (yet) in the live list renders
 *      the "Loading …" fallback instead of crashing.
 */
import '@testing-library/jest-dom';
import { render, screen } from '@testing-library/react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Session } from '../../../types/session';
import type { Artifact } from '../../../../../shared/types/artifacts';

// The resting canvas has its own full suite (QuickSessionCanvas.test.tsx) —
// stub it here so these tests focus purely on the tab-resolution branch.
vi.mock('../QuickSessionCanvas', () => ({
  QuickSessionCanvas: () => <div data-testid="mock-quick-session-canvas" />,
}));

// `mockArtifacts`/`mockLoaded` mirror useSessionArtifactsList's live-list
// shape; mutable so each test can drive what the hook returns (same pattern as
// RunCenterPane.test.tsx).
let mockArtifacts: Artifact[] = [];
let mockLoaded = true;
vi.mock('../../../hooks/useArtifactsList', () => ({
  useSessionArtifactsList: () => ({ artifacts: mockArtifacts, loaded: mockLoaded }),
}));
vi.mock('../ArtifactTabRenderer', () => ({
  ArtifactTabRenderer: () => <div data-testid="mock-artifact-tab-renderer" />,
}));

// Import after mocks.
import { QuickSessionCenterPane } from '../QuickSessionCenterPane';
import { useCenterPaneStore } from '../../../stores/centerPaneStore';
import { FLOW_TAB_ID } from '../../../../../shared/types/centerPane';

function makeArtifact(overrides: Partial<Artifact> = {}): Artifact {
  return {
    id: 'art-1',
    runId: 'run-quick-chat-1',
    sessionId: 's1',
    atype: 'idea-spec',
    label: 'IDEA-018',
    stepOrigin: null,
    mode: 'template',
    committed: false,
    sessionOnly: true,
    isNew: false,
    payloadJson: null,
    sourceRef: null,
    createdAt: '',
    committedAt: null,
    ...overrides,
  };
}

const SESSION = {
  id: 's1',
  name: 'tester-mctest',
  worktreePath: '/repo/.cyboflow/worktrees/quick-20260607',
  prompt: '',
  status: 'running',
  createdAt: new Date().toISOString(),
  output: [],
  jsonMessages: [],
  chatRunId: 'run-quick-chat-1',
} as Session;

function renderPane(session: Session = SESSION) {
  return render(
    <QuickSessionCenterPane
      session={session}
      projectId={3}
      projectName="tester-mctest"
      onBrowseAll={() => {}}
      onAddWorkflowToNewSession={() => {}}
      dockContent={<div data-testid="mock-dock-content" />}
    />,
  );
}

describe('QuickSessionCenterPane — artifact tabs', () => {
  beforeEach(() => {
    useCenterPaneStore.setState({ bySession: {} });
    mockArtifacts = [];
    mockLoaded = true;
  });

  it('renders the resting QuickSessionCanvas by default (home tab, no artifacts)', () => {
    renderPane();
    expect(screen.getByTestId('quick-session-center-pane')).toBeInTheDocument();
    expect(screen.getByTestId('mock-quick-session-canvas')).toBeInTheDocument();
  });

  it('a null chatRunId (sentinel not yet minted) never crashes — canvas still renders', () => {
    // sessionKey (String(session.id)) does not depend on chatRunId at all now
    // that the artifact list is session-scoped, but this still guards against a
    // null chatRunId crashing anything reachable from the session object.
    const sessionNoChat = { ...SESSION, chatRunId: null } as Session;
    renderPane(sessionNoChat);
    expect(screen.getByTestId('mock-quick-session-canvas')).toBeInTheDocument();
    expect(screen.queryByTestId('mock-artifact-tab-renderer')).not.toBeInTheDocument();
  });

  it('(F2 regression) an artifact tab whose backing row belongs to a PAST FLOW RUN (not the chat sentinel) still renders via the session-scoped list', () => {
    const sessionKey = String(SESSION.id);
    // The artifact's runId differs from SESSION.chatRunId ('run-quick-chat-1') —
    // it belongs to an earlier flow run this session hosted. Before the F2 fix,
    // this component queried ONLY the chat-sentinel run's artifacts, so this row
    // would never appear and useArtifactTabsSync would prune the tab as
    // "vanished" even though the DB row still exists.
    mockArtifacts = [
      makeArtifact({ id: 'a-past-run', runId: 'run-past-flow-1', atype: 'decomposed-stories', label: 'Stories' }),
    ];
    useCenterPaneStore.setState({
      bySession: {
        [sessionKey]: {
          tabs: [
            { id: FLOW_TAB_ID, kind: 'flow', label: 'Flow', pinned: true },
            {
              id: 'art:decomposed-stories',
              kind: 'artifact',
              label: 'Stories',
              atype: 'decomposed-stories',
              artifactId: 'a-past-run',
              committed: true,
            },
          ],
          activeTabId: 'art:decomposed-stories',
          terminalOpen: true,
          rightTab: 'steps',
        },
      },
    });

    renderPane();

    expect(screen.getByTestId('mock-artifact-tab-renderer')).toBeInTheDocument();
    expect(screen.queryByTestId('mock-quick-session-canvas')).not.toBeInTheDocument();
  });

  it('renders ArtifactTabRenderer for an artifact tab whose backing row is in the live list', () => {
    const sessionKey = String(SESSION.id);
    mockArtifacts = [makeArtifact({ id: 'a-idea', atype: 'idea-spec', label: 'Idea spec' })];
    // Seed the store with an already-open, focused artifact tab (as if
    // useArtifactTabsSync — or a chip click — had already opened it).
    useCenterPaneStore.setState({
      bySession: {
        [sessionKey]: {
          tabs: [
            { id: FLOW_TAB_ID, kind: 'flow', label: 'Flow', pinned: true },
            {
              id: 'art:idea-spec',
              kind: 'artifact',
              label: 'Idea spec',
              atype: 'idea-spec',
              artifactId: 'a-idea',
              committed: false,
            },
          ],
          activeTabId: 'art:idea-spec',
          terminalOpen: true,
          rightTab: 'steps',
        },
      },
    });

    renderPane();

    expect(screen.getByTestId('mock-artifact-tab-renderer')).toBeInTheDocument();
    expect(screen.queryByTestId('mock-quick-session-canvas')).not.toBeInTheDocument();
  });

  it('renders the "Loading…" fallback for an artifact tab whose row has not resolved yet', () => {
    const sessionKey = String(SESSION.id);
    // The tab is open (e.g. chip-opened) but the seed query is STILL in flight
    // (loaded:false) — the same useArtifactTabsSync this component shares with
    // RunCenterPane gates its prune pass on `loaded`, so an unresolved row while
    // loading is NOT (yet) treated as "vanished" and the tab survives to render
    // this fallback instead of being silently closed.
    mockArtifacts = [];
    mockLoaded = false;
    useCenterPaneStore.setState({
      bySession: {
        [sessionKey]: {
          tabs: [
            { id: FLOW_TAB_ID, kind: 'flow', label: 'Flow', pinned: true },
            {
              id: 'art:screenshots',
              kind: 'artifact',
              label: 'Screenshots',
              atype: 'screenshots',
            },
          ],
          activeTabId: 'art:screenshots',
          terminalOpen: true,
          rightTab: 'steps',
        },
      },
    });

    renderPane();

    expect(screen.getByText('Loading Screenshots…')).toBeInTheDocument();
    expect(screen.queryByTestId('mock-artifact-tab-renderer')).not.toBeInTheDocument();
  });
});
