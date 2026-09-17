/**
 * TaskCard scope badge — renders a compact S/L chip beside the priority tag
 * only when `task.scope` is set; absent (identical to today) when null.
 *
 * The backlog store is mocked to an empty-boards/empty-projects snapshot
 * (mirrors CardActionsMenu.test.tsx) so CardActionsMenu — a card descendant —
 * renders nothing and the project chip row stays hidden; the trpc client is
 * stubbed since it's imported by TaskCard/CardActionsMenu even though no call
 * fires on a plain render.
 *
 * Also covers the idea component ledger surfaces (markers.tsx's LedgerChip +
 * TaskCard's `ledger-expand` block, migration 101): all five chips render for
 * an idea, none for epics/tasks, the stale chip is visually distinct from the
 * not-started chip, the expand toggles aria-expanded, and the row-level
 * override calls `ideaComponents.setState`.
 */
import '@testing-library/jest-dom';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import type { BacklogTaskItem } from '../../../../../shared/types/tasks';
import { IDEA_COMPONENT_KEYS } from '../../../../../shared/types/ideaComponents';
import type { IdeaComponentState } from '../../../../../shared/types/ideaComponents';

vi.mock('../../../stores/backlogStore', () => {
  const useBacklogStore = (
    selector: (s: { boards: unknown[]; projects: unknown[]; filterProjectId: number | null }) => unknown,
  ) => selector({ boards: [], projects: [], filterProjectId: null });
  return { useBacklogStore };
});

const { setStateMock, forEntityMock } = vi.hoisted(() => ({
  setStateMock: vi.fn(),
  // DesignAffordance (mounted in the epic/task card footer) resolves via
  // design.forEntity — default to null (no button) so existing card assertions
  // below are unaffected.
  forEntityMock: vi.fn().mockResolvedValue(null),
}));

vi.mock('../../../trpc/client', () => ({
  trpc: {
    cyboflow: {
      tasks: {
        ideaDecomposition: { query: vi.fn() },
        setStage: { mutate: vi.fn() },
        archive: { mutate: vi.fn() },
        delete: { mutate: vi.fn() },
        update: { mutate: vi.fn() },
        getAttachments: { query: vi.fn() },
      },
      ideaComponents: {
        setState: { mutate: setStateMock },
        onComponentsChanged: { subscribe: () => ({ unsubscribe: vi.fn() }) },
      },
      design: {
        forEntity: { query: forEntityMock },
        snapshotHtml: { query: vi.fn() },
      },
    },
  },
}));

import { BoardCard } from '../TaskCard';

/** All five ledger components, each defaulted to 'not started' unless overridden by key. */
function makeComponents(overrides: Partial<Record<(typeof IDEA_COMPONENT_KEYS)[number], Partial<IdeaComponentState>>> = {}): IdeaComponentState[] {
  return IDEA_COMPONENT_KEYS.map((component) => ({
    component,
    state: 'incomplete',
    source: 'derived',
    sourceRunId: null,
    sourceSessionId: null,
    builtAgainstVersion: null,
    staleAt: null,
    staleReason: null,
    updatedAt: null,
    ...overrides[component],
  }));
}

function makeIdea(overrides: Partial<BacklogTaskItem> = {}): BacklogTaskItem {
  return {
    id: 'idea_1',
    project_id: 1,
    type: 'idea',
    ref: 'IDEA-001',
    title: 'Some idea',
    summary: null,
    body: null,
    priority: 'P1',
    category: 'feature',
    repo: null,
    parent_epic_id: null,
    originating_idea_id: null,
    scope: null,
    board_id: 'board-1',
    stage_id: 's-1',
    archived_at: null,
    decomposed_at: null,
    approved_at: null,
    sort_order: null,
    version: 1,
    stage_position: 1,
    inFlow: [],
    awaitingReview: false,
    isDone: false,
    memberships: [],
    created_at: '2026-06-01T00:00:00Z',
    updated_at: '2026-06-01T00:00:00Z',
    ...overrides,
  };
}

const onRun = vi.fn();

