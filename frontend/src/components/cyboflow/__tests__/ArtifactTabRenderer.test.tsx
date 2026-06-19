/**
 * ArtifactTabRenderer tests — the per-atype center-pane artifact dispatch.
 *
 * Each branch is driven by a stubbed useArtifactData + a fake Artifact, asserting:
 *   - the right body renders for each atype,
 *   - the shared ArtifactHeader's eyebrow + commit-state badge,
 *   - the Commit button shows only when not committed and forwards to
 *     trpc.cyboflow.artifacts.commit.mutate,
 *   - graceful empty/loading/error states.
 *
 * react-markdown is ESM-heavy in jsdom, so MarkdownPreview is stubbed to a plain
 * div that echoes its content (we only assert the idea body is passed through).
 */
import '@testing-library/jest-dom';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ArtifactTabRenderer } from '../ArtifactTabRenderer';
import { useArtifactData, type ArtifactData } from '../../../hooks/useArtifactData';
import type { Artifact, ArtifactType } from '../../../../../shared/types/artifacts';
import type { BacklogTaskItem } from '../../../../../shared/types/tasks';

// --- mocks -----------------------------------------------------------------

vi.mock('../../../hooks/useArtifactData', () => ({ useArtifactData: vi.fn() }));
const mockHook = vi.mocked(useArtifactData);

// Stub MarkdownPreview (avoids react-markdown ESM in jsdom); echo the content.
vi.mock('../../MarkdownPreview', () => ({
  MarkdownPreview: ({ content }: { content: string }) => <div data-testid="md-preview">{content}</div>,
}));

const commitMutate = vi.fn().mockResolvedValue({ artifactId: 'art-1' });
vi.mock('../../../trpc/client', () => ({
  trpc: {
    cyboflow: {
      artifacts: {
        commit: { mutate: (...args: unknown[]) => commitMutate(...args) },
      },
    },
  },
}));

// --- fixtures --------------------------------------------------------------

function makeArtifact(overrides: Partial<Artifact> = {}): Artifact {
  return {
    id: 'art-1',
    runId: 'run-1',
    sessionId: 'sess-1',
    atype: 'idea-spec',
    label: 'IDEA-018 spec',
    stepOrigin: 'Plan · get context',
    mode: 'template',
    committed: false,
    sessionOnly: true,
    isNew: false,
    payloadJson: null,
    sourceRef: 'IDEA-018',
    createdAt: '2026-06-18T00:00:00Z',
    committedAt: null,
    ...overrides,
  };
}

function makeIdea(overrides: Partial<BacklogTaskItem> = {}): BacklogTaskItem {
  return {
    id: 'IDEA-018',
    project_id: 1,
    type: 'idea',
    ref: 'IDEA-018',
    title: 'Tabbed center pane',
    summary: 'Move files + artifacts into center tabs.',
    body: '# Problem\n\nThe center column stacks.',
    priority: 'P1',
    repo: null,
    parent_epic_id: null,
    originating_idea_id: null,
    scope: 'large',
    board_id: 'b1',
    stage_id: 's1',
    archived_at: null,
    version: 1,
    stage_position: 1,
    inFlow: [],
    awaitingReview: false,
    isDone: false,
    created_at: '2026-06-18T00:00:00Z',
    updated_at: '2026-06-18T00:00:00Z',
    ...overrides,
  };
}

function setHook(value: ArtifactData): void {
  mockHook.mockReturnValue(value);
}

const PROPS = { projectId: 1, runId: 'run-1' };

