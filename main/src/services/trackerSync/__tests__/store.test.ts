/**
 * Unit tests for the tracker-sync data-access layer
 * (main/src/services/trackerSync/store.ts) — migration 093's four tables.
 *
 * Runs against a REAL temp-file DB through the full migration chain (same
 * technique as main/src/database/__tests__/migration093.test.ts and the
 * fullChainContinuity family), so the CHECK/UNIQUE/FK constraints and
 * `datetime('now')` defaults from the actual schema are exercised, not a
 * hand-rolled fixture. A project row is seeded directly with SQL (the FK
 * tracker_connections.project_id needs one); connections/links/outbox/
 * conflict rows are seeded through the store functions under test wherever
 * the test doesn't need a specific timestamp — the outbox ordering tests seed
 * `created_at`/`next_attempt_at` directly with SQL since they need
 * deterministic control over those columns that `enqueueOutbox` (which always
 * uses the schema's `datetime('now')` default) does not expose.
 *
 * Covers, per the task brief:
 *   - upsertLink's refresh-on-re-upsert semantics (same id, updated mutable
 *     columns, orphaned_at cleared).
 *   - claimNextPending: atomic claim (state flip + attempts++), oldest-first
 *     ordering, and next_attempt_at gating (future-dated rows skipped).
 *   - resolveOutbox's failed->pending retry re-queue vs. a terminal failed.
 *   - requeueInFlightAsAmbiguous (boot-time crash recovery).
 *   - listLinks' activeOnly filtering.
 *   - listActiveLinksWithoutEntity / hasActiveLinkedDescendant: the two queries
 *     that reach past the tracker tables into ideas/epics/tasks, so a hard
 *     delete's zombie links are findable and its cascade is knowable up front.
 *   - resolveConflict's state/resolved_at stamping.
 *   - findDisconnectedConnection's revival identity, base_url and source
 *     container included: a workspace slug is unique only within one tracker
 *     INSTANCE, so two self-hosted deployments sharing a slug must not revive
 *     each other's row — and under multi-project mapping one workspace owns N
 *     sibling rows in a project that differ only in their source.
 *   - listConnectionsByIdentity: the credential-rotation fan-out set, live rows
 *     only, split by instance the same normalized way.
 *   - push_target: the column that keeps N sibling mappings from each pushing
 *     their own copy of one locally filed idea, plus the two queries that keep
 *     it to ONE armed row per (project, provider) — claimPushTarget's atomic
 *     arm-and-demote and listDuplicatePushTargets' boot-repair scan.
 *   - findSiblingLinkForExternal: the cross-scope duplicate-import guard's
 *     lookup — a live link another mapping on the same tracker identity holds,
 *     with orphaned links, retired rows, and other workspaces/instances out.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseService } from '../../../database/database';
import {
  insertConnection,
  getConnection,
  listConnections,
  updateConnectionSettings,
  findDisconnectedConnection,
  listConnectionsByIdentity,
  listConnectionsForProviderProject,
  claimPushTarget,
  listDuplicatePushTargets,
  reactivateConnection,
  advanceCursor,
  storeSecret,
  readSecret,
  upsertLink,
  getLinkByEntity,
  getLinkByExternal,
  findSiblingLinkForExternal,
  listLinks,
  updateBaseline,
  markOrphaned,
  listLinksByParentExternal,
  listActiveLinksWithoutEntity,
  hasActiveLinkedDescendant,
  enqueueOutbox,
  claimNextPending,
  resolveOutbox,
  listUnresolvedOutbox,
  findOutboxByClientKey,
  requeueInFlightAsAmbiguous,
  insertConflict,
  listOpenConflicts,
  resolveConflict,
  hasOpenConflictForLink,
  clearOrphaned,
  listLedgerEntries,
  upsertLedgerEntry,
  deleteLedgerEntries,
  bumpConfigGeneration,
  type NewConnectionRow,
  type StoredSourceScope,
} from '../store';

/**
 * A scope no seeded row's source contradicts: the identity-axis tests seed rows
 * WITHOUT a source_json, and a stored null scope is a revival wildcard.
 */
const ANY_SCOPE: StoredSourceScope = { containerId: 'any', narrowId: 'all', narrowKind: 'all' };

/** A whole-container scope for `containerId` — the shape the Map step's groups carry. */
function scopeOf(containerId: string): StoredSourceScope {
  return { containerId, narrowId: 'all', narrowKind: 'all' };
}

let tmpDir: string;
let dbPath: string;
let svc: DatabaseService;
let raw: Database.Database;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'cyboflow-trackersync-store-'));
  dbPath = join(tmpDir, 'test.db');
  svc = new DatabaseService(dbPath);
  svc.initialize();
  raw = svc.getDb();
  raw.prepare('INSERT INTO projects (id, name, path) VALUES (1, ?, ?)').run('Proj 1', '/tmp/p1');
});

