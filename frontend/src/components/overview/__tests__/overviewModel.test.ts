/**
 * Unit tests for the Project Overview page's pure derivations:
 * selectOverviewPageState (all six states + boundary cases), deriveOverviewBacklog
 * (stage tiles, top-idea sort, next-up grouping/eligibility/in-flight), and
 * deriveRecommendedActions (every trigger on/off, dismissal, fixed ordering) —
 * plus the small formatDaysSince / priorityTone / OVERVIEW_DISMISSED_KEY helpers.
 */
import { describe, it, expect } from 'vitest';
import {
  selectOverviewPageState,
  deriveOverviewBacklog,
  deriveRecommendedActions,
  formatDaysSince,
  priorityTone,
  OVERVIEW_DISMISSED_KEY,
  type OverviewBacklog,
} from '../overviewModel';
import type { BacklogTaskItem, BoardStage } from '../../../../../shared/types/tasks';
import type { WorkflowRunStats } from '../../../../../shared/types/insights';
import type { VerifyProjectSetupRow } from '../../../../../shared/types/visualVerification';

// ---------------------------------------------------------------------------
// Fixture builders (mirrors backlogSelectors.test.ts's `item`/`stage` style)
// ---------------------------------------------------------------------------

function stage(position: number, label: string, opts: Partial<BoardStage> = {}): BoardStage {
  return {
    id: opts.id ?? `s-${position}`,
    label,
    color_oklch: 'oklch(0.5 0.1 0)',
    hint: opts.hint ?? null,
    position,
    write_policy: opts.write_policy ?? 'asserted',
    is_terminal: opts.is_terminal ?? false,
    hidden_by_default: opts.hidden_by_default ?? false,
  };
}

/** The standard five-stage board: 1 Idea, 6 Ready, 7 In development, 9 Done, 10 Won't do. */
const STAGES: BoardStage[] = [
  stage(1, 'Idea'),
  stage(6, 'Ready for development'),
  stage(7, 'In development', { id: 's-7', write_policy: 'derived' }),
  stage(9, 'Done', { id: 's-9', is_terminal: true }),
  stage(10, "Won't do", { id: 's-10', is_terminal: true, hidden_by_default: true }),
];

function stageIdFor(position: number): string {
  const found = STAGES.find((s) => s.position === position);
  if (found === undefined) throw new Error(`no fixture stage at position ${position}`);
  return found.id;
}

let idCounter = 0;

function item(over: Partial<BacklogTaskItem> = {}): BacklogTaskItem {
  idCounter += 1;
  const n = idCounter;
  return {
    id: `id-${n}`,
    project_id: 1,
    type: 'task',
    ref: `TASK-${n}`,
    title: `Item ${n}`,
    summary: null,
    body: null,
    priority: 'P2',
    category: 'feature',
    executor: 'agent',
    repo: null,
    parent_epic_id: null,
    originating_idea_id: null,
    scope: null,
    board_id: 'board-1',
    stage_id: stageIdFor(6),
    archived_at: null,
    decomposed_at: null,
    approved_at: '2026-01-01T00:00:00.000Z',
    sort_order: null,
    version: 1,
    stage_position: 6,
    inFlow: [],
    awaitingReview: false,
    isDone: false,
    memberships: [],
    created_at: '2026-06-01T00:00:00Z',
    updated_at: '2026-06-01T00:00:00Z',
    ...over,
  };
}

/** A ready-for-development task (stage 6, approved, not archived — sprint-eligible). */
function readyTask(over: Partial<BacklogTaskItem> = {}): BacklogTaskItem {
  return item({ type: 'task', stage_position: 6, stage_id: stageIdFor(6), ...over });
}

/** A done task at the terminal Done stage. */
function doneTask(over: Partial<BacklogTaskItem> = {}): BacklogTaskItem {
  return item({
    type: 'task',
    stage_position: 9,
    stage_id: stageIdFor(9),
    isDone: true,
    ...over,
  });
}

/** An open (not done, not archived, not decomposed) idea. */
function openIdea(over: Partial<BacklogTaskItem> = {}): BacklogTaskItem {
  return item({
    type: 'idea',
    stage_position: 1,
    stage_id: stageIdFor(1),
    scope: null,
    ...over,
  });
}

