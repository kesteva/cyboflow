/**
 * Unit tests for the recommendedActions engine — every detector's trigger +
 * exclusion chain, ranking/MAX_VISIBLE overflow, signature stability +
 * dismissal filtering/resurfacing, and singular/plural copy.
 *
 * All timestamps are driven through explicit `nowMs` (NOW below) rather than
 * the real clock, mirroring homeClassify.test.ts's convention.
 */
import { describe, it, expect } from 'vitest';
import type { QuickSessionGitSnapshot, QuickSessionRow } from '../../../../shared/types/quickSessions';
import type { QuickSessionTriage } from '../quickSessionTriage';
import type { BacklogTaskItem } from '../../../../shared/types/tasks';
import type { IdeaComponentState } from '../../../../shared/types/ideaComponents';
import type { ReviewItem } from '../../../../shared/types/reviews';
import { READY_FOR_DEV_POSITION } from '../../components/Backlog/backlogSelectors';
import {
  deriveRecommendedActions,
  MAX_VISIBLE,
  type BlockingFindingAction,
  type LaunchPlannerAction,
  type LaunchSprintAction,
  type MergeCleanAction,
  type RebaseBehindAction,
  type RecommendedActionsInput,
  type RecommendedActionsProjectRef,
  type RecommendedActionsRunRef,
  type ReviewBlockedAction,
  type RunLaunchFlowAction,
  type WrapUpStaleAction,
} from '../recommendedActions';

const NOW = Date.parse('2026-06-10T12:00:00.000Z');
const HOUR_MS = 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

function makeGit(overrides: Partial<QuickSessionGitSnapshot> = {}): QuickSessionGitSnapshot {
  return {
    isReadyToMerge: false,
    hasUncommittedChanges: false,
    hasUntrackedFiles: false,
    ahead: 0,
    behind: 0,
    lastCheckedIso: '2026-06-10T00:00:00.000Z',
    ...overrides,
  };
}

function makeSessionRow(overrides: Partial<QuickSessionRow> & { sessionId: string }): QuickSessionRow {
  return {
    sessionId: overrides.sessionId,
    name: overrides.name ?? overrides.sessionId,
    projectId: overrides.projectId ?? 1,
    runId: overrides.runId ?? null,
    state: overrides.state ?? 'idle',
    idleSince: overrides.idleSince ?? null,
    unviewed: overrides.unviewed ?? false,
    restedAtIso: overrides.restedAtIso ?? null,
    rawStatus: overrides.rawStatus ?? 'completed',
    exitCode: overrides.exitCode ?? null,
    summary: overrides.summary ?? null,
    summaryState: overrides.summaryState ?? null,
    waitingOn: overrides.waitingOn ?? null,
    summarySupported: overrides.summarySupported ?? true,
    worktreeName: overrides.worktreeName ?? null,
    git: overrides.git !== undefined ? overrides.git : null,
  };
}

function makeTriage(overrides: Partial<QuickSessionTriage> = {}): QuickSessionTriage {
  return { needsInput: [], readyForReview: [], working: [], ...overrides };
}

function makeTask(overrides: Partial<BacklogTaskItem> & { id: string }): BacklogTaskItem {
  return {
    id: overrides.id,
    project_id: overrides.project_id ?? 1,
    type: overrides.type ?? 'task',
    ref: overrides.ref ?? `TASK-${overrides.id}`,
    title: overrides.title ?? 'A task',
    summary: overrides.summary ?? null,
    body: overrides.body ?? null,
    priority: overrides.priority ?? 'P2',
    category: overrides.category ?? 'feature',
    executor: overrides.executor ?? 'agent',
    repo: overrides.repo ?? null,
    parent_epic_id: overrides.parent_epic_id ?? null,
    originating_idea_id: overrides.originating_idea_id ?? null,
    scope: overrides.scope ?? null,
    board_id: overrides.board_id ?? 'board-1-default',
    stage_id: overrides.stage_id ?? 'stage-board-1-default-1',
    archived_at: overrides.archived_at ?? null,
    decomposed_at: overrides.decomposed_at ?? null,
    approved_at: overrides.approved_at !== undefined ? overrides.approved_at : '2026-01-01T00:00:00.000Z',
    sort_order: overrides.sort_order !== undefined ? overrides.sort_order : null,
    version: overrides.version ?? 1,
    stage_position: overrides.stage_position ?? 1,
    inFlow: overrides.inFlow ?? [],
    awaitingReview: overrides.awaitingReview ?? false,
    isDone: overrides.isDone ?? false,
    memberships: overrides.memberships ?? [],
    children: overrides.children,
    childCount: overrides.childCount,
    pendingTasks: overrides.pendingTasks,
    experimentSeed: overrides.experimentSeed,
    components: overrides.components,
    created_at: overrides.created_at ?? '2026-01-01T00:00:00.000Z',
    updated_at: overrides.updated_at ?? '2026-01-01T00:00:00.000Z',
  };
}

