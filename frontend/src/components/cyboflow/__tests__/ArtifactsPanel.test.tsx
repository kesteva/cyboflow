/**
 * ArtifactsPanel tests — the right-rail "RUN DELIVERABLES" reopen surface.
 *
 * useArtifactsList / useSessionArtifactsList are mocked (the live list /
 * subscription is exercised in its own seam); these tests drive the panel's
 * pure rendering + interaction:
 *   - grouping headers (Templated deliverables / Live canvases) by atype mode
 *   - per-card status badge (green ✓ in repo / amber session-only)
 *   - clicking a card calls centerPaneStore.openArtifactTab with the right args
 *   - "open · in tabs" action once that atype has a tab in the session
 *   - dual scope: a `runId` prop uses the run-scoped hook, a `sessionId` prop
 *     uses the session-scoped one — both are called unconditionally (Rules of
 *     Hooks) and the panel selects whichever the caller actually passed.
 */
import '@testing-library/jest-dom';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the live-list hooks — return a fixed set of artifacts per test.
vi.mock('../../../hooks/useArtifactsList', () => ({
  useArtifactsList: vi.fn(),
  useSessionArtifactsList: vi.fn(),
}));

import { ArtifactsPanel } from '../ArtifactsPanel';
import { useArtifactsList, useSessionArtifactsList } from '../../../hooks/useArtifactsList';
import { useCenterPaneStore } from '../../../stores/centerPaneStore';
import type { Artifact } from '../../../../../shared/types/artifacts';

const mockHook = vi.mocked(useArtifactsList);
const mockSessionHook = vi.mocked(useSessionArtifactsList);

function makeArtifact(over: Partial<Artifact>): Artifact {
  return {
    id: 'art-1',
    runId: 'run-1',
    sessionId: 'sess-1',
    atype: 'idea-spec',
    label: 'Idea spec',
    stepOrigin: 'Plan · get context',
    mode: 'template',
    committed: true,
    sessionOnly: false,
    isNew: false,
    payloadJson: null,
    sourceRef: null,
    createdAt: '2026-06-18T00:00:00.000Z',
    committedAt: '2026-06-18T00:00:00.000Z',
    ...over,
  };
}

// Two templated (one committed, one session-only) + one live canvas.
const IDEA = makeArtifact({
  id: 'a-idea',
  atype: 'idea-spec',
  label: 'Idea spec',
  stepOrigin: 'Plan · get context',
  committed: true,
  mode: 'template',
});
const STORIES = makeArtifact({
  id: 'a-stories',
  atype: 'decomposed-stories',
  label: 'Decomposed stories',
  stepOrigin: 'Refine · decompose',
  committed: false,
  sessionOnly: true,
  mode: 'template',
});
const PROTO = makeArtifact({
  id: 'a-proto',
  atype: 'ui-prototype',
  label: 'UI prototype',
  stepOrigin: 'Execute · build',
  committed: false,
  sessionOnly: true,
  mode: 'canvas',
});

const SESSION_KEY = 'sess-1';

beforeEach(() => {
  mockHook.mockReset();
  mockHook.mockReturnValue({ artifacts: [IDEA, STORIES, PROTO], loaded: true });
  // The session-scoped hook is called unconditionally too (Rules of Hooks) even
  // when a test only exercises the runId scope — default it to empty so an
  // accidental fallback to it would fail loudly (empty state) rather than
  // silently reusing the run-scoped fixture.
  mockSessionHook.mockReset();
  mockSessionHook.mockReturnValue({ artifacts: [], loaded: true });
  // Reset center-pane state (no open artifact tabs).
  useCenterPaneStore.setState({ bySession: {} });
});

