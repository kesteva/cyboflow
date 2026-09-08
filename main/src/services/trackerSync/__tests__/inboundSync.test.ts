/**
 * Unit tests for main/src/services/trackerSync/inboundSync.ts — the inbound
 * half of the tracker-sync engine (tracker -> cyboflow).
 *
 * Wiring: a REAL temp-file DB through the full migration chain (same technique
 * as migration093.test.ts / store.test.ts) with the project's default board
 * seeded, a REAL TaskChangeRouter over that DB (so idea creation, stage moves
 * and the archive toggle actually land, refs and entity_events included), and
 * a fake TrackerAdapter serving canned issues. Nothing is mocked below the
 * adapter seam.
 *
 * Covers, per the task brief:
 *   - fresh import: an idea with the provenance footer, a link, and a baseline;
 *     the mapped stage is applied and the compound cursor advances.
 *   - overlap-window dedup: a second pass re-delivers the same issue and the
 *     compound cursor drops it (no duplicate idea).
 *   - remote-only change: applied locally, baseline advances.
 *   - both-changed content field, AUTO: remote wins + an already-resolved
 *     conflict row records the override.
 *   - both-changed content field, MANUAL: an OPEN conflict row, nothing
 *     applied, baseline unchanged, and the next pass skips the item.
 *   - conflict payloads: a STAGE row carries the remote's RAW state id and
 *     write-back group (its `remote_value` is only the mapped board stage), so
 *     accepting the LOCAL side later has something true to stamp.
 *   - both-changed STAGE, AUTO: local wins (nothing applied) and the override
 *     is recorded as 'auto-local'.
 *   - selection_mode 'assignee' and 'manual' filtering of fresh imports.
 *   - remote archive: local archive + orphaned link in Auto, open conflict in
 *     Manual.
 *   - import crash recovery: a pass killed between the create and the link
 *     write adopts the half-imported idea instead of duplicating it.
 *   - the cross-scope duplicate guard: an issue a SIBLING mapping on the same
 *     tracker identity already links is skipped permanently (the cursor moves),
 *     while another workspace claims nothing and a half-import of this
 *     connection's own is still repaired ahead of the guard.
 *   - deletion sweep in both conflict modes, including the scope-exit case —
 *     an issue absent from the SCOPED id listing but still alive on the point
 *     lookup is out of scope, not deleted.
 *   - echo suppression: an unresolved outbox row halts the batch and the
 *     cursor never advances past the blocked issue (by external_id, by the
 *     create path's client_key, and by the recovery MARKER a lost create's
 *     child carries when the provider minted its own id) — while a marker from
 *     an already-settled row holds nothing.
 *   - inbound changes never echo back OUTBOUND: the real writeBack listener is
 *     subscribed to the real taskChangeEvents (the way TrackerSyncService wires
 *     it) and must stay silent for provider-authored stage moves while still
 *     firing for local ones.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseService } from '../../../database/database';
import { TASK_ALL_CHANNEL, TaskChangeRouter, taskChangeEvents } from '../../../orchestrator/taskChangeRouter';
import { dbAdapter } from '../../../orchestrator/__test_fixtures__/dbAdapter';
import type { EntityCategory, Priority, TaskChangedEvent } from '../../../../../shared/types/tasks';
import type {
  TrackerIssue,
  TrackerSourceNarrow,
  TrackerSourceSelection,
  TrackerGroupTree,
  TrackerSourceTree,
  TrackerState,
  TrackerWorkspaceIdentity,
} from '../../../../../shared/types/trackerSync';
import type { TrackerAdapter, TrackerAdapterCapabilities, TrackerFieldOptionsRaw} from '../adapterTypes';
import type { TrackerConflictRow, TrackerConnectionRow, TrackerOutboxRow } from '../../../database/models';
import {
  insertConnection,
  getConnection,
  getLinkByExternal,
  upsertLink,
  enqueueOutbox,
  updateBaseline,
  updateConnectionSettings,
  type NewConnectionRow,
} from '../store';
import { createWriteBackListener, type WriteBackListener } from '../writeBack';
import {
  runInboundSync,
  runDeletionSweep,
  type EntityWriteRouter,
  type InboundSweepReport,
  type InboundSyncDeps,
  type ReviewFindingRouter,
  type TrackerBaseline,
  type TrackerConflictPayload,
} from '../inboundSync';
import type { TaskChange } from '../../../orchestrator/taskChangeRouter';
import type { ReviewItemCreate } from '../../../orchestrator/reviewItemRouter';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const STAGE = {
  idea: 'stage-board-1-default-1',
  ready: 'stage-board-1-default-6',
  done: 'stage-board-1-default-9',
  wontdo: 'stage-board-1-default-10',
};

const STATES: TrackerState[] = [
  { id: 'st-triage', name: 'Triage', color: null, group: 'triage' },
  { id: 'st-backlog', name: 'Backlog', color: null, group: 'backlog' },
  { id: 'st-todo', name: 'Todo', color: null, group: 'unstarted' },
  { id: 'st-progress', name: 'In Progress', color: null, group: 'started' },
  { id: 'st-done', name: 'Done', color: null, group: 'completed' },
  { id: 'st-canceled', name: 'Canceled', color: null, group: 'cancelled' },
];

const SOURCE: TrackerSourceSelection = { containerId: 'team-1', narrowId: 'all', narrowKind: 'all' };

/**
 * Canned-issue TrackerAdapter. Only the four read methods the inbound pass
 * uses are implemented; the write/wizard methods throw so an accidental call
 * fails loudly instead of silently returning undefined.
 */
class FakeAdapter implements TrackerAdapter {
  readonly provider = 'linear' as const;
  readonly capabilities: TrackerAdapterCapabilities = {
    nativeParentAutoClose: true,
    selfHostedBaseUrl: false,
    idempotentCreate: true,
    contentWrite: { title: true, description: true, priority: true, category: false },
    archive: 'trash',
    requiresIdReconciliation: false,
    guardedUpdates: false,
  };

  issues: TrackerIssue[] = [];
  states: TrackerState[] = STATES;
  /**
   * What the pass seeds its priority/category mappings from. Defaults to
   * Linear's fixed scale (this adapter's provider); a Dart-shaped test swaps in
   * a live `/config` list.
   */
  fieldOptions: TrackerFieldOptionsRaw = { priorities: ['0', '1', '2', '3', '4'], categories: null };
  /** Overrides the deletion sweep's id set; null = derive it from `issues`. */
  remoteIds: string[] | null = null;
  /**
   * The selection-INDEPENDENT point-lookup table behind getIssue. Deliberately
   * NOT backed by `issues`: an id absent here reads as hard-deleted, which is
   * what the sweep's deletion tests mean, while a scope-exit test puts the
   * still-alive issue in here and out of `remoteIds`.
   */
  issuesById = new Map<string, TrackerIssue>();
  /** Every `sinceIso` listIssues was called with, in order. */
  sinceCalls: Array<string | undefined> = [];

  async validateCredentials(): Promise<TrackerWorkspaceIdentity> {
    throw new Error('not used');
  }
  async listGroups(): Promise<TrackerGroupTree> {
    return { sections: [] };
  }
  async listContainers(): Promise<TrackerSourceTree> {
    throw new Error('not used');
  }
  async listNarrows(): Promise<TrackerSourceNarrow[]> {
    throw new Error('not used');
  }
  async listStates(): Promise<TrackerState[]> {
    return this.states;
  }
  async listFieldOptions(): Promise<TrackerFieldOptionsRaw> {
    return this.fieldOptions;
  }
  async listIssues(_selection: TrackerSourceSelection, sinceIso?: string): Promise<TrackerIssue[]> {
    this.sinceCalls.push(sinceIso);
    return this.issues;
  }
  async listIssueIds(): Promise<string[]> {
    return this.remoteIds ?? this.issues.map((i) => i.externalId);
  }
  async getIssue(externalId: string): Promise<TrackerIssue | null> {
    return this.issuesById.get(externalId) ?? null;
  }
  async createSubIssue(): Promise<TrackerIssue> {
    throw new Error('not used');
  }
  async createIssue(): Promise<TrackerIssue> {
    throw new Error('not used');
  }
  async updateIssueState(): Promise<void> {
    throw new Error('not used');
  }
  async updateIssueContent(): Promise<TrackerIssue | null> {
    throw new Error('not used');
  }
  async archiveIssue(): Promise<void> {
    throw new Error('not used');
  }
}

/**
 * A real TaskChangeRouter behind a kill switch, so a test can end the pass at
 * either of the import's two un-transacted seams: right AFTER the create
 * commits (the create -> link window the provenance marker exists to recover)
 * and INSTEAD of the follow-up stage move (the link -> placement window).
 */
class CrashingRouter implements EntityWriteRouter {
  /** Throw once the create has already landed in sqlite. */
  crashAfterCreate = false;
  /** Throw before a stage move is applied. */
  crashOnStageMove = false;

  constructor(private readonly inner: TaskChangeRouter) {}

  async applyChange(projectId: number, change: TaskChange): Promise<{ taskId: string }> {
    if (this.crashOnStageMove && change.taskId !== undefined && change.stageId !== undefined) {
      throw new Error('simulated crash: stage move');
    }
    const result = await this.inner.applyChange(projectId, change);
    if (this.crashAfterCreate && change.taskId === undefined) {
      throw new Error('simulated crash: after create');
    }
    return result;
  }
}

/**
 * Captures what an Auto-mode override files on the review-inbox chokepoint. A
 * fake rather than a real ReviewItemRouter: these cases are about WHAT the
 * merge reports, not about how review_items rows are written.
 */
class FakeReviewRouter implements ReviewFindingRouter {
  readonly created: ReviewItemCreate[] = [];
  readonly projectIds: number[] = [];
  /** Scripted failure — filing an audit record must never sink the pass. */
  fail: Error | null = null;

  async applyReviewItem(
    projectId: number,
    change: ReviewItemCreate,
  ): Promise<{ reviewItemId: string }> {
    if (this.fail !== null) throw this.fail;
    this.projectIds.push(projectId);
    this.created.push(change);
    return { reviewItemId: `rvw_${this.created.length}` };
  }
}

function makeIssue(overrides: Partial<TrackerIssue> = {}): TrackerIssue {
  return {
    externalId: 'ext-1',
    identifier: 'CORE-142',
    title: 'Ship the tracker sync',
    description: 'Two-way sync with Linear.',
    url: 'https://linear.app/acme/issue/CORE-142',
    stateId: 'st-backlog',
    assignee: null,
    estimate: null,
    parentExternalId: null,
    updatedAt: '2026-07-30T10:00:00.000Z',
    archivedAt: null,
    // Linear's '3' (Medium) — the token the default mapping round-trips with
    // the P2 that every entity this suite creates carries, so an issue nobody
    // overrode never produces a priority diff.
    priority: '3',
    category: null,
    recoveryClientKey: null,
    ...overrides,
  };
}

let tmpDir: string;
let svc: DatabaseService;
let raw: Database.Database;
let router: TaskChangeRouter;
let adapter: FakeAdapter;
let deps: InboundSyncDeps;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'cyboflow-trackersync-inbound-'));
  svc = new DatabaseService(join(tmpDir, 'test.db'));
  svc.initialize();
  raw = svc.getDb();
  raw.prepare('INSERT INTO projects (id, name, path) VALUES (1, ?, ?)').run('Proj 1', '/tmp/p1');
  svc.seedDefaultBoard(1);
  router = new TaskChangeRouter(dbAdapter(raw));
  adapter = new FakeAdapter();
  deps = { db: raw, adapter, router, nowIso: () => '2026-07-30T12:00:00.000Z' };
});