function inFlowEntry(over: Partial<BacklogTaskItem['inFlow'][number]> = {}): BacklogTaskItem['inFlow'][number] {
  return {
    agent: 'sprint',
    runId: 'run-12345678',
    stepId: null,
    runStatus: 'running',
    sessionId: 'sess-1',
    sessionName: 'quick-1',
    ...over,
  };
}

// ---------------------------------------------------------------------------
// selectOverviewPageState
// ---------------------------------------------------------------------------

describe('selectOverviewPageState', () => {
  it('empty-new: no ideas, no tasks, codebase provably fresh', () => {
    expect(selectOverviewPageState({ items: [], codebaseFresh: true })).toBe('empty-new');
  });

  it('empty-new-existing: no ideas, no tasks, codebase NOT fresh', () => {
    expect(selectOverviewPageState({ items: [], codebaseFresh: false })).toBe('empty-new-existing');
  });

  it('empty-new-existing: unknown freshness (null) falls back to existing, never the fresh hero', () => {
    expect(selectOverviewPageState({ items: [], codebaseFresh: null })).toBe('empty-new-existing');
  });

  it('empty-ideas: open ideas exist, zero tasks (none pending, none done)', () => {
    const items = [openIdea(), openIdea({ priority: 'P0' })];
    expect(selectOverviewPageState({ items, codebaseFresh: null })).toBe('empty-ideas');
  });

  it('empty-drained: tasks exist but none are sprint-ready, at least one done, ideas remain', () => {
    const items = [doneTask(), openIdea()];
    expect(selectOverviewPageState({ items, codebaseFresh: null })).toBe('empty-drained');
  });

  it('empty-drained still fires when a non-ready pending task exists alongside the done one', () => {
    // A task sitting in the Idea column (not yet ready) does not count as
    // "sprint-ready", so the backlog still reads as drained.
    const notReadyYet = item({ type: 'task', stage_position: 1, stage_id: stageIdFor(1) });
    const items = [doneTask(), openIdea(), notReadyYet];
    expect(selectOverviewPageState({ items, codebaseFresh: null })).toBe('empty-drained');
  });

  it('empty-done: at least one done item, no open ideas, no pending tasks', () => {
    const items = [doneTask(), doneTask()];
    expect(selectOverviewPageState({ items, codebaseFresh: null })).toBe('empty-done');
  });

  it('boundary: done tasks exist AND ideas remain ⇒ empty-drained, never empty-done', () => {
    // Same shape as the empty-done case, but with an open idea added — the
    // idea backlog being non-empty must route to empty-drained instead.
    const items = [doneTask(), openIdea()];
    const result = selectOverviewPageState({ items, codebaseFresh: null });
    expect(result).toBe('empty-drained');
    expect(result).not.toBe('empty-done');
  });

  it('normal: a ready task exists alongside a done task and an open idea', () => {
    const items = [doneTask(), openIdea(), readyTask()];
    expect(selectOverviewPageState({ items, codebaseFresh: null })).toBe('normal');
  });

  it('normal: tasks exist, none done yet, none ready yet (still mid-plan), no open ideas', () => {
    // hasDoneTask is false, so neither empty-drained nor empty-done applies.
    const notReadyYet = item({ type: 'task', stage_position: 1, stage_id: stageIdFor(1) });
    expect(selectOverviewPageState({ items: [notReadyYet], codebaseFresh: null })).toBe('normal');
  });

  it('archived items are excluded from every count (defense in depth)', () => {
    const items = [doneTask({ archived_at: '2026-06-10T00:00:00Z' }), openIdea({ archived_at: '2026-06-10T00:00:00Z' })];
    // Both items archived ⇒ reads as truly empty, not empty-drained/-ideas.
    expect(selectOverviewPageState({ items, codebaseFresh: true })).toBe('empty-new');
  });

  it('a decomposed idea does not count as "open" for empty-ideas/empty-done', () => {
    const decomposed = openIdea({ decomposed_at: '2026-06-05T00:00:00Z' });
    // No tasks, only a decomposed (non-open) idea ⇒ NOT empty-ideas (that
    // requires an open idea) — falls through to the totally-empty check,
    // but hasAnyIdea is true here so it lands on 'normal' (unclassified).
    expect(selectOverviewPageState({ items: [decomposed], codebaseFresh: null })).toBe('normal');
  });

  it('tasks nested under an epic count toward hasAnyTask / readyPendingCount', () => {
    const epicChild = readyTask();
    const epic = item({ type: 'epic', children: [epicChild] });
    expect(selectOverviewPageState({ items: [epic], codebaseFresh: null })).toBe('normal');
  });
});