describe('TaskCard scope badge', () => {
  it('renders "S" when scope is small', () => {
    render(<BoardCard task={makeIdea({ scope: 'small' })} onRun={onRun} launchingTaskId={null} now={Date.now()} />);
    const badge = screen.getByTestId('scope-tag');
    expect(badge).toHaveTextContent('S');
  });

  it('renders "L" when scope is large', () => {
    render(<BoardCard task={makeIdea({ scope: 'large' })} onRun={onRun} launchingTaskId={null} now={Date.now()} />);
    const badge = screen.getByTestId('scope-tag');
    expect(badge).toHaveTextContent('L');
  });

  it('renders nothing when scope is unset', () => {
    render(<BoardCard task={makeIdea({ scope: null })} onRun={onRun} launchingTaskId={null} now={Date.now()} />);
    expect(screen.queryByTestId('scope-tag')).not.toBeInTheDocument();
  });
});

// Backlog idea card "Open" (idea sessions plan, Stage 4). onRun is a single
// shared prop for both actions — BacklogPane branches on task.type internally
// (useIdeaSessionOpener vs useTaskRunLauncher); TaskCard only owns the
// label/testid/disable-reason swap.
describe('TaskCard "Open" button (idea sessions plan, Stage 4)', () => {
  it('renders "Open" with the idea testid for an idea, and "Run" with the task testid otherwise', () => {
    const { rerender } = render(
      <BoardCard task={makeIdea()} onRun={onRun} launchingTaskId={null} now={Date.now()} />,
    );
    const openButton = screen.getByTestId('task-open-button');
    expect(openButton).toHaveTextContent('Open');
    expect(screen.queryByTestId('task-run-button')).not.toBeInTheDocument();

    rerender(
      <BoardCard task={makeIdea({ type: 'task', ref: 'TASK-001' })} onRun={onRun} launchingTaskId={null} now={Date.now()} />,
    );
    expect(screen.getByTestId('task-run-button')).toHaveTextContent('Run');
    expect(screen.queryByTestId('task-open-button')).not.toBeInTheDocument();
  });

  it('calls onRun(task) when Open is clicked, same as Run', () => {
    onRun.mockClear();
    const idea = makeIdea();
    render(<BoardCard task={idea} onRun={onRun} launchingTaskId={null} now={Date.now()} />);
    fireEvent.click(screen.getByTestId('task-open-button'));
    expect(onRun).toHaveBeenCalledWith(idea);
  });

  it('is NOT disabled by an in-development association (inFlow), unlike Run', () => {
    render(
      <BoardCard
        task={makeIdea({
          inFlow: [{ agent: 'executor', runId: 'run-1', stepId: null, runStatus: 'running', sessionId: null, sessionName: null }],
        })}
        onRun={onRun}
        launchingTaskId={null}
        now={Date.now()}
      />,
    );
    const openButton = screen.getByTestId('task-open-button');
    expect(openButton).not.toBeDisabled();
    expect(openButton).not.toHaveAttribute('title');
  });

  it('IS disabled with a reason for an archived idea', () => {
    render(
      <BoardCard
        task={makeIdea({ archived_at: '2026-06-02T00:00:00Z' })}
        onRun={onRun}
        launchingTaskId={null}
        now={Date.now()}
      />,
    );
    const openButton = screen.getByTestId('task-open-button');
    expect(openButton).toBeDisabled();
    expect(openButton).toHaveAttribute('title', 'Archived — restore to open');
  });

  it('is disabled (in-flight guard) while launchingTaskId matches this idea, with no glyph/label change beyond the spinner', () => {
    render(<BoardCard task={makeIdea()} onRun={onRun} launchingTaskId="idea_1" now={Date.now()} />);
    expect(screen.getByTestId('task-open-button')).toBeDisabled();
  });
});

describe('TaskCard Design affordance (Tier 2, item 8c)', () => {
  it('renders the Design button for a task once forEntity resolves a bound design', async () => {
    forEntityMock.mockClear();
    forEntityMock.mockResolvedValueOnce({
      ideaId: 'idea-1',
      ideaRef: 'IDEA-014',
      ideaTitle: 'Spend flow',
      approvedAt: '2026-01-01T00:00:00.000Z',
      source: 'flow',
      sourceRunId: 'run-1',
    });
    render(
      <BoardCard task={makeIdea({ type: 'task', ref: 'TASK-001' })} onRun={onRun} launchingTaskId={null} now={Date.now()} />,
    );

    expect(await screen.findByTestId('design-affordance')).toBeInTheDocument();
  });

  it('renders no Design button for a task with no bound design', async () => {
    forEntityMock.mockClear();
    render(
      <BoardCard task={makeIdea({ type: 'task', ref: 'TASK-001' })} onRun={onRun} launchingTaskId={null} now={Date.now()} />,
    );

    await waitFor(() => expect(forEntityMock).toHaveBeenCalled());
    expect(screen.queryByTestId('design-affordance')).not.toBeInTheDocument();
  });

  it('never renders the Design button on an idea card (its own home covers that)', async () => {
    forEntityMock.mockClear();
    forEntityMock.mockResolvedValueOnce({
      ideaId: 'idea-1',
      ideaRef: 'IDEA-014',
      ideaTitle: 'Spend flow',
      approvedAt: '2026-01-01T00:00:00.000Z',
      source: 'flow',
      sourceRunId: 'run-1',
    });
    render(<BoardCard task={makeIdea()} onRun={onRun} launchingTaskId={null} now={Date.now()} />);

    // Give the (never-called, since the component isn't mounted for ideas)
    // resolution a tick, then assert the button is absent.
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByTestId('design-affordance')).not.toBeInTheDocument();
    expect(forEntityMock).not.toHaveBeenCalled();
  });
});

