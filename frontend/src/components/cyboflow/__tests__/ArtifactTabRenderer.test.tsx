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
import { useArtifactHtml, type UseArtifactHtml } from '../../../hooks/useArtifactHtml';
import { useFeedback, type UseFeedbackResult } from '../../../hooks/useFeedback';
import type { Artifact, ArtifactType, TaskVerificationReportEntry } from '../../../../../shared/types/artifacts';
import type { BacklogTaskItem } from '../../../../../shared/types/tasks';
import type { ReviewItem } from '../../../../../shared/types/reviews';
import type { Question } from '../../../../../shared/types/questions';

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

// Static-mockup HTML loads through useArtifactHtml (artifacts:load-html IPC).
// Mock it so the renderer test never touches window.electronAPI; default to a
// resolved-null (no on-disk html) and override per-test for the srcDoc cases.
vi.mock('../../../hooks/useArtifactHtml', () => ({ useArtifactHtml: vi.fn() }));
const mockHtml = vi.mocked(useArtifactHtml);
function setHtml(value: UseArtifactHtml): void {
  mockHtml.mockReturnValue(value);
}

// In-artifact feedback (IDEA-033) reads through useFeedback — mocked so the
// idea-spec/arch-design doc bodies and the approve-ideas/approve-designs gate
// chips never touch the real trpc.cyboflow.feedback surface. Defaults to the
// empty state (no comments/batches, no pending gate impact); individual tests
// override per-call via setFeedback.
vi.mock('../../../hooks/useFeedback', () => ({ useFeedback: vi.fn() }));
const mockFeedback = vi.mocked(useFeedback);
function setFeedback(value: Partial<UseFeedbackResult> = {}): void {
  mockFeedback.mockReturnValue({
    comments: [],
    batches: [],
    loading: false,
    createComment: vi.fn().mockResolvedValue(undefined),
    updateComment: vi.fn().mockResolvedValue(undefined),
    deleteComment: vi.fn().mockResolvedValue(undefined),
    sendBatch: vi.fn().mockResolvedValue({ sent: true, batchId: 'batch-1', round: 1 }),
    ...value,
  });
}

// Stub MarkdownPreview (avoids react-markdown ESM in jsdom); echo the content.
vi.mock('../../MarkdownPreview', () => ({
  MarkdownPreview: ({ content }: { content: string }) => <div data-testid="md-preview">{content}</div>,
}));

const commitMutate = vi.fn().mockResolvedValue({ artifactId: 'art-1' });
const reviewItemsResolveMutate = vi.fn().mockResolvedValue({ reviewItemId: 'rvw_gate', resumed: true });
// approve-plan (decomposed-stories live variant) answers the run's live
// AskUserQuestion via questions.answer.
const questionsAnswerMutate = vi.fn().mockResolvedValue({ ok: true });
// approve-ideas resolves a row's display ref to its full entity (incl. body)
// via tasks.list — the artifact payload carries only ref/title/scope/summary.
const tasksListQuery = vi.fn();
vi.mock('../../../trpc/client', () => ({
  trpc: {
    cyboflow: {
      artifacts: {
        commit: { mutate: (...args: unknown[]) => commitMutate(...args) },
      },
      reviewItems: {
        resolve: { mutate: (...args: unknown[]) => reviewItemsResolveMutate(...args) },
      },
      questions: {
        answer: { mutate: (...args: unknown[]) => questionsAnswerMutate(...args) },
      },
      tasks: {
        list: { query: (...args: unknown[]) => tasksListQuery(...args) },
      },
    },
  },
}));

// approve-ideas reads the already-wired project-scoped review_items inbox
// directly from the store (no new subscription) — mock it the same way
// RunPendingInputStrip.test.tsx does: a selector fn over a module-level array
// plus a spy-backed getState().init().
let mockReviewItems: ReviewItem[] = [];
const mockReviewInit = vi.fn();
const mockReviewRelease = vi.fn();
mockReviewInit.mockImplementation(() => mockReviewRelease);
vi.mock('../../../stores/reviewItemsSlice', () => ({
  useReviewItemsSlice: Object.assign(
    (selector: (s: { items: ReviewItem[] }) => unknown) => selector({ items: mockReviewItems }),
    { getState: () => ({ init: mockReviewInit }) },
  ),
}));
function setReviewItems(items: ReviewItem[]): void {
  mockReviewItems = items;
}