// ---------------------------------------------------------------------------
// deriveOverviewBacklog
// ---------------------------------------------------------------------------

describe('deriveOverviewBacklog', () => {
  it('stageTiles bucket by position and EXCLUDE hidden_by_default stages', () => {
    const tasks = [readyTask(), doneTask()];
    const result = deriveOverviewBacklog(tasks, STAGES);
    const stageIds = result.stageTiles.map((t) => t.stageId);
    expect(stageIds).not.toContain(stageIdFor(10)); // Won't do is hidden_by_default
    expect(stageIds).toContain(stageIdFor(6));
    expect(stageIds).toContain(stageIdFor(9));
    const readyTile = result.stageTiles.find((t) => t.stageId === stageIdFor(6));
    expect(readyTile?.count).toBe(1);
    const doneTile = result.stageTiles.find((t) => t.stageId === stageIdFor(9));
    expect(doneTile?.count).toBe(1);
  });

  it('stageTiles carry the stage label/color/hint through verbatim', () => {
    const result = deriveOverviewBacklog([], STAGES);
    const readyTile = result.stageTiles.find((t) => t.stageId === stageIdFor(6));
    expect(readyTile).toMatchObject({ label: 'Ready for development', color: 'oklch(0.5 0.1 0)', hint: null });
  });

  it('counts reuse deriveCounts (top-level items only, all types)', () => {
    const solo = readyTask();
    const idea = openIdea();
    const epic = item({ type: 'epic', children: [readyTask()] });
    const result = deriveOverviewBacklog([solo, idea, epic], STAGES);
    expect(result.counts.items).toBe(3);
    expect(result.counts.solo).toBe(1);
    expect(result.counts.ideas).toBe(1);
    expect(result.counts.epics).toBe(1);
  });

  it('topIdeas: sorted by priority ascending (P0 first), then updated_at descending within a tier', () => {
    const p2Old = openIdea({ title: 'p2-old', priority: 'P2', updated_at: '2026-01-01T00:00:00Z' });
    const p0 = openIdea({ title: 'p0', priority: 'P0', updated_at: '2026-01-01T00:00:00Z' });
    const p2New = openIdea({ title: 'p2-new', priority: 'P2', updated_at: '2026-02-01T00:00:00Z' });
    const result = deriveOverviewBacklog([p2Old, p0, p2New], STAGES);
    expect(result.topIdeas.map((i) => i.title)).toEqual(['p0', 'p2-new', 'p2-old']);
  });

  it('topIdeas excludes done, archived, and decomposed ideas', () => {
    const done = openIdea({ isDone: true });
    const archived = openIdea({ archived_at: '2026-06-10T00:00:00Z' });
    const decomposed = openIdea({ decomposed_at: '2026-06-10T00:00:00Z' });
    const open = openIdea({ title: 'still open' });
    const result = deriveOverviewBacklog([done, archived, decomposed, open], STAGES);
    expect(result.topIdeas.map((i) => i.title)).toEqual(['still open']);
  });

  it('topIdeas surfaces inFlow / inFlowLabel from the FIRST inFlow entry', () => {
    const idea = openIdea({
      inFlow: [inFlowEntry({ agent: 'planner', sessionName: 'my-session' })],
    });
    const result = deriveOverviewBacklog([idea], STAGES);
    expect(result.topIdeas[0].inFlow).toBe(true);
    expect(result.topIdeas[0].inFlowLabel).toBe('planner · my-session');
  });

  it('topIdeas inFlowLabel falls back to a short run id when the session is unresolved', () => {
    const idea = openIdea({ inFlow: [inFlowEntry({ sessionName: null, runId: 'abcdefgh12345678' })] });
    const result = deriveOverviewBacklog([idea], STAGES);
    expect(result.topIdeas[0].inFlowLabel).toBe('sprint · abcdefgh');
  });

  it('nextUp groups solo sprint-eligible tasks under a trailing "No epic" group', () => {
    const solo = readyTask({ title: 'solo task' });
    const result = deriveOverviewBacklog([solo], STAGES);
    expect(result.nextUp).toHaveLength(1);
    expect(result.nextUp[0]).toMatchObject({ epicId: null, epicTitle: 'No epic', readyCount: 1, totalCount: 1 });
    expect(result.nextUp[0].tasks[0]).toMatchObject({ title: 'solo task', eligible: true, inFlow: false });
  });

  it('nextUp groups epic-owned tasks under their parent epic, epic groups before "No epic"', () => {
    const child = readyTask({ title: 'epic child' });
    const epic = item({ type: 'epic', id: 'epic-1', ref: 'EPIC-1', title: 'The Epic', children: [child] });
    const solo = readyTask({ title: 'solo task' });
    const result = deriveOverviewBacklog([epic, solo], STAGES);
    expect(result.nextUp).toHaveLength(2);
    expect(result.nextUp[0]).toMatchObject({ epicId: 'epic-1', epicTitle: 'The Epic', totalCount: 1 });
    expect(result.nextUp[1]).toMatchObject({ epicId: null, epicTitle: 'No epic' });
  });

  it('nextUp EXCLUDES a pending (approved_at null), archived, or terminal-stage task', () => {
    const pending = readyTask({ approved_at: null });
    const archived = readyTask({ archived_at: '2026-06-10T00:00:00Z' });
    const done = doneTask();
    const wontDo = item({ type: 'task', stage_position: 10, stage_id: stageIdFor(10) });
    const eligible = readyTask({ title: 'the only eligible one' });
    const result = deriveOverviewBacklog([pending, archived, done, wontDo, eligible], STAGES);
    const allTitles = result.nextUp.flatMap((g) => g.tasks.map((t) => t.title));
    expect(allTitles).toEqual(['the only eligible one']);
  });

  it('nextUp EXCLUDES a task still in the Idea column (position < 6) even if approved', () => {
    const notReady = item({ type: 'task', stage_position: 1, stage_id: stageIdFor(1) });
    const result = deriveOverviewBacklog([notReady], STAGES);
    expect(result.nextUp).toHaveLength(0);
  });

  it('nextUp INCLUDES an in-flight task (position 7, In development) but marks it inFlow and drops it from readyCount', () => {
    const inFlightTask = readyTask({
      title: 'already running',
      stage_position: 7,
      stage_id: stageIdFor(7),
      inFlow: [inFlowEntry()],
    });
    const readyOne = readyTask({ title: 'ready one' });
    const result = deriveOverviewBacklog([inFlightTask, readyOne], STAGES);
    expect(result.nextUp).toHaveLength(1); // both fall into "No epic"
    const group = result.nextUp[0];
    expect(group.totalCount).toBe(2);
    expect(group.readyCount).toBe(1);
    const inFlightEntry = group.tasks.find((t) => t.title === 'already running');
    expect(inFlightEntry?.inFlow).toBe(true);
    expect(inFlightEntry?.eligible).toBe(true);
  });

  it('an epic whose only child is ineligible produces no group at all', () => {
    const ineligibleChild = readyTask({ approved_at: null });
    const epic = item({ type: 'epic', id: 'epic-2', title: 'Empty epic', children: [ineligibleChild] });
    const result = deriveOverviewBacklog([epic], STAGES);
    expect(result.nextUp).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// deriveRecommendedActions
// ---------------------------------------------------------------------------

const EMPTY_BACKLOG: OverviewBacklog = {
  counts: { items: 0, epics: 0, solo: 0, ideas: 0, done: 0, inFlow: 0, awaitingReview: 0 },
  stageTiles: [],
  topIdeas: [],
  nextUp: [],
};

function baseRecInput(over: Partial<Parameters<typeof deriveRecommendedActions>[0]> = {}): Parameters<
  typeof deriveRecommendedActions
>[0] {
  return {
    backlog: EMPTY_BACKLOG,
    workflowStats: [],
    verifySetup: provenSetupRow(),
    trackerConflictCount: 0,
    trackerProvider: null,
    trackerLastSyncAt: null,
    dismissed: {},
    nowIso: '2026-06-15T00:00:00.000Z',
    ...over,
  };
}

/** The ACTIVE partition — what the section renders as cards (most tests only care about this). */
function deriveActive(
  input: Parameters<typeof deriveRecommendedActions>[0],
): ReturnType<typeof deriveRecommendedActions>['active'] {
  return deriveRecommendedActions(input).active;
}

function provenSetupRow(over: Partial<VerifyProjectSetupRow> = {}): VerifyProjectSetupRow {
  return { projectId: 1, status: 'proven', provenModalities: ['web'], hasLaneDerivedRunbook: false, ...over };
}

function workflowStats(over: Partial<WorkflowRunStats>): WorkflowRunStats {
  return {
    workflowId: 'wf-1',
    workflowName: 'Sprint',
    projectId: 1,
    totalRuns: 0,
    activeRuns: 0,
    completedRuns: 0,
    failedRuns: 0,
    canceledRuns: 0,
    mergedRuns: 0,
    dismissedRuns: 0,
    nullOutcomeRuns: 0,
    interruptedRuns: 0,
    errorRatePct: 0,
    avgDurationMs: null,
    lastRunAt: null,
    ...over,
  };
}

const READY_GROUP: OverviewBacklog['nextUp'][number] = {
  epicId: null,
  epicTitle: 'No epic',
  readyCount: 2,
  totalCount: 2,
  tasks: [
    { id: 't1', title: 'a', priority: 'P2', category: 'feature', eligible: true, inFlow: false },
    { id: 't2', title: 'b', priority: 'P2', category: 'feature', eligible: true, inFlow: false },
  ],
};

describe('deriveRecommendedActions', () => {
  it('produces nothing when every trigger is off and verify-setup is already proven', () => {
    const result = deriveActive(baseRecInput());
    expect(result).toEqual([]);
  });

  it('launch-sprint fires when readyCount > 0, with a pluralized body', () => {
    const result = deriveActive(
      baseRecInput({ backlog: { ...EMPTY_BACKLOG, nextUp: [READY_GROUP] } }),
    );
    const action = result.find((a) => a.id === 'launch-sprint');
    expect(action).toBeDefined();
    expect(action?.body).toContain('2 tasks are Ready for development');
    expect(action?.ctaKind).toBe('primary');
  });

  it('launch-sprint uses singular grammar for exactly one ready task', () => {
    const oneReady: OverviewBacklog['nextUp'][number] = { ...READY_GROUP, readyCount: 1, totalCount: 1 };
    const result = deriveActive(baseRecInput({ backlog: { ...EMPTY_BACKLOG, nextUp: [oneReady] } }));
    const action = result.find((a) => a.id === 'launch-sprint');
    expect(action?.body).toBe('1 task is Ready for development — select it below and batch it into a sprint.');
  });

  it('launch-sprint does NOT fire when tasks are eligible but all in-flight (readyCount 0)', () => {
    const allInFlight: OverviewBacklog['nextUp'][number] = { ...READY_GROUP, readyCount: 0, totalCount: 2 };
    const result = deriveActive(baseRecInput({ backlog: { ...EMPTY_BACKLOG, nextUp: [allInFlight] } }));
    expect(result.find((a) => a.id === 'launch-sprint')).toBeUndefined();
  });

  it('launch-planner fires for the top open idea, quoting its title', () => {
    const backlog: OverviewBacklog = {
      ...EMPTY_BACKLOG,
      topIdeas: [
        { id: 'i1', ref: 'IDEA-1', title: 'Dark mode', scope: null, priority: 'P1', inFlow: false, inFlowLabel: null },
      ],
    };
    const result = deriveActive(baseRecInput({ backlog }));
    const action = result.find((a) => a.id === 'launch-planner');
    expect(action?.body).toBe('"Dark mode" is the top idea with no spec or stories yet — plan it before the next sprint.');
    expect(action?.ctaKind).toBe('secondary');
  });

  it('launch-planner does not fire when there are no open ideas', () => {
    const result = deriveActive(baseRecInput());
    expect(result.find((a) => a.id === 'launch-planner')).toBeUndefined();
  });

  it('run-compound fires when Sprint mergedRuns >= 3 and Compound has never run', () => {
    const result = deriveActive(
      baseRecInput({ workflowStats: [workflowStats({ workflowName: 'Sprint', mergedRuns: 3 })] }),
    );
    const action = result.find((a) => a.id === 'run-compound');
    expect(action?.body).toContain('3 sprint runs merged and Compound has never run');
  });

  it('run-compound fires and cites days-since when Compound has run before', () => {
    const result = deriveActive(
      baseRecInput({
        nowIso: '2026-06-15T00:00:00.000Z',
        workflowStats: [
          workflowStats({ workflowName: 'Sprint', mergedRuns: 5 }),
          workflowStats({ workflowId: 'wf-2', workflowName: 'Compound', lastRunAt: '2026-06-10T00:00:00.000Z' }),
        ],
      }),
    );
    const action = result.find((a) => a.id === 'run-compound');
    expect(action?.body).toBe('5 sprint runs merged since Compound last ran (5 days ago) — run it to consolidate learnings.');
  });

  it('run-compound does NOT fire below the merged-run threshold', () => {
    const result = deriveActive(
      baseRecInput({ workflowStats: [workflowStats({ workflowName: 'Sprint', mergedRuns: 2 })] }),
    );
    expect(result.find((a) => a.id === 'run-compound')).toBeUndefined();
  });

  it('verify-setup fires when the row is undefined (never registered)', () => {
    const result = deriveActive(baseRecInput({ verifySetup: undefined }));
    const action = result.find((a) => a.id === 'verify-setup');
    expect(action).toBeDefined();
    expect(action?.ctaKind).toBe('primary');
  });

  it('verify-setup fires when status is "unproven" or "none"', () => {
    const unproven = deriveActive(
      baseRecInput({ verifySetup: provenSetupRow({ status: 'unproven', provenModalities: [] }) }),
    );
    expect(unproven.find((a) => a.id === 'verify-setup')).toBeDefined();

    const none = deriveActive(
      baseRecInput({ verifySetup: provenSetupRow({ status: 'none', provenModalities: [] }) }),
    );
    expect(none.find((a) => a.id === 'verify-setup')).toBeDefined();
  });

  it('verify-setup does NOT fire when status is "proven"', () => {
    const result = deriveActive(baseRecInput());
    expect(result.find((a) => a.id === 'verify-setup')).toBeUndefined();
  });

  it('tracker-conflicts fires with provider label and last-sync hint', () => {
    const result = deriveActive(
      baseRecInput({
        trackerConflictCount: 3,
        trackerProvider: 'linear',
        trackerLastSyncAt: '2026-06-14T00:00:00.000Z',
        nowIso: '2026-06-15T00:00:00.000Z',
      }),
    );
    const action = result.find((a) => a.id === 'tracker-conflicts');
    expect(action?.body).toBe('3 conflicts need review in Linear (last synced 1 day ago).');
    expect(action?.ctaKind).toBe('secondary');
  });

  it('tracker-conflicts uses singular grammar for exactly one conflict, and "never synced" when unset', () => {
    const result = deriveActive(
      baseRecInput({ trackerConflictCount: 1, trackerProvider: 'dart', trackerLastSyncAt: null }),
    );
    const action = result.find((a) => a.id === 'tracker-conflicts');
    expect(action?.body).toBe('1 conflict needs review in Dart (never synced).');
  });

  it('tracker-conflicts does NOT fire when conflict count is 0', () => {
    const result = deriveActive(baseRecInput());
    expect(result.find((a) => a.id === 'tracker-conflicts')).toBeUndefined();
  });

  it('a dismissal suppresses the card while its fingerprint still matches', () => {
    const input = baseRecInput({
      backlog: { ...EMPTY_BACKLOG, nextUp: [READY_GROUP] },
      trackerConflictCount: 1,
      trackerProvider: 'plane',
    });
    // Dismiss under the CURRENT state: capture the live fingerprints.
    const live = deriveActive(input);
    const dismissed = Object.fromEntries(live.map((a) => [a.id, a.fingerprint]));
    const result = deriveRecommendedActions({ ...input, dismissed });
    expect(result.active.map((a) => a.id)).toEqual([]);
    // The suppressed cards still QUALIFY, so they land in the dismissed
    // partition (what "View dismissed" renders).
    expect(result.dismissed.map((a) => a.id)).toEqual(['launch-sprint', 'tracker-conflicts']);
  });

  it('a dismissed card REAPPEARS when its trigger state changes (stale fingerprint)', () => {
    const input = baseRecInput({
      backlog: { ...EMPTY_BACKLOG, nextUp: [READY_GROUP] },
      trackerConflictCount: 1,
      trackerProvider: 'plane',
    });
    const live = deriveActive(input);
    const dismissed = Object.fromEntries(live.map((a) => [a.id, a.fingerprint]));
    // A new task lands Ready and a second conflict appears — both fingerprints move.
    const moved = deriveActive({
      ...input,
      backlog: {
        ...EMPTY_BACKLOG,
        nextUp: [
          {
            ...READY_GROUP,
            readyCount: 3,
            totalCount: 3,
            tasks: [
              ...READY_GROUP.tasks,
              { id: 't3', title: 'c', priority: 'P2', category: 'feature', eligible: true, inFlow: false },
            ],
          },
        ],
      },
      trackerConflictCount: 2,
      dismissed,
    });
    expect(moved.map((a) => a.id)).toEqual(['launch-sprint', 'tracker-conflicts']);
  });

  it('orders active actions launch-sprint, launch-planner, run-compound, verify-setup, tracker-conflicts', () => {
    const result = deriveActive(
      baseRecInput({
        backlog: {
          ...EMPTY_BACKLOG,
          nextUp: [READY_GROUP],
          topIdeas: [
            { id: 'i1', ref: 'IDEA-1', title: 'X', scope: null, priority: 'P1', inFlow: false, inFlowLabel: null },
          ],
        },
        workflowStats: [workflowStats({ workflowName: 'Sprint', mergedRuns: 4 })],
        verifySetup: undefined,
        trackerConflictCount: 2,
        trackerProvider: 'linear',
      }),
    );
    expect(result.map((a) => a.id)).toEqual([
      'launch-sprint',
      'launch-planner',
      'run-compound',
      'verify-setup',
      'tracker-conflicts',
    ]);
  });
});

// ---------------------------------------------------------------------------
// formatDaysSince
// ---------------------------------------------------------------------------

describe('formatDaysSince', () => {
  it('returns "never" for a null timestamp', () => {
    expect(formatDaysSince('2026-06-15T00:00:00.000Z', null)).toBe('never');
  });

  it('returns "today" for the same day', () => {
    expect(formatDaysSince('2026-06-15T12:00:00.000Z', '2026-06-15T00:00:00.000Z')).toBe('today');
  });

  it('returns "1 day ago" for exactly one day', () => {
    expect(formatDaysSince('2026-06-15T00:00:00.000Z', '2026-06-14T00:00:00.000Z')).toBe('1 day ago');
  });

  it('returns "N days ago" for multiple days', () => {
    expect(formatDaysSince('2026-06-15T00:00:00.000Z', '2026-06-01T00:00:00.000Z')).toBe('14 days ago');
  });

  it('returns "never" for a malformed timestamp rather than throwing or printing NaN', () => {
    expect(formatDaysSince('2026-06-15T00:00:00.000Z', 'not-a-date')).toBe('never');
  });

  it('clamps a future "then" (clock skew) to "today" rather than a negative day count', () => {
    expect(formatDaysSince('2026-06-01T00:00:00.000Z', '2026-06-15T00:00:00.000Z')).toBe('today');
  });
});

// ---------------------------------------------------------------------------
// priorityTone
// ---------------------------------------------------------------------------

describe('priorityTone', () => {
  it('P0 is red, P1 is amber, P2-P6 are neutral', () => {
    expect(priorityTone('P0')).toBe('red');
    expect(priorityTone('P1')).toBe('amber');
    expect(priorityTone('P2')).toBe('neutral');
    expect(priorityTone('P3')).toBe('neutral');
    expect(priorityTone('P4')).toBe('neutral');
    expect(priorityTone('P5')).toBe('neutral');
    expect(priorityTone('P6')).toBe('neutral');
  });
});

// ---------------------------------------------------------------------------
// OVERVIEW_DISMISSED_KEY
// ---------------------------------------------------------------------------

describe('OVERVIEW_DISMISSED_KEY', () => {
  it('is namespaced per project id, under the cyboflow. prefix convention', () => {
    expect(OVERVIEW_DISMISSED_KEY(1)).toBe('cyboflow.projectOverview.dismissed.1');
    expect(OVERVIEW_DISMISSED_KEY(42)).toBe('cyboflow.projectOverview.dismissed.42');
    expect(OVERVIEW_DISMISSED_KEY(1)).not.toBe(OVERVIEW_DISMISSED_KEY(2));
  });
});