describe('ArtifactsPanel', () => {
  it('renders the eyebrow + both group headers, splitting templated vs. canvas', () => {
    render(<ArtifactsPanel runId="run-1" projectId={7} sessionKey={SESSION_KEY} />);

    expect(screen.getByText('Run deliverables')).toBeInTheDocument();
    expect(screen.getByText('Templated deliverables')).toBeInTheDocument();
    expect(screen.getByText('Live canvases')).toBeInTheDocument();

    // The two templated artifacts live under the templated group; the canvas
    // under live canvases.
    expect(screen.getByTestId('artifact-card-idea-spec')).toBeInTheDocument();
    expect(screen.getByTestId('artifact-card-decomposed-stories')).toBeInTheDocument();
    expect(screen.getByTestId('artifact-card-ui-prototype')).toBeInTheDocument();
  });

  it('shows a green in-repo badge for committed and amber session-only for uncommitted', () => {
    render(<ArtifactsPanel runId="run-1" projectId={7} sessionKey={SESSION_KEY} />);

    const ideaBadge = screen.getByTestId('artifact-badge-idea-spec');
    expect(ideaBadge).toHaveAttribute('data-badge', 'in-repo');
    expect(ideaBadge).toHaveTextContent('in repo');

    const storiesBadge = screen.getByTestId('artifact-badge-decomposed-stories');
    expect(storiesBadge).toHaveAttribute('data-badge', 'session-only');
    expect(storiesBadge).toHaveTextContent('session-only');

    const protoBadge = screen.getByTestId('artifact-badge-ui-prototype');
    expect(protoBadge).toHaveAttribute('data-badge', 'session-only');
  });

  it('renders a step-origin sub-line tagged template / live canvas per mode', () => {
    render(<ArtifactsPanel runId="run-1" projectId={7} sessionKey={SESSION_KEY} />);

    expect(screen.getByTestId('artifact-card-idea-spec-subline')).toHaveTextContent(
      'Plan · get context · template',
    );
    expect(screen.getByTestId('artifact-card-ui-prototype-subline')).toHaveTextContent(
      'Execute · build · live canvas',
    );
  });

  it('clicking a card calls openArtifactTab with the artifact args', () => {
    const spy = vi.spyOn(useCenterPaneStore.getState(), 'openArtifactTab');

    render(<ArtifactsPanel runId="run-1" projectId={7} sessionKey={SESSION_KEY} />);

    fireEvent.click(screen.getByTestId('artifact-card-decomposed-stories'));

    expect(spy).toHaveBeenCalledWith(SESSION_KEY, {
      atype: 'decomposed-stories',
      label: 'Decomposed stories',
      artifactId: 'a-stories',
      committed: false,
      isNew: false,
    });
  });

  it('clicking a card actually opens the tab in the center-pane store', () => {
    render(<ArtifactsPanel runId="run-1" projectId={7} sessionKey={SESSION_KEY} />);

    fireEvent.click(screen.getByTestId('artifact-card-idea-spec'));

    const session = useCenterPaneStore.getState().bySession[SESSION_KEY];
    expect(session).toBeDefined();
    const tab = session.tabs.find((t) => t.kind === 'artifact');
    expect(tab).toMatchObject({ id: 'art:idea-spec', atype: 'idea-spec', label: 'Idea spec' });
  });

  it('shows "open · in tabs" when a matching artifact tab is already open', () => {
    // Seed an open tab for the idea-spec atype.
    act(() => {
      useCenterPaneStore.getState().openArtifactTab(SESSION_KEY, {
        atype: 'idea-spec',
        label: 'Idea spec',
        artifactId: 'a-idea',
        committed: true,
      });
    });

    render(<ArtifactsPanel runId="run-1" projectId={7} sessionKey={SESSION_KEY} />);

    // Already-open idea-spec → "open · in tabs"; the closed stories → "open →".
    expect(screen.getByTestId('artifact-action-idea-spec')).toHaveTextContent('open · in tabs');
    expect(screen.getByTestId('artifact-action-decomposed-stories')).toHaveTextContent('open →');
  });

  it('renders an empty state when the run has no artifacts', () => {
    mockHook.mockReturnValue({ artifacts: [], loaded: true });

    render(<ArtifactsPanel runId="run-1" projectId={7} sessionKey={SESSION_KEY} />);

    expect(screen.getByTestId('artifacts-panel-empty')).toBeInTheDocument();
    expect(screen.queryByText('Templated deliverables')).not.toBeInTheDocument();
  });

  it('with a `sessionId` prop (no `runId`), sources artifacts from the session-scoped hook instead', () => {
    // Deliberately give the run-scoped and session-scoped hooks DIFFERENT
    // artifact sets so the assertion proves which one actually feeds the panel.
    mockHook.mockReturnValue({ artifacts: [], loaded: true });
    mockSessionHook.mockReturnValue({ artifacts: [IDEA], loaded: true });

    render(<ArtifactsPanel sessionId="sess-1" projectId={7} sessionKey={SESSION_KEY} />);

    expect(screen.getByTestId('artifact-card-idea-spec')).toBeInTheDocument();
    expect(screen.queryByTestId('artifacts-panel-empty')).not.toBeInTheDocument();
  });
});