describe('ArtifactTabRenderer', () => {
  beforeEach(() => {
    mockHook.mockReset();
    commitMutate.mockClear();
  });

  // --- idea-spec -----------------------------------------------------------

  it('renders the idea-spec doc with the blue eyebrow and markdown body', () => {
    setHook({ loading: false, error: null, data: { kind: 'idea', idea: makeIdea() } });
    render(<ArtifactTabRenderer artifact={makeArtifact({ atype: 'idea-spec' })} {...PROPS} />);

    expect(screen.getByTestId('artifact-idea-spec')).toBeInTheDocument();
    const eyebrow = screen.getByTestId('artifact-eyebrow');
    expect(eyebrow).toHaveTextContent('Artifact · idea spec');
    expect(eyebrow).toHaveStyle({ color: '#3b6dd6' });
    expect(screen.getByText('Tabbed center pane')).toBeInTheDocument();
    expect(screen.getByTestId('md-preview')).toHaveTextContent('The center column stacks.');
  });

  it('shows the idea-spec loading and error states', () => {
    setHook({ loading: true, error: null, data: null });
    const { rerender } = render(<ArtifactTabRenderer artifact={makeArtifact()} {...PROPS} />);
    expect(screen.getByTestId('artifact-idea-loading')).toBeInTheDocument();

    setHook({ loading: false, error: 'boom', data: null });
    rerender(<ArtifactTabRenderer artifact={makeArtifact()} {...PROPS} />);
    expect(screen.getByTestId('artifact-idea-error')).toHaveTextContent('boom');
  });

  // --- decomposed-stories --------------------------------------------------

  it('renders the decomposed-stories epic/task grid with the indigo eyebrow', () => {
    const idea = makeIdea({
      children: [
        {
          ...makeIdea({ id: 'EPIC-1', type: 'epic', ref: 'EPIC-001', title: 'Center tabs' }),
          children: [
            makeIdea({ id: 'TASK-1', type: 'task', ref: 'TASK-041', title: 'Build tab strip', priority: 'P0' }),
            makeIdea({ id: 'TASK-2', type: 'task', ref: 'TASK-042', title: 'Wire artifact tabs' }),
          ],
        },
      ],
    });
    setHook({ loading: false, error: null, data: { kind: 'stories', idea } });
    render(<ArtifactTabRenderer artifact={makeArtifact({ atype: 'decomposed-stories' })} {...PROPS} />);

    expect(screen.getByTestId('artifact-decomposed-stories')).toBeInTheDocument();
    const eyebrow = screen.getByTestId('artifact-eyebrow');
    expect(eyebrow).toHaveTextContent('Artifact · decomposed stories');
    expect(eyebrow).toHaveStyle({ color: '#5a4ad6' });
    expect(screen.getByTestId('artifact-stories-summary')).toHaveTextContent('1 epic · 2 tasks');
    expect(screen.getByText('Center tabs')).toBeInTheDocument();
    expect(screen.getAllByTestId('artifact-task-cell')).toHaveLength(2);
    expect(screen.getByText('TASK-041')).toBeInTheDocument();
    expect(screen.getByText('Build tab strip')).toBeInTheDocument();
  });

  it('shows the decomposed-stories no-epics empty state', () => {
    setHook({ loading: false, error: null, data: { kind: 'stories', idea: makeIdea({ children: [] }) } });
    render(<ArtifactTabRenderer artifact={makeArtifact({ atype: 'decomposed-stories' })} {...PROPS} />);
    expect(screen.getByTestId('artifact-stories-noepics')).toBeInTheDocument();
  });

  // --- screenshots ---------------------------------------------------------

  it('renders the screenshots empty state with the green eyebrow', () => {
    setHook({ loading: false, error: null, data: { kind: 'screenshots', payload: {} } });
    render(<ArtifactTabRenderer artifact={makeArtifact({ atype: 'screenshots', mode: 'template' })} {...PROPS} />);

    expect(screen.getByTestId('artifact-screenshots')).toBeInTheDocument();
    const eyebrow = screen.getByTestId('artifact-eyebrow');
    expect(eyebrow).toHaveTextContent('Artifact · screenshots');
    expect(eyebrow).toHaveStyle({ color: '#2d8a5b' });
    expect(screen.getByTestId('artifact-shots-empty')).toHaveTextContent('No screenshots captured.');
  });

  it('renders a screenshots grid card per fileName', () => {
    setHook({ loading: false, error: null, data: { kind: 'screenshots', payload: { fileNames: ['home.png', 'detail.png'] } } });
    render(<ArtifactTabRenderer artifact={makeArtifact({ atype: 'screenshots', mode: 'template' })} {...PROPS} />);
    expect(screen.getAllByTestId('artifact-shot-card')).toHaveLength(2);
    expect(screen.getByText('home.png')).toBeInTheDocument();
  });

  // --- ui-prototype / generic (live canvas) --------------------------------

  it('embeds the ui-prototype live canvas (iframe) for a localhost url', () => {
    setHook({ loading: false, error: null, data: { kind: 'canvas', payload: { url: 'http://localhost:8081' } } });
    render(<ArtifactTabRenderer artifact={makeArtifact({ atype: 'ui-prototype', mode: 'canvas' })} {...PROPS} />);

    expect(screen.getByTestId('artifact-canvas')).toBeInTheDocument();
    const eyebrow = screen.getByTestId('artifact-eyebrow');
    expect(eyebrow).toHaveTextContent('◳ Live canvas · ui prototype');
    expect(eyebrow).toHaveStyle({ color: '#c96442' });
    // A localhost url now renders the live iframe (not the placeholder).
    expect(screen.queryByTestId('artifact-canvas-placeholder')).not.toBeInTheDocument();
    expect(screen.getByTestId('live-canvas-iframe')).toHaveAttribute('src', 'http://localhost:8081');
    expect(screen.getByTestId('artifact-canvas-open')).toHaveAttribute('href', 'http://localhost:8081');
  });

  it('renders the generic canvas with a disabled open affordance when no url', () => {
    setHook({ loading: false, error: null, data: { kind: 'canvas', payload: {} } });
    render(<ArtifactTabRenderer artifact={makeArtifact({ atype: 'generic', mode: 'canvas' })} {...PROPS} />);
    expect(screen.getByTestId('artifact-eyebrow')).toHaveTextContent('◳ Live canvas · generic');
    expect(screen.getByTestId('artifact-canvas-open-disabled')).toBeInTheDocument();
  });

  // --- commit-state badge + commit button (ArtifactHeader, shared) ---------

  it('shows the session-only badge + Commit button when not committed, and commits on click', async () => {
    setHook({ loading: false, error: null, data: { kind: 'idea', idea: makeIdea() } });
    render(<ArtifactTabRenderer artifact={makeArtifact({ committed: false, payloadJson: '{"x":1}' })} {...PROPS} />);

    expect(screen.getByTestId('artifact-badge-session-only')).toBeInTheDocument();
    expect(screen.queryByTestId('artifact-badge-committed')).not.toBeInTheDocument();

    const btn = screen.getByTestId('artifact-commit-button');
    expect(btn).toHaveTextContent('Commit to repo');
    fireEvent.click(btn);

    await waitFor(() =>
      expect(commitMutate).toHaveBeenCalledWith({ projectId: 1, artifactId: 'art-1', payloadJson: '{"x":1}' }),
    );
  });

  it('shows the in-repo badge and hides the Commit button when committed', () => {
    setHook({ loading: false, error: null, data: { kind: 'idea', idea: makeIdea() } });
    render(<ArtifactTabRenderer artifact={makeArtifact({ committed: true })} {...PROPS} />);

    expect(screen.getByTestId('artifact-badge-committed')).toHaveTextContent('✓ in repo');
    expect(screen.queryByTestId('artifact-commit-button')).not.toBeInTheDocument();
  });

  it('dispatches every atype to a distinct body', () => {
    const cases: Array<{ atype: ArtifactType; mode: 'template' | 'canvas'; testid: string; data: ArtifactData }> = [
      { atype: 'idea-spec', mode: 'template', testid: 'artifact-idea-spec', data: { loading: false, error: null, data: { kind: 'idea', idea: makeIdea() } } },
      { atype: 'decomposed-stories', mode: 'template', testid: 'artifact-decomposed-stories', data: { loading: false, error: null, data: { kind: 'stories', idea: makeIdea({ children: [] }) } } },
      { atype: 'screenshots', mode: 'template', testid: 'artifact-screenshots', data: { loading: false, error: null, data: { kind: 'screenshots', payload: {} } } },
      { atype: 'ui-prototype', mode: 'canvas', testid: 'artifact-canvas', data: { loading: false, error: null, data: { kind: 'canvas', payload: {} } } },
      { atype: 'generic', mode: 'canvas', testid: 'artifact-canvas', data: { loading: false, error: null, data: { kind: 'canvas', payload: {} } } },
    ];
    for (const c of cases) {
      setHook(c.data);
      const { unmount } = render(<ArtifactTabRenderer artifact={makeArtifact({ atype: c.atype, mode: c.mode })} {...PROPS} />);
      expect(screen.getByTestId(c.testid)).toBeInTheDocument();
      unmount();
    }
  });
});