describe('TaskCard "In experiment" badge (C2)', () => {
  it('renders the badge when the task is a live experiment seed', () => {
    render(
      <BoardCard
        task={makeIdea({ type: 'task', ref: 'TASK-061', experimentSeed: true })}
        onRun={onRun}
        launchingTaskId={null}
        now={Date.now()}
      />,
    );
    expect(screen.getByTestId('experiment-badge')).toHaveTextContent('In experiment');
  });

  it('renders nothing when experimentSeed is false/undefined', () => {
    render(
      <BoardCard task={makeIdea({ type: 'task', ref: 'TASK-062' })} onRun={onRun} launchingTaskId={null} now={Date.now()} />,
    );
    expect(screen.queryByTestId('experiment-badge')).not.toBeInTheDocument();
  });
});

describe('TaskCard idea component ledger chips', () => {
  it('renders all five chips for an idea with a resolved component set', () => {
    render(
      <BoardCard
        task={makeIdea({ components: makeComponents() })}
        onRun={onRun}
        launchingTaskId={null}
        now={Date.now()}
      />,
    );
    for (const key of IDEA_COMPONENT_KEYS) {
      expect(screen.getByTestId(`ledger-chip-${key}`)).toBeInTheDocument();
    }
  });

  it('renders every chip even when some components are skipped — the set is always five', () => {
    render(
      <BoardCard
        task={makeIdea({ components: makeComponents({ architecture: { state: 'skipped' } }) })}
        onRun={onRun}
        launchingTaskId={null}
        now={Date.now()}
      />,
    );
    expect(screen.getAllByTestId(/^ledger-chip-/)).toHaveLength(IDEA_COMPONENT_KEYS.length);
    expect(screen.getByTestId('ledger-chip-architecture')).toHaveAttribute('data-ledger-state', 'skipped');
  });

  it('renders no chips for an epic or a task, even if components were (incorrectly) present', () => {
    render(
      <BoardCard
        task={makeIdea({ type: 'epic', ref: 'EPIC-001', components: makeComponents() })}
        onRun={onRun}
        launchingTaskId={null}
        now={Date.now()}
      />,
    );
    expect(screen.queryByTestId(/^ledger-chip-/)).not.toBeInTheDocument();
  });

  it('renders no chips when components is undefined (not yet computed)', () => {
    render(<BoardCard task={makeIdea()} onRun={onRun} launchingTaskId={null} now={Date.now()} />);
    expect(screen.queryByTestId(/^ledger-chip-/)).not.toBeInTheDocument();
  });

  // THE regression guard: "needs review" (stale) must never look like
  // "not started" — they are different points on the staleness axis.
  it('gives the stale ("needs review") chip a different visual treatment than the not-started chip', () => {
    render(
      <BoardCard
        task={makeIdea({
          components: makeComponents({
            prototype: { state: 'incomplete', staleAt: '2026-08-01T00:00:00Z' },
            stories: { state: 'incomplete', staleAt: null },
          }),
        })}
        onRun={onRun}
        launchingTaskId={null}
        now={Date.now()}
      />,
    );
    const stale = screen.getByTestId('ledger-chip-prototype');
    const notStarted = screen.getByTestId('ledger-chip-stories');
    expect(stale).toHaveAttribute('data-ledger-state', 'needs-review');
    expect(notStarted).toHaveAttribute('data-ledger-state', 'not-started');
    expect(stale.className).not.toBe(notStarted.className);
  });
});