function makeReviewItem(overrides: Partial<ReviewItem> & { id: string }): ReviewItem {
  return {
    id: overrides.id,
    project_id: overrides.project_id ?? 1,
    run_id: overrides.run_id !== undefined ? overrides.run_id : null,
    entity_type: overrides.entity_type ?? null,
    entity_id: overrides.entity_id ?? null,
    kind: overrides.kind ?? 'finding',
    status: overrides.status ?? 'pending',
    blocking: overrides.blocking ?? false,
    audience: overrides.audience ?? 'human',
    title: overrides.title ?? `item ${overrides.id}`,
    body: overrides.body ?? null,
    severity: overrides.severity ?? null,
    priority: overrides.priority ?? null,
    staged_at: overrides.staged_at ?? null,
    selected: overrides.selected ?? false,
    source: overrides.source ?? null,
    payload: overrides.payload ?? null,
    created_at: overrides.created_at ?? '2026-06-05T00:00:00.000Z',
    updated_at: overrides.updated_at ?? '2026-06-05T00:00:00.000Z',
    resolved_by: overrides.resolved_by ?? null,
    resolution: overrides.resolution ?? null,
  };
}

function makeRun(overrides: Partial<RecommendedActionsRunRef> = {}): RecommendedActionsRunRef {
  return {
    project_id: overrides.project_id ?? 1,
    status: overrides.status ?? 'running',
    workflowName: overrides.workflowName ?? 'sprint',
  };
}

function baseInput(overrides: Partial<RecommendedActionsInput> = {}): RecommendedActionsInput {
  return {
    nowMs: NOW,
    quickSessionTriage: makeTriage(),
    activeRuns: [],
    reviewItems: [],
    tasks: [],
    projects: [{ id: 1, name: 'Alpha' } as RecommendedActionsProjectRef],
    dismissedSignatures: {},
    ...overrides,
  };
}

function readyTask(id: string, projectId = 1): BacklogTaskItem {
  return makeTask({ id, project_id: projectId, type: 'task', stage_position: READY_FOR_DEV_POSITION });
}

function ideaComponents(overrides: Partial<Record<IdeaComponentState['component'], IdeaComponentState['state']>>): IdeaComponentState[] {
  const keys: IdeaComponentState['component'][] = ['idea-spec', 'prototype', 'architecture', 'epics', 'stories'];
  return keys.map((component) => ({
    component,
    state: overrides[component] ?? 'incomplete',
    source: 'derived',
    sourceRunId: null,
    sourceSessionId: null,
    builtAgainstVersion: null,
    staleAt: null,
    staleReason: null,
    updatedAt: null,
  }));
}

// ---------------------------------------------------------------------------
// review-blocked
// ---------------------------------------------------------------------------