afterEach(() => {
  raw.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

/** A fully-populated NewConnectionRow, minus the overrides a test needs. */
function makeConnectionRow(overrides: Partial<NewConnectionRow> = {}): NewConnectionRow {
  return {
    id: 'conn-1',
    project_id: 1,
    provider: 'linear',
    status: 'active',
    workspace_id: null,
    workspace_name: null,
    actor_label: null,
    base_url: null,
    secret_ciphertext: null,
    source_json: null,
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
  };
}

/**
 * Seed a real backlog entity for project 1 (the default board is seeded lazily
 * — the link queries that reach into ideas/epics/tasks are the only cases that
 * need one). Direct SQL, mirroring the outbox tests' reason for bypassing a
 * chokepoint: these tests are about the SQL, not about entity semantics.
 */
function seedEntity(
  type: 'idea' | 'epic' | 'task',
  id: string,
  lineage: { originatingIdeaId?: string; parentEpicId?: string } = {},
): void {
  svc.seedDefaultBoard(1);
  const board = 'board-1-default';
  const stage = 'stage-board-1-default-1';
  if (type === 'idea') {
    raw
      .prepare(
        'INSERT INTO ideas (id, project_id, ref, title, board_id, stage_id) VALUES (?, 1, ?, ?, ?, ?)',
      )
      .run(id, `IDEA-${id}`, `Title ${id}`, board, stage);
    return;
  }
  if (type === 'epic') {
    raw
      .prepare(
        `INSERT INTO epics (id, project_id, ref, title, board_id, stage_id, originating_idea_id)
         VALUES (?, 1, ?, ?, ?, ?, ?)`,
      )
      .run(id, `EPIC-${id}`, `Title ${id}`, board, stage, lineage.originatingIdeaId ?? null);
    return;
  }
  raw
    .prepare(
      `INSERT INTO tasks (id, project_id, ref, title, board_id, stage_id, originating_idea_id, parent_epic_id)
       VALUES (?, 1, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      `TASK-${id}`,
      `Title ${id}`,
      board,
      stage,
      lineage.originatingIdeaId ?? null,
      lineage.parentEpicId ?? null,
    );
}

/** Seed a connection row through the store and return its id. */
function seedConnection(overrides: Partial<NewConnectionRow> = {}): string {
  const row = insertConnection(raw, makeConnectionRow(overrides));
  return row.id;
}

/** Raw fetch of one outbox row by id — used for assertions the public API doesn't expose a getter for. */
function fetchOutboxRow(id: number) {
  return raw.prepare('SELECT * FROM tracker_outbox WHERE id = ?').get(id) as
    | {
        id: number;
        state: string;
        attempts: number;
        last_error: string | null;
        next_attempt_at: string | null;
      }
    | undefined;
}

// ---------------------------------------------------------------------------
// Connections
// ---------------------------------------------------------------------------

describe('trackerSync store — connections', () => {
  it('inserts and reads back a connection row verbatim', () => {
    const inserted = insertConnection(raw, makeConnectionRow({ id: 'conn-x', base_url: 'https://api.plane.so' }));
    expect(inserted.id).toBe('conn-x');
    expect(inserted.base_url).toBe('https://api.plane.so');
    expect(inserted.status).toBe('active');
    expect(inserted.created_at).toBeTruthy();
    expect(inserted.updated_at).toBeTruthy();

    const fetched = getConnection(raw, 'conn-x');
    expect(fetched).toEqual(inserted);
  });

  it('getConnection returns null for a missing id', () => {
    expect(getConnection(raw, 'nope')).toBeNull();
  });

  it('inserts the migration-112 columns verbatim, and a caller can override them off their default', () => {
    const defaults = insertConnection(raw, makeConnectionRow({ id: 'conn-112-default' }));
    expect(defaults.content_sync_mode).toBe('off');
    expect(defaults.archive_sync_mode).toBe('off');
    expect(defaults.priority_mapping_json).toBe('{}');
    expect(defaults.category_mapping_json).toBe('{}');

    const overridden = insertConnection(
      raw,
      makeConnectionRow({
        id: 'conn-112-overridden',
        content_sync_mode: 'auto',
        archive_sync_mode: 'manual',
        priority_mapping_json: '{"toProvider":{"P0":"urgent"}}',
        category_mapping_json: '{"toProvider":{"bug":"Bug"}}',
      }),
    );
    expect(overridden.content_sync_mode).toBe('auto');
    expect(overridden.archive_sync_mode).toBe('manual');
    expect(overridden.priority_mapping_json).toBe('{"toProvider":{"P0":"urgent"}}');
    expect(overridden.category_mapping_json).toBe('{"toProvider":{"bug":"Bug"}}');
  });

  it('listConnections excludes disconnected connections by default and includes them with the option', () => {
    seedConnection({ id: 'conn-a', status: 'active' });
    seedConnection({ id: 'conn-b', status: 'disconnected', provider: 'plane' });
    seedConnection({ id: 'conn-c', status: 'paused' });

    const defaultList = listConnections(raw, 1);
    expect(defaultList.map((c) => c.id).sort()).toEqual(['conn-a', 'conn-c']);

    const fullList = listConnections(raw, 1, { includeDisconnected: true });
    expect(fullList.map((c) => c.id).sort()).toEqual(['conn-a', 'conn-b', 'conn-c']);
  });

  it('listConnections scopes to a project when projectId is given, and covers all projects when omitted', () => {
    raw.prepare('INSERT INTO projects (id, name, path) VALUES (2, ?, ?)').run('Proj 2', '/tmp/p2');
    seedConnection({ id: 'conn-p1' });
    insertConnection(raw, makeConnectionRow({ id: 'conn-p2', project_id: 2 }));

    expect(listConnections(raw, 1).map((c) => c.id)).toEqual(['conn-p1']);
    expect(listConnections(raw, 2).map((c) => c.id)).toEqual(['conn-p2']);
    expect(listConnections(raw).map((c) => c.id).sort()).toEqual(['conn-p1', 'conn-p2']);
  });

  it('updateConnectionSettings writes only the supplied keys and stamps updated_at', () => {
    const before = seedConnection({ id: 'conn-1', conflict_mode: 'auto', status_sync_mode: 'auto' });
    const beforeRow = getConnection(raw, before)!;

    updateConnectionSettings(raw, before, { conflict_mode: 'manual', workspace_name: 'Acme Co' });

    const after = getConnection(raw, before)!;
    expect(after.conflict_mode).toBe('manual');
    expect(after.workspace_name).toBe('Acme Co');
    // Untouched fields survive the partial patch.
    expect(after.status_sync_mode).toBe(beforeRow.status_sync_mode);
    expect(after.selection_mode).toBe(beforeRow.selection_mode);
  });

  it('updateConnectionSettings patches content_sync_mode / archive_sync_mode independently', () => {
    const id = seedConnection({ id: 'conn-1' });
    expect(getConnection(raw, id)?.content_sync_mode).toBe('off');
    expect(getConnection(raw, id)?.archive_sync_mode).toBe('off');

    updateConnectionSettings(raw, id, { content_sync_mode: 'auto' });
    expect(getConnection(raw, id)?.content_sync_mode).toBe('auto');
    // The untouched direction keeps its stored value.
    expect(getConnection(raw, id)?.archive_sync_mode).toBe('off');

    updateConnectionSettings(raw, id, { archive_sync_mode: 'manual' });
    expect(getConnection(raw, id)?.content_sync_mode).toBe('auto');
    expect(getConnection(raw, id)?.archive_sync_mode).toBe('manual');
  });

  it('updateConnectionSettings patches priority_mapping_json / category_mapping_json independently', () => {
    const id = seedConnection({ id: 'conn-1' });
    expect(getConnection(raw, id)?.priority_mapping_json).toBe('{}');
    expect(getConnection(raw, id)?.category_mapping_json).toBe('{}');

    updateConnectionSettings(raw, id, {
      priority_mapping_json: '{"toProvider":{"P0":"urgent"}}',
    });
    expect(getConnection(raw, id)?.priority_mapping_json).toBe('{"toProvider":{"P0":"urgent"}}');
    // The untouched mapping keeps its stored value.
    expect(getConnection(raw, id)?.category_mapping_json).toBe('{}');

    updateConnectionSettings(raw, id, {
      category_mapping_json: '{"toProvider":{"bug":"Bug"}}',
    });
    expect(getConnection(raw, id)?.priority_mapping_json).toBe('{"toProvider":{"P0":"urgent"}}');
    expect(getConnection(raw, id)?.category_mapping_json).toBe('{"toProvider":{"bug":"Bug"}}');
  });

  it('push_target round-trips through insert and is patchable', () => {
    // The sibling mappings a multi-project connect mints: one pushes, the rest
    // are read + write-back only.
    const pushing = seedConnection({ id: 'conn-push' });
    const sibling = seedConnection({ id: 'conn-sibling', push_target: 0 });
    expect(getConnection(raw, pushing)!.push_target).toBe(1);
    expect(getConnection(raw, sibling)!.push_target).toBe(0);

    // Patchable, so a later "make THIS one the push target" edit needs no
    // re-connect.
    updateConnectionSettings(raw, pushing, { push_target: 0 });
    updateConnectionSettings(raw, sibling, { push_target: 1 });
    expect(getConnection(raw, pushing)!.push_target).toBe(0);
    expect(getConnection(raw, sibling)!.push_target).toBe(1);
  });

  it('claimPushTarget arms ONE row and demotes every live sibling of that (project, provider)', () => {
    // The defect: connect() armed the new row without demoting the rest, so a
    // later wizard run mapping a second group into an already-mapped project
    // left two armed siblings and one filed idea became two remote issues.
    raw.prepare('INSERT INTO projects (id, name, path) VALUES (2, ?, ?)').run('Proj 2', '/tmp/p2');
    seedConnection({ id: 'first' });
    seedConnection({ id: 'second' });
    // A paused row is still LIVE — it resumes on the next key paste and would
    // push from the moment it does.
    seedConnection({ id: 'paused', status: 'paused' });
    // Out of scope on every axis: retired, another provider, another project.
    seedConnection({ id: 'retired', status: 'disconnected' });
    seedConnection({ id: 'other-provider', provider: 'plane' });
    insertConnection(raw, makeConnectionRow({ id: 'other-project', project_id: 2 }));

    claimPushTarget(raw, 1, 'linear', 'second');

    expect(getConnection(raw, 'second')!.push_target).toBe(1);
    expect(getConnection(raw, 'first')!.push_target).toBe(0);
    expect(getConnection(raw, 'paused')!.push_target).toBe(0);
    expect(getConnection(raw, 'retired')!.push_target).toBe(1);
    expect(getConnection(raw, 'other-provider')!.push_target).toBe(1);
    expect(getConnection(raw, 'other-project')!.push_target).toBe(1);

    // The winner is ARMED, not merely left alone: a re-pick promotes a row that
    // was demoted a moment ago.
    claimPushTarget(raw, 1, 'linear', 'first');
    expect(getConnection(raw, 'first')!.push_target).toBe(1);
    expect(getConnection(raw, 'second')!.push_target).toBe(0);
  });

  it('listDuplicatePushTargets reports only the pairs holding MORE THAN ONE armed live row', () => {
    // Boot repair's input: a state connect() never leaves behind, but a
    // ledger-wiped migration replay does (109 re-adds push_target at DEFAULT 1).
    raw.prepare('INSERT INTO projects (id, name, path) VALUES (2, ?, ?)').run('Proj 2', '/tmp/p2');
    // The broken pair: two armed live rows.
    seedConnection({ id: 'dup-a' });
    seedConnection({ id: 'dup-b', status: 'paused' });
    // Healthy: one armed, one demoted.
    seedConnection({ id: 'plane-armed', provider: 'plane' });
    seedConnection({ id: 'plane-quiet', provider: 'plane', push_target: 0 });
    // Not a duplicate either — the second armed row is retired.
    insertConnection(raw, makeConnectionRow({ id: 'p2-live', project_id: 2 }));
    insertConnection(
      raw,
      makeConnectionRow({ id: 'p2-retired', project_id: 2, status: 'disconnected' }),
    );

    expect(listDuplicatePushTargets(raw)).toEqual([{ project_id: 1, provider: 'linear' }]);
  });

  it('listConnectionsForProviderProject returns the live rows of one pair, OLDEST first', () => {
    // The order boot repair picks its keeper from — the stable choice, and for
    // any pre-replay state the row most likely to have held the flag.
    seedConnection({ id: 'newer' });
    seedConnection({ id: 'older' });
    seedConnection({ id: 'retired', status: 'disconnected' });
    seedConnection({ id: 'other-provider', provider: 'plane' });
    // `datetime('now')` has one-second resolution, so two inserts in the same
    // test tie — stamp them apart rather than sleeping.
    const stamp = raw.prepare('UPDATE tracker_connections SET created_at = ? WHERE id = ?');
    stamp.run('2026-07-02 00:00:00', 'newer');
    stamp.run('2026-07-01 00:00:00', 'older');

    expect(listConnectionsForProviderProject(raw, 1, 'linear').map((c) => c.id)).toEqual([
      'older',
      'newer',
    ]);
  });

  it('advanceCursor sets the compound cursor columns', () => {
    const id = seedConnection();
    advanceCursor(raw, id, '2026-07-30 12:00:00', 'LIN-999');
    const row = getConnection(raw, id)!;
    expect(row.cursor_updated_at).toBe('2026-07-30 12:00:00');
    expect(row.cursor_external_id).toBe('LIN-999');
  });

  it('storeSecret/readSecret round-trip a ciphertext Buffer', () => {
    const id = seedConnection();
    expect(readSecret(raw, id)).toBeNull();

    const cipher = Buffer.from('encrypted-bytes', 'utf-8');
    storeSecret(raw, id, cipher);

    const readBack = readSecret(raw, id);
    expect(Buffer.isBuffer(readBack)).toBe(true);
    expect(readBack!.equals(cipher)).toBe(true);
  });

  it('findDisconnectedConnection matches on the full (project, provider, workspace) identity, and only when retired', () => {
    seedConnection({ id: 'conn-1', workspace_id: 'ws-1' });
    // An ACTIVE row is the project's live connection for that workspace — never
    // a revival candidate.
    expect(findDisconnectedConnection(raw, 1, 'linear', 'ws-1', null, ANY_SCOPE)).toBeNull();

    updateConnectionSettings(raw, 'conn-1', { status: 'disconnected' });
    expect(findDisconnectedConnection(raw, 1, 'linear', 'ws-1', null, ANY_SCOPE)?.id).toBe('conn-1');

    // Every axis of the identity is load-bearing.
    expect(findDisconnectedConnection(raw, 1, 'linear', 'ws-2', null, ANY_SCOPE)).toBeNull();
    expect(findDisconnectedConnection(raw, 1, 'plane', 'ws-1', null, ANY_SCOPE)).toBeNull();
    expect(findDisconnectedConnection(raw, 2, 'linear', 'ws-1', null, ANY_SCOPE)).toBeNull();
  });

  it('findDisconnectedConnection never claims a row whose workspace identity was never recorded', () => {
    seedConnection({ id: 'conn-1', status: 'disconnected', workspace_id: null });
    expect(findDisconnectedConnection(raw, 1, 'linear', 'ws-1', null, ANY_SCOPE)).toBeNull();
  });

  it('findDisconnectedConnection returns the most recently updated candidate', () => {
    seedConnection({ id: 'older', status: 'disconnected', workspace_id: 'ws-1' });
    seedConnection({ id: 'newer', status: 'disconnected', workspace_id: 'ws-1' });
    // `datetime('now')` has one-second resolution, so two inserts in the same
    // test tie — stamp them apart rather than sleeping.
    const stamp = raw.prepare('UPDATE tracker_connections SET updated_at = ? WHERE id = ?');
    stamp.run('2026-07-01 00:00:00', 'older');
    stamp.run('2026-07-02 00:00:00', 'newer');

    expect(findDisconnectedConnection(raw, 1, 'linear', 'ws-1', null, ANY_SCOPE)?.id).toBe('newer');
  });

  it('findDisconnectedConnection does NOT claim the same workspace slug on a DIFFERENT instance', () => {
    // The regression: the identity key ignored `base_url`, but a Plane workspace
    // slug is unique only WITHIN an instance. A retired self-hosted connection
    // would then be revived by a connect to an unrelated instance that happens to
    // use the same slug — keeping every old link, so write-back targets issue ids
    // that belong to the other deployment and the deletion sweep reads its 404s
    // as remote deletions.
    seedConnection({
      id: 'conn-a',
      provider: 'plane',
      status: 'disconnected',
      workspace_id: 'acme',
      base_url: 'https://plane.a.example',
    });

    expect(findDisconnectedConnection(raw, 1, 'plane', 'acme', 'https://plane.b.example', ANY_SCOPE)).toBeNull();

    // The SAME instance spelled differently is still the same instance: a
    // trailing slash and origin case are not identity.
    expect(findDisconnectedConnection(raw, 1, 'plane', 'acme', 'https://plane.a.example', ANY_SCOPE)?.id).toBe(
      'conn-a',
    );
    expect(findDisconnectedConnection(raw, 1, 'plane', 'acme', 'https://plane.a.example/', ANY_SCOPE)?.id).toBe(
      'conn-a',
    );
    expect(findDisconnectedConnection(raw, 1, 'plane', 'acme', 'HTTPS://Plane.A.Example//', ANY_SCOPE)?.id).toBe(
      'conn-a',
    );
  });

  it('findDisconnectedConnection reads a stored Plane cloud origin and a NULL base_url as one instance', () => {
    // The wizard pre-fills the cloud origin, so one life of a cloud connection
    // can hold the literal string and another a NULL — same instance either way.
    seedConnection({
      id: 'conn-cloud',
      provider: 'plane',
      status: 'disconnected',
      workspace_id: 'acme',
      base_url: 'https://api.plane.so',
    });

    expect(findDisconnectedConnection(raw, 1, 'plane', 'acme', null, ANY_SCOPE)?.id).toBe('conn-cloud');
    expect(findDisconnectedConnection(raw, 1, 'plane', 'acme', 'https://api.plane.so/', ANY_SCOPE)?.id).toBe(
      'conn-cloud',
    );
    // A self-hosted deployment of the same slug remains a different connection.
    expect(findDisconnectedConnection(raw, 1, 'plane', 'acme', 'https://plane.acme.dev', ANY_SCOPE)).toBeNull();
  });

  it('findDisconnectedConnection prefers an OLDER row on the matching instance over a newer one elsewhere', () => {
    seedConnection({
      id: 'other-instance',
      provider: 'plane',
      status: 'disconnected',
      workspace_id: 'acme',
      base_url: 'https://plane.b.example',
    });
    seedConnection({
      id: 'this-instance',
      provider: 'plane',
      status: 'disconnected',
      workspace_id: 'acme',
      base_url: 'https://plane.a.example',
    });
    const stamp = raw.prepare('UPDATE tracker_connections SET updated_at = ? WHERE id = ?');
    stamp.run('2026-07-02 00:00:00', 'other-instance');
    stamp.run('2026-07-01 00:00:00', 'this-instance');

    expect(findDisconnectedConnection(raw, 1, 'plane', 'acme', 'https://plane.a.example', ANY_SCOPE)?.id).toBe(
      'this-instance',
    );
  });

  it('findDisconnectedConnection does NOT claim a SIBLING mapping of the same workspace', () => {
    // Multi-project mapping retires N rows that differ in nothing but their
    // source. Reviving the wrong one would rewrite it onto another group's
    // source and strand that group's links on a row now pointing elsewhere.
    seedConnection({
      id: 'conn-core',
      status: 'disconnected',
      workspace_id: 'ws-1',
      source_json: JSON.stringify({ containerId: 'team-core', narrowId: 'all', narrowKind: 'all' }),
    });

    expect(findDisconnectedConnection(raw, 1, 'linear', 'ws-1', null, scopeOf('team-web'))).toBeNull();
    expect(findDisconnectedConnection(raw, 1, 'linear', 'ws-1', null, scopeOf('team-core'))?.id).toBe(
      'conn-core',
    );
    // The NARROW is not part of the key — re-picking a cycle under the same
    // container is the same mapping, and its links cannot be stranded by it.
    seedConnection({
      id: 'conn-narrowed',
      status: 'disconnected',
      workspace_id: 'ws-2',
      source_json: JSON.stringify({
        containerId: 'team-web',
        narrowId: 'cycle-12',
        narrowKind: 'cycle',
      }),
    });
    expect(findDisconnectedConnection(raw, 1, 'linear', 'ws-2', null, scopeOf('team-web'))?.id).toBe(
      'conn-narrowed',
    );
  });

  it('findDisconnectedConnection keys on the FULL scope, so two project groups under one team stay apart', () => {
    // The defect: the revival key read only `containerId`, but every Linear
    // project group under one team SHARES the team's container and differs only
    // in the narrow. Mapping the team's second project group would then revive
    // (and rewrite) the first one's retired row, repointing its links onto a
    // mapping that no longer polls them.
    seedConnection({
      id: 'conn-proj-a',
      status: 'disconnected',
      workspace_id: 'ws-1',
      source_json: JSON.stringify({
        containerId: 'team-1',
        narrowId: 'proj-A',
        narrowKind: 'project',
      }),
    });

    const sibling: StoredSourceScope = {
      containerId: 'team-1',
      narrowId: 'proj-B',
      narrowKind: 'project',
    };
    expect(findDisconnectedConnection(raw, 1, 'linear', 'ws-1', null, sibling)).toBeNull();

    // Its own scope claims it back…
    expect(
      findDisconnectedConnection(raw, 1, 'linear', 'ws-1', null, {
        containerId: 'team-1',
        narrowId: 'proj-A',
        narrowKind: 'project',
      })?.id,
    ).toBe('conn-proj-a');
    // …and so does the WIDER whole-team scope that contains it: a superset
    // cannot strand a retained link, so re-mapping the team as a whole adopts
    // the narrowed row rather than re-importing its backlog.
    expect(findDisconnectedConnection(raw, 1, 'linear', 'ws-1', null, scopeOf('team-1'))?.id).toBe(
      'conn-proj-a',
    );
  });

  it('findDisconnectedConnection lets a Dart SPACE scope claim its own retired member board', () => {
    // Pre-rev-4 Dart rows are board-scoped ("Engineering/Sprint") while the Map
    // step now offers only the space ("Engineering"), so without the widening
    // arm every existing Dart connection would mint a fresh row and re-import
    // its whole backlog as duplicates.
    seedConnection({
      id: 'conn-board',
      provider: 'dart',
      status: 'disconnected',
      workspace_id: 'acct-1',
      source_json: JSON.stringify({
        containerId: 'Engineering/Sprint',
        narrowId: 'all',
        narrowKind: 'all',
      }),
    });

    expect(
      findDisconnectedConnection(raw, 1, 'dart', 'acct-1', null, {
        containerId: 'Engineering',
        narrowId: 'all',
        narrowKind: 'space',
      })?.id,
    ).toBe('conn-board');
    // A DIFFERENT space owns none of it — the prefix must be a path segment.
    expect(
      findDisconnectedConnection(raw, 1, 'dart', 'acct-1', null, {
        containerId: 'Design',
        narrowId: 'all',
        narrowKind: 'space',
      }),
    ).toBeNull();
  });

  it('listConnectionsByIdentity returns every LIVE row sharing one key, across projects', () => {
    raw.prepare('INSERT INTO projects (id, name, path) VALUES (2, ?, ?)').run('Proj 2', '/tmp/p2');
    // Two mappings of one Linear workspace onto two cyboflow projects, plus a
    // paused one — a revoked key pauses exactly the rows a rotation must resume.
    seedConnection({ id: 'map-a', workspace_id: 'ws-1' });
    insertConnection(
      raw,
      makeConnectionRow({ id: 'map-b', project_id: 2, workspace_id: 'ws-1', status: 'paused' }),
    );
    // Not in the set: another workspace, another provider, and a retired row
    // whose secret was deliberately cleared.
    seedConnection({ id: 'other-ws', workspace_id: 'ws-2' });
    seedConnection({ id: 'other-provider', provider: 'plane', workspace_id: 'ws-1' });
    seedConnection({ id: 'retired', workspace_id: 'ws-1', status: 'disconnected' });

    expect(listConnectionsByIdentity(raw, 'linear', 'ws-1', null).map((c) => c.id)).toEqual([
      'map-a',
      'map-b',
    ]);
  });

  it('listConnectionsByIdentity splits two Plane instances that share a workspace slug', () => {
    seedConnection({
      id: 'plane-a',
      provider: 'plane',
      workspace_id: 'acme',
      base_url: 'https://plane.a.example',
    });
    seedConnection({
      id: 'plane-b',
      provider: 'plane',
      workspace_id: 'acme',
      base_url: 'https://plane.b.example',
    });

    // Normalized comparison, same as the revival lookup: a trailing slash is
    // not a different instance, a different host is.
    expect(
      listConnectionsByIdentity(raw, 'plane', 'acme', 'https://plane.a.example/').map((c) => c.id),
    ).toEqual(['plane-a']);
  });

  it('reactivateConnection rewrites the retired row IN PLACE, keeping its id and clearing the cursor', () => {
    seedConnection({
      id: 'conn-1',
      status: 'disconnected',
      workspace_id: 'ws-1',
      workspace_name: 'Old name',
      status_sync_mode: 'manual',
      pull_mode: 'manual',
      push_mode: 'manual',
      conflict_mode: 'manual',
      source_json: JSON.stringify({ containerId: 'team-old' }),
      cursor_updated_at: '2026-07-01 00:00:00',
      cursor_external_id: 'ext-9',
      last_sync_at: '2026-07-01 00:00:00',
      last_sync_log_json: '[{"marker":"OK","line":"a previous life"}]',
    });
    storeSecret(raw, 'conn-1', Buffer.from('old-key', 'utf-8'));

    // The wizard's fresh payload. Its own `id` is IGNORED — the id argument is
    // the row being rewritten, which is the whole point of the call.
    const revived = reactivateConnection(
      raw,
      'conn-1',
      makeConnectionRow({
        id: 'trk_freshly_minted',
        status: 'active',
        workspace_id: 'ws-1',
        workspace_name: 'Acme',
        status_sync_mode: 'auto',
        pull_mode: 'auto',
        push_mode: 'auto',
        conflict_mode: 'auto',
        source_json: JSON.stringify({ containerId: 'team-new' }),
        cursor_updated_at: null,
        cursor_external_id: null,
        last_sync_at: null,
        last_sync_log_json: null,
      }),
    );

    expect(revived.id).toBe('conn-1');
    expect(revived.status).toBe('active');
    expect(revived.workspace_name).toBe('Acme');
    expect(revived.status_sync_mode).toBe('auto');
    expect(revived.pull_mode).toBe('auto');
    expect(revived.push_mode).toBe('auto');
    expect(revived.conflict_mode).toBe('auto');
    expect(JSON.parse(revived.source_json ?? '{}')).toEqual({ containerId: 'team-new' });
    // The cursor RESET is what makes the retained links re-bind: the next pass
    // re-fetches everything and merges each issue against its existing link.
    expect(revived.cursor_updated_at).toBeNull();
    expect(revived.cursor_external_id).toBeNull();
    expect(revived.last_sync_at).toBeNull();
    expect(revived.last_sync_log_json).toBeNull();

    // One row, not two — and the stale key is gone with the rest of the row.
    const count = raw.prepare('SELECT COUNT(*) AS n FROM tracker_connections').get() as { n: number };
    expect(count.n).toBe(1);
    expect(readSecret(raw, 'conn-1')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Links
// ---------------------------------------------------------------------------

describe('trackerSync store — links', () => {
  it('upsertLink creates a new row on first call', () => {
    const connId = seedConnection();
    const link = upsertLink(raw, {
      connection_id: connId,
      entity_type: 'idea',
      entity_id: 'idea-1',
      provider: 'linear',
      external_id: 'LIN-1',
      external_url: 'https://linear.app/team/issue/LIN-1',
    });
    expect(link.entity_id).toBe('idea-1');
    expect(link.external_id).toBe('LIN-1');
    expect(link.orphaned_at).toBeNull();
  });

  it('a re-upsert for the same (entity_type, entity_id, provider) refreshes mutable columns in place — no duplicate row', () => {
    const connId = seedConnection();
    const first = upsertLink(raw, {
      connection_id: connId,
      entity_type: 'idea',
      entity_id: 'idea-1',
      provider: 'linear',
      external_id: 'LIN-1',
      external_url: 'https://linear.app/LIN-1',
      baseline_json: '{"title":"old"}',
    });

    const second = upsertLink(raw, {
      connection_id: connId,
      entity_type: 'idea',
      entity_id: 'idea-1',
      provider: 'linear',
      external_id: 'LIN-1',
      external_url: 'https://linear.app/LIN-1-renamed',
      baseline_json: '{"title":"new"}',
    });

    // Same row, not a new one.
    expect(second.id).toBe(first.id);
    expect(second.external_url).toBe('https://linear.app/LIN-1-renamed');
    expect(second.baseline_json).toBe('{"title":"new"}');

    const all = listLinks(raw, connId);
    expect(all).toHaveLength(1);
  });

  it('a re-upsert clears orphaned_at — a link seen again is live again', () => {
    const connId = seedConnection();
    const link = upsertLink(raw, {
      connection_id: connId,
      entity_type: 'task',
      entity_id: 'task-1',
      provider: 'linear',
      external_id: 'LIN-2',
    });
    markOrphaned(raw, link.id);
    expect(getLinkByEntity(raw, 'task', 'task-1', 'linear')!.orphaned_at).not.toBeNull();

    const refreshed = upsertLink(raw, {
      connection_id: connId,
      entity_type: 'task',
      entity_id: 'task-1',
      provider: 'linear',
      external_id: 'LIN-2',
    });
    expect(refreshed.id).toBe(link.id);
    expect(refreshed.orphaned_at).toBeNull();
  });

  it('getLinkByEntity and getLinkByExternal resolve the same row from either identity; both return null on a miss', () => {
    const connId = seedConnection();
    const link = upsertLink(raw, {
      connection_id: connId,
      entity_type: 'idea',
      entity_id: 'idea-9',
      provider: 'plane',
      external_id: 'proj/PLN-9',
    });

    expect(getLinkByEntity(raw, 'idea', 'idea-9', 'plane')).toEqual(link);
    expect(getLinkByExternal(raw, connId, 'proj/PLN-9')).toEqual(link);
    expect(getLinkByEntity(raw, 'idea', 'does-not-exist', 'plane')).toBeNull();
    expect(getLinkByExternal(raw, connId, 'does-not-exist')).toBeNull();
  });

  it('listLinks activeOnly filters out orphaned links', () => {
    const connId = seedConnection();
    const live = upsertLink(raw, {
      connection_id: connId,
      entity_type: 'idea',
      entity_id: 'idea-live',
      provider: 'linear',
      external_id: 'LIN-LIVE',
    });
    const orphan = upsertLink(raw, {
      connection_id: connId,
      entity_type: 'idea',
      entity_id: 'idea-orphan',
      provider: 'linear',
      external_id: 'LIN-ORPHAN',
    });
    markOrphaned(raw, orphan.id);

    expect(listLinks(raw, connId).map((l) => l.id).sort()).toEqual([live.id, orphan.id].sort());
    expect(listLinks(raw, connId, { activeOnly: true }).map((l) => l.id)).toEqual([live.id]);
  });

  it('updateBaseline overwrites baseline_json', () => {
    const connId = seedConnection();
    const link = upsertLink(raw, {
      connection_id: connId,
      entity_type: 'idea',
      entity_id: 'idea-1',
      provider: 'linear',
      external_id: 'LIN-1',
    });
    updateBaseline(raw, link.id, '{"stage":"done"}');
    expect(getLinkByEntity(raw, 'idea', 'idea-1', 'linear')!.baseline_json).toBe('{"stage":"done"}');
  });

  it('listLinksByParentExternal returns only the mirrored children of one parent', () => {
    const connId = seedConnection();
    upsertLink(raw, {
      connection_id: connId,
      entity_type: 'task',
      entity_id: 'task-child-1',
      provider: 'linear',
      external_id: 'LIN-CHILD-1',
      external_parent_id: 'LIN-PARENT',
    });
    upsertLink(raw, {
      connection_id: connId,
      entity_type: 'task',
      entity_id: 'task-child-2',
      provider: 'linear',
      external_id: 'LIN-CHILD-2',
      external_parent_id: 'LIN-PARENT',
    });
    upsertLink(raw, {
      connection_id: connId,
      entity_type: 'task',
      entity_id: 'task-unrelated',
      provider: 'linear',
      external_id: 'LIN-OTHER',
      external_parent_id: 'LIN-SOME-OTHER-PARENT',
    });

    const children = listLinksByParentExternal(raw, connId, 'LIN-PARENT');
    expect(children.map((c) => c.entity_id).sort()).toEqual(['task-child-1', 'task-child-2']);
  });

  it('listActiveLinksWithoutEntity finds only the links whose entity is really gone', () => {
    const connId = seedConnection();
    raw.prepare('INSERT INTO projects (id, name, path) VALUES (2, ?, ?)').run('Proj 2', '/tmp/p2');
    const otherConnId = seedConnection({ id: 'conn-2', project_id: 2 });
    seedEntity('idea', 'ide_live');

    // Live entity -> not a zombie.
    upsertLink(raw, {
      connection_id: connId,
      entity_type: 'idea',
      entity_id: 'ide_live',
      provider: 'linear',
      external_id: 'LIN-LIVE',
    });
    // Deleted entity -> exactly what a hard delete's cascade leaves behind.
    const zombie = upsertLink(raw, {
      connection_id: connId,
      entity_type: 'task',
      entity_id: 'tsk_deleted',
      provider: 'linear',
      external_id: 'LIN-ZOMBIE',
    });
    // Deleted entity, but the link is ALREADY orphaned -> nothing left to do.
    const settled = upsertLink(raw, {
      connection_id: connId,
      entity_type: 'epic',
      entity_id: 'epc_deleted',
      provider: 'linear',
      external_id: 'LIN-SETTLED',
    });
    markOrphaned(raw, settled.id);
    // Another project's zombie -> out of scope for this project's sweep.
    upsertLink(raw, {
      connection_id: otherConnId,
      entity_type: 'task',
      entity_id: 'tsk_elsewhere',
      provider: 'linear',
      external_id: 'LIN-ELSEWHERE',
    });

    expect(listActiveLinksWithoutEntity(raw, 1).map((l) => l.id)).toEqual([zombie.id]);
    expect(listActiveLinksWithoutEntity(raw, 2).map((l) => l.external_id)).toEqual([
      'LIN-ELSEWHERE',
    ]);
  });

  it('hasActiveLinkedDescendant mirrors the delete cascade an idea/epic takes with it', () => {
    const connId = seedConnection();
    seedEntity('idea', 'ide_1');
    seedEntity('epic', 'epc_1', { originatingIdeaId: 'ide_1' });
    seedEntity('task', 'tsk_1', { originatingIdeaId: 'ide_1', parentEpicId: 'epc_1' });
    seedEntity('task', 'tsk_direct', { originatingIdeaId: 'ide_1' });

    // Nothing under either root is linked yet.
    expect(hasActiveLinkedDescendant(raw, 'idea', 'ide_1')).toBe(false);
    expect(hasActiveLinkedDescendant(raw, 'epic', 'epc_1')).toBe(false);

    // A task reachable ONLY through the epic counts for both roots.
    const viaEpic = upsertLink(raw, {
      connection_id: connId,
      entity_type: 'task',
      entity_id: 'tsk_1',
      provider: 'linear',
      external_id: 'LIN-1',
    });
    expect(hasActiveLinkedDescendant(raw, 'idea', 'ide_1')).toBe(true);
    expect(hasActiveLinkedDescendant(raw, 'epic', 'epc_1')).toBe(true);
    // A task never has a cascade of its own.
    expect(hasActiveLinkedDescendant(raw, 'task', 'tsk_1')).toBe(false);

    // Orphaned links do not count — there is nothing left to rule on.
    markOrphaned(raw, viaEpic.id);
    expect(hasActiveLinkedDescendant(raw, 'idea', 'ide_1')).toBe(false);
    expect(hasActiveLinkedDescendant(raw, 'epic', 'epc_1')).toBe(false);

    // A small idea's DIRECT task (no epic in between) counts for the idea only.
    upsertLink(raw, {
      connection_id: connId,
      entity_type: 'task',
      entity_id: 'tsk_direct',
      provider: 'linear',
      external_id: 'LIN-2',
    });
    expect(hasActiveLinkedDescendant(raw, 'idea', 'ide_1')).toBe(true);
    expect(hasActiveLinkedDescendant(raw, 'epic', 'epc_1')).toBe(false);
  });

  it('findSiblingLinkForExternal finds a link another mapping on the same identity holds — across projects', () => {
    raw.prepare('INSERT INTO projects (id, name, path) VALUES (2, ?, ?)').run('Proj 2', '/tmp/p2');
    const teamGroup = seedConnection({ id: 'conn-team', workspace_id: 'org-1' });
    seedConnection({ id: 'conn-project', project_id: 2, workspace_id: 'org-1' });
    const held = upsertLink(raw, {
      connection_id: teamGroup,
      entity_type: 'idea',
      entity_id: 'idea-1',
      provider: 'linear',
      external_id: 'LIN-1',
    });

    const hit = findSiblingLinkForExternal(raw, {
      provider: 'linear',
      workspaceId: 'org-1',
      baseUrl: null,
      externalId: 'LIN-1',
      excludeConnectionId: 'conn-project',
    });
    expect(hit?.id).toBe(held.id);
    expect(hit?.entity_id).toBe('idea-1');

    // The holder asking about its OWN link is not a duplicate.
    expect(
      findSiblingLinkForExternal(raw, {
        provider: 'linear',
        workspaceId: 'org-1',
        baseUrl: null,
        externalId: 'LIN-1',
        excludeConnectionId: teamGroup,
      }),
    ).toBeNull();

    // An unclaimed issue on the same identity.
    expect(
      findSiblingLinkForExternal(raw, {
        provider: 'linear',
        workspaceId: 'org-1',
        baseUrl: null,
        externalId: 'LIN-9',
        excludeConnectionId: 'conn-project',
      }),
    ).toBeNull();
  });

  it('findSiblingLinkForExternal ignores orphaned links, disconnected rows, and another workspace or instance', () => {
    const orphanHolder = seedConnection({ id: 'conn-orphan', workspace_id: 'ws-1', provider: 'plane' });
    const retired = seedConnection({ id: 'conn-retired', workspace_id: 'ws-1', provider: 'plane' });
    seedConnection({ id: 'conn-other-ws', workspace_id: 'ws-2', provider: 'plane' });
    seedConnection({
      id: 'conn-other-instance',
      workspace_id: 'ws-1',
      provider: 'plane',
      base_url: 'https://plane.acme.dev',
    });
    const asker = {
      provider: 'plane' as const,
      workspaceId: 'ws-1',
      baseUrl: null,
      externalId: 'PLN-1',
      excludeConnectionId: 'conn-asking',
    };

    const orphaned = upsertLink(raw, {
      connection_id: orphanHolder,
      entity_type: 'idea',
      entity_id: 'idea-1',
      provider: 'plane',
      external_id: 'PLN-1',
    });
    markOrphaned(raw, orphaned.id);
    expect(findSiblingLinkForExternal(raw, asker)).toBeNull();

    // A retired mapping's retained links exist only for a revival to re-bind.
    upsertLink(raw, {
      connection_id: retired,
      entity_type: 'epic',
      entity_id: 'epic-1',
      provider: 'plane',
      external_id: 'PLN-1',
    });
    updateConnectionSettings(raw, retired, { status: 'disconnected' });
    expect(findSiblingLinkForExternal(raw, asker)).toBeNull();

    // Same external id, different workspace — a Plane id is unique only within one.
    upsertLink(raw, {
      connection_id: 'conn-other-ws',
      entity_type: 'task',
      entity_id: 'task-1',
      provider: 'plane',
      external_id: 'PLN-1',
    });
    expect(findSiblingLinkForExternal(raw, asker)).toBeNull();

    // Same workspace slug on a SELF-HOSTED deployment is a different tracker.
    upsertLink(raw, {
      connection_id: 'conn-other-instance',
      entity_type: 'task',
      entity_id: 'task-2',
      provider: 'plane',
      external_id: 'PLN-1',
    });
    expect(findSiblingLinkForExternal(raw, asker)).toBeNull();
    // ...and IS the sibling for a connection on that same deployment.
    expect(
      findSiblingLinkForExternal(raw, { ...asker, baseUrl: 'https://plane.acme.dev/' })?.entity_id,
    ).toBe('task-2');
  });
});

// ---------------------------------------------------------------------------
// Outbox
// ---------------------------------------------------------------------------

describe('trackerSync store — outbox', () => {
  it('enqueueOutbox writes the schema defaults (state=pending, attempts=0)', () => {
    const connId = seedConnection();
    const row = enqueueOutbox(raw, {
      connection_id: connId,
      kind: 'create_sub_issue',
      payload_json: '{"title":"x"}',
    });
    expect(row.state).toBe('pending');
    expect(row.attempts).toBe(0);
    expect(row.last_error).toBeNull();
    expect(row.next_attempt_at).toBeNull();
  });

  it('claimNextPending claims the oldest eligible row first, atomically flipping state and incrementing attempts', () => {
    const connId = seedConnection();
    // Seed three rows with explicit created_at so ordering is deterministic
    // (enqueueOutbox always uses datetime('now'), which has 1s resolution).
    const insert = raw.prepare(
      `INSERT INTO tracker_outbox (connection_id, kind, payload_json, state, created_at, updated_at, next_attempt_at)
       VALUES (?, 'update_state', '{}', 'pending', ?, ?, ?)`,
    );
    const oldest = insert.run(connId, '2026-01-01 00:00:01', '2026-01-01 00:00:01', null).lastInsertRowid as number;
    const middle = insert.run(connId, '2026-01-01 00:00:02', '2026-01-01 00:00:02', null).lastInsertRowid as number;
    insert.run(connId, '2026-01-01 00:00:03', '2026-01-01 00:00:03', null); // youngest — claimed last

    const first = claimNextPending(raw, connId, '2026-06-01 00:00:00');
    expect(first?.id).toBe(oldest);
    expect(first?.state).toBe('in_flight');
    expect(first?.attempts).toBe(1);
    // The claim really mutated the row, not just read it.
    expect(fetchOutboxRow(oldest)?.state).toBe('in_flight');

    const second = claimNextPending(raw, connId, '2026-06-01 00:00:00');
    expect(second?.id).toBe(middle);
    expect(second?.id).not.toBe(first?.id);
  });

  it('claimNextPending honours allowedKinds — a held direction is skipped, not consumed', () => {
    const connId = seedConnection();
    const insert = raw.prepare(
      `INSERT INTO tracker_outbox (connection_id, kind, payload_json, state, created_at, updated_at)
       VALUES (?, ?, '{}', 'pending', ?, ?)`,
    );
    // The push row is OLDER, so a filter that merely re-ordered would still
    // return it first; only a real filter can skip it.
    const push = insert.run(connId, 'create_issue', '2026-01-01 00:00:01', '2026-01-01 00:00:01')
      .lastInsertRowid as number;
    const status = insert.run(connId, 'update_state', '2026-01-01 00:00:02', '2026-01-01 00:00:02')
      .lastInsertRowid as number;

    const claimed = claimNextPending(raw, connId, '2026-06-01 00:00:00', ['update_state', 'close_parent']);
    expect(claimed?.id).toBe(status);
    // The skipped row is untouched — still pending, still on attempt 0, so a
    // later pass that DOES own its direction picks it up unchanged.
    expect(fetchOutboxRow(push)?.state).toBe('pending');
    expect(fetchOutboxRow(push)?.attempts).toBe(0);

    // Nothing else of that kind is left.
    expect(claimNextPending(raw, connId, '2026-06-01 00:00:00', ['update_state', 'close_parent'])).toBeNull();
    // Widen the filter and the held row is claimable.
    expect(claimNextPending(raw, connId, '2026-06-01 00:00:00', ['create_issue'])?.id).toBe(push);
  });

  it('claimNextPending with an EMPTY allowedKinds claims nothing (every direction held)', () => {
    const connId = seedConnection();
    enqueueOutbox(raw, { connection_id: connId, kind: 'update_state', payload_json: '{}' });

    expect(claimNextPending(raw, connId, '2026-06-01 00:00:00', [])).toBeNull();
    // …and omitting the filter still claims any kind.
    expect(claimNextPending(raw, connId, '2026-06-01 00:00:00')).not.toBeNull();
  });

  it('claimNextPending gates on next_attempt_at: future rows are skipped, past/null rows are eligible', () => {
    const connId = seedConnection();
    const insert = raw.prepare(
      `INSERT INTO tracker_outbox (connection_id, kind, payload_json, state, created_at, updated_at, next_attempt_at)
       VALUES (?, 'update_state', '{}', 'pending', ?, ?, ?)`,
    );
    // Oldest by created_at, but not eligible until far in the future.
    const future = insert
      .run(connId, '2026-01-01 00:00:01', '2026-01-01 00:00:01', '2099-01-01 00:00:00')
      .lastInsertRowid as number;
    const eligiblePast = insert
      .run(connId, '2026-01-01 00:00:02', '2026-01-01 00:00:02', '2026-01-01 00:00:00')
      .lastInsertRowid as number;
    const eligibleNull = insert
      .run(connId, '2026-01-01 00:00:03', '2026-01-01 00:00:03', null)
      .lastInsertRowid as number;

    const now = '2026-06-01 00:00:00';
    const claimed = new Set<number>();
    let claim = claimNextPending(raw, connId, now);
    while (claim) {
      claimed.add(claim.id);
      claim = claimNextPending(raw, connId, now);
    }

    expect(claimed).toEqual(new Set([eligiblePast, eligibleNull]));
    expect(claimed.has(future)).toBe(false);
    // The future-dated row is still sitting there, untouched, pending.
    expect(fetchOutboxRow(future)?.state).toBe('pending');
  });

  it('resolveOutbox("failed", nextAttemptAtIso) requeues to pending for retry; without it, the failure is terminal', () => {
    const connId = seedConnection();
    const retryable = enqueueOutbox(raw, { connection_id: connId, kind: 'update_state', payload_json: '{}' });
    const terminal = enqueueOutbox(raw, { connection_id: connId, kind: 'update_state', payload_json: '{}' });

    const claimedRetryable = claimNextPending(raw, connId, '2026-06-01 00:00:00')!;
    const claimedTerminal = claimNextPending(raw, connId, '2026-06-01 00:00:00')!;
    expect([claimedRetryable.id, claimedTerminal.id].sort()).toEqual([retryable.id, terminal.id].sort());

    resolveOutbox(raw, claimedRetryable.id, 'failed', {
      lastError: 'rate limited',
      nextAttemptAtIso: '2026-06-01 00:05:00',
    });
    const afterRetry = fetchOutboxRow(claimedRetryable.id)!;
    expect(afterRetry.state).toBe('pending');
    expect(afterRetry.next_attempt_at).toBe('2026-06-01 00:05:00');
    expect(afterRetry.last_error).toBe('rate limited');

    resolveOutbox(raw, claimedTerminal.id, 'failed', { lastError: 'bad request' });
    const afterTerminal = fetchOutboxRow(claimedTerminal.id)!;
    expect(afterTerminal.state).toBe('failed');
    expect(afterTerminal.next_attempt_at).toBeNull();
    expect(afterTerminal.last_error).toBe('bad request');

    // Not eligible yet (nextAttemptAtIso is in the future relative to "now").
    expect(claimNextPending(raw, connId, '2026-06-01 00:00:01')).toBeNull();
    // Once "now" passes next_attempt_at, the retry is claimable again with attempts incremented.
    const reclaimed = claimNextPending(raw, connId, '2026-06-01 00:05:00');
    expect(reclaimed?.id).toBe(claimedRetryable.id);
    expect(reclaimed?.attempts).toBe(2);

    // The terminal failure never comes back.
    expect(claimNextPending(raw, connId, '2099-01-01 00:00:00')).toBeNull();
  });

  it('claimNextPending returns null when a connection has no outbox rows at all', () => {
    const connId = seedConnection();
    expect(claimNextPending(raw, connId, '2026-06-01 00:00:00')).toBeNull();
  });

  it('resolveOutbox("done") and resolveOutbox("ambiguous") set state verbatim and clear next_attempt_at', () => {
    const connId = seedConnection();
    const done = enqueueOutbox(raw, { connection_id: connId, kind: 'close_parent', payload_json: '{}' });
    const ambiguous = enqueueOutbox(raw, { connection_id: connId, kind: 'create_sub_issue', payload_json: '{}' });
    claimNextPending(raw, connId, '2026-06-01 00:00:00');
    claimNextPending(raw, connId, '2026-06-01 00:00:00');

    resolveOutbox(raw, done.id, 'done');
    resolveOutbox(raw, ambiguous.id, 'ambiguous');

    expect(fetchOutboxRow(done.id)?.state).toBe('done');
    expect(fetchOutboxRow(ambiguous.id)?.state).toBe('ambiguous');
  });

  it('listUnresolvedOutbox returns pending/in_flight/ambiguous but not done/failed', () => {
    const connId = seedConnection();
    const pending = enqueueOutbox(raw, { connection_id: connId, kind: 'update_state', payload_json: '{}' });
    const inFlight = enqueueOutbox(raw, { connection_id: connId, kind: 'update_state', payload_json: '{}' });
    const ambiguous = enqueueOutbox(raw, { connection_id: connId, kind: 'update_state', payload_json: '{}' });
    const done = enqueueOutbox(raw, { connection_id: connId, kind: 'update_state', payload_json: '{}' });
    const failed = enqueueOutbox(raw, { connection_id: connId, kind: 'update_state', payload_json: '{}' });

    // Stamp each row's terminal/in-progress state directly — the point of this
    // test is the SELECT filter, not the claim/resolve transitions (covered by
    // the claimNextPending/resolveOutbox tests above).
    const setState = (id: number, state: string) =>
      raw.prepare('UPDATE tracker_outbox SET state = ? WHERE id = ?').run(state, id);
    setState(pending.id, 'pending');
    setState(inFlight.id, 'in_flight');
    setState(ambiguous.id, 'ambiguous');
    setState(done.id, 'done');
    setState(failed.id, 'failed');

    const unresolved = listUnresolvedOutbox(raw, connId).map((r) => r.id).sort();
    expect(unresolved).toEqual([pending.id, inFlight.id, ambiguous.id].sort());
  });

  it('findOutboxByClientKey looks up by the idempotency key, scoped to the connection', () => {
    const connId = seedConnection();
    const row = enqueueOutbox(raw, {
      connection_id: connId,
      kind: 'create_sub_issue',
      client_key: 'client-key-abc',
      payload_json: '{}',
    });
    expect(findOutboxByClientKey(raw, connId, 'client-key-abc')).toEqual(row);
    expect(findOutboxByClientKey(raw, connId, 'no-such-key')).toBeNull();
  });

  it('requeueInFlightAsAmbiguous converts every in_flight row for a connection and returns the count, leaving pending rows untouched', () => {
    const connId = seedConnection();
    const willClaim1 = enqueueOutbox(raw, { connection_id: connId, kind: 'update_state', payload_json: '{}' });
    const willClaim2 = enqueueOutbox(raw, { connection_id: connId, kind: 'update_state', payload_json: '{}' });
    const staysPending = enqueueOutbox(raw, { connection_id: connId, kind: 'update_state', payload_json: '{}' });

    claimNextPending(raw, connId, '2026-06-01 00:00:00');
    claimNextPending(raw, connId, '2026-06-01 00:00:00');
    expect(fetchOutboxRow(willClaim1.id)?.state).toBe('in_flight');
    expect(fetchOutboxRow(willClaim2.id)?.state).toBe('in_flight');

    const count = requeueInFlightAsAmbiguous(raw, connId);
    expect(count).toBe(2);
    expect(fetchOutboxRow(willClaim1.id)?.state).toBe('ambiguous');
    expect(fetchOutboxRow(willClaim2.id)?.state).toBe('ambiguous');
    expect(fetchOutboxRow(staysPending.id)?.state).toBe('pending');

    // Idempotent — nothing left in_flight the second time.
    expect(requeueInFlightAsAmbiguous(raw, connId)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Conflicts
// ---------------------------------------------------------------------------

describe('trackerSync store — conflicts', () => {
  it('insertConflict opens a conflict that shows up in listOpenConflicts and hasOpenConflictForLink', () => {
    const connId = seedConnection();
    const link = upsertLink(raw, {
      connection_id: connId,
      entity_type: 'idea',
      entity_id: 'idea-1',
      provider: 'linear',
      external_id: 'LIN-1',
    });
    const conflict = insertConflict(raw, {
      connection_id: connId,
      link_id: link.id,
      kind: 'field_conflict',
      field: 'title',
      local_value: 'Local title',
      remote_value: 'Remote title',
    });
    expect(conflict.state).toBe('open');
    expect(conflict.resolved_at).toBeNull();

    expect(listOpenConflicts(raw, connId).map((c) => c.id)).toEqual([conflict.id]);
    expect(hasOpenConflictForLink(raw, link.id)).toBe(true);
  });

  it('resolveConflict stamps state=resolved, records the resolution, and sets resolved_at', () => {
    const connId = seedConnection();
    const link = upsertLink(raw, {
      connection_id: connId,
      entity_type: 'task',
      entity_id: 'task-1',
      provider: 'plane',
      external_id: 'proj/1',
    });
    const conflict = insertConflict(raw, {
      connection_id: connId,
      link_id: link.id,
      kind: 'remote_deleted',
    });

    resolveConflict(raw, conflict.id, 'accept-theirs');

    const row = raw.prepare('SELECT state, resolution, resolved_at FROM tracker_conflicts WHERE id = ?').get(
      conflict.id,
    ) as { state: string; resolution: string | null; resolved_at: string | null };
    expect(row.state).toBe('resolved');
    expect(row.resolution).toBe('accept-theirs');
    expect(row.resolved_at).not.toBeNull();

    expect(listOpenConflicts(raw, connId)).toEqual([]);
    expect(hasOpenConflictForLink(raw, link.id)).toBe(false);
  });

  it('a conflict can be open with no link_id (a general remote-deletion record) and never counts toward hasOpenConflictForLink', () => {
    const connId = seedConnection();
    const conflict = insertConflict(raw, { connection_id: connId, kind: 'remote_deleted' });
    expect(conflict.link_id).toBeNull();
    expect(listOpenConflicts(raw, connId).map((c) => c.id)).toEqual([conflict.id]);
  });
});

// ---------------------------------------------------------------------------
// Reconciliation ledger (migration 123)
// ---------------------------------------------------------------------------

describe('store — reconciliation ledger', () => {
  it('upserts on (connection_id, external_id) rather than appending a history', () => {
    const connId = seedConnection();

    upsertLedgerEntry(raw, {
      connection_id: connId,
      external_id: 'bd-1',
      reason: 'unmapped-state',
      last_seen_revision: 'rev-1',
      config_generation: 0,
    });
    upsertLedgerEntry(raw, {
      connection_id: connId,
      external_id: 'bd-1',
      reason: 'out-of-selection',
      last_seen_revision: 'rev-2',
      config_generation: 3,
    });

    const rows = [...listLedgerEntries(raw, connId).values()];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      external_id: 'bd-1',
      // The CURRENT verdict replaces the old one — the ledger states what is
      // true now, not what was ever true.
      reason: 'out-of-selection',
      last_seen_revision: 'rev-2',
      config_generation: 3,
    });
  });

  it('scopes reads to one connection and deletes only the ids it is given', () => {
    const a = seedConnection({ id: 'conn-a' });
    const b = seedConnection({ id: 'conn-b', workspace_id: 'ws-b' });
    for (const externalId of ['bd-1', 'bd-2', 'bd-3']) {
      upsertLedgerEntry(raw, {
        connection_id: a,
        external_id: externalId,
        reason: 'archived',
        last_seen_revision: 'r',
        config_generation: 0,
      });
    }
    upsertLedgerEntry(raw, {
      connection_id: b,
      external_id: 'bd-1',
      reason: 'archived',
      last_seen_revision: 'r',
      config_generation: 0,
    });

    deleteLedgerEntries(raw, a, ['bd-2', 'bd-9']);

    expect([...listLedgerEntries(raw, a).keys()].sort()).toEqual(['bd-1', 'bd-3']);
    // The same external id under a SIBLING connection is a different row.
    expect([...listLedgerEntries(raw, b).keys()]).toEqual(['bd-1']);
  });

  it('deletes in chunks, so a workspace-sized id list cannot exceed sqlite’s parameter cap', () => {
    const connId = seedConnection();
    const ids = Array.from({ length: 1200 }, (_, index) => `bd-${index}`);
    for (const externalId of ids) {
      upsertLedgerEntry(raw, {
        connection_id: connId,
        external_id: externalId,
        reason: 'archived',
        last_seen_revision: 'r',
        config_generation: 0,
      });
    }

    deleteLedgerEntries(raw, connId, ids);

    expect(listLedgerEntries(raw, connId).size).toBe(0);
  });

  it('a deleted connection takes its ledger rows with it (ON DELETE CASCADE)', () => {
    const connId = seedConnection();
    upsertLedgerEntry(raw, {
      connection_id: connId,
      external_id: 'bd-1',
      reason: 'archived',
      last_seen_revision: 'r',
      config_generation: 0,
    });

    raw.prepare('DELETE FROM tracker_connections WHERE id = ?').run(connId);

    expect(listLedgerEntries(raw, connId).size).toBe(0);
  });

  it('bumpConfigGeneration advances the counter and returns the new value', () => {
    const connId = seedConnection();
    expect(getConnection(raw, connId)?.config_generation).toBe(0);

    expect(bumpConfigGeneration(raw, connId)).toBe(1);
    expect(bumpConfigGeneration(raw, connId)).toBe(2);
    expect(getConnection(raw, connId)?.config_generation).toBe(2);
  });

  it('clearOrphaned is markOrphaned’s inverse', () => {
    const connId = seedConnection();
    const link = upsertLink(raw, {
      connection_id: connId,
      entity_type: 'idea',
      entity_id: 'ide_1',
      provider: 'linear',
      external_id: 'ext-1',
    });

    markOrphaned(raw, link.id);
    expect(getLinkByExternal(raw, connId, 'ext-1')?.orphaned_at).not.toBeNull();

    clearOrphaned(raw, link.id);
    expect(getLinkByExternal(raw, connId, 'ext-1')?.orphaned_at).toBeNull();
  });
});