describe('TaskCard ledger expand', () => {
  it('is absent for an idea with no resolved components', () => {
    render(<BoardCard task={makeIdea()} onRun={onRun} launchingTaskId={null} now={Date.now()} />);
    expect(screen.queryByTestId('ledger-expand')).not.toBeInTheDocument();
  });

  it('toggles aria-expanded and reveals one row per component, using a DISTINCT testid from epic-expand', () => {
    render(
      <BoardCard
        task={makeIdea({ components: makeComponents() })}
        onRun={onRun}
        launchingTaskId={null}
        now={Date.now()}
      />,
    );
    const toggle = screen.getByTestId('ledger-expand');
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByTestId('epic-expand')).not.toBeInTheDocument();
    expect(screen.queryByTestId('task-children')).not.toBeInTheDocument();

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    for (const key of IDEA_COMPONENT_KEYS) {
      expect(screen.getByTestId(`ledger-row-${key}`)).toBeInTheDocument();
    }

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
  });

  it('renders a legible "needs review" provenance line distinct from "not started"', () => {
    render(
      <BoardCard
        task={makeIdea({
          components: makeComponents({
            prototype: { state: 'incomplete', staleAt: '2026-08-01T00:00:00Z', staleReason: 'idea body changed' },
          }),
        })}
        onRun={onRun}
        launchingTaskId={null}
        now={Date.now()}
      />,
    );
    fireEvent.click(screen.getByTestId('ledger-expand'));
    expect(screen.getByTestId('ledger-row-prototype')).toHaveTextContent('Needs review');
    expect(screen.getByTestId('ledger-row-prototype')).toHaveTextContent('idea body changed');
    expect(screen.getByTestId('ledger-row-stories')).toHaveTextContent('Not started');
  });

  it('calls ideaComponents.setState with the idea id, component and chosen state on override', async () => {
    setStateMock.mockResolvedValueOnce(makeComponents({ prototype: { state: 'complete' } }));
    render(
      <BoardCard
        task={makeIdea({ id: 'idea_42', components: makeComponents() })}
        onRun={onRun}
        launchingTaskId={null}
        now={Date.now()}
      />,
    );
    fireEvent.click(screen.getByTestId('ledger-expand'));
    fireEvent.change(screen.getByTestId('ledger-override-prototype'), { target: { value: 'complete' } });

    await waitFor(() =>
      expect(setStateMock).toHaveBeenCalledWith({ ideaId: 'idea_42', component: 'prototype', state: 'complete' }),
    );
  });
});

// Search / membership filtering (IDEA-053, TASK-203). The evidence line is the
// only user-visible signal that a card is on the board because a CHILD matched;
// its exact "Matches <REF> — <Title>" format is asserted here directly (the
// BacklogPane suite only checks the two substrings end-to-end).
describe('TaskCard matched-child evidence', () => {
  it('renders "Matches REF — Title" for a single matched child', () => {
    render(
      <BoardCard
        task={makeIdea({ type: 'epic', ref: 'EPIC-001', title: 'Parent epic' })}
        onRun={onRun}
        launchingTaskId={null}
        now={Date.now()}
        matchedChildRefs={[{ ref: 'TASK-014', title: 'Add retry guard' }]}
      />,
    );
    expect(screen.getByTestId('matched-child-evidence')).toHaveTextContent(
      'Matches TASK-014 — Add retry guard',
    );
  });

  it('comma-joins several matched children', () => {
    render(
      <BoardCard
        task={makeIdea({ type: 'epic', ref: 'EPIC-001', title: 'Parent epic' })}
        onRun={onRun}
        launchingTaskId={null}
        now={Date.now()}
        matchedChildRefs={[
          { ref: 'TASK-014', title: 'Add retry guard' },
          { ref: 'TASK-015', title: 'Update session token' },
        ]}
      />,
    );
    expect(screen.getByTestId('matched-child-evidence')).toHaveTextContent(
      'Matches TASK-014 — Add retry guard, TASK-015 — Update session token',
    );
  });

  it('renders nothing when there is no matched-child evidence (the unfiltered board)', () => {
    render(
      <BoardCard
        task={makeIdea({ type: 'epic', ref: 'EPIC-001' })}
        onRun={onRun}
        launchingTaskId={null}
        now={Date.now()}
      />,
    );
    expect(screen.queryByTestId('matched-child-evidence')).not.toBeInTheDocument();
  });
});