describe('review-blocked', () => {
  it('does not appear when needsInput is empty', () => {
    const { visible } = deriveRecommendedActions(baseInput());
    expect(visible.some((a) => a.kind === 'review-blocked')).toBe(false);
  });

  it('matches the approved-design example verbatim for 2 sessions', () => {
    const triage = makeTriage({
      needsInput: [
        makeSessionRow({ sessionId: 's1', name: 'jolly-brook' }),
        makeSessionRow({ sessionId: 's2', name: 'Tech debt cleanup' }),
      ],
    });
    const { visible } = deriveRecommendedActions(baseInput({ quickSessionTriage: triage }));
    const action = visible.find((a) => a.kind === 'review-blocked') as ReviewBlockedAction;
    expect(action).toBeDefined();
    expect(action.title).toBe('Review sessions needing your attention');
    expect(action.description).toBe(
      '2 sessions are blocked on your answer — jolly-brook and Tech debt cleanup.',
    );
    expect(action.dismissible).toBe(false);
    expect(action.sessionIds).toEqual(['s1', 's2']);
  });

  it('uses singular copy for exactly 1 session', () => {
    const triage = makeTriage({ needsInput: [makeSessionRow({ sessionId: 's1', name: 'lone-wolf' })] });
    const { visible } = deriveRecommendedActions(baseInput({ quickSessionTriage: triage }));
    const action = visible.find((a) => a.kind === 'review-blocked') as ReviewBlockedAction;
    expect(action.title).toBe('Review the session needing your attention');
    expect(action.description).toBe('1 session is blocked on your answer — lone-wolf.');
  });

  it('shows only 2 names plus an overflow count for 3+ sessions', () => {
    const triage = makeTriage({
      needsInput: [
        makeSessionRow({ sessionId: 's1', name: 'a' }),
        makeSessionRow({ sessionId: 's2', name: 'b' }),
        makeSessionRow({ sessionId: 's3', name: 'c' }),
      ],
    });
    const { visible } = deriveRecommendedActions(baseInput({ quickSessionTriage: triage }));
    const action = visible.find((a) => a.kind === 'review-blocked') as ReviewBlockedAction;
    expect(action.description).toBe('3 sessions are blocked on your answer — a and b, and 1 more.');
  });

  it('is never filtered out by a stored dismissal (not dismissible)', () => {
    const triage = makeTriage({ needsInput: [makeSessionRow({ sessionId: 's1', name: 'a' })] });
    const { visible } = deriveRecommendedActions(
      baseInput({ quickSessionTriage: triage, dismissedSignatures: { 'review-blocked': 's1' } }),
    );
    expect(visible.some((a) => a.kind === 'review-blocked')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// merge-clean
// ---------------------------------------------------------------------------

describe('merge-clean', () => {
  it('does not fire for a row without a ready-to-merge git snapshot', () => {
    const triage = makeTriage({
      readyForReview: [makeSessionRow({ sessionId: 's1', git: makeGit({ isReadyToMerge: false }) })],
    });
    const { visible } = deriveRecommendedActions(baseInput({ quickSessionTriage: triage }));
    expect(visible.some((a) => a.kind === 'merge-clean')).toBe(false);
  });

  it('matches the approved-design example verbatim for 2 sessions', () => {
    const triage = makeTriage({
      readyForReview: [
        makeSessionRow({ sessionId: 's1', name: 'eager-lily', git: makeGit({ isReadyToMerge: true, ahead: 2 }) }),
        makeSessionRow({ sessionId: 's2', name: 'lively-lynx', git: makeGit({ isReadyToMerge: true, ahead: 13 }) }),
      ],
    });
    const { visible } = deriveRecommendedActions(baseInput({ quickSessionTriage: triage }));
    const action = visible.find((a) => a.kind === 'merge-clean') as MergeCleanAction;
    expect(action.title).toBe('Merge 2 clean sessions');
    expect(action.description).toBe(
      'eager-lily (↑2) and lively-lynx (↑13) are ready to merge with clean trees.',
    );
    expect(action.sessionIds).toEqual(['s1', 's2']);
  });

  it('uses singular copy for exactly 1 session', () => {
    const triage = makeTriage({
      readyForReview: [makeSessionRow({ sessionId: 's1', name: 'solo', git: makeGit({ isReadyToMerge: true, ahead: 5 }) })],
    });
    const { visible } = deriveRecommendedActions(baseInput({ quickSessionTriage: triage }));
    const action = visible.find((a) => a.kind === 'merge-clean') as MergeCleanAction;
    expect(action.title).toBe('Merge 1 clean session');
    expect(action.description).toBe('solo (↑5) is ready to merge with a clean tree.');
  });
});

// ---------------------------------------------------------------------------
// rebase-behind (excludes merge-clean)
// ---------------------------------------------------------------------------

describe('rebase-behind', () => {
  it('fires for a non-ready-to-merge row that is behind base', () => {
    const triage = makeTriage({
      readyForReview: [makeSessionRow({ sessionId: 's1', name: 'a', git: makeGit({ behind: 3 }) })],
    });
    const { visible } = deriveRecommendedActions(baseInput({ quickSessionTriage: triage }));
    const action = visible.find((a) => a.kind === 'rebase-behind') as RebaseBehindAction;
    expect(action).toBeDefined();
    expect(action.title).toBe('Rebase 1 session behind base');
    expect(action.description).toBe('a needs a rebase before merging.');
  });

  it('excludes a session already claimed by merge-clean', () => {
    // Contrived: ready-to-merge AND behind>0 at once, purely to prove the
    // dedup-by-sessionId exclusion (real git state would never combine these).
    const triage = makeTriage({
      readyForReview: [
        makeSessionRow({ sessionId: 's1', name: 'a', git: makeGit({ isReadyToMerge: true, behind: 3 }) }),
      ],
    });
    const { visible } = deriveRecommendedActions(baseInput({ quickSessionTriage: triage }));
    expect(visible.some((a) => a.kind === 'merge-clean')).toBe(true);
    expect(visible.some((a) => a.kind === 'rebase-behind')).toBe(false);
  });

  it('does not fire for a row with no git cache entry', () => {
    const triage = makeTriage({ readyForReview: [makeSessionRow({ sessionId: 's1', git: null })] });
    const { visible } = deriveRecommendedActions(baseInput({ quickSessionTriage: triage }));
    expect(visible.some((a) => a.kind === 'rebase-behind')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// wrap-up-stale (excludes merge-clean AND rebase-behind)
// ---------------------------------------------------------------------------

describe('wrap-up-stale', () => {
  const staleIso = new Date(NOW - 73 * HOUR_MS).toISOString();

  it('fires for a session quiet more than 72h', () => {
    const triage = makeTriage({
      readyForReview: [makeSessionRow({ sessionId: 's1', name: 'a', restedAtIso: staleIso })],
    });
    const { visible } = deriveRecommendedActions(baseInput({ quickSessionTriage: triage }));
    const action = visible.find((a) => a.kind === 'wrap-up-stale') as WrapUpStaleAction;
    expect(action).toBeDefined();
    expect(action.title).toBe('Wrap up 1 stale session');
    expect(action.description).toBe('a has been quiet for over 3 days.');
  });

  it('does not fire exactly at the 72h boundary', () => {
    const exactlyIso = new Date(NOW - 72 * HOUR_MS).toISOString();
    const triage = makeTriage({ readyForReview: [makeSessionRow({ sessionId: 's1', restedAtIso: exactlyIso })] });
    const { visible } = deriveRecommendedActions(baseInput({ quickSessionTriage: triage }));
    expect(visible.some((a) => a.kind === 'wrap-up-stale')).toBe(false);
  });

  it('does not fire when restedAtIso is null or unparseable', () => {
    const triage = makeTriage({
      readyForReview: [
        makeSessionRow({ sessionId: 's1', restedAtIso: null }),
        makeSessionRow({ sessionId: 's2', restedAtIso: 'not-a-date' }),
      ],
    });
    const { visible } = deriveRecommendedActions(baseInput({ quickSessionTriage: triage }));
    expect(visible.some((a) => a.kind === 'wrap-up-stale')).toBe(false);
  });

  it('excludes a session already claimed by merge-clean', () => {
    const triage = makeTriage({
      readyForReview: [
        makeSessionRow({ sessionId: 's1', git: makeGit({ isReadyToMerge: true }), restedAtIso: staleIso }),
      ],
    });
    const { visible } = deriveRecommendedActions(baseInput({ quickSessionTriage: triage }));
    expect(visible.some((a) => a.kind === 'merge-clean')).toBe(true);
    expect(visible.some((a) => a.kind === 'wrap-up-stale')).toBe(false);
  });

  it('excludes a session already claimed by rebase-behind', () => {
    const triage = makeTriage({
      readyForReview: [makeSessionRow({ sessionId: 's1', git: makeGit({ behind: 2 }), restedAtIso: staleIso })],
    });
    const { visible } = deriveRecommendedActions(baseInput({ quickSessionTriage: triage }));
    expect(visible.some((a) => a.kind === 'rebase-behind')).toBe(true);
    expect(visible.some((a) => a.kind === 'wrap-up-stale')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// blocking-finding
// ---------------------------------------------------------------------------

describe('blocking-finding', () => {
  it('fires one card per run for a pending blocking finding with a run_id', () => {
    const item = makeReviewItem({ id: 'f1', kind: 'finding', blocking: true, run_id: 'run-1', title: 'Bad thing' });
    const { visible } = deriveRecommendedActions(baseInput({ reviewItems: [item] }));
    const action = visible.find((a) => a.kind === 'blocking-finding') as BlockingFindingAction;
    expect(action).toBeDefined();
    expect(action.runId).toBe('run-1');
    expect(action.findingIds).toEqual(['f1']);
    expect(action.description).toBe('"Bad thing" is blocking this run.');
  });

  it('ignores non-blocking, non-finding, non-pending, and run-less items', () => {
    const items = [
      makeReviewItem({ id: 'f1', kind: 'finding', blocking: false, run_id: 'run-1' }),
      makeReviewItem({ id: 'f2', kind: 'decision', blocking: true, run_id: 'run-2' }),
      makeReviewItem({ id: 'f3', kind: 'finding', blocking: true, run_id: 'run-3', status: 'resolved' }),
      makeReviewItem({ id: 'f4', kind: 'finding', blocking: true, run_id: null }),
    ];
    const { visible } = deriveRecommendedActions(baseInput({ reviewItems: items }));
    expect(visible.some((a) => a.kind === 'blocking-finding')).toBe(false);
  });

  it('groups multiple findings on the same run into one card, headlining the newest', () => {
    const items = [
      makeReviewItem({ id: 'old', kind: 'finding', blocking: true, run_id: 'run-1', title: 'Old', created_at: '2026-06-01T00:00:00.000Z' }),
      makeReviewItem({ id: 'new', kind: 'finding', blocking: true, run_id: 'run-1', title: 'New', created_at: '2026-06-05T00:00:00.000Z' }),
    ];
    const { visible } = deriveRecommendedActions(baseInput({ reviewItems: items }));
    const actions = visible.filter((a) => a.kind === 'blocking-finding') as BlockingFindingAction[];
    expect(actions).toHaveLength(1);
    expect(actions[0].findingIds.sort()).toEqual(['new', 'old']);
    expect(actions[0].description).toBe('2 blocking findings need a decision, including "New".');
  });

  it('sorts multiple runs newest-run-first', () => {
    const items = [
      makeReviewItem({ id: 'a', kind: 'finding', blocking: true, run_id: 'run-old', created_at: '2026-06-01T00:00:00.000Z' }),
      makeReviewItem({ id: 'b', kind: 'finding', blocking: true, run_id: 'run-new', created_at: '2026-06-08T00:00:00.000Z' }),
    ];
    const { visible } = deriveRecommendedActions(baseInput({ reviewItems: items }));
    const actions = visible.filter((a) => a.kind === 'blocking-finding') as BlockingFindingAction[];
    expect(actions.map((a) => a.runId)).toEqual(['run-new', 'run-old']);
  });

  it('resurfaces after dismissal when a new finding lands on the same run', () => {
    const item = makeReviewItem({ id: 'f1', kind: 'finding', blocking: true, run_id: 'run-1' });
    const firstPass = deriveRecommendedActions(baseInput({ reviewItems: [item] }));
    const action = firstPass.visible.find((a) => a.kind === 'blocking-finding') as BlockingFindingAction;

    const dismissed = { [action.id]: action.signature };
    const stillDismissed = deriveRecommendedActions(
      baseInput({ reviewItems: [item], dismissedSignatures: dismissed }),
    );
    expect(stillDismissed.visible.some((a) => a.kind === 'blocking-finding')).toBe(false);

    const item2 = makeReviewItem({ id: 'f2', kind: 'finding', blocking: true, run_id: 'run-1' });
    const resurfaced = deriveRecommendedActions(
      baseInput({ reviewItems: [item, item2], dismissedSignatures: dismissed }),
    );
    expect(resurfaced.visible.some((a) => a.kind === 'blocking-finding')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// launch-sprint
// ---------------------------------------------------------------------------

describe('launch-sprint', () => {
  it('does not fire for fewer than 3 ready tasks', () => {
    const tasks = [readyTask('t1'), readyTask('t2')];
    const { visible } = deriveRecommendedActions(baseInput({ tasks }));
    expect(visible.some((a) => a.kind === 'launch-sprint')).toBe(false);
  });

  it('fires for 3+ ready tasks with no active sprint run', () => {
    const tasks = [readyTask('t1'), readyTask('t2'), readyTask('t3')];
    const { visible } = deriveRecommendedActions(baseInput({ tasks }));
    const action = visible.find((a) => a.kind === 'launch-sprint') as LaunchSprintAction;
    expect(action).toBeDefined();
    expect(action.taskIds.sort()).toEqual(['t1', 't2', 't3']);
    expect(action.title).toBe('Launch a sprint');
    expect(action.description).toBe('3 tasks are ready for development.');
  });

  it('counts ready tasks nested under an epic', () => {
    const child1 = readyTask('c1');
    const child2 = readyTask('c2');
    const child3 = readyTask('c3');
    const epic = makeTask({ id: 'epic-1', type: 'epic', children: [child1, child2, child3] });
    const { visible } = deriveRecommendedActions(baseInput({ tasks: [epic] }));
    expect(visible.some((a) => a.kind === 'launch-sprint')).toBe(true);
  });

  it('does not fire when the project has an active (non-terminal) sprint run', () => {
    const tasks = [readyTask('t1'), readyTask('t2'), readyTask('t3')];
    const activeRuns = [makeRun({ project_id: 1, workflowName: 'sprint', status: 'running' })];
    const { visible } = deriveRecommendedActions(baseInput({ tasks, activeRuns }));
    expect(visible.some((a) => a.kind === 'launch-sprint')).toBe(false);
  });

  it('fires when the project only has a TERMINAL sprint run', () => {
    const tasks = [readyTask('t1'), readyTask('t2'), readyTask('t3')];
    const activeRuns = [makeRun({ project_id: 1, workflowName: 'sprint', status: 'completed' })];
    const { visible } = deriveRecommendedActions(baseInput({ tasks, activeRuns }));
    expect(visible.some((a) => a.kind === 'launch-sprint')).toBe(true);
  });

  it('names the project when more than one project exists', () => {
    const tasks = [readyTask('t1', 2), readyTask('t2', 2), readyTask('t3', 2)];
    const projects = [
      { id: 1, name: 'Alpha' },
      { id: 2, name: 'Beta' },
    ];
    const { visible } = deriveRecommendedActions(baseInput({ tasks, projects }));
    const action = visible.find((a) => a.kind === 'launch-sprint') as LaunchSprintAction;
    expect(action.title).toBe('Launch a sprint for Beta');
  });
});

// ---------------------------------------------------------------------------
// launch-planner
// ---------------------------------------------------------------------------

describe('launch-planner', () => {
  it('fires for the highest-priority idea with an incomplete ledger and no active flow', () => {
    const idea = makeTask({ id: 'idea-1', type: 'idea', title: 'My idea', priority: 'P1' });
    const { visible } = deriveRecommendedActions(baseInput({ tasks: [idea] }));
    const action = visible.find((a) => a.kind === 'launch-planner') as LaunchPlannerAction;
    expect(action).toBeDefined();
    expect(action.ideaId).toBe('idea-1');
    expect(action.description).toBe('"My idea" still needs its idea spec or stories completed.');
  });

  it('does not fire when the idea-spec component is already complete', () => {
    const idea = makeTask({
      id: 'idea-1',
      type: 'idea',
      components: ideaComponents({ 'idea-spec': 'complete' }),
    });
    const { visible } = deriveRecommendedActions(baseInput({ tasks: [idea] }));
    expect(visible.some((a) => a.kind === 'launch-planner')).toBe(false);
  });

  it('does not fire when the stories component is already complete', () => {
    const idea = makeTask({ id: 'idea-1', type: 'idea', components: ideaComponents({ stories: 'complete' }) });
    const { visible } = deriveRecommendedActions(baseInput({ tasks: [idea] }));
    expect(visible.some((a) => a.kind === 'launch-planner')).toBe(false);
  });

  it('does not fire when the idea already has a live run association', () => {
    const idea = makeTask({
      id: 'idea-1',
      type: 'idea',
      inFlow: [{ agent: 'planner', runId: 'r1', stepId: null, runStatus: 'running', sessionId: null, sessionName: null }],
    });
    const { visible } = deriveRecommendedActions(baseInput({ tasks: [idea] }));
    expect(visible.some((a) => a.kind === 'launch-planner')).toBe(false);
  });

  it('picks the highest-priority eligible idea across candidates', () => {
    const low = makeTask({ id: 'idea-low', type: 'idea', priority: 'P4', title: 'Low' });
    const high = makeTask({ id: 'idea-high', type: 'idea', priority: 'P0', title: 'High' });
    const { visible } = deriveRecommendedActions(baseInput({ tasks: [low, high] }));
    const action = visible.find((a) => a.kind === 'launch-planner') as LaunchPlannerAction;
    expect(action.ideaId).toBe('idea-high');
  });

  it('excludes done, archived, and decomposed ideas from candidacy', () => {
    const done = makeTask({ id: 'i-done', type: 'idea', priority: 'P0', isDone: true });
    const archived = makeTask({ id: 'i-arch', type: 'idea', priority: 'P0', archived_at: '2026-01-01T00:00:00.000Z' });
    const decomposed = makeTask({ id: 'i-decomp', type: 'idea', priority: 'P0', decomposed_at: '2026-01-01T00:00:00.000Z' });
    const eligible = makeTask({ id: 'i-eligible', type: 'idea', priority: 'P6' });
    const { visible } = deriveRecommendedActions(baseInput({ tasks: [done, archived, decomposed, eligible] }));
    const action = visible.find((a) => a.kind === 'launch-planner') as LaunchPlannerAction;
    expect(action.ideaId).toBe('i-eligible');
  });
});

// ---------------------------------------------------------------------------
// capture-first-idea
// ---------------------------------------------------------------------------

describe('capture-first-idea', () => {
  it('fires when there are zero non-archived ideas', () => {
    const { visible } = deriveRecommendedActions(baseInput({ tasks: [] }));
    expect(visible.some((a) => a.kind === 'capture-first-idea')).toBe(true);
  });

  it('fires when the only existing idea is archived', () => {
    const archived = makeTask({ id: 'i1', type: 'idea', archived_at: '2026-01-01T00:00:00.000Z' });
    const { visible } = deriveRecommendedActions(baseInput({ tasks: [archived] }));
    expect(visible.some((a) => a.kind === 'capture-first-idea')).toBe(true);
  });

  it('does not fire when a non-archived idea exists', () => {
    const idea = makeTask({ id: 'i1', type: 'idea' });
    const { visible } = deriveRecommendedActions(baseInput({ tasks: [idea] }));
    expect(visible.some((a) => a.kind === 'capture-first-idea')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// run-launch-flow
// ---------------------------------------------------------------------------

describe('run-launch-flow', () => {
  it('fires for a project with a completely empty backlog', () => {
    const { visible } = deriveRecommendedActions(baseInput({ tasks: [] }));
    const action = visible.find((a) => a.kind === 'run-launch-flow') as RunLaunchFlowAction;
    expect(action).toBeDefined();
    expect(action.projectId).toBe(1);
    expect(action.title).toBe('Run the Launch flow');
  });

  it('does not fire when the project has any entity at all, even an archived one', () => {
    const archived = makeTask({ id: 't1', archived_at: '2026-01-01T00:00:00.000Z' });
    const { visible } = deriveRecommendedActions(baseInput({ tasks: [archived] }));
    expect(visible.some((a) => a.kind === 'run-launch-flow')).toBe(false);
  });

  it('counts nested epic children toward "not empty"', () => {
    const child = readyTask('c1');
    const epic = makeTask({ id: 'epic-1', type: 'epic', children: [child] });
    const { visible } = deriveRecommendedActions(baseInput({ tasks: [epic] }));
    expect(visible.some((a) => a.kind === 'run-launch-flow')).toBe(false);
  });

  it('names the project when more than one project exists', () => {
    const projects = [
      { id: 1, name: 'Alpha' },
      { id: 2, name: 'Beta' },
    ];
    const { visible } = deriveRecommendedActions(baseInput({ tasks: [], projects }));
    const actions = visible.filter((a) => a.kind === 'run-launch-flow') as RunLaunchFlowAction[];
    expect(actions).toHaveLength(2);
    expect(actions.find((a) => a.projectId === 1)?.title).toBe('Run the Launch flow for Alpha');
    expect(actions.find((a) => a.projectId === 2)?.title).toBe('Run the Launch flow for Beta');
  });

  it('shows both capture-first-idea and run-launch-flow when the whole backlog is empty', () => {
    const { visible } = deriveRecommendedActions(baseInput({ tasks: [] }));
    expect(visible.some((a) => a.kind === 'capture-first-idea')).toBe(true);
    expect(visible.some((a) => a.kind === 'run-launch-flow')).toBe(true);
  });

  it('does not fire for an established codebase, even with an empty backlog', () => {
    const projects = [{ id: 1, name: 'Alpha', established_repo: true }];
    const { visible } = deriveRecommendedActions(baseInput({ tasks: [], projects }));
    expect(visible.some((a) => a.kind === 'run-launch-flow')).toBe(false);
    // capture-first-idea is unaffected — an established repo can still have no ideas.
    expect(visible.some((a) => a.kind === 'capture-first-idea')).toBe(true);
  });

  it('still fires when repo maturity is unknown (established_repo absent)', () => {
    const projects = [{ id: 1, name: 'Alpha' }];
    const { visible } = deriveRecommendedActions(baseInput({ tasks: [], projects }));
    expect(visible.some((a) => a.kind === 'run-launch-flow')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Ranking + MAX_VISIBLE overflow
// ---------------------------------------------------------------------------

describe('ranking and overflow', () => {
  it('ranks group 1 (session triage) before group 2 (flow launches)', () => {
    const triage = makeTriage({
      needsInput: [makeSessionRow({ sessionId: 's1' })],
      readyForReview: [makeSessionRow({ sessionId: 's2', git: makeGit({ isReadyToMerge: true }) })],
    });
    const tasks = [readyTask('t1'), readyTask('t2'), readyTask('t3')];
    const { visible } = deriveRecommendedActions(baseInput({ quickSessionTriage: triage, tasks }));
    const kinds = visible.map((a) => a.kind);
    const lastGroup1Index = Math.max(kinds.indexOf('review-blocked'), kinds.indexOf('merge-clean'));
    const group2Index = kinds.indexOf('launch-sprint');
    expect(lastGroup1Index).toBeLessThan(group2Index);
  });

  it('caps visible at MAX_VISIBLE and reports the remainder as overflow', () => {
    const triage = makeTriage({
      needsInput: [makeSessionRow({ sessionId: 's1' })],
      readyForReview: [
        makeSessionRow({ sessionId: 's2', name: 'merge-me', git: makeGit({ isReadyToMerge: true }) }),
        makeSessionRow({ sessionId: 's3', name: 'rebase-me', git: makeGit({ behind: 2 }) }),
        makeSessionRow({
          sessionId: 's4',
          name: 'stale-me',
          restedAtIso: new Date(NOW - 100 * HOUR_MS).toISOString(),
        }),
      ],
    });
    const findings = [
      makeReviewItem({ id: 'f1', kind: 'finding', blocking: true, run_id: 'run-1' }),
      makeReviewItem({ id: 'f2', kind: 'finding', blocking: true, run_id: 'run-2' }),
    ];
    // A fully-complete, non-archived idea so neither launch-planner (ledger already
    // complete) nor capture-first-idea (an idea exists) also fires here — keeps the
    // triggered set limited to exactly the 7 cards this test counts on below.
    const doneIdea = makeTask({
      id: 'idea-1',
      type: 'idea',
      components: ideaComponents({ 'idea-spec': 'complete', stories: 'complete' }),
    });
    const tasks = [readyTask('t1'), readyTask('t2'), readyTask('t3'), doneIdea];

    const { visible, overflow } = deriveRecommendedActions(
      baseInput({ quickSessionTriage: triage, reviewItems: findings, tasks }),
    );

    // review-blocked, merge-clean, rebase-behind, wrap-up-stale, 2x blocking-finding,
    // launch-sprint = 7 triggered cards total (run-launch-flow does not fire since
    // the project already has entities).
    expect(visible).toHaveLength(MAX_VISIBLE);
    expect(overflow).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Dismissal filtering + resurfacing (generic, beyond blocking-finding above)
// ---------------------------------------------------------------------------

describe('dismissal filtering', () => {
  it('filters a dismissible card whose signature matches the stored dismissal', () => {
    const triage = makeTriage({
      readyForReview: [makeSessionRow({ sessionId: 's1', git: makeGit({ isReadyToMerge: true }) })],
    });
    const first = deriveRecommendedActions(baseInput({ quickSessionTriage: triage }));
    const action = first.visible.find((a) => a.kind === 'merge-clean') as MergeCleanAction;

    const second = deriveRecommendedActions(
      baseInput({ quickSessionTriage: triage, dismissedSignatures: { [action.id]: action.signature } }),
    );
    expect(second.visible.some((a) => a.kind === 'merge-clean')).toBe(false);
  });

  it('resurfaces a dismissed card once new evidence changes its signature', () => {
    const triage1 = makeTriage({
      readyForReview: [makeSessionRow({ sessionId: 's1', name: 'a', git: makeGit({ isReadyToMerge: true }) })],
    });
    const first = deriveRecommendedActions(baseInput({ quickSessionTriage: triage1 }));
    const action = first.visible.find((a) => a.kind === 'merge-clean') as MergeCleanAction;
    const dismissed = { [action.id]: action.signature };

    // A second session becomes ready to merge — new evidence, new signature.
    const triage2 = makeTriage({
      readyForReview: [
        makeSessionRow({ sessionId: 's1', name: 'a', git: makeGit({ isReadyToMerge: true }) }),
        makeSessionRow({ sessionId: 's2', name: 'b', git: makeGit({ isReadyToMerge: true }) }),
      ],
    });
    const second = deriveRecommendedActions(baseInput({ quickSessionTriage: triage2, dismissedSignatures: dismissed }));
    expect(second.visible.some((a) => a.kind === 'merge-clean')).toBe(true);
  });
});