// decomposed-stories reads the app-lifetime live-question queue from the
// questionStore singleton — mock it the same selector+getState way.
let mockQuestionQueue: Question[] = [];
const mockQuestionInit = vi.fn(() => () => {});
vi.mock('../../../stores/questionStore', () => ({
  useQuestionStore: Object.assign(
    (selector: (s: { queue: Question[] }) => unknown) => selector({ queue: mockQuestionQueue }),
    { getState: () => ({ init: mockQuestionInit }) },
  ),
}));
function setQuestions(queue: Question[]): void {
  mockQuestionQueue = queue;
}

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
    category: 'feature',
    repo: null,
    parent_epic_id: null,
    originating_idea_id: null,
    scope: 'large',
    board_id: 'b1',
    stage_id: 's1',
    archived_at: null,
    decomposed_at: null,
    approved_at: '2026-01-01T00:00:00.000Z',
    sort_order: null,
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
    mockHtml.mockReset();
    mockFeedback.mockReset();
    // jsdom does not implement scrollIntoView; the behaviors-tested table's
    // evidence links call it to jump to the matching gallery thumbnail.
    HTMLElement.prototype.scrollIntoView = vi.fn();
    // Default: no resolved screenshot bytes (per-card fallback path).
    setImages({ images: {}, loading: false, error: null });
    // Default: no on-disk static mockup html (legacy url / placeholder paths).
    setHtml({ html: null, loading: false, error: null });
    // Default: no feedback comments/batches for any document.
    setFeedback();
    commitMutate.mockClear();
    reviewItemsResolveMutate.mockClear();
    questionsAnswerMutate.mockClear();
    tasksListQuery.mockReset();
    setReviewItems([]);
    setQuestions([]);
    mockReviewInit.mockClear();
    mockQuestionInit.mockClear();
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

  // --- arch-design -----------------------------------------------------------

  const ARCH_BODY =
    '# Problem\n\nIntro.\n\n## Architecture design\n\nUse a worker queue for mints.\n\n## Rollout\n\nLater.';

  it('renders the arch-design section markdown with the teal eyebrow', () => {
    setHook({ loading: false, error: null, data: { kind: 'arch', idea: makeIdea({ body: ARCH_BODY }) } });
    render(<ArtifactTabRenderer artifact={makeArtifact({ atype: 'arch-design' })} {...PROPS} />);

    expect(screen.getByTestId('artifact-arch-design')).toBeInTheDocument();
    const eyebrow = screen.getByTestId('artifact-eyebrow');
    expect(eyebrow).toHaveTextContent('Artifact · architecture design');
    expect(eyebrow).toHaveStyle({ color: '#2d7a8a' });
    // ONLY the extracted section is rendered — not the whole body.
    const md = screen.getByTestId('md-preview');
    expect(md).toHaveTextContent('Use a worker queue for mints.');
    expect(md).not.toHaveTextContent('Intro.');
    expect(md).not.toHaveTextContent('Later.');
  });

  it('shows the arch-design empty state when the body has no architecture section', () => {
    setHook({ loading: false, error: null, data: { kind: 'arch', idea: makeIdea() } });
    render(<ArtifactTabRenderer artifact={makeArtifact({ atype: 'arch-design' })} {...PROPS} />);

    expect(screen.getByTestId('artifact-arch-nosection')).toHaveTextContent('No architecture design yet.');
    expect(screen.queryByTestId('md-preview')).not.toBeInTheDocument();
  });

  it('shows the arch-design loading and error states', () => {
    setHook({ loading: true, error: null, data: null });
    const { rerender } = render(<ArtifactTabRenderer artifact={makeArtifact({ atype: 'arch-design' })} {...PROPS} />);
    expect(screen.getByTestId('artifact-arch-loading')).toBeInTheDocument();

    setHook({ loading: false, error: 'boom', data: null });
    rerender(<ArtifactTabRenderer artifact={makeArtifact({ atype: 'arch-design' })} {...PROPS} />);
    expect(screen.getByTestId('artifact-arch-error')).toHaveTextContent('boom');
  });

  // --- compound-recommendations --------------------------------------------

  it('renders the compound-recommendations markdown doc with the violet eyebrow', () => {
    setHook({
      loading: false,
      error: null,
      data: { kind: 'recommendations', payload: { markdown: '## Quick fixes\n\n- tighten the guard' } },
    });
    render(
      <ArtifactTabRenderer artifact={makeArtifact({ atype: 'compound-recommendations', sourceRef: null })} {...PROPS} />,
    );

    expect(screen.getByTestId('artifact-compound-recommendations')).toBeInTheDocument();
    const eyebrow = screen.getByTestId('artifact-eyebrow');
    expect(eyebrow).toHaveTextContent('Artifact · recommendations');
    expect(eyebrow).toHaveStyle({ color: '#8b5cf6' });
    expect(screen.getByTestId('md-preview')).toHaveTextContent('tighten the guard');
  });

  it('shows the compound-recommendations empty state when the payload has no markdown', () => {
    setHook({ loading: false, error: null, data: { kind: 'recommendations', payload: {} } });
    render(
      <ArtifactTabRenderer artifact={makeArtifact({ atype: 'compound-recommendations', sourceRef: null })} {...PROPS} />,
    );

    expect(screen.getByTestId('artifact-recommendations-empty')).toHaveTextContent('No recommendations drafted yet.');
    expect(screen.queryByTestId('md-preview')).not.toBeInTheDocument();
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
    setHook({ loading: false, error: null, data: { kind: 'stories', ideas: [makeStoriesIdea()] } });
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
    setHook({ loading: false, error: null, data: { kind: 'stories', ideas: [makeStoriesIdea()] } });
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
    setHook({ loading: false, error: null, data: { kind: 'stories', ideas: [makeStoriesIdea()] } });
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
    setHook({ loading: false, error: null, data: { kind: 'stories', ideas: [makeStoriesIdea()] } });
    render(<ArtifactTabRenderer artifact={makeArtifact({ atype: 'decomposed-stories' })} {...PROPS} />);

    // The second task (TASK-042) has body: null.
    fireEvent.click(screen.getAllByTestId('artifact-task-cell')[1]);
    expect(screen.getByTestId('task-detail-title')).toHaveTextContent('Wire artifact tabs');
    expect(screen.getByTestId('task-detail-nobody')).toHaveTextContent('No additional detail.');
    expect(screen.queryByTestId('md-preview')).not.toBeInTheDocument();
  });

  it('shows the decomposed-stories no-epics empty state', () => {
    setHook({ loading: false, error: null, data: { kind: 'stories', ideas: [makeIdea({ children: [] })] } });
    render(<ArtifactTabRenderer artifact={makeArtifact({ atype: 'decomposed-stories' })} {...PROPS} />);
    expect(screen.getByTestId('artifact-stories-noepics')).toBeInTheDocument();
  });

  // --- decomposed-stories: multi-idea sections, DRAFT mode + approve-plan gate ----

  // A multi-idea decomposition whose epics/tasks are hidden DRAFTS
  // (approved_at === null) — the state a plan-gated planner run parks in before
  // the plan gate is approved. Idea 1: EPIC-100 > TASK-100. Idea 2: direct TASK-101.
  function makeDraftIdeas(): BacklogTaskItem[] {
    return [
      makeIdea({
        id: 'IDEA-100',
        ref: 'IDEA-100',
        title: 'First idea',
        children: [
          {
            ...makeIdea({ id: 'EPIC-100', type: 'epic', ref: 'EPIC-100', title: 'Epic one', approved_at: null }),
            children: [
              makeIdea({ id: 'TASK-100', type: 'task', ref: 'TASK-100', title: 'Task one', approved_at: null }),
            ],
          },
        ],
      }),
      makeIdea({
        id: 'IDEA-101',
        ref: 'IDEA-101',
        title: 'Second idea',
        children: [
          makeIdea({ id: 'TASK-101', type: 'task', ref: 'TASK-101', title: 'Direct task', approved_at: null }),
        ],
      }),
    ];
  }

  // The same shape but every epic/task APPROVED (approved_at set, the makeIdea
  // default) — the post-approval state where drafts are revealed.
  function makeApprovedIdeas(): BacklogTaskItem[] {
    return [
      makeIdea({
        id: 'IDEA-100',
        ref: 'IDEA-100',
        title: 'First idea',
        children: [
          {
            ...makeIdea({ id: 'EPIC-100', type: 'epic', ref: 'EPIC-100', title: 'Epic one' }),
            children: [makeIdea({ id: 'TASK-100', type: 'task', ref: 'TASK-100', title: 'Task one' })],
          },
        ],
      }),
    ];
  }

  // The PROGRAMMATIC approve-plan gate: a pending decision review item stamped
  // 'gate:human-step:approve-plan' on this run.
  function makePlanGateItem(overrides: Partial<ReviewItem> = {}): ReviewItem {
    return {
      ...makeGateItem(),
      id: 'rvw_plan',
      kind: 'decision',
      source: 'gate:human-step:approve-plan',
      payload: { kind: 'decision', gate: 'approve-plan' },
      ...overrides,
    };
  }

  // A live AskUserQuestion approve-plan gate for this run. Its first sub-question
  // offers an 'Approve plan' option; a 'Reject plan' option is included unless
  // withReject === false.
  function makeApprovePlanQuestion({ withReject = true }: { withReject?: boolean } = {}): Question {
    return {
      id: 'q_plan',
      runId: 'run-1',
      workflowName: 'planner',
      toolUseId: 'tu_plan',
      questions: [
        {
          question: 'Approve this plan?',
          header: 'Plan',
          multiSelect: false,
          options: [
            { label: 'Approve plan' },
            { label: 'Revise' },
            ...(withReject ? [{ label: 'Reject plan' }] : []),
          ],
        },
      ],
      status: 'pending',
      createdAt: '2026-07-01T00:00:00.000Z',
      answeredAt: null,
      answerJson: null,
    };
  }

  function renderStories(ideas: BacklogTaskItem[]): void {
    setHook({ loading: false, error: null, data: { kind: 'stories', ideas } });
    render(<ArtifactTabRenderer artifact={makeArtifact({ atype: 'decomposed-stories' })} {...PROPS} />);
  }

  it('renders one section per idea the run owns (multi-idea batch)', () => {
    renderStories(makeDraftIdeas());

    expect(screen.getAllByTestId('artifact-stories-idea-section')).toHaveLength(2);
    expect(screen.getByText('First idea')).toBeInTheDocument();
    expect(screen.getByText('Second idea')).toBeInTheDocument();
    // Section headers carry each idea's ref; the counts aggregate across ideas
    // (1 epic; TASK-100 under the epic + direct TASK-101 = 2 tasks).
    expect(screen.getByText('IDEA-100')).toBeInTheDocument();
    expect(screen.getByText('IDEA-101')).toBeInTheDocument();
    expect(screen.getByTestId('artifact-stories-summary')).toHaveTextContent('2 ideas · 1 epic · 2 tasks');
  });

  it('shows the draft badge when any epic/task is a hidden draft', () => {
    renderStories(makeDraftIdeas());
    expect(screen.getByTestId('artifact-stories-draft-badge')).toHaveTextContent('Draft — pending plan approval');
  });

  it('hides the draft badge and footer when every epic/task is approved', () => {
    setReviewItems([makePlanGateItem()]); // gate present, but nothing is a draft
    renderStories(makeApprovedIdeas());
    expect(screen.queryByTestId('artifact-stories-draft-badge')).not.toBeInTheDocument();
    expect(screen.queryByTestId('stories-plan-footer')).not.toBeInTheDocument();
  });

  it('shows the draft badge but NO footer when draft mode has no resolvable gate', () => {
    // Draft mode but NO gate / live question (both mocks empty in beforeEach) →
    // the badge shows, but the Approve/Reject footer does not.
    renderStories(makeDraftIdeas());
    expect(screen.getByTestId('artifact-stories-draft-badge')).toBeInTheDocument();
    expect(screen.queryByTestId('stories-plan-footer')).not.toBeInTheDocument();
    expect(screen.queryByTestId('stories-approve-plan')).not.toBeInTheDocument();
  });

  it('renders Approve + Reject in the footer for a pending programmatic gate', () => {
    setReviewItems([makePlanGateItem()]);
    renderStories(makeDraftIdeas());
    expect(screen.getByTestId('stories-plan-footer')).toBeInTheDocument();
    expect(screen.getByTestId('stories-approve-plan')).toBeInTheDocument();
    expect(screen.getByTestId('stories-reject-plan')).toBeInTheDocument();
  });

  it('Approve resolves the programmatic approve-plan gate with outcome approve', async () => {
    setReviewItems([makePlanGateItem()]);
    renderStories(makeDraftIdeas());

    fireEvent.click(screen.getByTestId('stories-approve-plan'));
    await waitFor(() =>
      expect(reviewItemsResolveMutate).toHaveBeenCalledWith({
        projectId: 1,
        reviewItemId: 'rvw_plan',
        outcome: 'approve',
      }),
    );
    // The programmatic variant does NOT take the live-question answer path.
    expect(questionsAnswerMutate).not.toHaveBeenCalled();
  });

  it('Reject resolves the programmatic approve-plan gate with outcome reject', async () => {
    setReviewItems([makePlanGateItem()]);
    renderStories(makeDraftIdeas());

    fireEvent.click(screen.getByTestId('stories-reject-plan'));
    await waitFor(() =>
      expect(reviewItemsResolveMutate).toHaveBeenCalledWith({
        projectId: 1,
        reviewItemId: 'rvw_plan',
        outcome: 'reject',
      }),
    );
  });

  it('Approve answers a live AskUserQuestion with the approve option label (live wins over the gate)', async () => {
    // Both a live question AND a programmatic gate are pending — the live
    // question takes priority, so Approve answers it (never resolves the gate).
    setReviewItems([makePlanGateItem()]);
    setQuestions([makeApprovePlanQuestion()]);
    renderStories(makeDraftIdeas());

    fireEvent.click(screen.getByTestId('stories-approve-plan'));
    await waitFor(() =>
      expect(questionsAnswerMutate).toHaveBeenCalledWith({
        questionId: 'q_plan',
        answers: { 'Approve this plan?': 'Approve plan' },
      }),
    );
    expect(reviewItemsResolveMutate).not.toHaveBeenCalled();
  });

  it('Reject answers a live AskUserQuestion with the reject option label', async () => {
    setQuestions([makeApprovePlanQuestion()]);
    renderStories(makeDraftIdeas());

    fireEvent.click(screen.getByTestId('stories-reject-plan'));
    await waitFor(() =>
      expect(questionsAnswerMutate).toHaveBeenCalledWith({
        questionId: 'q_plan',
        answers: { 'Approve this plan?': 'Reject plan' },
      }),
    );
  });

  it('hides Reject for the live variant when the question presents no reject option', () => {
    setQuestions([makeApprovePlanQuestion({ withReject: false })]);
    renderStories(makeDraftIdeas());

    expect(screen.getByTestId('stories-approve-plan')).toBeInTheDocument();
    expect(screen.queryByTestId('stories-reject-plan')).not.toBeInTheDocument();
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

  it('renders NO Accept-as-baseline button — baseline retirement (§5.10)', () => {
    // Accept-as-baseline + the SSIM pre-diff retired entirely (verification-agent
    // redesign §5.10): the button never renders, on ANY verdict status, even PASS.
    setHook({
      loading: false,
      error: null,
      data: {
        kind: 'screenshots',
        payload: {
          fileNames: ['home.png'],
          verdict: {
            status: 'pass',
            confidence: 0.9,
            issues: [],
            feedback: 'ok',
            judgedFileNames: ['home.png'],
            baselineUsed: false,
            model: 'claude-opus-4-8',
            baselineKey: 'landing-page',
          },
        },
      },
    });
    render(<ArtifactTabRenderer artifact={makeArtifact({ atype: 'screenshots', mode: 'template' })} {...PROPS} />);

    expect(screen.queryByTestId('artifact-accept-baseline-button')).not.toBeInTheDocument();
    expect(screen.queryByTestId('artifact-verdict-footer')).not.toBeInTheDocument();
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

  // --- screenshots "Behaviors tested" report table (§5.9) ------------------

  function makeReportEntry(overrides: Partial<TaskVerificationReportEntry> = {}): TaskVerificationReportEntry {
    return {
      taskRef: 'TASK-001',
      requestId: 'req-1',
      attempt: 1,
      summary: 'Login form renders and submits',
      behaviors: [
        {
          id: 'b1',
          description: 'Submitting valid credentials navigates to the dashboard',
          expected: 'The dashboard header is visible after submit',
          result: 'pass',
          screenshots: ['home.png'],
          notes: '',
        },
      ],
      outcome: 'pass',
      completedAt: '2026-07-22T10:00:00.000Z',
      ...overrides,
    };
  }

  it('renders nothing new when the payload carries no reports (legacy identical)', () => {
    setHook({ loading: false, error: null, data: { kind: 'screenshots', payload: { fileNames: ['home.png'] } } });
    render(<ArtifactTabRenderer artifact={makeArtifact({ atype: 'screenshots', mode: 'template' })} {...PROPS} />);
    expect(screen.queryByTestId('artifact-behaviors-tested')).not.toBeInTheDocument();
  });

  it('renders a behaviors table with a result badge and expected text', () => {
    setHook({
      loading: false,
      error: null,
      data: {
        kind: 'screenshots',
        payload: { fileNames: ['home.png'], reports: [makeReportEntry()] },
      },
    });
    render(<ArtifactTabRenderer artifact={makeArtifact({ atype: 'screenshots', mode: 'template' })} {...PROPS} />);

    expect(screen.getByTestId('artifact-behaviors-tested')).toHaveTextContent('Behaviors tested');
    const group = screen.getByTestId('artifact-task-report');
    expect(group).toHaveTextContent('TASK-001');
    expect(group).toHaveTextContent('Login form renders and submits');
    const row = screen.getByTestId('artifact-behavior-row');
    expect(row).toHaveTextContent('Submitting valid credentials navigates to the dashboard');
    expect(row).toHaveTextContent('The dashboard header is visible after submit');
    expect(screen.getByTestId('artifact-behavior-result-badge')).toHaveTextContent('pass');
  });

  it('jumps to the matching gallery thumbnail when an evidence screenshot link is clicked', () => {
    setHook({
      loading: false,
      error: null,
      data: {
        kind: 'screenshots',
        payload: { fileNames: ['home.png'], reports: [makeReportEntry()] },
      },
    });
    render(<ArtifactTabRenderer artifact={makeArtifact({ atype: 'screenshots', mode: 'template' })} {...PROPS} />);

    const link = screen.getByTestId('artifact-behavior-evidence-link');
    expect(link).toHaveTextContent('home.png');
    fireEvent.click(link);
    expect(HTMLElement.prototype.scrollIntoView).toHaveBeenCalled();
  });

  it('renders an evidence filename NOT in fileNames as plain text, not a link', () => {
    setHook({
      loading: false,
      error: null,
      data: {
        kind: 'screenshots',
        payload: {
          fileNames: ['home.png'],
          reports: [
            makeReportEntry({
              behaviors: [
                {
                  id: 'b1',
                  description: 'Modal opens',
                  expected: 'Modal is visible',
                  result: 'fail',
                  screenshots: ['gone.png'],
                  notes: 'file was never captured',
                },
              ],
            }),
          ],
        },
      },
    });
    render(<ArtifactTabRenderer artifact={makeArtifact({ atype: 'screenshots', mode: 'template' })} {...PROPS} />);

    expect(screen.queryByTestId('artifact-behavior-evidence-link')).not.toBeInTheDocument();
    const missing = screen.getByTestId('artifact-behavior-evidence-missing');
    expect(missing).toHaveTextContent('gone.png');
  });

  it('groups multiple attempts of the same lane, latest prominent + older collapsed', () => {
    setHook({
      loading: false,
      error: null,
      data: {
        kind: 'screenshots',
        payload: {
          fileNames: ['home.png'],
          reports: [
            makeReportEntry({ requestId: 'req-1', attempt: 1, outcome: 'fail', completedAt: '2026-07-22T09:00:00.000Z' }),
            makeReportEntry({ requestId: 'req-2', attempt: 2, outcome: 'pass', completedAt: '2026-07-22T10:00:00.000Z' }),
          ],
        },
      },
    });
    render(<ArtifactTabRenderer artifact={makeArtifact({ atype: 'screenshots', mode: 'template' })} {...PROPS} />);

    // Exactly one group for the shared taskRef.
    expect(screen.getAllByTestId('artifact-task-report')).toHaveLength(1);
    // The latest attempt (attempt 2, pass) renders prominently.
    expect(screen.getByTestId('artifact-task-report-outcome')).toHaveTextContent('pass');
    expect(screen.queryByTestId('artifact-task-report-older')).not.toBeInTheDocument();

    // The older attempt is collapsed behind a toggle.
    const toggle = screen.getByTestId('artifact-task-report-toggle');
    expect(toggle).toHaveTextContent('1 earlier attempt');
    fireEvent.click(toggle);
    expect(screen.getByTestId('artifact-task-report-older')).toHaveTextContent('attempt 1');
  });

  it('drops a malformed report entry without throwing', () => {
    const malformed = {
      kind: 'screenshots',
      payload: { fileNames: ['home.png'], reports: [{ summary: 'no requestId or behaviors' }] },
    } as unknown as ArtifactData['data'];
    setHook({ loading: false, error: null, data: malformed });
    expect(() =>
      render(<ArtifactTabRenderer artifact={makeArtifact({ atype: 'screenshots', mode: 'template' })} {...PROPS} />),
    ).not.toThrow();
    expect(screen.queryByTestId('artifact-behaviors-tested')).not.toBeInTheDocument();
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

  it('renders the generic canvas with NO open affordance when no url', () => {
    setHook({ loading: false, error: null, data: { kind: 'canvas', payload: {} } });
    render(<ArtifactTabRenderer artifact={makeArtifact({ atype: 'generic', mode: 'canvas' })} {...PROPS} />);
    expect(screen.getByTestId('artifact-eyebrow')).toHaveTextContent('◳ Live canvas · generic');
    // No URL to open → the action is omitted entirely (no dead/disabled button).
    expect(screen.queryByTestId('artifact-canvas-open')).not.toBeInTheDocument();
    expect(screen.queryByTestId('artifact-canvas-open-disabled')).not.toBeInTheDocument();
  });

  it('refuses a javascript: canvas url — no live anchor and no open affordance at all', () => {
    // Build the scheme dynamically so the literal never appears as a script-url.
    const jsUrl = `${'java'}${'script'}:alert(1)`;
    setHook({ loading: false, error: null, data: { kind: 'canvas', payload: { url: jsUrl } } });
    render(<ArtifactTabRenderer artifact={makeArtifact({ atype: 'ui-prototype', mode: 'canvas' })} {...PROPS} />);
    // No live <a href> for a non-localhost (here non-http) payload url — and no button of any kind.
    expect(screen.queryByTestId('artifact-canvas-open')).not.toBeInTheDocument();
    expect(screen.queryByTestId('artifact-canvas-open-disabled')).not.toBeInTheDocument();
  });

  it('refuses a file:// canvas url — no live anchor and no open affordance at all', () => {
    setHook({ loading: false, error: null, data: { kind: 'canvas', payload: { url: 'file:///etc/passwd' } } });
    render(<ArtifactTabRenderer artifact={makeArtifact({ atype: 'ui-prototype', mode: 'canvas' })} {...PROPS} />);
    expect(screen.queryByTestId('artifact-canvas-open')).not.toBeInTheDocument();
    expect(screen.queryByTestId('artifact-canvas-open-disabled')).not.toBeInTheDocument();
  });

  it('refuses a remote http canvas url — no live anchor and no open affordance at all', () => {
    setHook({ loading: false, error: null, data: { kind: 'canvas', payload: { url: 'http://evil.example.com' } } });
    render(<ArtifactTabRenderer artifact={makeArtifact({ atype: 'ui-prototype', mode: 'canvas' })} {...PROPS} />);
    expect(screen.queryByTestId('artifact-canvas-open')).not.toBeInTheDocument();
    expect(screen.queryByTestId('artifact-canvas-open-disabled')).not.toBeInTheDocument();
  });

  // --- ui-prototype static mockup (Approach C: fileName pointer + srcDoc) ---

  it('embeds a static ui-prototype mockup via srcDoc (bare sandbox) from a fileName pointer', () => {
    // Pointer payload — the HTML itself comes from useArtifactHtml, not the payload.
    setHook({ loading: false, error: null, data: { kind: 'canvas', payload: { fileName: 'prototype/index.html' } } });
    setHtml({ html: '<html><head></head><body><h1>Mockup</h1></body></html>', loading: false, error: null });
    render(<ArtifactTabRenderer artifact={makeArtifact({ atype: 'ui-prototype', mode: 'canvas' })} {...PROPS} />);

    const iframe = screen.getByTestId('live-canvas-iframe');
    // srcDoc, NOT a cross-origin src; bare sandbox (no allow-scripts).
    expect(iframe).toHaveAttribute('srcdoc');
    expect(iframe).not.toHaveAttribute('src');
    expect(iframe.getAttribute('sandbox')).toBe('');
    expect(screen.queryByTestId('artifact-canvas-placeholder')).not.toBeInTheDocument();
    expect(screen.queryByTestId('artifact-canvas-unavailable')).not.toBeInTheDocument();
  });

  it('shows the loading state while the mockup html is in flight', () => {
    setHook({ loading: false, error: null, data: { kind: 'canvas', payload: { fileName: 'prototype/index.html' } } });
    setHtml({ html: null, loading: true, error: null });
    render(<ArtifactTabRenderer artifact={makeArtifact({ atype: 'ui-prototype', mode: 'canvas' })} {...PROPS} />);
    expect(screen.getByTestId('artifact-canvas-loading')).toBeInTheDocument();
    expect(screen.queryByTestId('live-canvas-iframe')).not.toBeInTheDocument();
  });

  it('shows the explicit "prototype unavailable" empty state (never a blank iframe) for a pointer whose html is absent', () => {
    setHook({ loading: false, error: null, data: { kind: 'canvas', payload: { fileName: 'prototype/index.html' } } });
    setHtml({ html: null, loading: false, error: null }); // file missing / unreadable → fail-soft null
    render(<ArtifactTabRenderer artifact={makeArtifact({ atype: 'ui-prototype', mode: 'canvas' })} {...PROPS} />);
    expect(screen.getByTestId('artifact-canvas-unavailable')).toHaveTextContent('Prototype unavailable');
    expect(screen.queryByTestId('live-canvas-iframe')).not.toBeInTheDocument();
  });

  it('embeds a COMMITTED canvas snapshot via srcDoc even with no fileName/url in the payload', () => {
    setHook({ loading: false, error: null, data: { kind: 'canvas', payload: {} } });
    setHtml({ html: '<html><body>committed snapshot</body></html>', loading: false, error: null });
    render(
      <ArtifactTabRenderer artifact={makeArtifact({ atype: 'ui-prototype', mode: 'canvas', committed: true })} {...PROPS} />,
    );
    const iframe = screen.getByTestId('live-canvas-iframe');
    expect(iframe).toHaveAttribute('srcdoc');
    expect(iframe.getAttribute('sandbox')).toBe('');
  });

  it('renders a legacy COMMITTED {url} canvas as the live url embed, NOT "unavailable" (#7)', () => {
    // Render selection is by payload SHAPE, not the committed flag: a committed
    // url-only canvas (no snapshot html) must still embed its url.
    setHook({ loading: false, error: null, data: { kind: 'canvas', payload: { url: 'http://localhost:8081' } } });
    setHtml({ html: null, loading: false, error: null });
    render(
      <ArtifactTabRenderer artifact={makeArtifact({ atype: 'generic', mode: 'canvas', committed: true })} {...PROPS} />,
    );
    expect(screen.getByTestId('live-canvas-iframe')).toHaveAttribute('src', 'http://localhost:8081');
    expect(screen.queryByTestId('artifact-canvas-unavailable')).not.toBeInTheDocument();
  });

  it('renders an UNCOMMITTED generic {fileName} canvas as inline srcDoc html (#7)', () => {
    // A fileName pointer means on-disk HTML regardless of committed state — the
    // old committed-gated hook skipped this and it read as "unavailable".
    setHook({ loading: false, error: null, data: { kind: 'canvas', payload: { fileName: 'prototype/index.html' } } });
    setHtml({ html: '<html><body>gen mock</body></html>', loading: false, error: null });
    render(
      <ArtifactTabRenderer artifact={makeArtifact({ atype: 'generic', mode: 'canvas', committed: false })} {...PROPS} />,
    );
    const iframe = screen.getByTestId('live-canvas-iframe');
    expect(iframe).toHaveAttribute('srcdoc');
    expect(iframe).not.toHaveAttribute('src');
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

    // IDEA-039: the commit call forwards ONLY identity — no payloadJson echo,
    // even though the artifact carries one.
    await waitFor(() =>
      expect(commitMutate).toHaveBeenCalledWith({ projectId: 1, artifactId: 'art-1' }),
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
      { atype: 'decomposed-stories', mode: 'template', testid: 'artifact-decomposed-stories', data: { loading: false, error: null, data: { kind: 'stories', ideas: [makeIdea({ children: [] })] } } },
      { atype: 'screenshots', mode: 'template', testid: 'artifact-screenshots', data: { loading: false, error: null, data: { kind: 'screenshots', payload: {} } } },
      { atype: 'ui-prototype', mode: 'canvas', testid: 'artifact-canvas', data: { loading: false, error: null, data: { kind: 'canvas', payload: {} } } },
      { atype: 'generic', mode: 'canvas', testid: 'artifact-canvas', data: { loading: false, error: null, data: { kind: 'canvas', payload: {} } } },
      { atype: 'arch-design', mode: 'template', testid: 'artifact-arch-design', data: { loading: false, error: null, data: { kind: 'arch', idea: makeIdea() } } },
      { atype: 'compound-recommendations', mode: 'template', testid: 'artifact-compound-recommendations', data: { loading: false, error: null, data: { kind: 'recommendations', payload: { markdown: '## x' } } } },
    ];
    for (const c of cases) {
      setHook(c.data);
      const { unmount } = render(<ArtifactTabRenderer artifact={makeArtifact({ atype: c.atype, mode: c.mode })} {...PROPS} />);
      expect(screen.getByTestId(c.testid)).toBeInTheDocument();
      unmount();
    }
  });

  // --- approve-ideas ---------------------------------------------------------

  const APPROVE_IDEAS_PAYLOAD = JSON.stringify({
    ideas: [
      { ref: 'IDEA-014', title: 'Ship the widget', scope: 'small', summary: 'A small widget.' },
      { ref: 'IDEA-015', title: 'Rework the gadget' },
    ],
  });

  function makeGateItem(overrides: Partial<ReviewItem> = {}): ReviewItem {
    return {
      id: 'rvw_gate',
      project_id: 1,
      run_id: 'run-1',
      entity_type: null,
      entity_id: null,
      kind: 'decision',
      status: 'pending',
      blocking: true,
      title: 'Approve ideas',
      body: null,
      severity: null,
      priority: null,
      staged_at: null,
      selected: false,
      source: 'gate:human-step:approve-ideas',
      payload: { kind: 'decision', gate: 'approve-ideas', ideaRefs: ['IDEA-014', 'IDEA-015'] },
      created_at: '2026-07-01T00:00:00.000Z',
      updated_at: '2026-07-01T00:00:00.000Z',
      resolved_by: null,
      resolution: null,
      ...overrides,
    };
  }

  function renderApproveIdeas(payloadJson: string | null = APPROVE_IDEAS_PAYLOAD): void {
    render(
      <ArtifactTabRenderer
        artifact={makeArtifact({ atype: 'approve-ideas', mode: 'template', payloadJson })}
        {...PROPS}
      />,
    );
  }

  it('renders the approve-ideas rows with the amber eyebrow', () => {
    setReviewItems([makeGateItem()]);
    renderApproveIdeas();

    expect(screen.getByTestId('artifact-approve-ideas')).toBeInTheDocument();
    const eyebrow = screen.getByTestId('artifact-eyebrow');
    expect(eyebrow).toHaveTextContent('Artifact · approve ideas');
    expect(eyebrow).toHaveStyle({ color: '#b8860b' });
    expect(screen.getAllByTestId('approve-ideas-row')).toHaveLength(2);
    expect(screen.getByText('Ship the widget')).toBeInTheDocument();
  });

  it('toggles each idea row independently and updates the footer counts', () => {
    setReviewItems([makeGateItem()]);
    renderApproveIdeas();

    expect(screen.getByTestId('approve-ideas-counts')).toHaveTextContent('0 approved · 0 denied · 2 undecided');

    fireEvent.click(screen.getByTestId('approve-ideas-approve-IDEA-014'));
    expect(screen.getByTestId('approve-ideas-approve-IDEA-014')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('approve-ideas-deny-IDEA-015')).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByTestId('approve-ideas-counts')).toHaveTextContent('1 approved · 0 denied · 1 undecided');

    fireEvent.click(screen.getByTestId('approve-ideas-deny-IDEA-015'));
    // The other row's verdict is untouched by this click.
    expect(screen.getByTestId('approve-ideas-approve-IDEA-014')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('approve-ideas-deny-IDEA-015')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('approve-ideas-counts')).toHaveTextContent('1 approved · 1 denied · 0 undecided');
  });

  it('disables Submit while any row is undecided, enables it once every row is decided', () => {
    setReviewItems([makeGateItem()]);
    renderApproveIdeas();

    const submit = screen.getByTestId('approve-ideas-submit');
    expect(submit).toBeDisabled();

    fireEvent.click(screen.getByTestId('approve-ideas-approve-IDEA-014'));
    expect(submit).toBeDisabled();

    fireEvent.click(screen.getByTestId('approve-ideas-deny-IDEA-015'));
    expect(submit).not.toBeDisabled();
  });

  it('Submit fires exactly one resolve call carrying the complete verdict map', async () => {
    setReviewItems([makeGateItem()]);
    renderApproveIdeas();

    fireEvent.click(screen.getByTestId('approve-ideas-approve-IDEA-014'));
    fireEvent.click(screen.getByTestId('approve-ideas-deny-IDEA-015'));
    fireEvent.click(screen.getByTestId('approve-ideas-submit'));

    await waitFor(() =>
      expect(reviewItemsResolveMutate).toHaveBeenCalledWith({
        projectId: 1,
        reviewItemId: 'rvw_gate',
        verdicts: { 'IDEA-014': 'approve', 'IDEA-015': 'deny' },
      }),
    );
    expect(reviewItemsResolveMutate).toHaveBeenCalledTimes(1);
  });

  it('Approve all fills every row with approve and enables Submit in one click', () => {
    setReviewItems([makeGateItem()]);
    renderApproveIdeas();

    fireEvent.click(screen.getByTestId('approve-ideas-approve-all'));

    expect(screen.getByTestId('approve-ideas-approve-IDEA-014')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('approve-ideas-approve-IDEA-015')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('approve-ideas-counts')).toHaveTextContent('2 approved · 0 denied · 0 undecided');
    expect(screen.getByTestId('approve-ideas-submit')).not.toBeDisabled();
  });

  it('Deny all overwrites prior per-row picks with deny for every row', () => {
    setReviewItems([makeGateItem()]);
    renderApproveIdeas();

    fireEvent.click(screen.getByTestId('approve-ideas-approve-IDEA-014'));
    fireEvent.click(screen.getByTestId('approve-ideas-deny-all'));

    expect(screen.getByTestId('approve-ideas-approve-IDEA-014')).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByTestId('approve-ideas-deny-IDEA-014')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('approve-ideas-deny-IDEA-015')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('approve-ideas-counts')).toHaveTextContent('0 approved · 2 denied · 0 undecided');
  });

  it('Approve all then Submit resolves with an all-approve verdict map', async () => {
    setReviewItems([makeGateItem()]);
    renderApproveIdeas();

    fireEvent.click(screen.getByTestId('approve-ideas-approve-all'));
    fireEvent.click(screen.getByTestId('approve-ideas-submit'));

    await waitFor(() =>
      expect(reviewItemsResolveMutate).toHaveBeenCalledWith({
        projectId: 1,
        reviewItemId: 'rvw_gate',
        verdicts: { 'IDEA-014': 'approve', 'IDEA-015': 'approve' },
      }),
    );
  });

  it('renders read-only rows + a note when the batch has ideas but no pending gate for this run', () => {
    setReviewItems([]); // no gate item at all
    renderApproveIdeas();

    expect(screen.getByTestId('approve-ideas-no-gate-note')).toHaveTextContent(
      'No pending approval gate for this run.',
    );
    expect(screen.queryByTestId('approve-ideas-footer')).not.toBeInTheDocument();

    const approveBtn = screen.getByTestId('approve-ideas-approve-IDEA-014');
    expect(approveBtn).toBeDisabled();
    fireEvent.click(approveBtn);
    expect(approveBtn).toHaveAttribute('aria-pressed', 'false');
    expect(reviewItemsResolveMutate).not.toHaveBeenCalled();
  });

  it('treats a gate item for a DIFFERENT run as no pending gate (read-only)', () => {
    setReviewItems([makeGateItem({ run_id: 'run-other' })]);
    renderApproveIdeas();
    expect(screen.getByTestId('approve-ideas-no-gate-note')).toBeInTheDocument();
  });

  it('finds the gate via the payload discriminant when the source is agent-minted', async () => {
    // Default ORCHESTRATED planner mints via cyboflow_report_finding, so the source
    // is 'agent:planner' (NOT 'gate:human-step:approve-ideas'); the gate is
    // recognized only via payload.gate — the footer must still render + Submit works.
    setReviewItems([makeGateItem({ source: 'agent:planner' })]);
    renderApproveIdeas();

    expect(screen.queryByTestId('approve-ideas-no-gate-note')).not.toBeInTheDocument();
    expect(screen.getByTestId('approve-ideas-footer')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('approve-ideas-approve-IDEA-014'));
    fireEvent.click(screen.getByTestId('approve-ideas-deny-IDEA-015'));
    fireEvent.click(screen.getByTestId('approve-ideas-submit'));

    await waitFor(() =>
      expect(reviewItemsResolveMutate).toHaveBeenCalledWith({
        projectId: 1,
        reviewItemId: 'rvw_gate',
        verdicts: { 'IDEA-014': 'approve', 'IDEA-015': 'deny' },
      }),
    );
  });

  it('shows the empty state for a malformed payload, without throwing', () => {
    setReviewItems([makeGateItem()]);
    expect(() => renderApproveIdeas('not json')).not.toThrow();
    expect(screen.getByTestId('artifact-approve-ideas-empty')).toHaveTextContent('No ideas to review.');
    expect(screen.queryByTestId('approve-ideas-row')).not.toBeInTheDocument();
  });

  it('shows the empty state for a null payload', () => {
    setReviewItems([makeGateItem()]);
    renderApproveIdeas(null);
    expect(screen.getByTestId('artifact-approve-ideas-empty')).toHaveTextContent('No ideas to review.');
  });

  // --- approve-ideas: click-through to the full spec (TaskDetailModal) -------
  // A run only ever gets ONE idea-spec artifact tab, so in a multi-idea batch
  // the row's text block resolves its display ref against the live backlog
  // (tasks.list — the payload row itself carries no opaque entity id) and
  // opens the shared TaskDetailModal.

  function makeSpecIdea(overrides: Partial<BacklogTaskItem> = {}): BacklogTaskItem {
    return makeIdea({
      id: 'idea-014',
      ref: 'IDEA-014',
      title: 'Ship the widget',
      body: '# Widget spec\n\nFull detail for IDEA-014.',
      ...overrides,
    });
  }

  it('clicking a row resolves the ref via tasks.list and opens the modal with the full spec', async () => {
    setReviewItems([makeGateItem()]);
    tasksListQuery.mockResolvedValue([makeSpecIdea()]);
    renderApproveIdeas();

    expect(screen.queryByTestId('task-detail-modal')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('approve-ideas-open-spec-IDEA-014'));

    await waitFor(() => expect(screen.getByTestId('task-detail-modal')).toBeInTheDocument());
    expect(tasksListQuery).toHaveBeenCalledWith({ projectId: 1 });
    expect(screen.getByTestId('md-preview')).toHaveTextContent('Full detail for IDEA-014.');
  });

  it('names the ref in an inline error and does not open the modal when the ref is missing from the list', async () => {
    setReviewItems([makeGateItem()]);
    tasksListQuery.mockResolvedValue([]); // IDEA-014 not present
    renderApproveIdeas();

    fireEvent.click(screen.getByTestId('approve-ideas-open-spec-IDEA-014'));

    await waitFor(() =>
      expect(screen.getByTestId('approve-ideas-spec-error')).toHaveTextContent("Couldn't load the spec for IDEA-014."),
    );
    expect(screen.queryByTestId('task-detail-modal')).not.toBeInTheDocument();
  });

  it('shows the same inline error without an unhandled rejection when tasks.list rejects', async () => {
    setReviewItems([makeGateItem()]);
    tasksListQuery.mockRejectedValue(new Error('network down'));
    renderApproveIdeas();

    fireEvent.click(screen.getByTestId('approve-ideas-open-spec-IDEA-014'));

    await waitFor(() =>
      expect(screen.getByTestId('approve-ideas-spec-error')).toHaveTextContent("Couldn't load the spec for IDEA-014."),
    );
    expect(screen.queryByTestId('task-detail-modal')).not.toBeInTheDocument();
  });

  it('clicking an Approve verdict button does not open the spec modal', () => {
    setReviewItems([makeGateItem()]);
    renderApproveIdeas();

    fireEvent.click(screen.getByTestId('approve-ideas-approve-IDEA-014'));
    expect(screen.queryByTestId('task-detail-modal')).not.toBeInTheDocument();
    expect(tasksListQuery).not.toHaveBeenCalled();
  });

  it('closes the modal via the shared close affordance', async () => {
    setReviewItems([makeGateItem()]);
    tasksListQuery.mockResolvedValue([makeSpecIdea()]);
    renderApproveIdeas();

    fireEvent.click(screen.getByTestId('approve-ideas-open-spec-IDEA-014'));
    await waitFor(() => expect(screen.getByTestId('task-detail-modal')).toBeInTheDocument());

    fireEvent.click(screen.getByLabelText('Close modal'));
    expect(screen.queryByTestId('task-detail-modal')).not.toBeInTheDocument();
  });

  it('spec viewing works read-only too (no pending gate for this run)', async () => {
    setReviewItems([]); // no gate item -> readOnly rows
    tasksListQuery.mockResolvedValue([makeSpecIdea()]);
    renderApproveIdeas();

    expect(screen.getByTestId('approve-ideas-no-gate-note')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('approve-ideas-open-spec-IDEA-014'));
    await waitFor(() => expect(screen.getByTestId('task-detail-modal')).toBeInTheDocument());
  });

  it('the last click wins when a second row is clicked before the first fetch resolves', async () => {
    setReviewItems([makeGateItem()]);
    let resolveFirst: (rows: BacklogTaskItem[]) => void = () => {};
    const firstPromise = new Promise<BacklogTaskItem[]>((res) => {
      resolveFirst = res;
    });
    tasksListQuery
      .mockReturnValueOnce(firstPromise)
      .mockResolvedValueOnce([
        makeSpecIdea({ id: 'idea-015', ref: 'IDEA-015', title: 'Rework the gadget', body: 'Gadget detail.' }),
      ]);
    renderApproveIdeas();

    fireEvent.click(screen.getByTestId('approve-ideas-open-spec-IDEA-014'));
    fireEvent.click(screen.getByTestId('approve-ideas-open-spec-IDEA-015'));

    await waitFor(() => expect(screen.getByTestId('task-detail-modal')).toBeInTheDocument());
    expect(screen.getByTestId('task-detail-title')).toHaveTextContent('Rework the gadget');

    // The slower first fetch resolving afterward must not clobber the second's result.
    resolveFirst([makeSpecIdea()]);
    await Promise.resolve();
    expect(screen.getByTestId('task-detail-title')).toHaveTextContent('Rework the gadget');
  });

  // --- approve-designs --------------------------------------------------------
  // Structural clone of approve-ideas above: same gate machinery (dual mint-path
  // recognition, shared IdeaVerdictMap + reviewItems.resolve), different payload
  // shape ('designs' vs 'ideas') and gate discriminant ('approve-designs' /
  // DecisionPayload.designRefs vs 'approve-ideas' / ideaRefs).

  const APPROVE_DESIGNS_PAYLOAD = JSON.stringify({
    designs: [
      { ref: 'IDEA-014', title: 'Ship the widget', scope: 'small', summary: 'A small widget.' },
      { ref: 'IDEA-015', title: 'Rework the gadget' },
    ],
  });

  function makeDesignGateItem(overrides: Partial<ReviewItem> = {}): ReviewItem {
    return {
      id: 'rvw_gate',
      project_id: 1,
      run_id: 'run-1',
      entity_type: null,
      entity_id: null,
      kind: 'decision',
      status: 'pending',
      blocking: true,
      title: 'Approve designs',
      body: null,
      severity: null,
      priority: null,
      staged_at: null,
      selected: false,
      source: 'gate:human-step:approve-designs',
      payload: { kind: 'decision', gate: 'approve-designs', designRefs: ['IDEA-014', 'IDEA-015'] },
      created_at: '2026-07-01T00:00:00.000Z',
      updated_at: '2026-07-01T00:00:00.000Z',
      resolved_by: null,
      resolution: null,
      ...overrides,
    };
  }

  function renderApproveDesigns(payloadJson: string | null = APPROVE_DESIGNS_PAYLOAD): void {
    render(
      <ArtifactTabRenderer
        artifact={makeArtifact({ atype: 'approve-designs', mode: 'template', payloadJson })}
        {...PROPS}
      />,
    );
  }

  it('renders the approve-designs rows with the amber eyebrow', () => {
    setReviewItems([makeDesignGateItem()]);
    renderApproveDesigns();

    expect(screen.getByTestId('artifact-approve-designs')).toBeInTheDocument();
    const eyebrow = screen.getByTestId('artifact-eyebrow');
    expect(eyebrow).toHaveTextContent('Artifact · approve designs');
    expect(eyebrow).toHaveStyle({ color: '#8a7326' });
    expect(screen.getAllByTestId('approve-designs-row')).toHaveLength(2);
    expect(screen.getByText('Ship the widget')).toBeInTheDocument();
  });

  it('toggles each design row independently and updates the footer counts', () => {
    setReviewItems([makeDesignGateItem()]);
    renderApproveDesigns();

    expect(screen.getByTestId('approve-designs-counts')).toHaveTextContent('0 approved · 0 denied · 2 undecided');

    fireEvent.click(screen.getByTestId('approve-designs-approve-IDEA-014'));
    expect(screen.getByTestId('approve-designs-approve-IDEA-014')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('approve-designs-deny-IDEA-015')).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByTestId('approve-designs-counts')).toHaveTextContent('1 approved · 0 denied · 1 undecided');

    fireEvent.click(screen.getByTestId('approve-designs-deny-IDEA-015'));
    expect(screen.getByTestId('approve-designs-approve-IDEA-014')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('approve-designs-deny-IDEA-015')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('approve-designs-counts')).toHaveTextContent('1 approved · 1 denied · 0 undecided');
  });

  it('disables Submit while any design row is undecided, enables it once every row is decided', () => {
    setReviewItems([makeDesignGateItem()]);
    renderApproveDesigns();

    const submit = screen.getByTestId('approve-designs-submit');
    expect(submit).toBeDisabled();

    fireEvent.click(screen.getByTestId('approve-designs-approve-IDEA-014'));
    expect(submit).toBeDisabled();

    fireEvent.click(screen.getByTestId('approve-designs-deny-IDEA-015'));
    expect(submit).not.toBeDisabled();
  });

  it('Submit fires exactly one resolve call carrying the complete verdict map', async () => {
    setReviewItems([makeDesignGateItem()]);
    renderApproveDesigns();

    fireEvent.click(screen.getByTestId('approve-designs-approve-IDEA-014'));
    fireEvent.click(screen.getByTestId('approve-designs-deny-IDEA-015'));
    fireEvent.click(screen.getByTestId('approve-designs-submit'));

    await waitFor(() =>
      expect(reviewItemsResolveMutate).toHaveBeenCalledWith({
        projectId: 1,
        reviewItemId: 'rvw_gate',
        verdicts: { 'IDEA-014': 'approve', 'IDEA-015': 'deny' },
      }),
    );
    expect(reviewItemsResolveMutate).toHaveBeenCalledTimes(1);
  });

  it('Approve all fills every design row with approve and enables Submit in one click', () => {
    setReviewItems([makeDesignGateItem()]);
    renderApproveDesigns();

    fireEvent.click(screen.getByTestId('approve-designs-approve-all'));

    expect(screen.getByTestId('approve-designs-approve-IDEA-014')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('approve-designs-approve-IDEA-015')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('approve-designs-counts')).toHaveTextContent('2 approved · 0 denied · 0 undecided');
    expect(screen.getByTestId('approve-designs-submit')).not.toBeDisabled();
  });

  it('Deny all overwrites prior per-row picks with deny for every design row', () => {
    setReviewItems([makeDesignGateItem()]);
    renderApproveDesigns();

    fireEvent.click(screen.getByTestId('approve-designs-approve-IDEA-014'));
    fireEvent.click(screen.getByTestId('approve-designs-deny-all'));

    expect(screen.getByTestId('approve-designs-approve-IDEA-014')).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByTestId('approve-designs-deny-IDEA-014')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('approve-designs-deny-IDEA-015')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('approve-designs-counts')).toHaveTextContent('0 approved · 2 denied · 0 undecided');
  });

  it('renders read-only design rows + a note when the batch has designs but no pending gate for this run', () => {
    setReviewItems([]); // no gate item at all
    renderApproveDesigns();

    expect(screen.getByTestId('approve-designs-no-gate-note')).toHaveTextContent(
      'No pending approval gate for this run.',
    );
    expect(screen.queryByTestId('approve-designs-footer')).not.toBeInTheDocument();

    const approveBtn = screen.getByTestId('approve-designs-approve-IDEA-014');
    expect(approveBtn).toBeDisabled();
    fireEvent.click(approveBtn);
    expect(approveBtn).toHaveAttribute('aria-pressed', 'false');
    expect(reviewItemsResolveMutate).not.toHaveBeenCalled();
  });

  it('treats a design gate item for a DIFFERENT run as no pending gate (read-only)', () => {
    setReviewItems([makeDesignGateItem({ run_id: 'run-other' })]);
    renderApproveDesigns();
    expect(screen.getByTestId('approve-designs-no-gate-note')).toBeInTheDocument();
  });

  it('finds the design gate via the payload discriminant when the source is agent-minted', async () => {
    // Default ORCHESTRATED planner mints via cyboflow_report_finding, so the source
    // is 'agent:architect' (NOT 'gate:human-step:approve-designs'); the gate is
    // recognized only via payload.gate — the footer must still render + Submit works.
    setReviewItems([makeDesignGateItem({ source: 'agent:architect' })]);
    renderApproveDesigns();

    expect(screen.queryByTestId('approve-designs-no-gate-note')).not.toBeInTheDocument();
    expect(screen.getByTestId('approve-designs-footer')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('approve-designs-approve-IDEA-014'));
    fireEvent.click(screen.getByTestId('approve-designs-deny-IDEA-015'));
    fireEvent.click(screen.getByTestId('approve-designs-submit'));

    await waitFor(() =>
      expect(reviewItemsResolveMutate).toHaveBeenCalledWith({
        projectId: 1,
        reviewItemId: 'rvw_gate',
        verdicts: { 'IDEA-014': 'approve', 'IDEA-015': 'deny' },
      }),
    );
  });

  it('shows the empty state for a malformed design payload, without throwing', () => {
    setReviewItems([makeDesignGateItem()]);
    expect(() => renderApproveDesigns('not json')).not.toThrow();
    expect(screen.getByTestId('artifact-approve-designs-empty')).toHaveTextContent('No designs to review.');
    expect(screen.queryByTestId('approve-designs-row')).not.toBeInTheDocument();
  });

  it('shows the empty state for a null design payload', () => {
    setReviewItems([makeDesignGateItem()]);
    renderApproveDesigns(null);
    expect(screen.getByTestId('artifact-approve-designs-empty')).toHaveTextContent('No designs to review.');
  });

  // --- approve-designs: click-through to the full spec (TaskDetailModal) -----

  function makeSpecDesignIdea(overrides: Partial<BacklogTaskItem> = {}): BacklogTaskItem {
    return makeIdea({
      id: 'idea-014',
      ref: 'IDEA-014',
      title: 'Ship the widget',
      body: '## Architecture design\n\nFull detail for IDEA-014.',
      ...overrides,
    });
  }

  it('clicking a design row resolves the ref via tasks.list and opens the modal with the full spec', async () => {
    setReviewItems([makeDesignGateItem()]);
    tasksListQuery.mockResolvedValue([makeSpecDesignIdea()]);
    renderApproveDesigns();

    expect(screen.queryByTestId('task-detail-modal')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('approve-designs-open-spec-IDEA-014'));

    await waitFor(() => expect(screen.getByTestId('task-detail-modal')).toBeInTheDocument());
    expect(tasksListQuery).toHaveBeenCalledWith({ projectId: 1 });
    expect(screen.getByTestId('md-preview')).toHaveTextContent('Full detail for IDEA-014.');
  });

  it('names the ref in an inline error and does not open the modal when the ref is missing from the list', async () => {
    setReviewItems([makeDesignGateItem()]);
    tasksListQuery.mockResolvedValue([]); // IDEA-014 not present
    renderApproveDesigns();

    fireEvent.click(screen.getByTestId('approve-designs-open-spec-IDEA-014'));

    await waitFor(() =>
      expect(screen.getByTestId('approve-designs-spec-error')).toHaveTextContent("Couldn't load the spec for IDEA-014."),
    );
    expect(screen.queryByTestId('task-detail-modal')).not.toBeInTheDocument();
  });

  it('clicking an Approve verdict button does not open the design spec modal', () => {
    setReviewItems([makeDesignGateItem()]);
    renderApproveDesigns();

    fireEvent.click(screen.getByTestId('approve-designs-approve-IDEA-014'));
    expect(screen.queryByTestId('task-detail-modal')).not.toBeInTheDocument();
    expect(tasksListQuery).not.toHaveBeenCalled();
  });

  it('design spec viewing works read-only too (no pending gate for this run)', async () => {
    setReviewItems([]); // no gate item -> readOnly rows
    tasksListQuery.mockResolvedValue([makeSpecDesignIdea()]);
    renderApproveDesigns();

    expect(screen.getByTestId('approve-designs-no-gate-note')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('approve-designs-open-spec-IDEA-014'));
    await waitFor(() => expect(screen.getByTestId('task-detail-modal')).toBeInTheDocument());
  });
});