afterEach(() => {
  raw.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

function makeConnection(overrides: Partial<NewConnectionRow> = {}): TrackerConnectionRow {
  return insertConnection(raw, {
    id: 'conn-1',
    project_id: 1,
    provider: 'linear',
    status: 'active',
    workspace_id: 'ws-1',
    workspace_name: 'Acme',
    actor_label: 'K. Esteva',
    base_url: null,
    secret_ciphertext: null,
    source_json: JSON.stringify(SOURCE),
    selection_mode: 'all',
    selection_json: null,
    state_mapping_json: '{}',
    status_sync_mode: 'auto',
    status_sync_enabled: 1,
    pull_mode: 'auto',
    push_mode: 'auto',
    push_target: 1,
    content_sync_mode: 'off',
    archive_sync_mode: 'off',
    priority_mapping_json: '{}',
    category_mapping_json: '{}',
    config_generation: 0,
    mirror_subissues: 1,
    conflict_mode: 'auto',
    cursor_updated_at: null,
    cursor_external_id: null,
    last_sync_at: null,
    last_sync_log_json: null,
    ...overrides,
  });
}

/**
 * A full {@link InboundSweepReport} with everything at zero except the counters
 * a test names. Kept as a builder rather than inline literals so adding a
 * counter to the report does not mean editing every sweep assertion — while
 * `toEqual` against the WHOLE object still fails a test that quietly starts
 * counting something it should not.
 */
function sweepReport(overrides: Partial<InboundSweepReport>): InboundSweepReport {
  return {
    sweepArchived: 0,
    conflictsOpened: 0,
    outOfScope: 0,
    entityLocked: 0,
    reconcileFetched: 0,
    reconcileImported: 0,
    reconcileLedgered: 0,
    reconcileSkipped: 0,
    resurrected: 0,
    archivalDeferred: 0,
    ...overrides,
  };
}

/** Re-read the connection row (cursor assertions need the persisted values). */
function reload(id = 'conn-1'): TrackerConnectionRow {
  const row = getConnection(raw, id);
  if (!row) throw new Error(`connection ${id} vanished`);
  return row;
}

interface IdeaRow {
  id: string;
  title: string;
  body: string | null;
  stage_id: string;
  archived_at: string | null;
}

function ideas(): IdeaRow[] {
  return raw
    // rowid = true insertion order. created_at is datetime('now') with ONE-SECOND
    // resolution, so same-second rows tie and the id tiebreak is a minted UUID —
    // i.e. random — which made apply-order assertions a coin flip.
    .prepare('SELECT id, title, body, stage_id, archived_at FROM ideas ORDER BY rowid ASC')
    .all() as IdeaRow[];
}

function conflicts(): TrackerConflictRow[] {
  return raw
    .prepare('SELECT * FROM tracker_conflicts ORDER BY id ASC')
    .all() as TrackerConflictRow[];
}

function baselineOf(externalId: string): TrackerBaseline {
  const link = getLinkByExternal(raw, 'conn-1', externalId);
  if (!link || link.baseline_json === null) throw new Error(`no baseline for ${externalId}`);
  return JSON.parse(link.baseline_json) as TrackerBaseline;
}

// ---------------------------------------------------------------------------
// Fresh import
// ---------------------------------------------------------------------------

describe('runInboundSync — fresh import', () => {
  it("treats an outbound-only 'indev' mapping exactly like don't-import", async () => {
    // 'indev' pins the WRITE-BACK state; it must never act as an inbound
    // target, because position 7 is orchestrator-derived and a tracker actor
    // writing it is rejected as 'forbidden_stage'. Importing it would either
    // throw or land a stage the boot self-heal reverts on the next pass.
    const connection = makeConnection({
      state_mapping_json: JSON.stringify({ 'st-backlog': 'indev' }),
    });
    adapter.issues = [makeIssue()];

    const report = await runInboundSync(deps, connection);

    expect(report.imported).toBe(0);
    expect(report.skipped).toBe(1);
    expect(ideas()).toHaveLength(0);
  });

  it('imports an orphaned issue as an idea with a provenance footer, link, baseline and cursor', async () => {
    const connection = makeConnection();
    const issue = makeIssue();
    adapter.issues = [issue];

    const report = await runInboundSync(deps, connection);

    expect(report.imported).toBe(1);
    expect(report.skipped).toBe(0);
    expect(report.haltedOnOutbox).toBeUndefined();

    const [idea] = ideas();
    expect(idea.title).toBe('Ship the tracker sync');
    expect(idea.body).toContain('Two-way sync with Linear.');
    // The marker carries (provider, externalId) — the import's recovery key.
    expect(idea.body).toContain('<!-- cyboflow:tracker linear:ext-1 -->');
    expect(idea.body).toContain('CORE-142');
    expect(idea.body).toContain('https://linear.app/acme/issue/CORE-142');
    // 'backlog' maps to the Idea stage, so no follow-up move.
    expect(idea.stage_id).toBe(STAGE.idea);

    const link = getLinkByExternal(raw, 'conn-1', 'ext-1');
    expect(link).not.toBeNull();
    expect(link?.entity_type).toBe('idea');
    expect(link?.entity_id).toBe(idea.id);
    expect(link?.external_identifier).toBe('CORE-142');
    expect(baselineOf('ext-1')).toEqual({
      title: 'Ship the tracker sync',
      description: 'Two-way sync with Linear.',
      stateId: 'st-backlog',
      updatedAt: '2026-07-30T10:00:00.000Z',
      // Emitted from the very first snapshot, including as null: a baseline
      // that omitted them would read as "never synced" and make the next pass
      // take the backfill arm instead of merging.
      priority: '3',
      category: null,
    });

    const after = reload();
    expect(after.cursor_updated_at).toBe('2026-07-30T10:00:00.000Z');
    expect(after.cursor_external_id).toBe('ext-1');
    // No cursor yet on the first pass -> a full fetch.
    expect(adapter.sinceCalls).toEqual([undefined]);
  });

  it('moves an imported idea to the mapped stage when the target is not Idea', async () => {
    const connection = makeConnection();
    adapter.issues = [makeIssue({ stateId: 'st-progress' })];

    await runInboundSync(deps, connection);

    expect(ideas()[0].stage_id).toBe(STAGE.ready);
  });

  it('skips a don’t-import state and still advances the cursor', async () => {
    const connection = makeConnection();
    adapter.issues = [makeIssue({ stateId: 'st-triage' })];

    const report = await runInboundSync(deps, connection);

    expect(report.imported).toBe(0);
    expect(report.skipped).toBe(1);
    expect(ideas()).toHaveLength(0);
    expect(reload().cursor_external_id).toBe('ext-1');
  });

  it('never imports an already-archived remote issue as a new idea', async () => {
    const connection = makeConnection();
    adapter.issues = [makeIssue({ archivedAt: '2026-07-29T09:00:00.000Z' })];

    const report = await runInboundSync(deps, connection);

    expect(report.imported).toBe(0);
    expect(report.skipped).toBe(1);
    expect(ideas()).toHaveLength(0);
  });

  it('applies issues in ascending (updatedAt, externalId) order', async () => {
    const connection = makeConnection();
    adapter.issues = [
      makeIssue({ externalId: 'ext-c', identifier: 'C-3', title: 'C', updatedAt: '2026-07-30T10:00:02.000Z' }),
      makeIssue({ externalId: 'ext-b', identifier: 'B-2', title: 'B', updatedAt: '2026-07-30T10:00:01.000Z' }),
      makeIssue({ externalId: 'ext-a', identifier: 'A-1', title: 'A', updatedAt: '2026-07-30T10:00:01.000Z' }),
    ];

    const report = await runInboundSync(deps, connection);

    expect(report.imported).toBe(3);
    expect(ideas().map((i) => i.title)).toEqual(['A', 'B', 'C']);
    const after = reload();
    expect(after.cursor_updated_at).toBe('2026-07-30T10:00:02.000Z');
    expect(after.cursor_external_id).toBe('ext-c');
  });
});

// ---------------------------------------------------------------------------
// Import crash recovery
// ---------------------------------------------------------------------------

describe('runInboundSync — import crash recovery', () => {
  it('adopts a half-imported idea instead of importing the issue a second time', async () => {
    const connection = makeConnection();
    const crashing = new CrashingRouter(router);
    const crashDeps: InboundSyncDeps = { ...deps, router: crashing };
    adapter.issues = [makeIssue({ stateId: 'st-progress' })];

    // Killed after the idea commits but before the link is written.
    crashing.crashAfterCreate = true;
    await expect(runInboundSync(crashDeps, connection)).rejects.toThrow('simulated crash');

    // A durable idea nothing points at, and a cursor that never advanced — so
    // the next pass sees the same unlinked issue all over again.
    const [orphan] = ideas();
    expect(ideas()).toHaveLength(1);
    expect(getLinkByExternal(raw, 'conn-1', 'ext-1')).toBeNull();
    expect(reload().cursor_updated_at).toBeNull();

    crashing.crashAfterCreate = false;
    const report = await runInboundSync(crashDeps, reload());

    // Adopted, not duplicated.
    expect(report.imported).toBe(1);
    const rows = ideas();
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(orphan.id);
    expect(getLinkByExternal(raw, 'conn-1', 'ext-1')?.entity_id).toBe(orphan.id);
    expect(baselineOf('ext-1').stateId).toBe('st-progress');
    // The placement the crash skipped is made on the adopt pass.
    expect(rows[0].stage_id).toBe(STAGE.ready);
    expect(reload().cursor_external_id).toBe('ext-1');
  });

  it('does not adopt an idea whose marker belongs to a DIFFERENT issue', async () => {
    const connection = makeConnection();
    const crashing = new CrashingRouter(router);
    const crashDeps: InboundSyncDeps = { ...deps, router: crashing };
    adapter.issues = [makeIssue({ externalId: 'ext-1', title: 'First' })];

    crashing.crashAfterCreate = true;
    await expect(runInboundSync(crashDeps, connection)).rejects.toThrow('simulated crash');

    // A different issue must get its own idea, not the orphaned one.
    crashing.crashAfterCreate = false;
    adapter.issues = [makeIssue({ externalId: 'ext-2', identifier: 'CORE-143', title: 'Second' })];
    const report = await runInboundSync(crashDeps, reload());

    expect(report.imported).toBe(1);
    const rows = ideas();
    expect(rows).toHaveLength(2);
    const link = getLinkByExternal(raw, 'conn-1', 'ext-2');
    expect(rows.find((row) => row.id === link?.entity_id)?.title).toBe('Second');
    // The orphan is still an orphan; only ITS issue may adopt it.
    expect(rows.some((row) => row.title === 'First')).toBe(true);
    expect(getLinkByExternal(raw, 'conn-1', 'ext-1')).toBeNull();
  });

  it('never re-imports after a crash between the link write and the stage move', async () => {
    const connection = makeConnection();
    const crashing = new CrashingRouter(router);
    const crashDeps: InboundSyncDeps = { ...deps, router: crashing };
    adapter.issues = [makeIssue({ stateId: 'st-progress' })];

    crashing.crashOnStageMove = true;
    await expect(runInboundSync(crashDeps, connection)).rejects.toThrow('simulated crash');

    // The link is already durable, so the issue is no longer importable at all.
    expect(ideas()).toHaveLength(1);
    expect(getLinkByExternal(raw, 'conn-1', 'ext-1')).not.toBeNull();

    crashing.crashOnStageMove = false;
    const report = await runInboundSync(crashDeps, reload());

    expect(report.imported).toBe(0);
    expect(ideas()).toHaveLength(1);
    // The residual cost of two writes that cannot share a transaction: the
    // entity is linked and syncable, but the placement this window skipped is
    // not re-derived (the remote state has not changed since the baseline).
    expect(ideas()[0].stage_id).toBe(STAGE.idea);
  });
});

// ---------------------------------------------------------------------------
// Import crash recovery — the repair runs AHEAD of the permanent-skip gates
//
// A crash between the create and the link leaves a marked idea nothing points
// at, and only the LINK repairs it. Every gate that answers "should this issue
// import?" is therefore the wrong question to ask first: an issue that becomes
// ineligible between the crash and the next pass took a skip branch that
// returned 'applied', the cursor moved past it, and the idea stayed unlinked
// forever — the issue may never enter the incremental window again.
// ---------------------------------------------------------------------------

describe('runInboundSync — a half-import is repaired regardless of current eligibility', () => {
  /** Crash a pass between the idea's create and its link write. */
  async function crashMidImport(
    connection: TrackerConnectionRow,
    issue: TrackerIssue,
  ): Promise<{ orphanId: string; crashDeps: InboundSyncDeps }> {
    const crashing = new CrashingRouter(router);
    const crashDeps: InboundSyncDeps = { ...deps, router: crashing };
    adapter.issues = [issue];
    crashing.crashAfterCreate = true;
    await expect(runInboundSync(crashDeps, connection)).rejects.toThrow('simulated crash');
    crashing.crashAfterCreate = false;

    const rows = ideas();
    expect(rows).toHaveLength(1);
    expect(getLinkByExternal(raw, 'conn-1', 'ext-1')).toBeNull();
    return { orphanId: rows[0].id, crashDeps };
  }

  it('links the idea when the issue was ARCHIVED remotely in the meantime, then archives it', async () => {
    const connection = makeConnection();
    const { orphanId, crashDeps } = await crashMidImport(connection, makeIssue());

    // The tracker retires the issue before the repair pass runs. As an UNLINKED
    // issue it is skipped outright (we never import something already retired)
    // — which is exactly the branch that used to strand the idea.
    adapter.issues = [
      makeIssue({ archivedAt: '2026-07-30T10:30:00.000Z', updatedAt: '2026-07-30T11:00:00.000Z' }),
    ];
    await runInboundSync(crashDeps, reload());

    // Linked — the repair is not conditional on wanting the issue.
    const link = getLinkByExternal(raw, 'conn-1', 'ext-1');
    expect(link?.entity_id).toBe(orphanId);
    // …and then given exactly the outcome a LINKED archived issue gets: Auto
    // archives in place and orphans the link.
    expect(ideas()[0].archived_at).not.toBeNull();
    expect(link?.orphaned_at).not.toBeNull();
    expect(ideas()).toHaveLength(1);
  });

  it('links the idea when the issue was remapped to DON’T IMPORT in the meantime', async () => {
    const connection = makeConnection();
    const { orphanId, crashDeps } = await crashMidImport(connection, makeIssue());

    // Triage maps to 'dont' by default: the issue is no longer importable.
    adapter.issues = [makeIssue({ stateId: 'st-triage', updatedAt: '2026-07-30T11:00:00.000Z' })];
    await runInboundSync(crashDeps, reload());

    expect(getLinkByExternal(raw, 'conn-1', 'ext-1')?.entity_id).toBe(orphanId);
    expect(ideas()).toHaveLength(1);
    // 'dont' names no stage, so the idea stays where the crashed pass left it —
    // the same non-answer a LINKED issue on that state gets from the merge.
    expect(ideas()[0].stage_id).toBe(STAGE.idea);
    expect(reload().cursor_external_id).toBe('ext-1');
  });

  it('links the idea when the SELECTION no longer covers the issue', async () => {
    const connection = makeConnection();
    const { orphanId, crashDeps } = await crashMidImport(connection, makeIssue());

    // The user narrows the connection's selection between the crash and the
    // repair pass, to a manual list this issue is not on.
    updateConnectionSettings(raw, 'conn-1', {
      selection_mode: 'manual',
      selection_json: JSON.stringify({ issueIds: ['ext-other'] }),
    });
    adapter.issues = [makeIssue({ updatedAt: '2026-07-30T11:00:00.000Z' })];
    await runInboundSync(crashDeps, reload());

    expect(getLinkByExternal(raw, 'conn-1', 'ext-1')?.entity_id).toBe(orphanId);
    expect(ideas()).toHaveLength(1);
  });

  it('still refuses to import an ineligible issue that has NO half-import behind it', async () => {
    // The mirror image, so the repair path cannot be mistaken for a hole in the
    // gates: with no marked idea to adopt, every skip still skips.
    const connection = makeConnection();
    adapter.issues = [
      makeIssue({ stateId: 'st-triage' }),
      makeIssue({ externalId: 'ext-2', identifier: 'CORE-143', archivedAt: '2026-07-29T09:00:00.000Z' }),
    ];

    const report = await runInboundSync(deps, connection);

    expect(report.imported).toBe(0);
    expect(report.skipped).toBe(2);
    expect(ideas()).toHaveLength(0);
    expect(getLinkByExternal(raw, 'conn-1', 'ext-1')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Cross-scope duplicate imports
//
// Multi-project mapping mints N sibling connections on one tracker identity,
// and their scopes overlap by construction (a Linear team group and a project
// group beneath it), so the SAME issue is fetched by two connections. To the
// second one it looks unlinked — the link is the sibling's — and importing it
// would mint a second idea for one remote issue.
// ---------------------------------------------------------------------------

describe('runInboundSync — an issue a sibling mapping already owns', () => {
  /**
   * A second mapping of the same workspace onto ANOTHER cyboflow project,
   * already holding a link for `externalId` — the shape the wizard produces
   * when two overlapping groups are mapped in one pass.
   */
  function seedSiblingMapping(
    externalId: string,
    overrides: Partial<NewConnectionRow> = {},
  ): TrackerConnectionRow {
    raw.prepare('INSERT INTO projects (id, name, path) VALUES (2, ?, ?)').run('Proj 2', '/tmp/p2');
    const sibling = makeConnection({
      id: 'conn-sibling',
      project_id: 2,
      source_json: JSON.stringify({ containerId: 'team-2', narrowId: 'all', narrowKind: 'all' }),
      ...overrides,
    });
    upsertLink(raw, {
      connection_id: sibling.id,
      entity_type: 'idea',
      entity_id: 'ide_sibling',
      provider: 'linear',
      external_id: externalId,
    });
    return sibling;
  }

  it('skips it, counts it as cross-scope, and still advances the cursor', async () => {
    const connection = makeConnection();
    seedSiblingMapping('ext-1');
    adapter.issues = [makeIssue()];

    const report = await runInboundSync(deps, connection);

    expect(report.imported).toBe(0);
    expect(report.crossScopeSkips).toBe(1);
    // The reason breakdown of a permanent skip, so it counts as skipped too.
    expect(report.skipped).toBe(1);
    expect(ideas()).toHaveLength(0);
    expect(getLinkByExternal(raw, 'conn-1', 'ext-1')).toBeNull();
    // PERMANENT — the issue belongs to the sibling, so nothing is re-offered.
    expect(reload().cursor_external_id).toBe('ext-1');
  });

  it('imports normally when the other connection is on a DIFFERENT workspace', async () => {
    const connection = makeConnection();
    seedSiblingMapping('ext-1', { workspace_id: 'ws-2' });
    adapter.issues = [makeIssue()];

    const report = await runInboundSync(deps, connection);

    expect(report.imported).toBe(1);
    expect(report.crossScopeSkips).toBe(0);
    expect(getLinkByExternal(raw, 'conn-1', 'ext-1')).not.toBeNull();
  });

  it('still repairs THIS connection’s half-import — the guard sits behind the adoption', async () => {
    // Precedence, deliberately: the local idea already exists, and the link is
    // the only thing that stops it being an orphan forever. A guard that ran
    // first would strand it the moment a sibling claimed the issue.
    const connection = makeConnection();
    const crashing = new CrashingRouter(router);
    const crashDeps: InboundSyncDeps = { ...deps, router: crashing };
    adapter.issues = [makeIssue()];
    crashing.crashAfterCreate = true;
    await expect(runInboundSync(crashDeps, connection)).rejects.toThrow('simulated crash');
    crashing.crashAfterCreate = false;
    const orphanId = ideas()[0].id;

    seedSiblingMapping('ext-1');
    const report = await runInboundSync(crashDeps, reload());

    expect(report.crossScopeSkips).toBe(0);
    expect(getLinkByExternal(raw, 'conn-1', 'ext-1')?.entity_id).toBe(orphanId);
    expect(ideas()).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Overlap-window dedup
// ---------------------------------------------------------------------------

describe('runInboundSync — overlap-window dedup', () => {
  it('drops issues the overlap window re-delivers at or before the stored cursor', async () => {
    const connection = makeConnection();
    adapter.issues = [makeIssue()];
    await runInboundSync(deps, connection);
    expect(ideas()).toHaveLength(1);

    // Second pass: same issue, unchanged updatedAt, re-delivered because the
    // fetch reaches 10 minutes behind the cursor.
    const second = await runInboundSync(deps, reload());

    expect(second.imported).toBe(0);
    expect(second.updated).toBe(0);
    expect(second.skipped).toBe(0);
    expect(ideas()).toHaveLength(1);
    expect(conflicts()).toHaveLength(0);

    // The second fetch asked for cursor - 10 minutes, inclusive.
    expect(adapter.sinceCalls[1]).toBe('2026-07-30T09:50:00.000Z');
    const after = reload();
    expect(after.cursor_updated_at).toBe('2026-07-30T10:00:00.000Z');
    expect(after.cursor_external_id).toBe('ext-1');
  });

  it('still applies a same-timestamp neighbour that sorts AFTER the cursor id', async () => {
    const connection = makeConnection();
    adapter.issues = [makeIssue({ externalId: 'ext-a', title: 'A' })];
    await runInboundSync(deps, connection);

    adapter.issues = [
      makeIssue({ externalId: 'ext-a', title: 'A' }),
      makeIssue({ externalId: 'ext-b', identifier: 'CORE-143', title: 'B' }),
    ];
    const second = await runInboundSync(deps, reload());

    expect(second.imported).toBe(1);
    expect(ideas().map((i) => i.title)).toEqual(['A', 'B']);
  });
});

// ---------------------------------------------------------------------------
// Three-way merge
// ---------------------------------------------------------------------------

describe('runInboundSync — three-way merge', () => {
  /** Import `issue`, then hand back the created idea id. */
  async function importOnce(connection: TrackerConnectionRow, issue: TrackerIssue): Promise<string> {
    adapter.issues = [issue];
    await runInboundSync(deps, connection);
    return ideas()[0].id;
  }

  it('applies a remote-only title/description change and advances the baseline', async () => {
    const connection = makeConnection();
    await importOnce(connection, makeIssue());

    adapter.issues = [
      makeIssue({
        title: 'Ship tracker sync (v1)',
        description: 'Linear AND Plane.',
        updatedAt: '2026-07-30T11:00:00.000Z',
      }),
    ];
    const report = await runInboundSync(deps, reload());

    expect(report.updated).toBe(1);
    expect(report.autoResolved).toBe(0);
    expect(report.conflictsOpened).toBe(0);

    const [idea] = ideas();
    expect(idea.title).toBe('Ship tracker sync (v1)');
    expect(idea.body).toContain('Linear AND Plane.');
    // The provenance footer survives a description replacement.
    expect(idea.body).toContain('<!-- cyboflow:tracker linear:ext-1 -->');
    expect(idea.body).not.toContain('Two-way sync with Linear.');

    expect(baselineOf('ext-1')).toEqual({
      title: 'Ship tracker sync (v1)',
      description: 'Linear AND Plane.',
      stateId: 'st-backlog',
      updatedAt: '2026-07-30T11:00:00.000Z',
      priority: '3',
      category: null,
    });
  });

  it('applies a remote-only STATE change as a stage move', async () => {
    const connection = makeConnection();
    await importOnce(connection, makeIssue());

    adapter.issues = [makeIssue({ stateId: 'st-done', updatedAt: '2026-07-30T11:00:00.000Z' })];
    const report = await runInboundSync(deps, reload());

    expect(report.updated).toBe(1);
    expect(ideas()[0].stage_id).toBe(STAGE.done);
  });

  it('leaves a local-only edit alone (outbound owns pushing it back)', async () => {
    const connection = makeConnection();
    const ideaId = await importOnce(connection, makeIssue());

    await router.applyChange(1, { actor: 'user', entityType: 'idea', taskId: ideaId, fields: { title: 'Local title' } });

    // Remote is unchanged apart from a touch of updatedAt.
    adapter.issues = [makeIssue({ updatedAt: '2026-07-30T11:00:00.000Z' })];
    const report = await runInboundSync(deps, reload());

    expect(report.updated).toBe(0);
    expect(report.conflictsOpened).toBe(0);
    expect(report.autoResolved).toBe(0);
    expect(ideas()[0].title).toBe('Local title');
  });

  it('AUTO: both sides changed a content field -> remote wins and the override is recorded', async () => {
    const connection = makeConnection({ conflict_mode: 'auto' });
    const ideaId = await importOnce(connection, makeIssue());

    await router.applyChange(1, { actor: 'user', entityType: 'idea', taskId: ideaId, fields: { title: 'Local title' } });
    adapter.issues = [makeIssue({ title: 'Remote title', updatedAt: '2026-07-30T11:00:00.000Z' })];

    const report = await runInboundSync(deps, reload());

    expect(report.updated).toBe(1);
    expect(report.autoResolved).toBe(1);
    expect(report.conflictsOpened).toBe(0);
    expect(ideas()[0].title).toBe('Remote title');

    const [conflict] = conflicts();
    expect(conflict.kind).toBe('field_conflict');
    expect(conflict.field).toBe('title');
    expect(conflict.local_value).toBe('Local title');
    expect(conflict.remote_value).toBe('Remote title');
    expect(conflict.state).toBe('resolved');
    expect(conflict.resolution).toBe('auto-remote');
    expect(conflict.resolved_at).not.toBeNull();

    // Baseline advanced to the remote snapshot, so the next pass is quiet.
    expect(baselineOf('ext-1').title).toBe('Remote title');
  });

  it('AUTO: both sides changed the STAGE -> local wins and the override is recorded', async () => {
    const connection = makeConnection({ conflict_mode: 'auto' });
    const ideaId = await importOnce(connection, makeIssue());

    await router.applyChange(1, { actor: 'user', entityType: 'idea', taskId: ideaId, stageId: STAGE.wontdo });
    adapter.issues = [makeIssue({ stateId: 'st-done', updatedAt: '2026-07-30T11:00:00.000Z' })];

    const report = await runInboundSync(deps, reload());

    expect(report.updated).toBe(0);
    expect(report.autoResolved).toBe(1);
    // Cyboflow wins stage/status: the local parking survives.
    expect(ideas()[0].stage_id).toBe(STAGE.wontdo);

    const [conflict] = conflicts();
    expect(conflict.field).toBe('stage');
    expect(conflict.local_value).toBe(STAGE.wontdo);
    expect(conflict.remote_value).toBe(STAGE.done);
    expect(conflict.resolution).toBe('auto-local');
    expect(baselineOf('ext-1').stateId).toBe('st-done');
  });

  it('MANUAL: a both-changed field opens a conflict, applies nothing, and parks the item', async () => {
    const connection = makeConnection({ conflict_mode: 'manual' });
    const ideaId = await importOnce(connection, makeIssue());

    await router.applyChange(1, { actor: 'user', entityType: 'idea', taskId: ideaId, fields: { title: 'Local title' } });
    adapter.issues = [makeIssue({ title: 'Remote title', updatedAt: '2026-07-30T11:00:00.000Z' })];

    const first = await runInboundSync(deps, reload());

    expect(first.conflictsOpened).toBe(1);
    expect(first.updated).toBe(0);
    expect(first.autoResolved).toBe(0);
    // Nothing applied…
    expect(ideas()[0].title).toBe('Local title');
    // …and the baseline is deliberately left where it was.
    expect(baselineOf('ext-1').title).toBe('Ship the tracker sync');

    const [conflict] = conflicts();
    expect(conflict.state).toBe('open');
    expect(conflict.field).toBe('title');

    // A later pass sees the open conflict and skips the item without piling up
    // duplicate conflict rows.
    adapter.issues = [makeIssue({ title: 'Remote title again', updatedAt: '2026-07-30T12:00:00.000Z' })];
    const second = await runInboundSync(deps, reload());

    expect(second.skipped).toBe(1);
    expect(second.conflictsOpened).toBe(0);
    expect(second.updated).toBe(0);
    expect(conflicts()).toHaveLength(1);
    expect(ideas()[0].title).toBe('Local title');
    expect(baselineOf('ext-1').title).toBe('Ship the tracker sync');
  });

  it('MANUAL: a STAGE conflict records the remote RAW state, a content one its remote value', async () => {
    // `remote_value` on a stage row is the MAPPED board stage, which cannot
    // advance a baseline — so the row also carries the provider state id and its
    // write-back group, which is what trackerSyncService stamps when the user
    // accepts the LOCAL side. Content fields need nothing extra.
    const connection = makeConnection({ conflict_mode: 'manual' });
    const ideaId = await importOnce(connection, makeIssue());

    await router.applyChange(1, { actor: 'user', entityType: 'idea', taskId: ideaId, stageId: STAGE.wontdo });
    await router.applyChange(1, { actor: 'user', entityType: 'idea', taskId: ideaId, fields: { title: 'Local title' } });
    adapter.issues = [
      makeIssue({ title: 'Remote title', stateId: 'st-done', updatedAt: '2026-07-30T11:00:00.000Z' }),
    ];

    await runInboundSync(deps, reload());

    const byField = new Map(conflicts().map((row) => [row.field, row]));
    const stage = byField.get('stage');
    expect(stage?.remote_value).toBe(STAGE.done);
    expect(JSON.parse(stage?.payload_json ?? '{}') as TrackerConflictPayload).toEqual({
      externalId: 'ext-1',
      mode: 'manual',
      detectedAt: '2026-07-30T12:00:00.000Z',
      remoteStateId: 'st-done',
      remoteGroup: 'completed',
    });

    const title = byField.get('title');
    expect(title?.remote_value).toBe('Remote title');
    expect(JSON.parse(title?.payload_json ?? '{}') as TrackerConflictPayload).toEqual({
      externalId: 'ext-1',
      mode: 'manual',
      detectedAt: '2026-07-30T12:00:00.000Z',
    });
  });

  it('MANUAL: a stage conflict on a state with NO write-back group records a null group', async () => {
    const connection = makeConnection({ conflict_mode: 'manual' });
    const ideaId = await importOnce(connection, makeIssue({ stateId: 'st-done' }));

    await router.applyChange(1, { actor: 'user', entityType: 'idea', taskId: ideaId, stageId: STAGE.wontdo });
    // 'unstarted' maps to Ready for development, which writes nothing back.
    adapter.issues = [makeIssue({ stateId: 'st-todo', updatedAt: '2026-07-30T11:00:00.000Z' })];

    await runInboundSync(deps, reload());

    const [conflict] = conflicts();
    expect(conflict.field).toBe('stage');
    const payload = JSON.parse(conflict.payload_json ?? '{}') as TrackerConflictPayload;
    expect(payload.remoteStateId).toBe('st-todo');
    expect(payload.remoteGroup).toBeNull();
  });

  it('MANUAL: a non-conflicting remote-only change still flows', async () => {
    const connection = makeConnection({ conflict_mode: 'manual' });
    await importOnce(connection, makeIssue());

    adapter.issues = [makeIssue({ title: 'Remote title', updatedAt: '2026-07-30T11:00:00.000Z' })];
    const report = await runInboundSync(deps, reload());

    expect(report.updated).toBe(1);
    expect(report.conflictsOpened).toBe(0);
    expect(ideas()[0].title).toBe('Remote title');
  });

  it('preserves the OUTBOUND half’s write-back stamp when it refreshes the baseline', async () => {
    // `baseline_json` is shared with writeBack.ts/outboxWorker.ts, which stamp
    // lastWrittenGroup/lastWrittenAt onto it as their write-back dedupe. An
    // inbound refresh must lay its snapshot OVER those keys, not replace them.
    const connection = makeConnection();
    await importOnce(connection, makeIssue());

    const link = getLinkByExternal(raw, 'conn-1', 'ext-1');
    raw
      .prepare('UPDATE entity_external_links SET baseline_json = ? WHERE id = ?')
      .run(
        JSON.stringify({
          ...JSON.parse(link?.baseline_json ?? '{}'),
          lastWrittenGroup: 'completed',
          lastWrittenAt: '2026-07-30T10:30:00.000Z',
        }),
        link?.id,
      );

    adapter.issues = [makeIssue({ title: 'Remote title', updatedAt: '2026-07-30T11:00:00.000Z' })];
    await runInboundSync(deps, reload());

    const refreshed = JSON.parse(
      getLinkByExternal(raw, 'conn-1', 'ext-1')?.baseline_json ?? '{}',
    ) as Record<string, unknown>;
    expect(refreshed.title).toBe('Remote title');
    expect(refreshed.lastWrittenGroup).toBe('completed');
    expect(refreshed.lastWrittenAt).toBe('2026-07-30T10:30:00.000Z');
  });

  it('seeds a baseline from the remote snapshot when a link carries only the write-back stamp', async () => {
    const connection = makeConnection();
    await importOnce(connection, makeIssue());

    const link = getLinkByExternal(raw, 'conn-1', 'ext-1');
    raw
      .prepare('UPDATE entity_external_links SET baseline_json = ? WHERE id = ?')
      .run(JSON.stringify({ lastWrittenGroup: 'started', stateId: 'st-progress' }), link?.id);

    adapter.issues = [makeIssue({ title: 'Remote title', updatedAt: '2026-07-30T11:00:00.000Z' })];
    const report = await runInboundSync(deps, reload());

    // Not mergeable yet: adopt the snapshot, apply nothing, keep the stamp.
    expect(report.updated).toBe(0);
    expect(report.skipped).toBe(1);
    expect(ideas()[0].title).toBe('Ship the tracker sync');
    const refreshed = JSON.parse(
      getLinkByExternal(raw, 'conn-1', 'ext-1')?.baseline_json ?? '{}',
    ) as Record<string, unknown>;
    expect(refreshed.title).toBe('Remote title');
    expect(refreshed.lastWrittenGroup).toBe('started');
  });

  it('treats a converged edit (both sides now equal) as no conflict', async () => {
    const connection = makeConnection({ conflict_mode: 'manual' });
    const ideaId = await importOnce(connection, makeIssue());

    await router.applyChange(1, { actor: 'user', entityType: 'idea', taskId: ideaId, fields: { title: 'Agreed title' } });
    adapter.issues = [makeIssue({ title: 'Agreed title', updatedAt: '2026-07-30T11:00:00.000Z' })];

    const report = await runInboundSync(deps, reload());

    expect(report.conflictsOpened).toBe(0);
    expect(report.updated).toBe(0);
    expect(baselineOf('ext-1').title).toBe('Agreed title');
  });
});

// ---------------------------------------------------------------------------
// The two MAPPED fields
//
// Priority and category do NOT diff on their literal values: the local scale is
// seven levels and every provider offers four or five, so the merge converts
// the LOCAL side out through the effective mapping and compares in PROVIDER
// space (invariant 2). These cases pin that, the never-synced backfill arm, and
// the unmappable-token report.
// ---------------------------------------------------------------------------

describe('runInboundSync — priority merge', () => {
  /** Import `issue`, then hand back the created idea id. */
  async function importOnce(connection: TrackerConnectionRow, issue: TrackerIssue): Promise<string> {
    adapter.issues = [issue];
    await runInboundSync(deps, connection);
    return ideas()[0].id;
  }

  /** The linked entity's stored priority/category. */
  function entityFields(id: string): { priority: string; category: string } {
    return raw.prepare('SELECT priority, category FROM ideas WHERE id = ?').get(id) as {
      priority: string;
      category: string;
    };
  }

  /** Everything entity_events recorded for one entity, newest last. */
  function events(id: string): Array<{ actor: string; changes_json: string | null }> {
    return raw
      .prepare('SELECT actor, changes_json FROM entity_events WHERE entity_id = ? ORDER BY seq ASC')
      .all(id) as Array<{ actor: string; changes_json: string | null }>;
  }

  /** Set a local value the way a USER would — through the chokepoint, as 'user'. */
  async function setLocal(id: string, fields: { priority?: Priority; category?: EntityCategory }): Promise<void> {
    await router.applyChange(1, { actor: 'user', entityType: 'idea', taskId: id, fields });
  }

  it('carries the remote priority onto the IMPORTED idea', async () => {
    // Without this the idea takes the table default (P2) while its baseline
    // records the remote's real token — a gap that never closes, because the
    // next pass reads it as "the user re-prioritized locally" and (once
    // outbound content write-back exists) demotes the tracker to match.
    const connection = makeConnection();
    const ideaId = await importOnce(connection, makeIssue({ priority: '1' }));

    expect(entityFields(ideaId).priority).toBe('P0');
    expect(baselineOf('ext-1').priority).toBe('1');
    // …and the very next pass sees a settled entity, not a local change.
    adapter.issues = [makeIssue({ priority: '1', updatedAt: '2026-07-30T11:00:00.000Z' })];
    const report = await runInboundSync(deps, reload());
    expect(report.updated).toBe(0);
    expect(report.conflictsOpened).toBe(0);
  });

  it('leaves the local default in place when the remote value has no mapping', async () => {
    // No prior expectation to violate, so this is silent rather than reported —
    // unlike a remote value that CHANGED out from under a mapping.
    adapter.fieldOptions = { priorities: ['critical', 'high', 'medium', 'low'], categories: [] };
    const connection = makeConnection({ provider: 'dart' });
    const ideaId = await importOnce(connection, makeIssue({ priority: 'Blocker' }));

    expect(entityFields(ideaId).priority).toBe('P2');
  });

  it('applies a remote-only priority change through the mapping, as the PROVIDER', async () => {
    const connection = makeConnection();
    const ideaId = await importOnce(connection, makeIssue());
    expect(entityFields(ideaId).priority).toBe('P2');

    // Linear '1' is Urgent.
    adapter.issues = [makeIssue({ priority: '1', updatedAt: '2026-07-30T11:00:00.000Z' })];
    const report = await runInboundSync(deps, reload());

    expect(report.updated).toBe(1);
    expect(report.conflictsOpened).toBe(0);
    expect(entityFields(ideaId).priority).toBe('P0');
    // The baseline stores the PROVIDER-RAW token, never the local level.
    expect(baselineOf('ext-1').priority).toBe('1');
    // actor = the provider, so writeBack's listener skips its own inbound value.
    const last = events(ideaId).at(-1);
    expect(last?.actor).toBe('linear');
    expect(last?.changes_json).toContain('P0');
  });

  it('does NOT demote a P3 when the remote sits on the rung P3 shares with P2', async () => {
    // THE FLAP CASE (invariant 2). P2 and P3 both mean Linear '3'. A merge that
    // compared in LOCAL space would map '3' back to P2 and quietly overwrite the
    // user's P3 — on this pass, and on every pass after it.
    const connection = makeConnection();
    const ideaId = await importOnce(connection, makeIssue({ priority: '2' }));
    await setLocal(ideaId, { priority: 'P3' });

    adapter.issues = [makeIssue({ priority: '3', updatedAt: '2026-07-30T11:00:00.000Z' })];
    const report = await runInboundSync(deps, reload());

    // The remote MOVED (2 -> 3), and the two sides now agree in provider space.
    expect(report.conflictsOpened).toBe(0);
    expect(report.autoResolved).toBe(0);
    expect(entityFields(ideaId).priority).toBe('P3');

    // And it stays P3 on a second pass, which is the part that matters.
    adapter.issues = [makeIssue({ priority: '3', updatedAt: '2026-07-30T12:00:00.000Z' })];
    await runInboundSync(deps, reload());
    expect(entityFields(ideaId).priority).toBe('P3');
  });

  it('opens ONE conflict, in provider space, when both sides moved', async () => {
    const connection = makeConnection({ conflict_mode: 'manual' });
    const ideaId = await importOnce(connection, makeIssue());
    await setLocal(ideaId, { priority: 'P0' });

    adapter.issues = [makeIssue({ priority: '2', updatedAt: '2026-07-30T11:00:00.000Z' })];
    const report = await runInboundSync(deps, reload());

    expect(report.conflictsOpened).toBe(1);
    const [row] = conflicts();
    expect(row.field).toBe('priority');
    // BOTH sides as provider tokens: the local P0 converted out, not 'P0'.
    expect(row.local_value).toBe('1');
    expect(row.remote_value).toBe('2');
    // The pass's own resolution of the remote token, recorded so a later ruling
    // need not rebuild the mapping from a live probe.
    expect(JSON.parse(row.payload_json ?? '{}')).toMatchObject({ remoteLocal: 'P1' });
    // Manual mode parks the item: nothing applied, baseline untouched.
    expect(entityFields(ideaId).priority).toBe('P0');
    expect(baselineOf('ext-1').priority).toBe('3');
  });

  it('gives AUTO mode to the tracker and files the audit finding', async () => {
    const review = new FakeReviewRouter();
    const connection = makeConnection();
    const ideaId = await importOnce(connection, makeIssue());
    await setLocal(ideaId, { priority: 'P0' });

    adapter.issues = [makeIssue({ priority: '2', updatedAt: '2026-07-30T11:00:00.000Z' })];
    const report = await runInboundSync({ ...deps, reviewRouter: review }, reload());

    expect(report.autoResolved).toBe(1);
    expect(report.conflictsOpened).toBe(0);
    expect(entityFields(ideaId).priority).toBe('P1');
    expect(review.created).toHaveLength(1);
    expect(review.created[0].body).toContain('priority');
  });

  it('leaves a LOCAL-only priority change alone — outbound owns pushing it', async () => {
    const connection = makeConnection();
    const ideaId = await importOnce(connection, makeIssue());
    await setLocal(ideaId, { priority: 'P0' });

    adapter.issues = [makeIssue({ title: 'Retitled', updatedAt: '2026-07-30T11:00:00.000Z' })];
    await runInboundSync(deps, reload());

    expect(entityFields(ideaId).priority).toBe('P0');
    expect(conflicts()).toHaveLength(0);
  });

  it('round-trips a CLEARED Dart priority to P6 and back to no value', async () => {
    // Dart omits a null field entirely, so unset arrives as null — and P6 is
    // the local level that maps OUT to nothing, which is what closes the loop.
    adapter.fieldOptions = { priorities: ['critical', 'high', 'medium', 'low'], categories: [] };
    const connection = makeConnection({ provider: 'dart' });
    const ideaId = await importOnce(connection, makeIssue({ priority: 'Medium' }));
    expect(entityFields(ideaId).priority).toBe('P2');

    adapter.issues = [makeIssue({ priority: null, updatedAt: '2026-07-30T11:00:00.000Z' })];
    await runInboundSync(deps, reload());

    expect(entityFields(ideaId).priority).toBe('P6');
    expect(baselineOf('ext-1').priority).toBeNull();
  });

  it("matches Dart's Title-case reads against its lowercase /config tokens", async () => {
    // MEASURED: /config lists 'critical', every task read returns 'Critical'.
    // A case-sensitive compare would report a change on every single pass.
    adapter.fieldOptions = { priorities: ['critical', 'high', 'medium', 'low'], categories: [] };
    const connection = makeConnection({ provider: 'dart' });
    const ideaId = await importOnce(connection, makeIssue({ priority: 'Medium' }));

    adapter.issues = [makeIssue({ priority: 'MEDIUM', updatedAt: '2026-07-30T11:00:00.000Z' })];
    const report = await runInboundSync(deps, reload());

    expect(report.updated).toBe(0);
    expect(report.conflictsOpened).toBe(0);
    expect(entityFields(ideaId).priority).toBe('P2');
  });
});

describe('runInboundSync — a remote value the mapping cannot express', () => {
  async function importOnce(connection: TrackerConnectionRow, issue: TrackerIssue): Promise<string> {
    adapter.issues = [issue];
    await runInboundSync(deps, connection);
    return ideas()[0].id;
  }

  function priorityOf(id: string): string {
    return (raw.prepare('SELECT priority FROM ideas WHERE id = ?').get(id) as { priority: string })
      .priority;
  }

  it('applies nothing, opens no conflict, and REPORTS it', async () => {
    // A bespoke workspace priority, or one the workspace renamed. Guessing a
    // level would apply a priority the user never chose; opening a conflict
    // would offer a "take theirs" button that could not do anything.
    adapter.fieldOptions = { priorities: ['critical', 'high', 'medium', 'low'], categories: [] };
    const connection = makeConnection({ provider: 'dart' });
    const ideaId = await importOnce(connection, makeIssue({ priority: 'Medium' }));

    adapter.issues = [makeIssue({ priority: 'Blocker', updatedAt: '2026-07-30T11:00:00.000Z' })];
    const report = await runInboundSync(deps, reload());

    expect(report.unmappedFieldValues).toBe(1);
    expect(report.conflictsOpened).toBe(0);
    expect(report.autoResolved).toBe(0);
    expect(priorityOf(ideaId)).toBe('P2');
  });

  it('PINS the baseline half so the warning re-derives instead of going quiet', async () => {
    // If the snapshot advanced onto the unmapped token, the next pass would see
    // no delta and stop reporting — a one-line warning about a renamed tracker
    // value would scroll away after a single pass and never return.
    adapter.fieldOptions = { priorities: ['critical', 'high', 'medium', 'low'], categories: [] };
    const connection = makeConnection({ provider: 'dart' });
    await importOnce(connection, makeIssue({ priority: 'Medium' }));

    adapter.issues = [makeIssue({ priority: 'Blocker', updatedAt: '2026-07-30T11:00:00.000Z' })];
    await runInboundSync(deps, reload());
    expect(baselineOf('ext-1').priority).toBe('Medium');

    adapter.issues = [makeIssue({ priority: 'Blocker', updatedAt: '2026-07-30T12:00:00.000Z' })];
    const second = await runInboundSync(deps, reload());
    expect(second.unmappedFieldValues).toBe(1);
  });

  it('still advances the CURSOR — the condition is not one time resolves', async () => {
    // Unlike a held direction, an unmapped value is not waiting on anything, so
    // pinning the fetch window on it would stall every issue behind it forever.
    adapter.fieldOptions = { priorities: ['critical', 'high', 'medium', 'low'], categories: [] };
    const connection = makeConnection({ provider: 'dart' });
    await importOnce(connection, makeIssue({ priority: 'Medium' }));

    adapter.issues = [makeIssue({ priority: 'Blocker', updatedAt: '2026-07-30T11:00:00.000Z' })];
    await runInboundSync(deps, reload());

    expect(reload().cursor_updated_at).toBe('2026-07-30T11:00:00.000Z');
  });

  it('lets the OTHER fields of the same issue merge normally', async () => {
    adapter.fieldOptions = { priorities: ['critical', 'high', 'medium', 'low'], categories: [] };
    const connection = makeConnection({ provider: 'dart' });
    await importOnce(connection, makeIssue({ priority: 'Medium' }));

    adapter.issues = [
      makeIssue({ priority: 'Blocker', title: 'Retitled', updatedAt: '2026-07-30T11:00:00.000Z' }),
    ];
    await runInboundSync(deps, reload());

    expect(ideas()[0].title).toBe('Retitled');
    expect(baselineOf('ext-1').title).toBe('Retitled');
  });

  it('REPORTS a persisted mapping entry the workspace renamed away', async () => {
    // The outbound half of the same rename, and it reaches the user through the
    // same ⚠ line: the wizard persisted the whole seeded table, so 'critical'
    // is in the overlay even though the seed just dropped it. Restoring it
    // verbatim would queue a write Dart 400s on and the outbox calls terminal.
    adapter.fieldOptions = { priorities: ['high', 'medium', 'low'], categories: [] };
    const connection = makeConnection({
      provider: 'dart',
      priority_mapping_json: JSON.stringify({
        toProvider: { P0: 'critical', P1: 'high', P2: 'medium', P4: 'low', P6: null },
      }),
    });
    await importOnce(connection, makeIssue({ priority: 'Medium' }));

    adapter.issues = [makeIssue({ priority: 'Medium', updatedAt: '2026-07-30T11:00:00.000Z' })];
    const report = await runInboundSync(deps, reload());

    // Counted once per pass, and again on the NEXT pass — a stale mapping stays
    // reported until the user confirms it, exactly like an unmapped read.
    expect(report.unmappedFieldValues).toBe(1);
    adapter.issues = [makeIssue({ priority: 'Medium', updatedAt: '2026-07-30T12:00:00.000Z' })];
    expect((await runInboundSync(deps, reload())).unmappedFieldValues).toBe(1);
  });

  it('imports an UNSET remote priority as P6 even when P0 is mapped to nothing', async () => {
    // The regression: "— Not sent" on P0 used to make Dart's absent priority
    // resolve to the first level with no outbound token, importing every
    // unprioritized issue as CRITICAL.
    adapter.fieldOptions = { priorities: ['critical', 'high', 'medium', 'low'], categories: [] };
    const connection = makeConnection({
      provider: 'dart',
      priority_mapping_json: JSON.stringify({ toProvider: { P0: null } }),
    });
    const ideaId = await importOnce(connection, makeIssue({ priority: null }));

    expect(priorityOf(ideaId)).toBe('P6');
  });
});

describe('runInboundSync — the never-synced backfill arm', () => {
  async function importOnce(connection: TrackerConnectionRow, issue: TrackerIssue): Promise<string> {
    adapter.issues = [issue];
    await runInboundSync(deps, connection);
    return ideas()[0].id;
  }

  /**
   * Rewrite the link's baseline to the shape a pre-feature build left behind:
   * the content/state keys present, the two mapped fields ABSENT. This is the
   * state every existing link is in the first time this code runs.
   */
  function stripMappedKeys(externalId: string): void {
    const link = getLinkByExternal(raw, 'conn-1', externalId);
    if (link === null || link.baseline_json === null) throw new Error('no link');
    const blob = JSON.parse(link.baseline_json) as Record<string, unknown>;
    delete blob.priority;
    delete blob.category;
    updateBaseline(raw, link.id, JSON.stringify(blob));
  }

  it('does nothing on the first pass — no diff, no conflict, no apply', async () => {
    // Falling through to the ordinary diff here would open a conflict (or
    // silently overwrite the local priority) on EVERY linked entity at once,
    // the first time a build carrying this code ran a pass.
    const connection = makeConnection({ conflict_mode: 'manual' });
    const ideaId = await importOnce(connection, makeIssue());
    await router.applyChange(1, {
      actor: 'user',
      entityType: 'idea',
      taskId: ideaId,
      fields: { priority: 'P0' },
    });
    stripMappedKeys('ext-1');

    // Both sides differ from each other AND from the (absent) baseline.
    adapter.issues = [makeIssue({ priority: '2', updatedAt: '2026-07-30T11:00:00.000Z' })];
    const report = await runInboundSync(deps, reload());

    expect(report.conflictsOpened).toBe(0);
    expect(report.autoResolved).toBe(0);
    expect(report.unmappedFieldValues).toBe(0);
    expect(
      (raw.prepare('SELECT priority FROM ideas WHERE id = ?').get(ideaId) as { priority: string })
        .priority,
    ).toBe('P0');
  });

  it('HEALS the baseline in that same pass, so merging starts from the next change', async () => {
    const connection = makeConnection();
    await importOnce(connection, makeIssue());
    stripMappedKeys('ext-1');
    expect(baselineOf('ext-1').priority).toBeUndefined();

    adapter.issues = [makeIssue({ priority: '2', updatedAt: '2026-07-30T11:00:00.000Z' })];
    await runInboundSync(deps, reload());
    expect(baselineOf('ext-1').priority).toBe('2');

    // The NEXT remote move is an ordinary remote-only change and applies.
    adapter.issues = [makeIssue({ priority: '1', updatedAt: '2026-07-30T12:00:00.000Z' })];
    await runInboundSync(deps, reload());
    expect(
      (raw.prepare('SELECT priority FROM ideas ORDER BY rowid ASC').get() as { priority: string })
        .priority,
    ).toBe('P0');
  });
});

describe('runInboundSync — category merge (Dart only)', () => {
  const DART_TYPES = ['Feature', 'Bug', 'Chore', 'Task'];

  async function importOnce(connection: TrackerConnectionRow, issue: TrackerIssue): Promise<string> {
    adapter.issues = [issue];
    await runInboundSync(deps, connection);
    return ideas()[0].id;
  }

  function categoryOf(id: string): string {
    return (raw.prepare('SELECT category FROM ideas WHERE id = ?').get(id) as { category: string })
      .category;
  }

  it('applies a remote-only type change on Dart', async () => {
    adapter.fieldOptions = { priorities: ['medium'], categories: DART_TYPES };
    const connection = makeConnection({ provider: 'dart' });
    const ideaId = await importOnce(connection, makeIssue({ priority: 'Medium', category: 'Feature' }));
    expect(categoryOf(ideaId)).toBe('feature');

    adapter.issues = [
      makeIssue({ priority: 'Medium', category: 'Bug', updatedAt: '2026-07-30T11:00:00.000Z' }),
    ];
    const report = await runInboundSync(deps, reload());

    expect(report.updated).toBe(1);
    expect(categoryOf(ideaId)).toBe('bug');
    expect(baselineOf('ext-1').category).toBe('Bug');
  });

  it('reports a Dart type the mapping does not name, rather than guessing', async () => {
    adapter.fieldOptions = { priorities: ['medium'], categories: DART_TYPES };
    const connection = makeConnection({ provider: 'dart' });
    const ideaId = await importOnce(connection, makeIssue({ priority: 'Medium', category: 'Bug' }));

    adapter.issues = [
      makeIssue({ priority: 'Medium', category: 'Milestone', updatedAt: '2026-07-30T11:00:00.000Z' }),
    ];
    const report = await runInboundSync(deps, reload());

    expect(report.unmappedFieldValues).toBe(1);
    expect(categoryOf(ideaId)).toBe('bug');
  });

  it('stands the whole arm down on a provider with no type field', async () => {
    // Linear sends a structural null because it models no issue type at all.
    // Diffing a local 'bug' against that would read the absence of the CONCEPT
    // as "the tracker cleared this entity's category".
    const connection = makeConnection();
    const ideaId = await importOnce(connection, makeIssue());
    await router.applyChange(1, {
      actor: 'user',
      entityType: 'idea',
      taskId: ideaId,
      fields: { category: 'bug' },
    });

    adapter.issues = [makeIssue({ title: 'Retitled', updatedAt: '2026-07-30T11:00:00.000Z' })];
    const report = await runInboundSync(deps, reload());

    expect(report.conflictsOpened).toBe(0);
    expect(report.autoResolved).toBe(0);
    expect(report.unmappedFieldValues).toBe(0);
    expect(categoryOf(ideaId)).toBe('bug');
  });

  it('maps nothing on a Dart workspace whose types are not categories', async () => {
    // The real probe workspace: Task / Subtask / Project / Milestone. Nothing
    // matches, so the arm has no vocabulary and reports rather than inventing.
    adapter.fieldOptions = {
      priorities: ['medium'],
      categories: ['Task', 'Subtask', 'Project', 'Milestone'],
    };
    const connection = makeConnection({ provider: 'dart' });
    const ideaId = await importOnce(connection, makeIssue({ priority: 'Medium', category: 'Task' }));

    adapter.issues = [
      makeIssue({ priority: 'Medium', category: 'Subtask', updatedAt: '2026-07-30T11:00:00.000Z' }),
    ];
    const report = await runInboundSync(deps, reload());

    expect(report.unmappedFieldValues).toBe(1);
    expect(categoryOf(ideaId)).toBe('feature');
  });
});

// ---------------------------------------------------------------------------
// Auto-mode audit findings
// ---------------------------------------------------------------------------

describe('runInboundSync — the audit record an AUTO override files', () => {
  let review: FakeReviewRouter;
  /** The dep bag WITH the review-queue seam wired (the app's real shape). */
  let audited: InboundSyncDeps;

  beforeEach(() => {
    review = new FakeReviewRouter();
    audited = { ...deps, reviewRouter: review };
  });

  /** Import `issue` through the audited deps, then hand back the created idea id. */
  async function importOnce(connection: TrackerConnectionRow, issue: TrackerIssue): Promise<string> {
    adapter.issues = [issue];
    await runInboundSync(audited, connection);
    return ideas()[0].id;
  }

  it('a CONTENT override files exactly one non-blocking finding carrying BOTH values', async () => {
    // The regression: the override's only record was a tracker_conflicts row
    // that is written already-resolved, and every product surface lists OPEN
    // conflicts only — so the local value the tracker overwrote was
    // unreachable from inside the app.
    const connection = makeConnection({ conflict_mode: 'auto' });
    const ideaId = await importOnce(connection, makeIssue());
    review.created.length = 0;

    await router.applyChange(1, { actor: 'user', entityType: 'idea', taskId: ideaId, fields: { title: 'Local title' } });
    adapter.issues = [makeIssue({ title: 'Remote title', updatedAt: '2026-07-30T11:00:00.000Z' })];

    const report = await runInboundSync(audited, reload());

    expect(report.autoResolved).toBe(1);
    expect(review.created).toHaveLength(1);
    const [finding] = review.created;
    expect(review.projectIds).toEqual([1]);
    expect(finding.op).toBe('create');
    expect(finding.kind).toBe('finding');
    // NON-BLOCKING always: an audit record must never park anything.
    expect(finding.blocking).toBe(false);
    // The tracker is the actor — this is the provider's value landing locally.
    expect(finding.actor).toBe('linear');
    expect(finding.entityType).toBe('idea');
    expect(finding.entityId).toBe(ideaId);

    const ref = (raw.prepare('SELECT ref FROM ideas WHERE id = ?').get(ideaId) as { ref: string }).ref;
    expect(finding.title).toBe(`Tracker sync auto-resolved a conflict on ${ref}`);

    const body = finding.body ?? '';
    expect(body).toContain(ref);
    expect(body).toContain('title');
    // BOTH sides, so the overwritten value is recoverable by reading it...
    expect(body).toContain('Local title');
    expect(body).toContain('Remote title');
    // ...plus which side won and why, and how to find the issue.
    expect(body).toContain('tracker');
    expect(body).toContain('CORE-142');
    expect(body).toContain('https://linear.app/acme/issue/CORE-142');
  });

  it('a STAGE override files one too — the doc says EVERY override', async () => {
    const connection = makeConnection({ conflict_mode: 'auto' });
    const ideaId = await importOnce(connection, makeIssue());
    review.created.length = 0;

    await router.applyChange(1, { actor: 'user', entityType: 'idea', taskId: ideaId, stageId: STAGE.wontdo });
    adapter.issues = [makeIssue({ stateId: 'st-done', updatedAt: '2026-07-30T11:00:00.000Z' })];

    const report = await runInboundSync(audited, reload());

    expect(report.autoResolved).toBe(1);
    expect(review.created).toHaveLength(1);
    const body = review.created[0].body ?? '';
    expect(body).toContain('stage');
    expect(body).toContain(STAGE.wontdo);
    expect(body).toContain(STAGE.done);
    // Stage is the one field cyboflow wins.
    expect(body).toContain('cyboflow');
  });

  it('files NOTHING for a clean remote-only apply — there was no override to audit', async () => {
    const connection = makeConnection({ conflict_mode: 'auto' });
    await importOnce(connection, makeIssue());
    review.created.length = 0;

    adapter.issues = [makeIssue({ title: 'Remote title', updatedAt: '2026-07-30T11:00:00.000Z' })];
    const report = await runInboundSync(audited, reload());

    expect(report.updated).toBe(1);
    expect(report.autoResolved).toBe(0);
    expect(review.created).toEqual([]);
  });

  it('files nothing and throws nothing when the review-queue seam is absent', async () => {
    const connection = makeConnection({ conflict_mode: 'auto' });
    adapter.issues = [makeIssue()];
    await runInboundSync(deps, connection);
    const ideaId = ideas()[0].id;

    await router.applyChange(1, { actor: 'user', entityType: 'idea', taskId: ideaId, fields: { title: 'Local title' } });
    adapter.issues = [makeIssue({ title: 'Remote title', updatedAt: '2026-07-30T11:00:00.000Z' })];

    // `deps` carries no reviewRouter — the resolved conflict row stays the
    // record and the pass runs to completion regardless.
    const report = await runInboundSync(deps, reload());
    expect(report.autoResolved).toBe(1);
    expect(review.created).toEqual([]);
    expect(conflicts()).toHaveLength(1);
  });

  it('survives a review-queue write that throws — the conflict row is the fallback record', async () => {
    const connection = makeConnection({ conflict_mode: 'auto' });
    const ideaId = await importOnce(connection, makeIssue());

    await router.applyChange(1, { actor: 'user', entityType: 'idea', taskId: ideaId, fields: { title: 'Local title' } });
    adapter.issues = [makeIssue({ title: 'Remote title', updatedAt: '2026-07-30T11:00:00.000Z' })];
    review.fail = new Error('review queue is wedged');

    const report = await runInboundSync(audited, reload());

    expect(report.autoResolved).toBe(1);
    expect(ideas()[0].title).toBe('Remote title');
    expect(conflicts()[0].resolution).toBe('auto-remote');
  });
});

// ---------------------------------------------------------------------------
// Selection filtering
// ---------------------------------------------------------------------------

describe('runInboundSync — selection filtering', () => {
  const assigned = (id: string): TrackerIssue['assignee'] => ({ id, name: id, initials: 'XX' });

  it("selection_mode 'assignee' imports only issues assigned to the chosen users", async () => {
    const connection = makeConnection({
      selection_mode: 'assignee',
      selection_json: JSON.stringify({ assigneeIds: ['user-1'] }),
    });
    adapter.issues = [
      makeIssue({ externalId: 'ext-1', title: 'Mine', assignee: assigned('user-1') }),
      makeIssue({ externalId: 'ext-2', title: 'Theirs', assignee: assigned('user-2'), updatedAt: '2026-07-30T10:00:01.000Z' }),
      makeIssue({ externalId: 'ext-3', title: 'Nobody’s', assignee: null, updatedAt: '2026-07-30T10:00:02.000Z' }),
    ];

    const report = await runInboundSync(deps, connection);

    expect(report.imported).toBe(1);
    expect(report.skipped).toBe(2);
    expect(ideas().map((i) => i.title)).toEqual(['Mine']);
    // Filtered-out issues still advance the cursor.
    expect(reload().cursor_external_id).toBe('ext-3');
  });

  it("selection_mode 'manual' imports only the explicitly chosen issue ids", async () => {
    const connection = makeConnection({
      selection_mode: 'manual',
      selection_json: JSON.stringify({ issueIds: ['ext-2'] }),
    });
    adapter.issues = [
      makeIssue({ externalId: 'ext-1', title: 'Unpicked' }),
      makeIssue({ externalId: 'ext-2', title: 'Picked', updatedAt: '2026-07-30T10:00:01.000Z' }),
    ];

    const report = await runInboundSync(deps, connection);

    expect(report.imported).toBe(1);
    expect(ideas().map((i) => i.title)).toEqual(['Picked']);
  });

  it("selection_mode 'all' imports everything mapped", async () => {
    const connection = makeConnection({ selection_mode: 'all' });
    adapter.issues = [
      makeIssue({ externalId: 'ext-1', title: 'One', assignee: assigned('user-9') }),
      makeIssue({ externalId: 'ext-2', title: 'Two', updatedAt: '2026-07-30T10:00:01.000Z' }),
    ];

    const report = await runInboundSync(deps, connection);

    expect(report.imported).toBe(2);
  });

  it('does not re-filter an issue that is ALREADY linked', async () => {
    const connection = makeConnection({ selection_mode: 'assignee', selection_json: JSON.stringify({ assigneeIds: ['user-1'] }) });
    adapter.issues = [makeIssue({ assignee: assigned('user-1') })];
    await runInboundSync(deps, connection);

    // Re-assigned away from the selected user, then edited remotely.
    adapter.issues = [
      makeIssue({ assignee: assigned('user-2'), title: 'Reassigned', updatedAt: '2026-07-30T11:00:00.000Z' }),
    ];
    const report = await runInboundSync(deps, reload());

    expect(report.updated).toBe(1);
    expect(ideas()[0].title).toBe('Reassigned');
  });
});

// ---------------------------------------------------------------------------
// Remote archive
// ---------------------------------------------------------------------------

describe('runInboundSync — remote archive', () => {
  it('AUTO: archives the linked entity in place, orphans the link, records the event', async () => {
    const connection = makeConnection({ conflict_mode: 'auto' });
    adapter.issues = [makeIssue()];
    await runInboundSync(deps, connection);

    adapter.issues = [makeIssue({ archivedAt: '2026-07-30T10:30:00.000Z', updatedAt: '2026-07-30T11:00:00.000Z' })];
    const report = await runInboundSync(deps, reload());

    expect(report.archivedRemotely).toBe(1);
    expect(ideas()[0].archived_at).not.toBeNull();
    expect(getLinkByExternal(raw, 'conn-1', 'ext-1')?.orphaned_at).not.toBeNull();

    const [conflict] = conflicts();
    expect(conflict.kind).toBe('remote_deleted');
    expect(conflict.state).toBe('resolved');
    expect(conflict.resolution).toBe('auto-archived');
    expect(JSON.parse(conflict.payload_json ?? '{}')).toMatchObject({ reason: 'archived' });

    // A later pass leaves the orphaned link alone instead of re-recording it.
    adapter.issues = [makeIssue({ archivedAt: '2026-07-30T10:30:00.000Z', updatedAt: '2026-07-30T12:00:00.000Z' })];
    const third = await runInboundSync(deps, reload());
    expect(third.archivedRemotely).toBe(0);
    expect(third.skipped).toBe(1);
    expect(conflicts()).toHaveLength(1);
  });

  it('MANUAL: opens a remote_deleted conflict and leaves the entity alone', async () => {
    const connection = makeConnection({ conflict_mode: 'manual' });
    adapter.issues = [makeIssue()];
    await runInboundSync(deps, connection);

    adapter.issues = [makeIssue({ archivedAt: '2026-07-30T10:30:00.000Z', updatedAt: '2026-07-30T11:00:00.000Z' })];
    const report = await runInboundSync(deps, reload());

    expect(report.conflictsOpened).toBe(1);
    expect(report.archivedRemotely).toBe(0);
    expect(ideas()[0].archived_at).toBeNull();
    expect(getLinkByExternal(raw, 'conn-1', 'ext-1')?.orphaned_at).toBeNull();
    expect(conflicts()[0].state).toBe('open');
  });
});

// ---------------------------------------------------------------------------
// Deletion sweep
// ---------------------------------------------------------------------------

describe('runDeletionSweep', () => {
  it('AUTO: archives locally + orphans the link for a vanished issue', async () => {
    const connection = makeConnection({ conflict_mode: 'auto' });
    adapter.issues = [makeIssue()];
    await runInboundSync(deps, connection);

    // Gone from the scoped listing AND from the point lookup — a real deletion.
    adapter.remoteIds = [];
    const sweep = await runDeletionSweep(deps, reload());

    expect(sweep.sweepArchived).toBe(1);
    expect(sweep.conflictsOpened).toBe(0);
    expect(ideas()[0].archived_at).not.toBeNull();
    expect(getLinkByExternal(raw, 'conn-1', 'ext-1')?.orphaned_at).not.toBeNull();
    expect(conflicts()[0]).toMatchObject({ kind: 'remote_deleted', state: 'resolved', resolution: 'auto-archived' });

    // Orphaned links drop out of the active set, so a second sweep is a no-op.
    const again = await runDeletionSweep(deps, reload());
    expect(again.sweepArchived).toBe(0);
    expect(conflicts()).toHaveLength(1);
  });

  it('MANUAL: opens a remote_deleted conflict and does not touch the entity', async () => {
    const connection = makeConnection({ conflict_mode: 'manual' });
    adapter.issues = [makeIssue()];
    await runInboundSync(deps, connection);

    // Gone from the scoped listing AND from the point lookup — a real deletion.
    adapter.remoteIds = [];
    const sweep = await runDeletionSweep(deps, reload());

    expect(sweep.conflictsOpened).toBe(1);
    expect(sweep.sweepArchived).toBe(0);
    expect(ideas()[0].archived_at).toBeNull();
    expect(getLinkByExternal(raw, 'conn-1', 'ext-1')?.orphaned_at).toBeNull();
    expect(conflicts()[0].state).toBe('open');

    // The open conflict suppresses duplicate rows on the next sweep.
    const again = await runDeletionSweep(deps, reload());
    expect(again.conflictsOpened).toBe(0);
    expect(conflicts()).toHaveLength(1);
  });

  it('leaves links whose issue is still present untouched', async () => {
    const connection = makeConnection({ conflict_mode: 'auto' });
    adapter.issues = [makeIssue()];
    await runInboundSync(deps, connection);

    const sweep = await runDeletionSweep(deps, reload());

    expect(sweep).toEqual(sweepReport({}));
    expect(ideas()[0].archived_at).toBeNull();
  });

  it('archives locally when the point lookup shows the issue was ARCHIVED remotely', async () => {
    const connection = makeConnection({ conflict_mode: 'auto' });
    adapter.issues = [makeIssue()];
    await runInboundSync(deps, connection);

    // Archived issues drop out of the scoped listing but still resolve.
    adapter.remoteIds = [];
    adapter.issuesById.set('ext-1', makeIssue({ archivedAt: '2026-07-29T09:00:00.000Z' }));

    const sweep = await runDeletionSweep(deps, reload());

    expect(sweep).toEqual(sweepReport({ sweepArchived: 1 }));
    expect(ideas()[0].archived_at).not.toBeNull();
    expect(getLinkByExternal(raw, 'conn-1', 'ext-1')?.orphaned_at).not.toBeNull();
    expect(JSON.parse(conflicts()[0].payload_json ?? '{}')).toMatchObject({
      reason: 'archived',
      archivedAt: '2026-07-29T09:00:00.000Z',
    });
  });
});

// ---------------------------------------------------------------------------
// Deletion sweep — scope exit is NOT deletion
// ---------------------------------------------------------------------------

describe('runDeletionSweep — an issue that left the configured scope', () => {
  /** Import ext-1, then move it out of the scoped listing while it stays alive. */
  async function importThenMoveOutOfScope(connection: TrackerConnectionRow): Promise<void> {
    adapter.issues = [makeIssue()];
    await runInboundSync(deps, connection);
    adapter.remoteIds = [];
    adapter.issuesById.set('ext-1', makeIssue());
  }

  it('AUTO: leaves the entity and the link exactly as they are', async () => {
    const connection = makeConnection({ conflict_mode: 'auto' });
    await importThenMoveOutOfScope(connection);

    const sweep = await runDeletionSweep(deps, reload());

    expect(sweep).toEqual(sweepReport({ outOfScope: 1 }));
    expect(ideas()[0].archived_at).toBeNull();
    expect(getLinkByExternal(raw, 'conn-1', 'ext-1')?.orphaned_at).toBeNull();
    expect(conflicts()).toHaveLength(0);

    // Still linked and still syncable: a later remote edit merges as normal.
    adapter.issues = [makeIssue({ title: 'Remote title', updatedAt: '2026-07-30T11:00:00.000Z' })];
    const report = await runInboundSync(deps, reload());
    expect(report.updated).toBe(1);
    expect(ideas()[0].title).toBe('Remote title');
  });

  it('MANUAL: does not open a remote_deleted conflict', async () => {
    const connection = makeConnection({ conflict_mode: 'manual' });
    await importThenMoveOutOfScope(connection);

    const sweep = await runDeletionSweep(deps, reload());

    expect(sweep).toEqual(sweepReport({ outOfScope: 1 }));
    expect(conflicts()).toHaveLength(0);
    expect(ideas()[0].archived_at).toBeNull();
    expect(getLinkByExternal(raw, 'conn-1', 'ext-1')?.orphaned_at).toBeNull();
  });

  it('reports every out-of-scope link and still handles a genuinely deleted one', async () => {
    const connection = makeConnection({ conflict_mode: 'auto' });
    adapter.issues = [
      makeIssue({ externalId: 'ext-1', title: 'Moved' }),
      makeIssue({ externalId: 'ext-2', identifier: 'CORE-143', title: 'Deleted', updatedAt: '2026-07-30T10:00:01.000Z' }),
    ];
    await runInboundSync(deps, connection);

    // Both vanish from the scoped listing; only ext-1 still resolves.
    adapter.remoteIds = [];
    adapter.issuesById.set('ext-1', makeIssue({ externalId: 'ext-1', title: 'Moved' }));

    const sweep = await runDeletionSweep(deps, reload());

    expect(sweep).toEqual(sweepReport({ sweepArchived: 1, outOfScope: 1 }));
    const moved = getLinkByExternal(raw, 'conn-1', 'ext-1');
    const deleted = getLinkByExternal(raw, 'conn-1', 'ext-2');
    expect(moved?.orphaned_at).toBeNull();
    expect(deleted?.orphaned_at).not.toBeNull();
    const rows = ideas();
    expect(rows.find((row) => row.id === moved?.entity_id)?.archived_at).toBeNull();
    expect(rows.find((row) => row.id === deleted?.entity_id)?.archived_at).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Echo suppression
// ---------------------------------------------------------------------------

describe('runInboundSync — echo suppression', () => {
  it('halts the batch at an issue with an unresolved outbox row and never advances past it', async () => {
    const connection = makeConnection();
    enqueueOutbox(raw, {
      connection_id: 'conn-1',
      kind: 'update_state',
      external_id: 'ext-b',
      payload_json: JSON.stringify({ stateId: 'st-done' }),
    });

    adapter.issues = [
      makeIssue({ externalId: 'ext-a', title: 'A', updatedAt: '2026-07-30T10:00:00.000Z' }),
      makeIssue({ externalId: 'ext-b', title: 'B', updatedAt: '2026-07-30T10:00:01.000Z' }),
      makeIssue({ externalId: 'ext-c', title: 'C', updatedAt: '2026-07-30T10:00:02.000Z' }),
    ];

    const report = await runInboundSync(deps, connection);

    expect(report.haltedOnOutbox).toBe('ext-b');
    // Only the issue BEFORE the blocked one was applied.
    expect(report.imported).toBe(1);
    expect(ideas().map((i) => i.title)).toEqual(['A']);

    const after = reload();
    expect(after.cursor_updated_at).toBe('2026-07-30T10:00:00.000Z');
    expect(after.cursor_external_id).toBe('ext-a');
  });

  it('recognizes our own in-flight CREATE by its client_key', async () => {
    const connection = makeConnection();
    enqueueOutbox(raw, {
      connection_id: 'conn-1',
      kind: 'create_sub_issue',
      external_id: null,
      client_key: 'ext-1',
      payload_json: JSON.stringify({ title: 'Mirrored task' }),
    });
    adapter.issues = [makeIssue()];

    const report = await runInboundSync(deps, connection);

    expect(report.haltedOnOutbox).toBe('ext-1');
    expect(report.imported).toBe(0);
    expect(ideas()).toHaveLength(0);
    expect(reload().cursor_updated_at).toBeNull();
  });

  it('recognizes a lost CREATE by its recovery marker when the provider minted its own id', async () => {
    const connection = makeConnection();
    enqueueOutbox(raw, {
      connection_id: 'conn-1',
      kind: 'create_sub_issue',
      entity_type: 'task',
      entity_id: 'tsk-1',
      client_key: 'ck-1',
      payload_json: JSON.stringify({ parentExternalId: 'proj1/parent', title: 'Mirrored task' }),
    });
    // The Plane shape: the create COMMITTED but its response was lost, so the
    // child comes back under a provider-minted composite id that matches
    // neither external_id nor client_key. The marker the create stamped into
    // its description is the only thing identifying it as ours.
    adapter.issues = [
      makeIssue({
        externalId: 'proj1/child',
        title: 'Mirrored task',
        parentExternalId: 'proj1/parent',
        recoveryClientKey: 'ck-1',
      }),
    ];

    const report = await runInboundSync(deps, connection);

    expect(report.haltedOnOutbox).toBe('proj1/child');
    expect(report.imported).toBe(0);
    expect(ideas()).toHaveLength(0);
    expect(reload().cursor_updated_at).toBeNull();
  });

  it('holds a PUSHED-but-unacked issue so it is never imported as a duplicate idea', async () => {
    const connection = makeConnection();
    // The push shape: we filed IDEA ide-1 as a top-level issue, the create
    // committed, and its response was lost. The remote issue carries a
    // provider-minted id matching neither column — only the marker names it.
    enqueueOutbox(raw, {
      connection_id: 'conn-1',
      kind: 'create_issue',
      entity_type: 'idea',
      entity_id: 'ide-1',
      client_key: 'ck-push',
      payload_json: '{}',
    });
    adapter.issues = [
      makeIssue({
        externalId: 'proj1/pushed',
        title: 'Ship tracker sync',
        parentExternalId: null,
        recoveryClientKey: 'ck-push',
      }),
    ];

    const report = await runInboundSync(deps, connection);

    // Importing it here would produce a SECOND idea for the one that made it.
    expect(report.haltedOnOutbox).toBe('proj1/pushed');
    expect(report.imported).toBe(0);
    expect(ideas()).toHaveLength(0);
    expect(reload().cursor_updated_at).toBeNull();
  });

  it('holds a pushed issue by client_key alone where creates are idempotent', async () => {
    const connection = makeConnection();
    enqueueOutbox(raw, {
      connection_id: 'conn-1',
      kind: 'create_issue',
      entity_type: 'idea',
      entity_id: 'ide-1',
      // Linear: the client key IS the created issue's id, so no marker exists.
      client_key: 'ext-1',
      payload_json: '{}',
    });
    adapter.issues = [makeIssue()];

    const report = await runInboundSync(deps, connection);

    expect(report.haltedOnOutbox).toBe('ext-1');
    expect(ideas()).toHaveLength(0);
  });

  it('does not hold an issue whose marker belongs to a SETTLED outbox row', async () => {
    const connection = makeConnection();
    const row = enqueueOutbox(raw, {
      connection_id: 'conn-1',
      kind: 'create_sub_issue',
      entity_type: 'task',
      entity_id: 'tsk-1',
      client_key: 'ck-1',
      payload_json: JSON.stringify({ parentExternalId: 'proj1/parent', title: 'Mirrored task' }),
    });
    raw.prepare("UPDATE tracker_outbox SET state = 'done' WHERE id = ?").run(row.id);
    adapter.issues = [makeIssue({ externalId: 'proj1/child', recoveryClientKey: 'ck-1' })];

    const report = await runInboundSync(deps, connection);

    expect(report.haltedOnOutbox).toBeUndefined();
    expect(report.imported).toBe(1);
  });

  it('resumes once the outbox row settles', async () => {
    const connection = makeConnection();
    const row = enqueueOutbox(raw, {
      connection_id: 'conn-1',
      kind: 'update_state',
      external_id: 'ext-1',
      payload_json: '{}',
    });
    adapter.issues = [makeIssue()];

    const halted = await runInboundSync(deps, connection);
    expect(halted.haltedOnOutbox).toBe('ext-1');

    raw.prepare("UPDATE tracker_outbox SET state = 'done' WHERE id = ?").run(row.id);
    const resumed = await runInboundSync(deps, reload());

    expect(resumed.haltedOnOutbox).toBeUndefined();
    expect(resumed.imported).toBe(1);
    expect(reload().cursor_external_id).toBe('ext-1');
  });
});

// ---------------------------------------------------------------------------
// Inbound changes must not echo back OUTBOUND
// ---------------------------------------------------------------------------

/**
 * TaskChangedEvent carries no actor/origin, so writeBack.ts routes a
 * provider-authored stage move exactly like a local one. These tests wire the
 * REAL listener onto the REAL emitter the way TrackerSyncService.start does —
 * which is also the only way an inbound-triggered enqueue is observable, since
 * the listener runs INLINE on TaskChangeRouter's post-commit emit.
 */
describe('runInboundSync — inbound changes do not echo back outbound', () => {
  /** STATES plus a SECOND completed-group state, to catch a state-specific overwrite. */
  const TWO_DONE_STATES: TrackerState[] = [
    ...STATES,
    { id: 'st-released', name: 'Released', color: null, group: 'completed' },
  ];

  let listener: WriteBackListener | null = null;
  let handler: ((event: TaskChangedEvent) => void) | null = null;

  function subscribeWriteBack(): void {
    const built = createWriteBackListener({ db: raw, nowIso: () => '2026-07-30 12:00:00' });
    const fn = (event: TaskChangedEvent): void => built.handleTaskChanged(event);
    taskChangeEvents.on(TASK_ALL_CHANNEL, fn);
    listener = built;
    handler = fn;
  }

  afterEach(() => {
    if (handler !== null) taskChangeEvents.off(TASK_ALL_CHANNEL, handler);
    listener?.dispose();
    listener = null;
    handler = null;
  });

  /** Every outbox row, settled or not — "zero enqueued" must mean zero. */
  function outboxRows(): TrackerOutboxRow[] {
    return raw.prepare('SELECT * FROM tracker_outbox ORDER BY id ASC').all() as TrackerOutboxRow[];
  }

  it('queues nothing for an inbound move to Done', async () => {
    const connection = makeConnection();
    subscribeWriteBack();
    adapter.issues = [makeIssue()];
    await runInboundSync(deps, connection);

    adapter.issues = [makeIssue({ stateId: 'st-done', updatedAt: '2026-07-30T11:00:00.000Z' })];
    const report = await runInboundSync(deps, reload());

    expect(report.updated).toBe(1);
    expect(ideas()[0].stage_id).toBe(STAGE.done);
    expect(outboxRows()).toEqual([]);
  });

  it("queues nothing for an inbound move to Won't do", async () => {
    const connection = makeConnection();
    subscribeWriteBack();
    adapter.issues = [makeIssue()];
    await runInboundSync(deps, connection);

    adapter.issues = [makeIssue({ stateId: 'st-canceled', updatedAt: '2026-07-30T11:00:00.000Z' })];
    await runInboundSync(deps, reload());

    expect(ideas()[0].stage_id).toBe(STAGE.wontdo);
    expect(outboxRows()).toEqual([]);
  });

  it('does not overwrite the provider’s own completed state when the remote moves to a SECOND done state', async () => {
    adapter.states = TWO_DONE_STATES;
    const connection = makeConnection();
    subscribeWriteBack();
    adapter.issues = [makeIssue()];
    await runInboundSync(deps, connection);

    // 'Released' is in the completed group but is NOT the state outbound would
    // pick (pickWriteBackState takes the FIRST of the group, 'st-done'), so an
    // echoed write-back here would drag the issue off the user's own state.
    adapter.issues = [makeIssue({ stateId: 'st-released', updatedAt: '2026-07-30T11:00:00.000Z' })];
    const report = await runInboundSync(deps, reload());

    expect(report.updated).toBe(1);
    expect(ideas()[0].stage_id).toBe(STAGE.done);
    expect(outboxRows()).toEqual([]);
  });

  it('queues nothing for a fresh import that lands on a mapped terminal stage', async () => {
    const connection = makeConnection();
    subscribeWriteBack();
    adapter.issues = [makeIssue({ stateId: 'st-done' })];

    const report = await runInboundSync(deps, connection);

    expect(report.imported).toBe(1);
    expect(ideas()[0].stage_id).toBe(STAGE.done);
    expect(outboxRows()).toEqual([]);
  });

  it('still enqueues for a genuinely LOCAL stage move', async () => {
    const connection = makeConnection();
    subscribeWriteBack();
    adapter.issues = [makeIssue()];
    await runInboundSync(deps, connection);

    await router.applyChange(1, {
      actor: 'user',
      entityType: 'idea',
      taskId: ideas()[0].id,
      stageId: STAGE.done,
    });

    const rows = outboxRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe('update_state');
    expect(rows[0].external_id).toBe('ext-1');
    expect(JSON.parse(rows[0].payload_json)).toEqual({ desiredGroup: 'completed' });
  });

  it('still enqueues a LOCAL move away from the stage an inbound pass just applied', async () => {
    // The stamp records where the REMOTE is, so it must suppress only the echo
    // — a later local decision to park the idea is a real write-back.
    const connection = makeConnection();
    subscribeWriteBack();
    adapter.issues = [makeIssue()];
    await runInboundSync(deps, connection);

    adapter.issues = [makeIssue({ stateId: 'st-done', updatedAt: '2026-07-30T11:00:00.000Z' })];
    await runInboundSync(deps, reload());
    expect(outboxRows()).toEqual([]);

    await router.applyChange(1, {
      actor: 'user',
      entityType: 'idea',
      taskId: ideas()[0].id,
      stageId: STAGE.wontdo,
    });

    const rows = outboxRows();
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0].payload_json)).toEqual({ desiredGroup: 'cancelled' });
  });

  it('re-arms the write-back once the remote leaves the terminal group', async () => {
    // A stale stamp must not wedge outbound: after the remote moves back to a
    // group no local stage demands, a local move to Done is a real write again.
    const connection = makeConnection();
    subscribeWriteBack();
    adapter.issues = [makeIssue({ stateId: 'st-done' })];
    await runInboundSync(deps, connection);
    expect(outboxRows()).toEqual([]);

    adapter.issues = [makeIssue({ stateId: 'st-backlog', updatedAt: '2026-07-30T11:00:00.000Z' })];
    await runInboundSync(deps, reload());
    expect(ideas()[0].stage_id).toBe(STAGE.idea);
    expect(outboxRows()).toEqual([]);

    await router.applyChange(1, {
      actor: 'user',
      entityType: 'idea',
      taskId: ideas()[0].id,
      stageId: STAGE.done,
    });

    expect(outboxRows()).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// applyLinkedStage — the inbound half of a MANUAL status direction
// ---------------------------------------------------------------------------

describe('runInboundSync — applyLinkedStage: false (status direction held)', () => {
  /** Import an issue, then hand back the created idea id. */
  async function importOnce(connection: TrackerConnectionRow): Promise<string> {
    adapter.issues = [makeIssue()];
    await runInboundSync(deps, connection);
    return ideas()[0].id;
  }

  /** The same deps with the stage dimension held. */
  function heldDeps(): InboundSyncDeps {
    return { ...deps, applyLinkedStage: false };
  }

  it('does NOT move the stage, and PINS the baseline state so the move survives to the next pass', async () => {
    const connection = makeConnection();
    await importOnce(connection);

    adapter.issues = [makeIssue({ stateId: 'st-done', updatedAt: '2026-07-30T11:00:00.000Z' })];
    const held = await runInboundSync(heldDeps(), reload());

    expect(held.updated).toBe(0);
    expect(held.stageDeferred).toBe(1);
    expect(ideas()[0].stage_id).toBe(STAGE.idea);
    // The state half of the baseline did NOT advance — the remote move is still
    // "unseen", which is what makes it applicable later.
    expect(baselineOf('ext-1').stateId).toBe('st-backlog');
    // …while the rest of the snapshot did.
    expect(baselineOf('ext-1').updatedAt).toBe('2026-07-30T11:00:00.000Z');
    // And the CURSOR did not move past it — otherwise the next pass would
    // filter the very issue it is supposed to finally apply.
    expect(reload().cursor_updated_at).toBe('2026-07-30T10:00:00.000Z');

    // The very next pass that IS allowed to apply it does so, from the same
    // remote state — nothing had to be re-sent or re-detected.
    const applied = await runInboundSync(deps, reload());
    expect(applied.updated).toBe(1);
    expect(ideas()[0].stage_id).toBe(STAGE.done);
    expect(baselineOf('ext-1').stateId).toBe('st-done');
  });

  it('still merges CONTENT while the stage is held, without clobbering the pinned state', async () => {
    const connection = makeConnection();
    await importOnce(connection);

    adapter.issues = [
      makeIssue({
        title: 'Ship tracker sync (v1)',
        description: 'Linear AND Plane.',
        stateId: 'st-done',
        updatedAt: '2026-07-30T11:00:00.000Z',
      }),
    ];
    const report = await runInboundSync(heldDeps(), reload());

    // Content is a different direction and keeps flowing.
    expect(report.updated).toBe(1);
    const [idea] = ideas();
    expect(idea.title).toBe('Ship tracker sync (v1)');
    expect(idea.body).toContain('Linear AND Plane.');
    expect(idea.stage_id).toBe(STAGE.idea);

    // The content half advanced; the state half did not. This is the
    // cross-field clobber composeBaselineJson has to avoid.
    const baseline = baselineOf('ext-1');
    expect(baseline.title).toBe('Ship tracker sync (v1)');
    expect(baseline.description).toBe('Linear AND Plane.');
    expect(baseline.stateId).toBe('st-backlog');
  });

  it('opens no STAGE conflict while held, so a manual-mode item is not parked', async () => {
    const connection = makeConnection({ conflict_mode: 'manual' });
    const ideaId = await importOnce(connection);

    // Both sides move the status: normally a stage conflict.
    await router.applyChange(1, {
      actor: 'user',
      entityType: 'idea',
      taskId: ideaId,
      stageId: STAGE.done,
    });
    adapter.issues = [
      makeIssue({ stateId: 'st-ready', title: 'Remote title', updatedAt: '2026-07-30T11:00:00.000Z' }),
    ];

    const report = await runInboundSync(heldDeps(), reload());

    // No stage conflict — asking the user to rule on a dimension they have
    // asked us not to sync would also park the item and stop the content merge.
    expect(conflicts()).toHaveLength(0);
    expect(report.conflictsOpened).toBe(0);
    expect(ideas()[0].stage_id).toBe(STAGE.done);
    // The content half still landed.
    expect(ideas()[0].title).toBe('Remote title');
  });

  it('still IMPORTS new issues while the stage direction is held', async () => {
    const connection = makeConnection();
    adapter.issues = [makeIssue({ stateId: 'st-done' })];

    const report = await runInboundSync(heldDeps(), connection);

    // Import is the PULL direction and has its own mode; a held status
    // direction must not silently stop it. The mapped stage still applies —
    // the hold is about MOVING a linked entity, not about where a brand-new
    // import lands.
    expect(report.imported).toBe(1);
    expect(ideas()[0].stage_id).toBe(STAGE.done);
  });
});

// ---------------------------------------------------------------------------
// A parked item that still owes work
//
// An open conflict parks an item and applies nothing. The cursor is what
// decides whether a later pass ever SEES it again, so anything the park
// suppressed that no durable row records is lost the moment the cursor moves.
// A remote STAGE change is exactly that: the conflict rows describe the fields
// they were opened FOR, and resolving one advances only its own field.
// ---------------------------------------------------------------------------

describe('runInboundSync — an open conflict must not swallow a pending stage change', () => {
  async function importOnce(connection: TrackerConnectionRow): Promise<string> {
    adapter.issues = [makeIssue()];
    await runInboundSync(deps, connection);
    return ideas()[0].id;
  }

  /**
   * Settle the one open TITLE conflict the way the user accepting their own
   * value does — which is the point being made: TrackerSyncService's
   * `acceptLocalFieldValue` resolves the row and advances the baseline's TITLE,
   * and nothing else. The stage baseline is untouched by any ruling about a
   * title, so the stage change only survives if the CURSOR kept the issue in
   * the fetch window.
   */
  function acceptLocalTitle(): void {
    const [conflict] = conflicts();
    expect(conflict.field).toBe('title');
    raw
      .prepare("UPDATE tracker_conflicts SET state = 'resolved', resolution = 'manual-local' WHERE id = ?")
      .run(conflict.id);
    const link = getLinkByExternal(raw, 'conn-1', 'ext-1');
    if (link === null) throw new Error('no link for ext-1');
    updateBaseline(
      raw,
      link.id,
      JSON.stringify({ ...baselineOf('ext-1'), title: conflict.remote_value }),
    );
  }

  it('HELD status + an open content conflict: the stage survives both passes and applies on a manual one', async () => {
    const connection = makeConnection({ conflict_mode: 'manual' });
    const ideaId = await importOnce(connection);
    const held: InboundSyncDeps = { ...deps, applyLinkedStage: false };

    // Both sides edit the title (a content conflict), and the remote ALSO moves
    // state — a change the held status direction may not apply.
    await router.applyChange(1, {
      actor: 'user',
      entityType: 'idea',
      taskId: ideaId,
      fields: { title: 'Local title' },
    });
    adapter.issues = [
      makeIssue({ title: 'Remote title', stateId: 'st-done', updatedAt: '2026-07-30T11:00:00.000Z' }),
    ];

    // PASS 1 — the conflict opens and the stage is deferred; the cursor holds.
    const first = await runInboundSync(held, reload());
    expect(first.conflictsOpened).toBe(1);
    expect(first.stageDeferred).toBe(1);
    expect(conflicts().map((row) => row.field)).toEqual(['title']);
    expect(reload().cursor_updated_at).toBe('2026-07-30T10:00:00.000Z');

    // PASS 2 — the open conflict short-circuits the item BEFORE the merge. This
    // is the regression: the short-circuit used to report the issue as fully
    // applied, the cursor advanced past it, and the held stage change was gone
    // for good — the issue leaves the incremental window and resolving the
    // TITLE conflict never touches the stage baseline.
    const second = await runInboundSync(held, reload());
    expect(second.skipped).toBe(1);
    expect(second.stageDeferred).toBe(1);
    expect(second.conflictsOpened).toBe(0);
    expect(reload().cursor_updated_at).toBe('2026-07-30T10:00:00.000Z');
    // Nothing was applied either way.
    expect(ideas()[0].stage_id).toBe(STAGE.idea);
    expect(ideas()[0].title).toBe('Local title');
    expect(baselineOf('ext-1').stateId).toBe('st-backlog');

    // The user resolves the title conflict, then hits "Sync now" — which runs
    // every direction, so the stage finally applies from the same remote state.
    acceptLocalTitle();

    const manual = await runInboundSync(deps, reload());
    expect(manual.updated).toBe(1);
    expect(ideas()[0].stage_id).toBe(STAGE.done);
    expect(baselineOf('ext-1').stateId).toBe('st-done');
    expect(reload().cursor_updated_at).toBe('2026-07-30T11:00:00.000Z');
  });

  it('AUTO status + a manual-mode content conflict: the parked stage move is re-delivered after resolution', async () => {
    // The interplay the status-manual case above shares a root with. Here the
    // stage move is APPLICABLE — status runs, and only the remote moved — but
    // the manual-mode park drops the whole item, conflicting field and all. No
    // row records the stage, so the cursor has to hold for it too.
    const connection = makeConnection({ conflict_mode: 'manual' });
    const ideaId = await importOnce(connection);

    await router.applyChange(1, {
      actor: 'user',
      entityType: 'idea',
      taskId: ideaId,
      fields: { title: 'Local title' },
    });
    adapter.issues = [
      makeIssue({ title: 'Remote title', stateId: 'st-done', updatedAt: '2026-07-30T11:00:00.000Z' }),
    ];

    const first = await runInboundSync(deps, reload());
    expect(first.conflictsOpened).toBe(1);
    expect(first.stageDeferred).toBe(1);
    expect(ideas()[0].stage_id).toBe(STAGE.idea);
    expect(reload().cursor_updated_at).toBe('2026-07-30T10:00:00.000Z');

    const second = await runInboundSync(deps, reload());
    expect(second.stageDeferred).toBe(1);
    expect(reload().cursor_updated_at).toBe('2026-07-30T10:00:00.000Z');

    acceptLocalTitle();

    const after = await runInboundSync(deps, reload());
    expect(after.updated).toBe(1);
    expect(ideas()[0].stage_id).toBe(STAGE.done);
    expect(reload().cursor_updated_at).toBe('2026-07-30T11:00:00.000Z');
  });

  it('lets the cursor move past an item parked by a STAGE conflict — that row already records it', async () => {
    // The exception, and why the hold is conditional rather than blanket: a
    // stage conflict row carries the remote state id and applies it on
    // resolution, so the work is durable. Holding the cursor for it as well
    // would pin the fetch window open for as long as the user takes to answer.
    const connection = makeConnection({ conflict_mode: 'manual' });
    const ideaId = await importOnce(connection);

    await router.applyChange(1, {
      actor: 'user',
      entityType: 'idea',
      taskId: ideaId,
      stageId: STAGE.wontdo,
    });
    adapter.issues = [makeIssue({ stateId: 'st-done', updatedAt: '2026-07-30T11:00:00.000Z' })];

    await runInboundSync(deps, reload());
    expect(conflicts().map((row) => row.field)).toEqual(['stage']);

    adapter.issues = [makeIssue({ stateId: 'st-done', updatedAt: '2026-07-30T12:00:00.000Z' })];
    const second = await runInboundSync(deps, reload());

    expect(second.skipped).toBe(1);
    expect(second.stageDeferred).toBe(0);
    expect(reload().cursor_updated_at).toBe('2026-07-30T12:00:00.000Z');
  });

  it('lets the cursor move past a parked item with NO stage change waiting', async () => {
    const connection = makeConnection({ conflict_mode: 'manual' });
    const ideaId = await importOnce(connection);

    await router.applyChange(1, {
      actor: 'user',
      entityType: 'idea',
      taskId: ideaId,
      fields: { title: 'Local title' },
    });
    adapter.issues = [makeIssue({ title: 'Remote title', updatedAt: '2026-07-30T11:00:00.000Z' })];
    await runInboundSync(deps, reload());

    adapter.issues = [makeIssue({ title: 'Remote title again', updatedAt: '2026-07-30T12:00:00.000Z' })];
    const second = await runInboundSync(deps, reload());

    expect(second.skipped).toBe(1);
    expect(second.stageDeferred).toBe(0);
    expect(reload().cursor_updated_at).toBe('2026-07-30T12:00:00.000Z');
  });

  it('HOLDS the cursor for a remote content change no open conflict records', async () => {
    // The hazard the content arm closes: an item parked by a TITLE conflict
    // whose remote DESCRIPTION also moved. Resolving the title advances only
    // the title half of the baseline, so nothing would ever re-derive the
    // description — and once the cursor passes the issue, only another remote
    // edit would ever fetch it again.
    const connection = makeConnection({ conflict_mode: 'manual' });
    const ideaId = await importOnce(connection);

    await router.applyChange(1, {
      actor: 'user',
      entityType: 'idea',
      taskId: ideaId,
      fields: { title: 'Local title' },
    });
    adapter.issues = [makeIssue({ title: 'Remote title', updatedAt: '2026-07-30T11:00:00.000Z' })];
    await runInboundSync(deps, reload());
    expect(conflicts().map((row) => row.field)).toEqual(['title']);
    const parkedAt = reload().cursor_updated_at;

    adapter.issues = [
      makeIssue({
        title: 'Remote title',
        description: 'A body change nobody recorded',
        updatedAt: '2026-07-30T12:00:00.000Z',
      }),
    ];
    const second = await runInboundSync(deps, reload());

    expect(second.contentDeferred).toBe(1);
    expect(second.stageDeferred).toBe(0);
    // The cursor stays put, so the description is re-offered until the title
    // conflict is answered and the merge can apply the whole item.
    expect(reload().cursor_updated_at).toBe(parkedAt);
  });
});

// ---------------------------------------------------------------------------
// importNewIssues — the inbound half of a MANUAL pull direction
// ---------------------------------------------------------------------------

describe('runInboundSync — importNewIssues: false (import direction held)', () => {
  /** The same deps with the import direction held. */
  function heldDeps(): InboundSyncDeps {
    return { ...deps, importNewIssues: false };
  }

  it('does not import a new issue, and holds the cursor so it is re-offered', async () => {
    const connection = makeConnection();
    adapter.issues = [makeIssue()];

    const held = await runInboundSync(heldDeps(), connection);

    expect(held.imported).toBe(0);
    expect(held.importDeferred).toBe(1);
    // NOT counted as a skip: a skip is a decision, a deferral is a delay.
    expect(held.skipped).toBe(0);
    expect(ideas()).toHaveLength(0);
    expect(reload().cursor_updated_at).toBeNull();

    // The next pass that MAY import finds the same issue waiting.
    const allowed = await runInboundSync(deps, reload());
    expect(allowed.imported).toBe(1);
    expect(ideas()).toHaveLength(1);
    expect(reload().cursor_external_id).toBe('ext-1');
  });

  it('keeps merging LINKED items past a held import, without advancing the cursor', async () => {
    const connection = makeConnection();
    // ext-1 imports normally on a fully-open pass…
    adapter.issues = [makeIssue()];
    await runInboundSync(deps, connection);

    // …then a NEW issue arrives BEFORE a change to the linked one.
    adapter.issues = [
      makeIssue({ externalId: 'ext-2', title: 'Newcomer', updatedAt: '2026-07-30T10:30:00.000Z' }),
      makeIssue({ title: 'Ship tracker sync (v1)', updatedAt: '2026-07-30T11:00:00.000Z' }),
    ];
    const held = await runInboundSync(heldDeps(), reload());

    // The linked item behind the held one still merged…
    expect(held.updated).toBe(1);
    expect(held.importDeferred).toBe(1);
    expect(ideas().map((i) => i.title)).toEqual(['Ship tracker sync (v1)']);
    // …but the cursor stayed at the last FULLY applied issue, so the newcomer
    // is re-offered rather than filtered out by the cursor that skipped it.
    expect(reload().cursor_external_id).toBe('ext-1');
    expect(reload().cursor_updated_at).toBe('2026-07-30T10:00:00.000Z');

    // Re-applying the linked item next pass is a no-op, not a duplicate.
    const allowed = await runInboundSync(deps, reload());
    expect(allowed.imported).toBe(1);
    expect(allowed.updated).toBe(0);
    expect(ideas()).toHaveLength(2);
  });

  it('still ADOPTS a half-imported idea — repair is not a new import', async () => {
    const connection = makeConnection();
    const crashing = new CrashingRouter(router);
    adapter.issues = [makeIssue({ stateId: 'st-progress' })];

    // Crash after the idea commits but before its link is written.
    crashing.crashAfterCreate = true;
    await expect(
      runInboundSync({ ...deps, router: crashing }, connection),
    ).rejects.toThrow('simulated crash');
    const [orphan] = ideas();
    expect(getLinkByExternal(raw, 'conn-1', 'ext-1')).toBeNull();

    // Import is now held — but leaving the orphan unrepaired would strand an
    // idea nothing points at, so the adopt proceeds.
    crashing.crashAfterCreate = false;
    const report = await runInboundSync({ ...heldDeps(), router: crashing }, reload());

    expect(report.imported).toBe(1);
    expect(report.importDeferred).toBe(0);
    expect(ideas()).toHaveLength(1);
    expect(getLinkByExternal(raw, 'conn-1', 'ext-1')?.entity_id).toBe(orphan.id);
    // Repair completed, so the cursor is free to move.
    expect(reload().cursor_external_id).toBe('ext-1');
  });

  it("does not defer an issue it would never have imported anyway", async () => {
    // A 'dont'-mapped state and a selection-filtered issue are DECISIONS, not
    // delays — deferring them would pin the cursor forever on issues no mode
    // will ever let in.
    const connection = makeConnection({
      state_mapping_json: JSON.stringify({ 'st-backlog': 'dont' }),
    });
    adapter.issues = [makeIssue()];

    const held = await runInboundSync(heldDeps(), connection);

    expect(held.importDeferred).toBe(0);
    expect(held.skipped).toBe(1);
    expect(reload().cursor_external_id).toBe('ext-1');
  });
});

// ---------------------------------------------------------------------------
// A locked local entity defers ONE item — it must never wedge the pass
// ---------------------------------------------------------------------------

/**
 * TaskChangeRouter refuses a stage move (and an archive) on an entity that has
 * a non-terminal run, for every actor but the orchestrator. A tracker actor is
 * not the orchestrator, so a remote status change on anything currently in a
 * live session draws 'active_runs' — the ORDINARY case, not an exotic one.
 *
 * These tests pin the blast radius. The rejection must defer that one item and
 * let the rest of the batch through; before the fix it propagated out of the
 * pass, pinned the cursor on the failing issue, and skipped every issue behind
 * it AND the deletion sweep — so a single live run stopped the connection's
 * whole inbound flow for as long as it ran.
 *
 * The run is REAL (a `workflow_runs` row), not a throwing router double, so the
 * production guard is what these exercise.
 */
function seedLiveRun(taskId: string, runId = 'run-live'): void {
  raw
    .prepare(`INSERT OR IGNORE INTO workflows (id, project_id, name, spec_json) VALUES ('wf-1', 1, 'sprint', '{}')`)
    .run();
  raw
    .prepare(
      `INSERT INTO workflow_runs (id, workflow_id, project_id, status, permission_mode_snapshot, task_id)
       VALUES (?, 'wf-1', 1, 'running', 'default', ?)`,
    )
    .run(runId, taskId);
}

describe('runInboundSync — a locked local entity', () => {
  it('defers the refused stage move instead of failing the pass', async () => {
    const connection = makeConnection();
    adapter.issues = [makeIssue()];
    await runInboundSync(deps, connection);
    const idea = ideas()[0];
    const stageBefore = idea.stage_id;
    seedLiveRun(idea.id);

    // The remote moves to Done, which maps to the Done stage — a move the live
    // run forbids.
    adapter.issues = [makeIssue({ stateId: 'st-done', updatedAt: '2026-07-30T11:00:00.000Z' })];
    const report = await runInboundSync(deps, reload());

    expect(report.entityLocked).toBe(1);
    expect(ideas()[0].stage_id).toBe(stageBefore);
    // Pinned on BOTH halves: the cursor holds at the FIRST pass's high-water
    // mark so the issue is re-fetched, and the baseline's state half stays put
    // so the delta is still there to re-apply.
    expect(reload().cursor_updated_at).toBe('2026-07-30T10:00:00.000Z');
    expect(baselineOf('ext-1').stateId).toBe('st-backlog');
  });

  it('re-applies the deferred move once the run reaches a terminal status', async () => {
    const connection = makeConnection();
    adapter.issues = [makeIssue()];
    await runInboundSync(deps, connection);
    seedLiveRun(ideas()[0].id);

    adapter.issues = [makeIssue({ stateId: 'st-done', updatedAt: '2026-07-30T11:00:00.000Z' })];
    expect((await runInboundSync(deps, reload())).entityLocked).toBe(1);

    raw.prepare(`UPDATE workflow_runs SET status = 'completed' WHERE id = 'run-live'`).run();
    const after = await runInboundSync(deps, reload());

    expect(after.entityLocked).toBe(0);
    expect(ideas()[0].stage_id).not.toBe('stage-board-1-default-1');
    expect(baselineOf('ext-1').stateId).toBe('st-done');
    expect(reload().cursor_external_id).toBe('ext-1');
  });

  it('still applies the CONTENT half of a refused merge', async () => {
    const connection = makeConnection();
    adapter.issues = [makeIssue()];
    await runInboundSync(deps, connection);
    seedLiveRun(ideas()[0].id);

    adapter.issues = [
      makeIssue({
        title: 'Renamed remotely',
        stateId: 'st-done',
        updatedAt: '2026-07-30T11:00:00.000Z',
      }),
    ];
    const report = await runInboundSync(deps, reload());

    expect(report.entityLocked).toBe(1);
    // The title landed even though the stage did not — re-running the whole
    // item next pass would re-file its auto-resolution findings.
    expect(ideas()[0].title).toBe('Renamed remotely');
    expect(baselineOf('ext-1').title).toBe('Renamed remotely');
    expect(baselineOf('ext-1').stateId).toBe('st-backlog');
  });

  it('keeps applying the issues BEHIND the locked one', async () => {
    const connection = makeConnection();
    adapter.issues = [makeIssue(), makeIssue({ externalId: 'ext-2', identifier: 'CORE-143' })];
    await runInboundSync(deps, connection);
    const locked = ideas().find((i) => i.title === 'Ship the tracker sync');
    seedLiveRun(locked?.id ?? '');

    adapter.issues = [
      makeIssue({ stateId: 'st-done', updatedAt: '2026-07-30T11:00:00.000Z' }),
      makeIssue({
        externalId: 'ext-2',
        identifier: 'CORE-143',
        title: 'Second issue, renamed',
        updatedAt: '2026-07-30T11:01:00.000Z',
      }),
    ];
    const report = await runInboundSync(deps, reload());

    expect(report.entityLocked).toBe(1);
    expect(ideas().some((i) => i.title === 'Second issue, renamed')).toBe(true);
  });

  it('rethrows a rejection that is NOT about the entity being busy', async () => {
    const connection = makeConnection();
    adapter.issues = [makeIssue()];
    await runInboundSync(deps, connection);

    // A router that fails for an unpredicted reason is a bug, not a deferral.
    const exploding: EntityWriteRouter = {
      applyChange: async () => {
        throw new Error('boom');
      },
    };
    adapter.issues = [makeIssue({ title: 'Renamed', updatedAt: '2026-07-30T11:00:00.000Z' })];

    await expect(runInboundSync({ ...deps, router: exploding }, reload())).rejects.toThrow('boom');
  });
});

describe('runDeletionSweep — a locked local entity', () => {
  it('skips the locked link and sweeps the rest', async () => {
    const connection = makeConnection({ conflict_mode: 'auto' });
    adapter.issues = [makeIssue(), makeIssue({ externalId: 'ext-2', identifier: 'CORE-143' })];
    await runInboundSync(deps, connection);
    const locked = ideas().find((i) => i.title === 'Ship the tracker sync');
    seedLiveRun(locked?.id ?? '');

    // Both issues are gone remotely; only the unlocked one can be archived.
    adapter.remoteIds = [];
    const sweep = await runDeletionSweep(deps, reload());

    expect(sweep.entityLocked).toBe(1);
    expect(sweep.sweepArchived).toBe(1);
    // Untouched: still active, no conflict row, so the next sweep retries it.
    expect(getLinkByExternal(raw, 'conn-1', 'ext-1')?.orphaned_at).toBeNull();
    expect(conflicts()).toHaveLength(1);
  });
});
