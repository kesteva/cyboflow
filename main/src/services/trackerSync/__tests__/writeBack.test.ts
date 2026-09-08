/**
 * Unit tests for the OUTBOUND detection half
 * (main/src/services/trackerSync/writeBack.ts).
 *
 * Runs against a REAL temp-file DB through the full migration chain (same
 * technique as store.test.ts / migration093.test.ts) so board seeding, the
 * entity tables, and migration 093's constraints are the real thing. The
 * TaskChangeRouter is NOT involved — its post-commit broadcast payload is
 * synthesized directly (see makeEvent), which is exactly what the listener
 * sees in production and keeps these tests free of the chokepoint's queueing.
 *
 * Covers, per the task brief:
 *   - stage-change enqueue (Done -> 'completed') + dedup on a repeated event.
 *   - the last-written-group baseline stamp suppressing a re-enqueue.
 *   - paused / unlinked / epic entities ignored, and a MANUAL direction still
 *     enqueuing (the mode gates the drain, never the intent).
 *   - the IDEA PUSH trigger: a locally-created idea enqueues one create_issue
 *     per active connection, each of its four event-level skips, and the
 *     per-connection `push_target = 0` skip that keeps sibling mapping rows
 *     from filing the same idea N times.
 *   - decomposition: origin 'started' + one create_sub_issue per unlinked
 *     minted task, and NO creates when mirroring is off.
 *   - close_parent only once EVERY mirrored sibling is terminal — including
 *     when the LAST child is the one cancelled, and cancelling (not completing)
 *     the parent of a wholly abandoned breakdown.
 *   - Won't do -> 'cancelled'.
 *   - dispose() making the listener inert.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseService } from '../../../database/database';
import type { TrackerOutboxRow } from '../../../database/models';
import type { BacklogTaskItem, TaskChangeAction, TaskChangedEvent, TaskType } from '../../../../../shared/types/tasks';
import { insertConnection, upsertLink, listUnresolvedOutbox, updateBaseline, getLinkByEntity, getConnection, markOrphaned, type NewConnectionRow } from '../store';
import { PROVIDER_ADAPTER_GUARDS_UPDATES } from '../providerCapabilities';
import { resolveStageIds } from '../stateMapping';
import {
  backfillContentWrites,
  backfillStatusWrites,
  createWriteBackListener,
  type WriteBackBaselineStamp,
} from '../writeBack';

const PROJECT_ID = 1;
const NOW = '2026-07-30 12:00:00';

let tmpDir: string;
let svc: DatabaseService;
let raw: Database.Database;
let stageIds: ReturnType<typeof resolveStageIds>;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'cyboflow-trackersync-writeback-'));
  svc = new DatabaseService(join(tmpDir, 'test.db'));
  svc.initialize();
  raw = svc.getDb();
  raw.prepare('INSERT INTO projects (id, name, path) VALUES (?, ?, ?)').run(PROJECT_ID, 'Proj 1', '/tmp/p1');
  svc.seedDefaultBoard(PROJECT_ID);
  stageIds = resolveStageIds(raw, PROJECT_ID);
});

afterEach(() => {
  vi.restoreAllMocks();
  raw.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const BOARD_ID = `board-${PROJECT_ID}-default`;

function makeConnectionRow(overrides: Partial<NewConnectionRow> = {}): NewConnectionRow {
  return {
    id: 'conn-1',
    project_id: PROJECT_ID,
    provider: 'linear',
    status: 'active',
    workspace_id: 'ws-1',
    workspace_name: 'Acme',
    actor_label: 'K.',
    base_url: null,
    secret_ciphertext: null,
    source_json: null,
    selection_mode: 'all',
    selection_json: JSON.stringify({ containerId: 'team-1', narrowId: 'all', narrowKind: 'all' }),
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
  };
}

function seedConnection(overrides: Partial<NewConnectionRow> = {}): string {
  return insertConnection(raw, makeConnectionRow(overrides)).id;
}

function seedIdea(id: string, ref: string, stageId: string = stageIds.idea): void {
  raw
    .prepare(
      'INSERT INTO ideas (id, project_id, ref, title, summary, body, board_id, stage_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    )
    .run(id, PROJECT_ID, ref, `Idea ${ref}`, null, null, BOARD_ID, stageId);
}

function seedTask(id: string, ref: string, opts: { stageId?: string; ideaId?: string; body?: string | null } = {}): void {
  raw
    .prepare(
      `INSERT INTO tasks (id, project_id, ref, title, summary, body, board_id, stage_id, originating_idea_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      PROJECT_ID,
      ref,
      `Task ${ref}`,
      `summary ${ref}`,
      opts.body ?? null,
      BOARD_ID,
      opts.stageId ?? stageIds.ready,
      opts.ideaId ?? null,
    );
}

/** A synthesized post-commit broadcast payload, matching TaskChangeRouter's emit. */
function makeEvent(
  id: string,
  type: TaskType,
  stageId: string,
  overrides: Partial<BacklogTaskItem> = {},
  action: TaskChangeAction = 'stageMoved',
): TaskChangedEvent {
  const task: BacklogTaskItem = {
    id,
    project_id: PROJECT_ID,
    type,
    ref: id.toUpperCase(),
    title: `Title ${id}`,
    summary: null,
    body: null,
    priority: 'P2',
    category: 'feature',
    repo: null,
    parent_epic_id: null,
    originating_idea_id: null,
    scope: null,
    board_id: BOARD_ID,
    stage_id: stageId,
    archived_at: null,
    decomposed_at: null,
    approved_at: null,
    experiment_id: null,
    sort_order: null,
    version: 1,
    stage_position: 0,
    inFlow: [],
    awaitingReview: false,
    isDone: false,
    memberships: [],
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
  return { projectId: PROJECT_ID, taskId: id, action, task };
}

function makeListener() {
  return createWriteBackListener({ db: raw, nowIso: () => NOW });
}

function outbox(connectionId = 'conn-1'): TrackerOutboxRow[] {
  return listUnresolvedOutbox(raw, connectionId);
}

/** Stamp a link's baseline the way outboxWorker does after a successful write. */
function stampLastWritten(linkId: number, stamp: WriteBackBaselineStamp): void {
  updateBaseline(raw, linkId, JSON.stringify(stamp));
}

// ---------------------------------------------------------------------------
// Stage-driven write-back
// ---------------------------------------------------------------------------

describe('writeBack — stage moves', () => {
  it('enqueues update_state for a linked idea moved to Done, and dedups a repeat', () => {
    const connectionId = seedConnection();
    seedIdea('ide_1', 'IDEA-1', stageIds.done);
    upsertLink(raw, {
      connection_id: connectionId,
      entity_type: 'idea',
      entity_id: 'ide_1',
      provider: 'linear',
      external_id: 'ext-1',
    });

    const listener = makeListener();
    const event = makeEvent('ide_1', 'idea', stageIds.done);
    listener.handleTaskChanged(event);

    const rows = outbox();
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe('update_state');
    expect(rows[0].external_id).toBe('ext-1');
    expect(rows[0].entity_id).toBe('ide_1');
    expect(JSON.parse(rows[0].payload_json)).toEqual({ desiredGroup: 'completed' });

    // A replayed event must not queue the same remote write twice.
    listener.handleTaskChanged(event);
    expect(outbox()).toHaveLength(1);
  });

  it('settles the earlier queued write when a later stage move supersedes it', () => {
    // Two stage moves before either drains — the ordinary case for a card
    // dragged twice, or a task that starts and finishes inside one poll
    // interval. Only the LATEST instruction may ever reach the tracker: a stale
    // one carrying a retry backoff would otherwise drain last and drag the
    // remote issue back to where it no longer is.
    const connectionId = seedConnection();
    seedTask('tsk_1', 'TASK-1', { stageId: stageIds.done });
    upsertLink(raw, {
      connection_id: connectionId,
      entity_type: 'task',
      entity_id: 'tsk_1',
      provider: 'linear',
      external_id: 'ext-1',
    });

    const listener = makeListener();
    listener.handleTaskChanged(makeEvent('tsk_1', 'task', stageIds.inDevelopment));
    listener.handleTaskChanged(makeEvent('tsk_1', 'task', stageIds.done));

    // `outbox()` lists only UNSETTLED rows, which is the point: both intents
    // were recorded, and exactly one of them is still drainable.
    const drainable = outbox();
    expect(drainable).toHaveLength(1);
    expect(JSON.parse(drainable[0].payload_json)).toEqual({ desiredGroup: 'completed' });

    const all = raw
      .prepare('SELECT * FROM tracker_outbox ORDER BY id ASC')
      .all() as TrackerOutboxRow[];
    expect(all).toHaveLength(2);
    expect(JSON.parse(all[0].payload_json)).toEqual({ desiredGroup: 'started' });
    // Settled `done`, not `failed`: nothing went wrong, the instruction was
    // simply replaced.
    expect(all[0].state).toBe('done');
    expect(all[0].last_error).toContain('superseded');
  });

  it("maps Won't do to the 'cancelled' group", () => {
    const connectionId = seedConnection();
    seedTask('tsk_1', 'TASK-1', { stageId: stageIds.wontdo });
    upsertLink(raw, {
      connection_id: connectionId,
      entity_type: 'task',
      entity_id: 'tsk_1',
      provider: 'linear',
      external_id: 'ext-1',
    });

    makeListener().handleTaskChanged(makeEvent('tsk_1', 'task', stageIds.wontdo));

    expect(JSON.parse(outbox()[0].payload_json)).toEqual({ desiredGroup: 'cancelled' });
  });

  it('writes nothing for Ready for development (readiness is not started)', () => {
    const connectionId = seedConnection();
    seedIdea('ide_1', 'IDEA-1', stageIds.ready);
    upsertLink(raw, {
      connection_id: connectionId,
      entity_type: 'idea',
      entity_id: 'ide_1',
      provider: 'linear',
      external_id: 'ext-1',
    });

    makeListener().handleTaskChanged(makeEvent('ide_1', 'idea', stageIds.ready));

    expect(outbox()).toHaveLength(0);
  });

  it('skips a group the baseline says we already wrote', () => {
    const connectionId = seedConnection();
    seedTask('tsk_1', 'TASK-1', { stageId: stageIds.done });
    const link = upsertLink(raw, {
      connection_id: connectionId,
      entity_type: 'task',
      entity_id: 'tsk_1',
      provider: 'linear',
      external_id: 'ext-1',
    });
    stampLastWritten(link.id, {
      stateId: 'state-done',
      lastWrittenGroup: 'completed',
      lastWrittenAt: NOW,
    });

    makeListener().handleTaskChanged(makeEvent('tsk_1', 'task', stageIds.done));

    expect(outbox()).toHaveLength(0);
  });

  it('ignores an unlinked entity and a paused connection', () => {
    // (a) linked but the connection is paused
    const paused = seedConnection({ id: 'conn-paused', status: 'paused' });
    seedIdea('ide_2', 'IDEA-2', stageIds.done);
    upsertLink(raw, {
      connection_id: paused,
      entity_type: 'idea',
      entity_id: 'ide_2',
      provider: 'plane',
      external_id: 'ext-2',
    });
    // (b) not linked at all
    seedIdea('ide_3', 'IDEA-3', stageIds.done);

    const listener = makeListener();
    listener.handleTaskChanged(makeEvent('ide_2', 'idea', stageIds.done));
    listener.handleTaskChanged(makeEvent('ide_3', 'idea', stageIds.done));

    expect(outbox('conn-paused')).toHaveLength(0);
  });

  it('still enqueues on a MANUAL status connection — the mode gates the drain, not the intent', () => {
    // The old `two_way = 0` suppressed the enqueue outright, which lost the
    // stage move for good. A manual direction must instead DELAY it: the row
    // lands durably here and waits for a "Sync now" to claim it.
    const held = seedConnection({ id: 'conn-held', status_sync_mode: 'manual' });
    seedIdea('ide_1', 'IDEA-1', stageIds.done);
    upsertLink(raw, {
      connection_id: held,
      entity_type: 'idea',
      entity_id: 'ide_1',
      provider: 'linear',
      external_id: 'ext-1',
    });

    makeListener().handleTaskChanged(makeEvent('ide_1', 'idea', stageIds.done));

    const rows = outbox('conn-held');
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe('update_state');
    expect(rows[0].state).toBe('pending');
    expect(JSON.parse(rows[0].payload_json)).toEqual({ desiredGroup: 'completed' });
  });

  it('ignores an orphaned link and a deleted-action event', () => {
    const connectionId = seedConnection();
    seedIdea('ide_1', 'IDEA-1', stageIds.done);
    const link = upsertLink(raw, {
      connection_id: connectionId,
      entity_type: 'idea',
      entity_id: 'ide_1',
      provider: 'linear',
      external_id: 'ext-1',
    });
    raw.prepare("UPDATE entity_external_links SET orphaned_at = datetime('now') WHERE id = ?").run(link.id);

    const listener = makeListener();
    listener.handleTaskChanged(makeEvent('ide_1', 'idea', stageIds.done));
    expect(outbox()).toHaveLength(0);

    raw.prepare('UPDATE entity_external_links SET orphaned_at = NULL WHERE id = ?').run(link.id);
    listener.handleTaskChanged(makeEvent('ide_1', 'idea', stageIds.done, {}, 'deleted'));
    expect(outbox()).toHaveLength(0);
  });

  it('goes inert after dispose()', () => {
    const connectionId = seedConnection();
    seedIdea('ide_1', 'IDEA-1', stageIds.done);
    upsertLink(raw, {
      connection_id: connectionId,
      entity_type: 'idea',
      entity_id: 'ide_1',
      provider: 'linear',
      external_id: 'ext-1',
    });

    const listener = makeListener();
    listener.dispose();
    listener.handleTaskChanged(makeEvent('ide_1', 'idea', stageIds.done));

    expect(outbox()).toHaveLength(0);
  });

  it('swallows a routing failure instead of breaking the entity write', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const connectionId = seedConnection();
    seedIdea('ide_1', 'IDEA-1', stageIds.done);
    upsertLink(raw, {
      connection_id: connectionId,
      entity_type: 'idea',
      entity_id: 'ide_1',
      provider: 'linear',
      external_id: 'ext-1',
    });
    // An event whose project has no board makes resolveStageIds throw.
    const orphanProjectEvent = { ...makeEvent('ide_1', 'idea', stageIds.done), projectId: 999 };

    expect(() => makeListener().handleTaskChanged(orphanProjectEvent)).not.toThrow();
    expect(errorSpy).toHaveBeenCalled();
    expect(outbox()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Decomposition + sub-issue mirroring
// ---------------------------------------------------------------------------

describe('writeBack — decomposition', () => {
  function seedDecomposedIdea(connectionId: string): void {
    seedIdea('ide_1', 'IDEA-1');
    seedTask('tsk_1', 'TASK-1', { ideaId: 'ide_1', body: 'body one' });
    seedTask('tsk_2', 'TASK-2', { ideaId: 'ide_1' });
    upsertLink(raw, {
      connection_id: connectionId,
      entity_type: 'idea',
      entity_id: 'ide_1',
      provider: 'linear',
      external_id: 'ext-idea',
    });
  }

  const decomposedEvent = () =>
    makeEvent('ide_1', 'idea', '', { decomposed_at: NOW }, 'decomposed');

  it("enqueues the origin issue's 'started' write plus one create_sub_issue per unlinked minted task", () => {
    const connectionId = seedConnection();
    seedDecomposedIdea(connectionId);

    const listener = makeListener();
    listener.handleTaskChanged({
      ...decomposedEvent(),
      task: { ...decomposedEvent().task, stage_id: stageIds.idea },
    });

    const rows = outbox();
    expect(rows).toHaveLength(3);

    const stateRow = rows.find((r) => r.kind === 'update_state');
    expect(stateRow?.external_id).toBe('ext-idea');
    expect(JSON.parse(stateRow?.payload_json ?? '{}')).toEqual({ desiredGroup: 'started' });

    const creates = rows.filter((r) => r.kind === 'create_sub_issue');
    expect(creates.map((r) => r.entity_id)).toEqual(['tsk_1', 'tsk_2']);
    for (const create of creates) {
      expect(create.entity_type).toBe('task');
      expect(create.client_key).toMatch(/^[0-9a-f-]{36}$/);
    }
    // Description prefers the body, falling back to the summary. The LOCAL
    // priority/category ride along so the drain can map them against the
    // workspace's live vocabulary — which only exists there.
    expect(JSON.parse(creates[0].payload_json)).toEqual({
      parentExternalId: 'ext-idea',
      title: 'Task TASK-1',
      description: 'body one',
      priority: 'P2',
      category: 'feature',
    });
    expect(JSON.parse(creates[1].payload_json).description).toBe('summary TASK-2');
  });

  it('does not re-queue a create for a task that is already linked or already queued', () => {
    const connectionId = seedConnection();
    seedDecomposedIdea(connectionId);
    // tsk_1 already has its sub-issue.
    upsertLink(raw, {
      connection_id: connectionId,
      entity_type: 'task',
      entity_id: 'tsk_1',
      provider: 'linear',
      external_id: 'ext-sub-1',
      external_parent_id: 'ext-idea',
    });

    const listener = makeListener();
    const event = { ...decomposedEvent(), task: { ...decomposedEvent().task, stage_id: stageIds.idea } };
    listener.handleTaskChanged(event);
    // A replay must not double-create tsk_2 either.
    listener.handleTaskChanged(event);

    const creates = outbox().filter((r) => r.kind === 'create_sub_issue');
    expect(creates.map((r) => r.entity_id)).toEqual(['tsk_2']);
  });

  it('writes only the origin state when mirroring is off', () => {
    const connectionId = seedConnection({ mirror_subissues: 0 });
    seedDecomposedIdea(connectionId);

    makeListener().handleTaskChanged({
      ...decomposedEvent(),
      task: { ...decomposedEvent().task, stage_id: stageIds.idea },
    });

    const rows = outbox();
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe('update_state');
    expect(JSON.parse(rows[0].payload_json)).toEqual({ desiredGroup: 'started' });
  });

  it("does not drag a Done idea back to 'started' on a replayed decomposition", () => {
    const connectionId = seedConnection();
    seedDecomposedIdea(connectionId);

    makeListener().handleTaskChanged({
      ...decomposedEvent(),
      task: { ...decomposedEvent().task, stage_id: stageIds.done },
    });

    const stateRows = outbox().filter((r) => r.kind !== 'create_sub_issue');
    expect(stateRows).toHaveLength(1);
    expect(JSON.parse(stateRows[0].payload_json)).toEqual({ desiredGroup: 'completed' });
  });

  it('skips archived minted tasks', () => {
    const connectionId = seedConnection();
    seedDecomposedIdea(connectionId);
    raw.prepare("UPDATE tasks SET archived_at = datetime('now') WHERE id = 'tsk_2'").run();

    makeListener().handleTaskChanged({
      ...decomposedEvent(),
      task: { ...decomposedEvent().task, stage_id: stageIds.idea },
    });

    expect(outbox().filter((r) => r.kind === 'create_sub_issue').map((r) => r.entity_id)).toEqual(['tsk_1']);
  });
});

// ---------------------------------------------------------------------------
// Parent rollup
// ---------------------------------------------------------------------------

describe('writeBack — close-parent rollup', () => {
  function seedMirroredPair(
    connectionId: string,
    secondStage: string,
    firstStage: string = stageIds.done,
  ): void {
    seedIdea('ide_1', 'IDEA-1');
    seedTask('tsk_1', 'TASK-1', { ideaId: 'ide_1', stageId: firstStage });
    seedTask('tsk_2', 'TASK-2', { ideaId: 'ide_1', stageId: secondStage });
    upsertLink(raw, {
      connection_id: connectionId,
      entity_type: 'idea',
      entity_id: 'ide_1',
      provider: 'linear',
      external_id: 'ext-idea',
    });
    for (const [entityId, externalId] of [
      ['tsk_1', 'ext-sub-1'],
      ['tsk_2', 'ext-sub-2'],
    ]) {
      upsertLink(raw, {
        connection_id: connectionId,
        entity_type: 'task',
        entity_id: entityId,
        provider: 'linear',
        external_id: externalId,
        external_parent_id: 'ext-idea',
      });
    }
  }

  it('does NOT close the parent while a sibling is still open', () => {
    const connectionId = seedConnection();
    seedMirroredPair(connectionId, stageIds.inDevelopment);

    makeListener().handleTaskChanged(makeEvent('tsk_1', 'task', stageIds.done));

    const rows = outbox();
    expect(rows.map((r) => r.kind)).toEqual(['update_state']);
    expect(rows[0].external_id).toBe('ext-sub-1');
  });

  it('closes the parent once every mirrored sibling is terminal', () => {
    const connectionId = seedConnection();
    seedMirroredPair(connectionId, stageIds.done);

    makeListener().handleTaskChanged(makeEvent('tsk_2', 'task', stageIds.done));

    const rows = outbox();
    const closeRow = rows.find((r) => r.kind === 'close_parent');
    expect(closeRow?.external_id).toBe('ext-idea');
    expect(JSON.parse(closeRow?.payload_json ?? '{}')).toEqual({ desiredGroup: 'completed' });
  });

  it("counts a Won't-do sibling as settled and dedups a repeated close", () => {
    const connectionId = seedConnection();
    seedMirroredPair(connectionId, stageIds.wontdo);

    const listener = makeListener();
    const event = makeEvent('tsk_1', 'task', stageIds.done);
    listener.handleTaskChanged(event);
    listener.handleTaskChanged(event);

    expect(outbox().filter((r) => r.kind === 'close_parent')).toHaveLength(1);
  });

  it("closes the parent when the LAST open child is moved to Won't do", () => {
    const connectionId = seedConnection();
    seedMirroredPair(connectionId, stageIds.wontdo);

    // The cancelled child is the event: a rollup that only ran on 'completed'
    // would leave the parent open forever.
    makeListener().handleTaskChanged(makeEvent('tsk_2', 'task', stageIds.wontdo));

    const closeRow = outbox().find((r) => r.kind === 'close_parent');
    expect(closeRow?.external_id).toBe('ext-idea');
    // One sibling actually got done, so the breakdown completed.
    expect(JSON.parse(closeRow?.payload_json ?? '{}')).toEqual({ desiredGroup: 'completed' });
  });

  it('cancels the parent when EVERY child was abandoned', () => {
    const connectionId = seedConnection();
    seedMirroredPair(connectionId, stageIds.wontdo, stageIds.wontdo);

    makeListener().handleTaskChanged(makeEvent('tsk_2', 'task', stageIds.wontdo));

    const closeRow = outbox().find((r) => r.kind === 'close_parent');
    expect(closeRow?.external_id).toBe('ext-idea');
    // Nothing was delivered — claiming the parent as done would be a lie.
    expect(JSON.parse(closeRow?.payload_json ?? '{}')).toEqual({ desiredGroup: 'cancelled' });
  });

  it("does NOT close the parent on a Won't-do child while a sibling is open", () => {
    const connectionId = seedConnection();
    seedMirroredPair(connectionId, stageIds.wontdo, stageIds.inDevelopment);

    makeListener().handleTaskChanged(makeEvent('tsk_2', 'task', stageIds.wontdo));

    const rows = outbox();
    expect(rows.map((r) => r.kind)).toEqual(['update_state']);
    expect(rows[0].external_id).toBe('ext-sub-2');
  });

  it('does not close a parent we already wrote as completed', () => {
    const connectionId = seedConnection();
    seedMirroredPair(connectionId, stageIds.done);
    const parentLink = getLinkByEntity(raw, 'idea', 'ide_1', 'linear');
    stampLastWritten(parentLink?.id ?? 0, {
      stateId: 'state-done',
      lastWrittenGroup: 'completed',
      lastWrittenAt: NOW,
    });

    makeListener().handleTaskChanged(makeEvent('tsk_2', 'task', stageIds.done));

    expect(outbox().filter((r) => r.kind === 'close_parent')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Trigger 4 — the idea push
// ---------------------------------------------------------------------------

describe('writeBack — idea push (create_issue)', () => {
  /** The 'created' event a freshly-filed idea produces. */
  function createdEvent(id: string, overrides: Partial<BacklogTaskItem> = {}, actor?: 'user' | 'linear' | 'plane' | 'orchestrator'): TaskChangedEvent {
    const event = makeEvent(id, 'idea', stageIds.idea, overrides, 'created');
    return actor === undefined ? event : { ...event, actor };
  }

  it('enqueues one create_issue per active connection, with a client key and no external id', () => {
    seedConnection({ id: 'conn-1', provider: 'linear' });
    seedConnection({ id: 'conn-2', provider: 'plane' });
    seedIdea('ide_1', 'IDEA-1');

    makeListener().handleTaskChanged(createdEvent('ide_1', {}, 'user'));

    for (const connectionId of ['conn-1', 'conn-2']) {
      const rows = outbox(connectionId);
      expect(rows).toHaveLength(1);
      expect(rows[0].kind).toBe('create_issue');
      expect(rows[0].entity_type).toBe('idea');
      expect(rows[0].entity_id).toBe('ide_1');
      // No remote issue exists yet — that is what the row is FOR.
      expect(rows[0].external_id).toBeNull();
      // The idempotency key the worker hands the adapter.
      expect(rows[0].client_key).toMatch(/^[0-9a-f-]{36}$/);
      // The draft is composed at DRAIN time, so nothing is snapshotted here.
      expect(rows[0].payload_json).toBe('{}');
    }
  });

  it('skips a PROVIDER-authored create — the inbound import must not push its own issue back', () => {
    seedConnection();
    seedIdea('ide_1', 'IDEA-1');

    makeListener().handleTaskChanged(createdEvent('ide_1', {}, 'linear'));

    expect(outbox()).toHaveLength(0);
  });

  it('skips an idea that ALREADY carries a link for that provider', () => {
    const connectionId = seedConnection();
    seedIdea('ide_1', 'IDEA-1');
    upsertLink(raw, {
      connection_id: connectionId,
      entity_type: 'idea',
      entity_id: 'ide_1',
      provider: 'linear',
      external_id: 'ext-1',
    });

    makeListener().handleTaskChanged(createdEvent('ide_1', {}, 'user'));

    expect(outbox()).toHaveLength(0);
  });

  it('skips a body carrying the tracker-import provenance marker, even unattributed', () => {
    seedConnection();
    seedIdea('ide_1', 'IDEA-1');

    // No `actor` at all — a hand-built broadcast. The marker is the backstop.
    makeListener().handleTaskChanged(
      createdEvent('ide_1', {
        body: 'Imported body\n\n---\n<!-- cyboflow:tracker linear:ext-9 -->\nImported from Linear',
      }),
    );

    expect(outbox()).toHaveLength(0);
  });

  it('skips an A/B experiment sandbox idea', () => {
    seedConnection();
    seedIdea('ide_1', 'IDEA-1');

    makeListener().handleTaskChanged(createdEvent('ide_1', { experiment_id: 'exp-1' }, 'user'));

    expect(outbox()).toHaveLength(0);
  });

  it('skips a paused connection and dedupes a replayed create event', () => {
    seedConnection({ id: 'conn-paused', status: 'paused' });
    const active = seedConnection({ id: 'conn-active' });
    seedIdea('ide_1', 'IDEA-1');

    const listener = makeListener();
    listener.handleTaskChanged(createdEvent('ide_1', {}, 'user'));
    listener.handleTaskChanged(createdEvent('ide_1', {}, 'user'));

    expect(outbox('conn-paused')).toHaveLength(0);
    expect(outbox(active)).toHaveLength(1);
  });

  it('files ONE issue when sibling mapping rows share the project — only push_target = 1 pushes', () => {
    // Two mappings of the same Linear workspace onto one cyboflow project: the
    // second is import-only, or the idea would be filed twice remotely.
    seedConnection({ id: 'conn-team-a', push_target: 1 });
    seedConnection({ id: 'conn-team-b', push_target: 0 });
    seedIdea('ide_1', 'IDEA-1');

    makeListener().handleTaskChanged(createdEvent('ide_1', {}, 'user'));

    const pushed = outbox('conn-team-a');
    expect(pushed).toHaveLength(1);
    expect(pushed[0].kind).toBe('create_issue');
    expect(outbox('conn-team-b')).toHaveLength(0);
  });

  it('queues on a PUSH-MANUAL connection too — the drain is where the hold lives', () => {
    seedConnection({ push_mode: 'manual' });
    seedIdea('ide_1', 'IDEA-1');

    makeListener().handleTaskChanged(createdEvent('ide_1', {}, 'user'));

    const rows = outbox();
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe('create_issue');
    expect(rows[0].state).toBe('pending');
  });

  it('does not push on a stage move or on a non-idea create', () => {
    seedConnection();
    seedIdea('ide_1', 'IDEA-1');
    seedTask('tsk_1', 'TASK-1');

    const listener = makeListener();
    // An UPDATE to an existing idea is not a filing.
    listener.handleTaskChanged(makeEvent('ide_1', 'idea', stageIds.idea, {}, 'stageMoved'));
    // A task create is the mirroring path's business, not the push's.
    listener.handleTaskChanged(makeEvent('tsk_1', 'task', stageIds.idea, {}, 'created'));

    expect(outbox()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Trigger 5 — content write-back
// ---------------------------------------------------------------------------

/**
 * A baseline agreeing with `makeEvent`'s defaults on every synced field, so a
 * test that changes exactly one thing produces exactly one reason to enqueue.
 * `priority: '3'` is Linear Medium, which the seeded mapping round-trips with
 * the P2 every synthesized event carries.
 */
const SYNCED_BASELINE = {
  title: 'Title ide_1',
  description: null,
  stateId: 'state-backlog',
  priority: '3',
  category: null,
};

function linkIdea(
  connectionId: string,
  overrides: { baseline?: Record<string, unknown>; provider?: 'linear' | 'plane' | 'dart'; externalId?: string; entityId?: string } = {},
): ReturnType<typeof upsertLink> {
  return upsertLink(raw, {
    connection_id: connectionId,
    entity_type: 'idea',
    entity_id: overrides.entityId ?? 'ide_1',
    provider: overrides.provider ?? 'linear',
    external_id: overrides.externalId ?? 'ext-1',
    baseline_json: JSON.stringify(overrides.baseline ?? SYNCED_BASELINE),
  });
}

/** An entity-change event for the linked idea, with one field moved. */
function contentEvent(
  overrides: Partial<BacklogTaskItem>,
  actor?: TaskChangedEvent['actor'],
): TaskChangedEvent {
  const event = makeEvent('ide_1', 'idea', stageIds.idea, overrides, 'updated');
  return actor === undefined ? event : { ...event, actor };
}

describe('writeBack — content trigger', () => {
  beforeEach(() => {
    seedIdea('ide_1', 'IDEA-1');
  });

  it('enqueues one update_content with an EMPTY payload when the title diverges', () => {
    const connectionId = seedConnection({ content_sync_mode: 'auto' });
    linkIdea(connectionId);

    makeListener().handleTaskChanged(contentEvent({ title: 'Renamed' }));

    const rows = outbox();
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe('update_content');
    expect(rows[0].external_id).toBe('ext-1');
    expect(rows[0].entity_id).toBe('ide_1');
    // Drain-time compose: the row states an INTENT, never a payload.
    expect(rows[0].payload_json).toBe('{}');
  });

  it('fires on description and on priority, in PROVIDER space', () => {
    const connectionId = seedConnection({ content_sync_mode: 'auto' });
    linkIdea(connectionId);
    const listener = makeListener();

    // P3 and P2 both map to Linear's '3' — a LOCAL-space diff would fire here
    // and demote the user's P3 on the next inbound pass.
    listener.handleTaskChanged(contentEvent({ priority: 'P3' }));
    expect(outbox()).toHaveLength(0);

    listener.handleTaskChanged(contentEvent({ priority: 'P0' }));
    expect(outbox()).toHaveLength(1);
  });

  it('ignores the provenance FOOTER — only the remote-owned half of the body counts', () => {
    const connectionId = seedConnection({ content_sync_mode: 'auto' });
    linkIdea(connectionId, { baseline: { ...SYNCED_BASELINE, description: 'Shared body' } });

    makeListener().handleTaskChanged(
      contentEvent({ body: 'Shared body\n\n---\n<!-- cyboflow:tracker linear:ext-1 -->\nImported' }),
    );

    expect(outbox()).toHaveLength(0);
  });

  it('does NOT fire on a provider-authored event, even when the entity diverges', () => {
    const connectionId = seedConnection({ content_sync_mode: 'auto' });
    linkIdea(connectionId);

    makeListener().handleTaskChanged(contentEvent({ title: 'Renamed' }, 'linear'));

    expect(outbox()).toHaveLength(0);
  });

  it('does NOT fire when the baseline never synced the field (the backfill arm)', () => {
    const connectionId = seedConnection({ content_sync_mode: 'auto' });
    // A pre-feature link: no priority key at all.
    linkIdea(connectionId, {
      baseline: { title: 'Title ide_1', description: null, stateId: 'state-backlog' },
    });

    makeListener().handleTaskChanged(contentEvent({ priority: 'P0' }));

    expect(outbox()).toHaveLength(0);
  });

  it("declines the enqueue entirely when content sync is 'off'", () => {
    const connectionId = seedConnection({ content_sync_mode: 'off' });
    linkIdea(connectionId);

    makeListener().handleTaskChanged(contentEvent({ title: 'Renamed' }));

    // Not delayed — DECLINED. A queued row of a kind no drain will ever claim
    // halts the inbound batch at this issue forever (invariant 5).
    expect(outbox()).toHaveLength(0);
  });

  it('collapses a burst onto the PENDING row, but succeeds an in-flight one', () => {
    const connectionId = seedConnection({ content_sync_mode: 'auto' });
    linkIdea(connectionId);
    const listener = makeListener();

    listener.handleTaskChanged(contentEvent({ title: 'Rename 1' }));
    listener.handleTaskChanged(contentEvent({ title: 'Rename 2' }));
    expect(outbox()).toHaveLength(1);

    // The row is now on the wire, carrying a payload composed from 'Rename 2'.
    raw.prepare("UPDATE tracker_outbox SET state = 'in_flight'").run();
    listener.handleTaskChanged(contentEvent({ title: 'Rename 3' }));

    // Suppressing here would lose 'Rename 3' outright — the in-flight write is
    // going to land the older text and no row would be left to say otherwise.
    const rows = outbox();
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.state)).toEqual(['in_flight', 'pending']);
  });

  it('gives two connections on ONE idea two independent decisions', () => {
    const linearConn = seedConnection({ id: 'conn-linear', content_sync_mode: 'auto' });
    const planeConn = seedConnection({
      id: 'conn-plane',
      provider: 'plane',
      content_sync_mode: 'off',
    });
    linkIdea(linearConn, { externalId: 'ext-lin' });
    linkIdea(planeConn, { provider: 'plane', externalId: 'proj/ext-plane' });

    makeListener().handleTaskChanged(contentEvent({ title: 'Renamed' }));

    expect(outbox('conn-linear')).toHaveLength(1);
    // resolveLinked would have answered 'linear' and stopped; the off-mode
    // connection has to be reached and then declined on its own terms.
    expect(outbox('conn-plane')).toHaveLength(0);
  });

  it('says nothing about an entity on its way OUT of the tracker', () => {
    const connectionId = seedConnection({ content_sync_mode: 'auto', archive_sync_mode: 'off' });
    linkIdea(connectionId);

    makeListener().handleTaskChanged(
      contentEvent({ title: 'Renamed', archived_at: '2026-07-30 12:00:00' }),
    );

    expect(outbox()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Trigger 5's backfill arm — content sync leaving 'off'
// ---------------------------------------------------------------------------

/**
 * The baseline a CONVERGED seeded idea has: `seedIdea` writes title
 * "Idea IDEA-1" with a null body, and P2 maps to Linear's '3' (see the content
 * trigger's provider-space test). SYNCED_BASELINE deliberately differs on
 * title, which is what makes it the DIVERGENT fixture here.
 */
const CONVERGED_BASELINE = {
  title: 'Idea IDEA-1',
  description: null,
  stateId: 'state-backlog',
  priority: '3',
  category: null,
};

function backfill(connectionId: string): number {
  const connection = getConnection(raw, connectionId);
  if (connection === null) throw new Error(`no connection ${connectionId}`);
  return backfillContentWrites({ db: raw, nowIso: () => NOW }, connection);
}

describe('writeBack — content backfill on turning the direction on', () => {
  beforeEach(() => {
    seedIdea('ide_1', 'IDEA-1');
  });

  it('enqueues the write an edit made while the direction was off never queued', () => {
    // The exact reported shape: the edit landed under 'off' (declined, no row),
    // and the user then turned content sync on.
    const connectionId = seedConnection({ content_sync_mode: 'off' });
    linkIdea(connectionId);
    makeListener().handleTaskChanged(contentEvent({ title: 'Renamed' }));
    expect(outbox()).toHaveLength(0);

    raw.prepare("UPDATE tracker_connections SET content_sync_mode = 'auto' WHERE id = ?").run(connectionId);
    expect(backfill(connectionId)).toBe(1);

    const rows = outbox();
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe('update_content');
    expect(rows[0].external_id).toBe('ext-1');
    expect(rows[0].entity_id).toBe('ide_1');
    expect(rows[0].payload_json).toBe('{}');
  });

  it('enqueues NOTHING for an entity that already matches its baseline', () => {
    const connectionId = seedConnection({ content_sync_mode: 'auto' });
    linkIdea(connectionId, { baseline: CONVERGED_BASELINE });

    expect(backfill(connectionId)).toBe(0);
    expect(outbox()).toHaveLength(0);
  });

  it("is inert while the direction is still 'off'", () => {
    // The guard matters: the caller reads the connection back AFTER the patch,
    // and a mis-ordered call would otherwise queue undrainable rows.
    const connectionId = seedConnection({ content_sync_mode: 'off' });
    linkIdea(connectionId);

    expect(backfill(connectionId)).toBe(0);
    expect(outbox()).toHaveLength(0);
  });

  it('skips an ARCHIVED entity — the archive direction owns those', () => {
    const connectionId = seedConnection({ content_sync_mode: 'auto' });
    linkIdea(connectionId);
    raw.prepare("UPDATE ideas SET archived_at = ? WHERE id = 'ide_1'").run(NOW);

    expect(backfill(connectionId)).toBe(0);
    expect(outbox()).toHaveLength(0);
  });

  it('skips an ORPHANED link — its issue is already gone remotely', () => {
    const connectionId = seedConnection({ content_sync_mode: 'auto' });
    markOrphaned(raw, linkIdea(connectionId).id);

    expect(backfill(connectionId)).toBe(0);
    expect(outbox()).toHaveLength(0);
  });

  it('skips a link whose entity row is gone', () => {
    const connectionId = seedConnection({ content_sync_mode: 'auto' });
    linkIdea(connectionId, { entityId: 'ide_missing' });

    expect(backfill(connectionId)).toBe(0);
    expect(outbox()).toHaveLength(0);
  });

  it('is idempotent — a second flip collapses onto the pending row', () => {
    const connectionId = seedConnection({ content_sync_mode: 'auto' });
    linkIdea(connectionId);

    expect(backfill(connectionId)).toBe(1);
    expect(backfill(connectionId)).toBe(0);
    expect(outbox()).toHaveLength(1);
  });

  it('reaches every divergent link on the connection, not just the first', () => {
    const connectionId = seedConnection({ content_sync_mode: 'auto' });
    seedIdea('ide_2', 'IDEA-2');
    linkIdea(connectionId);
    linkIdea(connectionId, { entityId: 'ide_2', externalId: 'ext-2' });

    expect(backfill(connectionId)).toBe(2);
    expect(outbox().map((row) => row.external_id).sort()).toEqual(['ext-1', 'ext-2']);
  });

  it('does not touch a PAUSED connection', () => {
    const connectionId = seedConnection({ content_sync_mode: 'auto', status: 'paused' });
    linkIdea(connectionId);

    expect(backfill(connectionId)).toBe(0);
    expect(outbox()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Status sync 'off' (migration 130) + its backfill arm
// ---------------------------------------------------------------------------

function statusBackfill(connectionId: string): number {
  const connection = getConnection(raw, connectionId);
  if (connection === null) throw new Error(`no connection ${connectionId}`);
  return backfillStatusWrites({ db: raw, nowIso: () => NOW }, connection);
}

describe("writeBack — status sync 'off'", () => {
  it('DECLINES a stage move outright, exactly as content off does', () => {
    const connectionId = seedConnection({ status_sync_enabled: 0 });
    seedIdea('ide_1', 'IDEA-1', stageIds.done);
    linkIdea(connectionId);

    makeListener().handleTaskChanged(makeEvent('ide_1', 'idea', stageIds.done));

    // Not delayed — DECLINED. A queued row of a kind no drain will ever claim
    // halts the inbound batch at this issue forever (invariant 5).
    expect(outbox()).toHaveLength(0);
  });

  it('declines the close_parent rollup too — one gate covers both status kinds', () => {
    const connectionId = seedConnection({ status_sync_enabled: 0, mirror_subissues: 1 });
    seedIdea('ide_1', 'IDEA-1');
    seedTask('tsk_1', 'TASK-1', { stageId: stageIds.done, ideaId: 'ide_1' });
    upsertLink(raw, {
      connection_id: connectionId,
      entity_type: 'task',
      entity_id: 'tsk_1',
      provider: 'linear',
      external_id: 'ext-child',
      external_parent_id: 'ext-parent',
    });

    makeListener().handleTaskChanged(makeEvent('tsk_1', 'task', stageIds.done));

    expect(outbox()).toHaveLength(0);
  });

  it('still enqueues at MANUAL — the mode gates the drain, only off declines', () => {
    const connectionId = seedConnection({ status_sync_mode: 'manual', status_sync_enabled: 1 });
    seedIdea('ide_1', 'IDEA-1', stageIds.done);
    linkIdea(connectionId);

    makeListener().handleTaskChanged(makeEvent('ide_1', 'idea', stageIds.done));

    expect(outbox()).toHaveLength(1);
    expect(outbox()[0].kind).toBe('update_state');
  });
});

describe('writeBack — status backfill on turning the direction on', () => {
  it('enqueues the stage move the direction declined while it was off', () => {
    const connectionId = seedConnection({ status_sync_enabled: 0 });
    seedIdea('ide_1', 'IDEA-1', stageIds.done);
    linkIdea(connectionId);
    makeListener().handleTaskChanged(makeEvent('ide_1', 'idea', stageIds.done));
    expect(outbox()).toHaveLength(0);

    raw.prepare('UPDATE tracker_connections SET status_sync_enabled = 1 WHERE id = ?').run(connectionId);
    expect(statusBackfill(connectionId)).toBe(1);

    const rows = outbox();
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe('update_state');
    expect(rows[0].external_id).toBe('ext-1');
    expect(JSON.parse(rows[0].payload_json)).toEqual({ desiredGroup: 'completed' });
  });

  it('says nothing for a stage that maps to NO group', () => {
    // Ready for development deliberately writes nothing — readiness is not
    // "started" — and a backfill must not start saying what that stage never said.
    const connectionId = seedConnection();
    seedIdea('ide_1', 'IDEA-1', stageIds.ready);
    linkIdea(connectionId);

    expect(statusBackfill(connectionId)).toBe(0);
    expect(outbox()).toHaveLength(0);
  });

  it('says nothing when the baseline already records that group as written', () => {
    const connectionId = seedConnection();
    seedIdea('ide_1', 'IDEA-1', stageIds.done);
    const link = linkIdea(connectionId);
    stampLastWritten(link.id, {
      stateId: 'state-done',
      lastWrittenGroup: 'completed',
      lastWrittenAt: NOW,
    });

    expect(statusBackfill(connectionId)).toBe(0);
    expect(outbox()).toHaveLength(0);
  });

  it('skips archived entities, orphaned links, and missing entity rows', () => {
    const connectionId = seedConnection();
    seedIdea('ide_1', 'IDEA-1', stageIds.done);
    seedIdea('ide_2', 'IDEA-2', stageIds.done);
    linkIdea(connectionId);
    raw.prepare("UPDATE ideas SET archived_at = ? WHERE id = 'ide_1'").run(NOW);
    markOrphaned(raw, linkIdea(connectionId, { entityId: 'ide_2', externalId: 'ext-2' }).id);
    linkIdea(connectionId, { entityId: 'ide_missing', externalId: 'ext-3' });

    expect(statusBackfill(connectionId)).toBe(0);
    expect(outbox()).toHaveLength(0);
  });

  it("is inert while the direction is still off, and on a paused connection", () => {
    const offConn = seedConnection({ id: 'conn-off', status_sync_enabled: 0 });
    const pausedConn = seedConnection({ id: 'conn-paused', status: 'paused' });
    seedIdea('ide_1', 'IDEA-1', stageIds.done);
    linkIdea(offConn);
    linkIdea(pausedConn, { externalId: 'ext-2' });

    expect(statusBackfill(offConn)).toBe(0);
    expect(statusBackfill(pausedConn)).toBe(0);
    expect(outbox('conn-off')).toHaveLength(0);
    expect(outbox('conn-paused')).toHaveLength(0);
  });

  it('is idempotent — a second flip collapses onto the pending row', () => {
    const connectionId = seedConnection();
    seedIdea('ide_1', 'IDEA-1', stageIds.done);
    linkIdea(connectionId);

    expect(statusBackfill(connectionId)).toBe(1);
    expect(statusBackfill(connectionId)).toBe(0);
    expect(outbox()).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Trigger 6 — archive
// ---------------------------------------------------------------------------

describe('writeBack — archive trigger', () => {
  beforeEach(() => {
    seedIdea('ide_1', 'IDEA-1');
  });

  function archivedEvent(actor?: TaskChangedEvent['actor']): TaskChangedEvent {
    return contentEvent({ archived_at: '2026-07-30 12:00:00' }, actor);
  }

  it('enqueues archive_issue on the archive, once, and supersedes every queued kind', () => {
    const connectionId = seedConnection({ archive_sync_mode: 'auto', content_sync_mode: 'auto' });
    const link = linkIdea(connectionId);
    const listener = makeListener();

    // A state write and a content write are already queued for this issue.
    listener.handleTaskChanged(makeEvent('ide_1', 'idea', stageIds.done));
    listener.handleTaskChanged(contentEvent({ title: 'Renamed' }));
    expect(outbox()).toHaveLength(2);

    listener.handleTaskChanged(archivedEvent());

    const rows = outbox();
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe('archive_issue');
    expect(rows[0].payload_json).toBe('{}');
    expect(link.id).toBeGreaterThan(0);

    // A replayed archive event adds nothing.
    listener.handleTaskChanged(archivedEvent());
    expect(outbox()).toHaveLength(1);
  });

  it("declines for 'off', for a provider with no archive endpoint, and for the provider actor", () => {
    const off = seedConnection({ id: 'conn-off', archive_sync_mode: 'off' });
    const plane = seedConnection({
      id: 'conn-plane',
      provider: 'plane',
      archive_sync_mode: 'auto',
    });
    const linear = seedConnection({ id: 'conn-lin', archive_sync_mode: 'auto' });
    linkIdea(off, { externalId: 'ext-off' });
    linkIdea(plane, { provider: 'plane', externalId: 'proj/ext-plane' });
    linkIdea(linear, { provider: 'dart', externalId: 'ext-dart' });
    const listener = makeListener();

    listener.handleTaskChanged(archivedEvent('linear'));
    expect([...outbox('conn-off'), ...outbox('conn-plane'), ...outbox('conn-lin')]).toHaveLength(0);

    listener.handleTaskChanged(archivedEvent());
    expect(outbox('conn-off')).toHaveLength(0);
    // Plane declares archive: 'none' — a row here could only ever throw, and an
    // unsettleable row halts inbound for that issue forever.
    expect(outbox('conn-plane')).toHaveLength(0);
    expect(outbox('conn-lin')).toHaveLength(1);
  });

  it('re-arms after an unarchive: the stamp is cleared, and nothing is written remotely', () => {
    const connectionId = seedConnection({ archive_sync_mode: 'auto' });
    const link = linkIdea(connectionId, {
      baseline: { ...SYNCED_BASELINE, archivedWrittenAt: '2026-07-29 09:00:00' },
    });
    const listener = makeListener();

    // Already archived remotely -> the replayed archive says nothing.
    listener.handleTaskChanged(archivedEvent());
    expect(outbox()).toHaveLength(0);

    // Unarchived locally: no remote write, but the stamp goes…
    listener.handleTaskChanged(contentEvent({}));
    expect(outbox()).toHaveLength(0);
    expect(JSON.parse(getLinkByEntity(raw, 'idea', 'ide_1', 'linear')?.baseline_json ?? '{}')).not.toHaveProperty(
      'archivedWrittenAt',
    );

    // …so a LATER archive is a genuine first write again.
    listener.handleTaskChanged(archivedEvent());
    expect(outbox().map((row) => row.kind)).toEqual(['archive_issue']);
  });
});

// ---------------------------------------------------------------------------
// The guarded-update enqueue gate
// ---------------------------------------------------------------------------

/**
 * A provider that REQUIRES guarded writes but whose shipped adapter cannot make
 * them (docs/proposals/tracker-beads-provider.md, "The disable must be
 * expressible"). Simulated by flipping the provision table for the duration of
 * one test — the requirement half is a permanent fact about beads, the
 * provision half is a fact about the build, and only the pair gates the
 * enqueue.
 *
 * The gate lives HERE, at enqueue, rather than only at drain, for the reason
 * invariant 5 gives for the 'off' modes: a queued row nothing will ever send is
 * a permanent inbound stall, because the blocker that halts the inbound batch
 * at an issue is KIND-AGNOSTIC.
 */
function withDegradedGuards(body: () => void): void {
  const restore = PROVIDER_ADAPTER_GUARDS_UPDATES.beads;
  PROVIDER_ADAPTER_GUARDS_UPDATES.beads = false;
  try {
    body();
  } finally {
    PROVIDER_ADAPTER_GUARDS_UPDATES.beads = restore;
  }
}

describe('writeBack — guarded-update enqueue gate', () => {
  it('enqueues nothing for a stage move when the adapter cannot guard', () => {
    withDegradedGuards(() => {
      const connectionId = seedConnection({ provider: 'beads' });
      seedIdea('ide_1', 'IDEA-1', stageIds.done);
      upsertLink(raw, {
        connection_id: connectionId,
        entity_type: 'idea',
        entity_id: 'ide_1',
        provider: 'beads',
        external_id: 'ext-1',
      });

      makeListener().handleTaskChanged(makeEvent('ide_1', 'idea', stageIds.done));

      expect(outbox()).toHaveLength(0);
    });
  });

  /**
   * The content scenario, set up once. Returned as a closure so the SAME
   * scenario can be run degraded and undegraded — a gate test that only ever
   * asserts "nothing was enqueued" cannot tell a working gate from a scenario
   * that would have enqueued nothing anyway.
   */
  function seedContentScenario(): () => void {
    const connectionId = seedConnection({
      provider: 'beads',
      content_sync_mode: 'auto',
    });
    seedIdea('ide_1', 'IDEA-1');
    upsertLink(raw, {
      connection_id: connectionId,
      entity_type: 'idea',
      entity_id: 'ide_1',
      provider: 'beads',
      external_id: 'ext-1',
      baseline_json: JSON.stringify({
        title: 'Remote title',
        description: null,
        stateId: 'open',
        priority: '2',
        category: 'feature',
      }),
    });
    const listener = makeListener();
    return () => {
      listener.handleTaskChanged(
        makeEvent('ide_1', 'idea', stageIds.idea, { title: 'Edited' }, 'updated'),
      );
    };
  }

  it('enqueues nothing for a content edit when the adapter cannot guard', () => {
    const run = seedContentScenario();
    withDegradedGuards(run);
    expect(outbox()).toHaveLength(0);

    // POSITIVE CONTROL, same scenario: the gate is what suppressed it, not the
    // fixture.
    run();
    expect(outbox().map((row) => row.kind)).toEqual(['update_content']);
  });

  it('CREATES still flow — a fresh issue has no concurrent editor to race', () => {
    withDegradedGuards(() => {
      seedConnection({ id: 'conn-1', provider: 'beads' });
      seedIdea('ide_1', 'IDEA-1');

      makeListener().handleTaskChanged(makeEvent('ide_1', 'idea', stageIds.idea, {}, 'created'));

      expect(outbox().map((row) => row.kind)).toEqual(['create_issue']);
    });
  });

  it('the SHIPPED beads adapter guards, so nothing is gated in the ordinary build', () => {
    const connectionId = seedConnection({ provider: 'beads' });
    seedIdea('ide_1', 'IDEA-1', stageIds.done);
    upsertLink(raw, {
      connection_id: connectionId,
      entity_type: 'idea',
      entity_id: 'ide_1',
      provider: 'beads',
      external_id: 'ext-1',
    });

    makeListener().handleTaskChanged(makeEvent('ide_1', 'idea', stageIds.done));

    expect(outbox().map((row) => row.kind)).toEqual(['update_state']);
  });
});
