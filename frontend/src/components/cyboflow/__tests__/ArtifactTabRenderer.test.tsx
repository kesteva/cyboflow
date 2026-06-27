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
import { useArtifactImages, type UseArtifactImages } from '../../../hooks/useArtifactImages';
import type { Artifact, ArtifactType } from '../../../../../shared/types/artifacts';
import type { BacklogTaskItem } from '../../../../../shared/types/tasks';

// --- mocks -----------------------------------------------------------------

vi.mock('../../../hooks/useArtifactData', () => ({ useArtifactData: vi.fn() }));
const mockHook = vi.mocked(useArtifactData);

// Screenshot bytes load through useArtifactImages (artifacts:load-images IPC).
// Mock it so the renderer test never touches window.electronAPI; default to an
// empty map and override per-test for the resolved-<img> cases.
vi.mock('../../../hooks/useArtifactImages', () => ({ useArtifactImages: vi.fn() }));
const mockImages = vi.mocked(useArtifactImages);
function setImages(value: UseArtifactImages): void {
  mockImages.mockReturnValue(value);
}

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
    mockImages.mockReset();
    // Default: no resolved screenshot bytes (per-card fallback path).
    setImages({ images: {}, loading: false, error: null });
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

  function makeStoriesIdea(): BacklogTaskItem {
    return makeIdea({
      children: [
        {
          ...makeIdea({ id: 'EPIC-1', type: 'epic', ref: 'EPIC-001', title: 'Center tabs' }),
          children: [
            makeIdea({
              id: 'TASK-1',
              type: 'task',
              ref: 'TASK-041',
              title: 'Build tab strip',
              priority: 'P0',
              summary: 'Tab strip across the top.',
              body: '## Acceptance\n\nRender a horizontal tab strip with keyboard nav.',
            }),
            makeIdea({ id: 'TASK-2', type: 'task', ref: 'TASK-042', title: 'Wire artifact tabs', body: null }),
          ],
        },
      ],
    });
  }

  it('renders the decomposed-stories epic/task grid with the indigo eyebrow', () => {
    setHook({ loading: false, error: null, data: { kind: 'stories', idea: makeStoriesIdea() } });
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

  it('stacks tasks vertically (a single column, NOT a 2-col grid)', () => {
    setHook({ loading: false, error: null, data: { kind: 'stories', idea: makeStoriesIdea() } });
    render(<ArtifactTabRenderer artifact={makeArtifact({ atype: 'decomposed-stories' })} {...PROPS} />);

    const cells = screen.getAllByTestId('artifact-task-cell');
    expect(cells).toHaveLength(2);
    // The shared container is the cells' common parent.
    const container = cells[0].parentElement as HTMLElement;
    expect(container).toBe(cells[1].parentElement);
    // Vertical stack: a flex column, NOT a 2-col CSS grid.
    expect(container).toHaveStyle({ display: 'flex', flexDirection: 'column' });
    expect(container).not.toHaveStyle({ gridTemplateColumns: '1fr 1fr' });
    // Each card is an accessible button.
    for (const cell of cells) {
      expect(cell.tagName).toBe('BUTTON');
      expect(cell).toHaveAttribute('aria-label');
    }
  });

  it('opens the task detail with the full markdown body on card click, then closes', () => {
    setHook({ loading: false, error: null, data: { kind: 'stories', idea: makeStoriesIdea() } });
    render(<ArtifactTabRenderer artifact={makeArtifact({ atype: 'decomposed-stories' })} {...PROPS} />);

    // Modal is closed initially.
    expect(screen.queryByTestId('task-detail-modal')).not.toBeInTheDocument();

    // Click the first task card.
    const cells = screen.getAllByTestId('artifact-task-cell');
    fireEvent.click(cells[0]);

    // Detail shows ref, title, priority, summary, and the body markdown.
    const modal = screen.getByTestId('task-detail-modal');
    expect(modal).toBeInTheDocument();
    expect(screen.getByTestId('task-detail-title')).toHaveTextContent('Build tab strip');
    expect(screen.getByTestId('task-detail-priority')).toHaveTextContent('P0');
    expect(screen.getByTestId('task-detail-summary')).toHaveTextContent('Tab strip across the top.');
    // Body is rendered via MarkdownPreview (stubbed to echo its content).
    expect(screen.getByTestId('md-preview')).toHaveTextContent('Render a horizontal tab strip with keyboard nav.');

    // Close via the Modal close button.
    fireEvent.click(screen.getByLabelText('Close modal'));
    expect(screen.queryByTestId('task-detail-modal')).not.toBeInTheDocument();
  });

  it('shows the No-additional-detail state when a task body is null/empty', () => {
    setHook({ loading: false, error: null, data: { kind: 'stories', idea: makeStoriesIdea() } });
    render(<ArtifactTabRenderer artifact={makeArtifact({ atype: 'decomposed-stories' })} {...PROPS} />);

    // The second task (TASK-042) has body: null.
    fireEvent.click(screen.getAllByTestId('artifact-task-cell')[1]);
    expect(screen.getByTestId('task-detail-title')).toHaveTextContent('Wire artifact tabs');
    expect(screen.getByTestId('task-detail-nobody')).toHaveTextContent('No additional detail.');
    expect(screen.queryByTestId('md-preview')).not.toBeInTheDocument();
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

  it('renders an <img> with the resolved data URL for each loaded screenshot', () => {
    setHook({ loading: false, error: null, data: { kind: 'screenshots', payload: { fileNames: ['home.png', 'detail.png'] } } });
    setImages({
      images: {
        'home.png': 'data:image/png;base64,AAA',
        'detail.png': 'data:image/png;base64,BBB',
      },
      loading: false,
      error: null,
    });
    render(<ArtifactTabRenderer artifact={makeArtifact({ atype: 'screenshots', mode: 'template' })} {...PROPS} />);

    const imgs = screen.getAllByTestId('artifact-shot-image');
    expect(imgs).toHaveLength(2);
    expect(imgs[0]).toHaveAttribute('src', 'data:image/png;base64,AAA');
    expect(imgs[0]).toHaveAttribute('alt', 'home.png');
    expect(imgs[1]).toHaveAttribute('src', 'data:image/png;base64,BBB');
    expect(screen.queryByTestId('artifact-shot-missing')).not.toBeInTheDocument();
  });

  it('shows a per-card fallback for a fileName whose bytes did not resolve', () => {
    setHook({ loading: false, error: null, data: { kind: 'screenshots', payload: { fileNames: ['home.png', 'gone.png'] } } });
    // Only home.png resolved on disk; gone.png is missing / blocked by the guard.
    setImages({ images: { 'home.png': 'data:image/png;base64,AAA' }, loading: false, error: null });
    render(<ArtifactTabRenderer artifact={makeArtifact({ atype: 'screenshots', mode: 'template' })} {...PROPS} />);

    expect(screen.getAllByTestId('artifact-shot-card')).toHaveLength(2);
    expect(screen.getAllByTestId('artifact-shot-image')).toHaveLength(1);
    const missing = screen.getByTestId('artifact-shot-missing');
    expect(missing).toHaveTextContent('image unavailable');
    expect(screen.getByText('gone.png')).toBeInTheDocument();
  });

  it('falls back to the empty state (no throw) when fileNames is not an array', () => {
    // Malformed payload — fileNames laundered through parsePayload as a non-array.
    // The runtime narrowing must coerce to [] rather than letting .map() throw.
    const malformed = { kind: 'screenshots', payload: { fileNames: 'shot.png' } } as unknown as ArtifactData['data'];
    setHook({ loading: false, error: null, data: malformed });
    expect(() =>
      render(<ArtifactTabRenderer artifact={makeArtifact({ atype: 'screenshots', mode: 'template' })} {...PROPS} />),
    ).not.toThrow();
    expect(screen.getByTestId('artifact-shots-empty')).toBeInTheDocument();
    expect(screen.queryByTestId('artifact-shots-grid')).not.toBeInTheDocument();
  });

  it('drops non-string entries from a mixed fileNames array', () => {
    const mixed = { kind: 'screenshots', payload: { fileNames: ['home.png', 42, null, 'detail.png'] } } as unknown as ArtifactData['data'];
    setHook({ loading: false, error: null, data: mixed });
    render(<ArtifactTabRenderer artifact={makeArtifact({ atype: 'screenshots', mode: 'template' })} {...PROPS} />);
    expect(screen.getAllByTestId('artifact-shot-card')).toHaveLength(2);
    expect(screen.getByText('home.png')).toBeInTheDocument();
    expect(screen.getByText('detail.png')).toBeInTheDocument();
  });

  // --- screenshots verdict banner (P9) -------------------------------------

  it('renders the PASS verdict banner (green check + confidence, no feedback/issues)', () => {
    setHook({
      loading: false,
      error: null,
      data: {
        kind: 'screenshots',
        payload: {
          fileNames: ['home.png'],
          verdict: {
            status: 'pass',
            confidence: 0.92,
            issues: [],
            feedback: 'Matches the intent.',
            judgedFileNames: ['home.png'],
            baselineUsed: false,
            model: 'claude-opus-4-8',
          },
        },
      },
    });
    render(<ArtifactTabRenderer artifact={makeArtifact({ atype: 'screenshots', mode: 'template' })} {...PROPS} />);

    const banner = screen.getByTestId('artifact-verdict-banner');
    expect(banner).toHaveAttribute('data-verdict-status', 'pass');
    expect(banner).toHaveTextContent('Visual check passed');
    expect(screen.getByTestId('artifact-verdict-confidence')).toHaveTextContent('92% confidence');
    expect(screen.getByTestId('artifact-verdict-icon')).toHaveTextContent('✓');
    // PASS suppresses feedback + issue list.
    expect(screen.queryByTestId('artifact-verdict-feedback')).not.toBeInTheDocument();
    expect(screen.queryByTestId('artifact-verdict-issues')).not.toBeInTheDocument();
  });

  it('renders the FAIL verdict banner with feedback + a per-issue list', () => {
    setHook({
      loading: false,
      error: null,
      data: {
        kind: 'screenshots',
        payload: {
          fileNames: ['home.png', 'detail.png'],
          verdict: {
            status: 'fail',
            confidence: 0.81,
            issues: [
              { severity: 'high', description: 'Header overlaps the hero', fileName: 'home.png' },
              { severity: 'low', description: 'Footer spacing is tight' },
            ],
            feedback: 'Two layout regressions found.',
            judgedFileNames: ['home.png', 'detail.png'],
            baselineUsed: false,
            model: 'claude-opus-4-8',
          },
        },
      },
    });
    render(<ArtifactTabRenderer artifact={makeArtifact({ atype: 'screenshots', mode: 'template' })} {...PROPS} />);

    const banner = screen.getByTestId('artifact-verdict-banner');
    expect(banner).toHaveAttribute('data-verdict-status', 'fail');
    expect(banner).toHaveTextContent('Visual check failed');
    expect(screen.getByTestId('artifact-verdict-feedback')).toHaveTextContent('Two layout regressions found.');
    const issues = screen.getAllByTestId('artifact-verdict-issue');
    expect(issues).toHaveLength(2);
    expect(issues[0]).toHaveTextContent('Header overlaps the hero');
    expect(issues[0]).toHaveTextContent('home.png');

    // The per-image issue annotates the matching thumbnail (home.png) only.
    const badge = screen.getByTestId('artifact-shot-issue-badge');
    expect(badge).toHaveTextContent('1 issue');
    // Only one card carries a badge (detail.png has no per-file issue).
    expect(screen.getAllByTestId('artifact-shot-issue-badge')).toHaveLength(1);
  });

  it('renders the low_confidence banner as "needs human visual review" (amber, with feedback)', () => {
    setHook({
      loading: false,
      error: null,
      data: {
        kind: 'screenshots',
        payload: {
          fileNames: ['home.png'],
          verdict: {
            status: 'low_confidence',
            confidence: 0.42,
            issues: [],
            feedback: 'Could not determine if the modal rendered.',
            judgedFileNames: ['home.png'],
            baselineUsed: false,
            model: 'claude-opus-4-8',
          },
        },
      },
    });
    render(<ArtifactTabRenderer artifact={makeArtifact({ atype: 'screenshots', mode: 'template' })} {...PROPS} />);

    const banner = screen.getByTestId('artifact-verdict-banner');
    expect(banner).toHaveAttribute('data-verdict-status', 'low_confidence');
    expect(banner).toHaveTextContent('Needs human visual review');
    expect(screen.getByTestId('artifact-verdict-confidence')).toHaveTextContent('42% confidence');
    expect(screen.getByTestId('artifact-verdict-feedback')).toHaveTextContent('Could not determine if the modal rendered.');
  });

  it('renders no verdict banner when the payload carries no verdict', () => {
    setHook({ loading: false, error: null, data: { kind: 'screenshots', payload: { fileNames: ['home.png'] } } });
    render(<ArtifactTabRenderer artifact={makeArtifact({ atype: 'screenshots', mode: 'template' })} {...PROPS} />);
    expect(screen.queryByTestId('artifact-verdict-banner')).not.toBeInTheDocument();
    expect(screen.getByTestId('artifact-shots-grid')).toBeInTheDocument();
  });

  it('ignores a malformed verdict (no banner, no throw)', () => {
    const malformed = {
      kind: 'screenshots',
      payload: { fileNames: ['home.png'], verdict: 'pass' },
    } as unknown as ArtifactData['data'];
    setHook({ loading: false, error: null, data: malformed });
    expect(() =>
      render(<ArtifactTabRenderer artifact={makeArtifact({ atype: 'screenshots', mode: 'template' })} {...PROPS} />),
    ).not.toThrow();
    expect(screen.queryByTestId('artifact-verdict-banner')).not.toBeInTheDocument();
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

  it('refuses a javascript: canvas url — renders the disabled span, not a live anchor', () => {
    // Build the scheme dynamically so the literal never appears as a script-url.
    const jsUrl = `${'java'}${'script'}:alert(1)`;
    setHook({ loading: false, error: null, data: { kind: 'canvas', payload: { url: jsUrl } } });
    render(<ArtifactTabRenderer artifact={makeArtifact({ atype: 'ui-prototype', mode: 'canvas' })} {...PROPS} />);
    // No live <a href> for a non-localhost (here non-http) payload url.
    expect(screen.queryByTestId('artifact-canvas-open')).not.toBeInTheDocument();
    expect(screen.getByTestId('artifact-canvas-open-disabled')).toBeInTheDocument();
  });

  it('refuses a file:// canvas url — renders the disabled span, not a live anchor', () => {
    setHook({ loading: false, error: null, data: { kind: 'canvas', payload: { url: 'file:///etc/passwd' } } });
    render(<ArtifactTabRenderer artifact={makeArtifact({ atype: 'ui-prototype', mode: 'canvas' })} {...PROPS} />);
    expect(screen.queryByTestId('artifact-canvas-open')).not.toBeInTheDocument();
    expect(screen.getByTestId('artifact-canvas-open-disabled')).toBeInTheDocument();
  });

  it('refuses a remote http canvas url — renders the disabled span, not a live anchor', () => {
    setHook({ loading: false, error: null, data: { kind: 'canvas', payload: { url: 'http://evil.example.com' } } });
    render(<ArtifactTabRenderer artifact={makeArtifact({ atype: 'ui-prototype', mode: 'canvas' })} {...PROPS} />);
    expect(screen.queryByTestId('artifact-canvas-open')).not.toBeInTheDocument();
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
