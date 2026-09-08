/**
 * Unit tests for the outbox drain + ambiguous recovery
 * (main/src/services/trackerSync/outboxWorker.ts).
 *
 * Real temp-file DB through the full migration chain (same technique as
 * store.test.ts / migration093.test.ts) + a hand-rolled FakeAdapter with call
 * capture and per-method scripted failures. No network, no mocking framework
 * on the adapter seam — the adapter interface is small enough to implement
 * honestly, which also keeps these tests a compile-time check that the worker
 * only uses the documented surface.
 *
 * Covers, per the task brief:
 *   - drain happy path: update_state writes the mapped provider state, settles
 *     the row `done`, and stamps the echo-suppression baseline on the link.
 *   - create_sub_issue: links the created issue (parent + baseline snapshot).
 *   - 5xx -> retry with next_attempt_at = now + min(2^attempts, 32) minutes.
 *   - TrackerAuthError -> connection paused and drain HALTS, with the rejected
 *     row HELD unsettled (not terminal) so a key rotation replays it.
 *   - supersession: a newer state write settles the queued older one at ENQUEUE,
 *     and the drain refuses a stale row that never met that sweep.
 *   - a group with no provider state -> terminal failure (no retry storm).
 *   - post-send local failure leaves the row `in_flight` for boot recovery.
 *   - a create whose outcome is UNCERTAIN on a non-idempotent provider parks as
 *     `ambiguous` (never a second POST) and is adopted by the next reconcile;
 *     a 4xx there is still terminal, and an idempotent provider still retries.
 *   - ambiguous recovery: Linear point-lookup (found -> adopted, missing ->
 *     pending), Plane client-key match (a same-title sibling is NOT ours), and
 *     update_state -> straight to pending.
 *   - a push carrying `pushContainerId` (a Dart space group) reaches the
 *     adapter with the concrete board its create must land in.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseService } from '../../../database/database';
import { TaskChangeRouter } from '../../../orchestrator/taskChangeRouter';
import { dbAdapter } from '../../../orchestrator/__test_fixtures__/dbAdapter';
import type {
  EntityExternalLinkRow,
  TrackerConflictRow,
  TrackerConnectionRow,
  TrackerOutboxRow,
} from '../../../database/models';
import type {
  TrackerIssue,
  TrackerProvider,
  TrackerNarrowKind,
  TrackerSourceNarrow,
  TrackerSourceSelection,
  TrackerGroupTree,
  TrackerSourceTree,
  TrackerState,
  TrackerWorkspaceIdentity,
} from '../../../../../shared/types/trackerSync';
import type {
  IssueContentPatch,
  IssueDraft,
  TrackerAdapter,
  TrackerAdapterCapabilities,
  TrackerFieldOptionsRaw,
} from '../adapterTypes';
import { TrackerApiError, TrackerAuthError, TrackerRevisionMismatchError } from '../errors';
import {
  enqueueOutbox,
  getConnection,
  getLinkByEntity,
  getLinkById,
  insertConnection,
  markOrphaned,
  requeueInFlightAsAmbiguous,
  supersedeQueuedStateWrites,
  updateConnectionSettings,
  upsertLink,
  type NewConnectionRow,
} from '../store';
import { drainOutbox, processAmbiguous, toSqliteUtc, type OutboxDeps } from '../outboxWorker';
import { resolveStageIds } from '../stateMapping';
import type { CreateSubIssuePayload, UpdateStatePayload } from '../writeBack';

const PROJECT_ID = 1;
const NOW = '2026-07-30 12:00:00';
const SELECTION: TrackerSourceSelection = { containerId: 'team-1', narrowId: 'all', narrowKind: 'all' };

const STATES: TrackerState[] = [
  { id: 'state-backlog', name: 'Backlog', color: null, group: 'backlog' },
  { id: 'state-progress', name: 'In Progress', color: null, group: 'started' },
  { id: 'state-done', name: 'Done', color: null, group: 'completed' },
  { id: 'state-canceled', name: 'Canceled', color: null, group: 'cancelled' },
];

let tmpDir: string;
let svc: DatabaseService;
let raw: Database.Database;
/**
 * The REAL entity-write chokepoint, exactly as inboundSync.test.ts uses it: the
 * one local write this module makes (the post-create description alignment)
 * must go through it, and a fake that only records the call would not prove the
 * body actually lands.
 */
let router: TaskChangeRouter;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'cyboflow-trackersync-outbox-'));
  svc = new DatabaseService(join(tmpDir, 'test.db'));
  svc.initialize();
  raw = svc.getDb();
  raw.prepare('INSERT INTO projects (id, name, path) VALUES (?, ?, ?)').run(PROJECT_ID, 'Proj 1', '/tmp/p1');
  // The content and archive fixtures write real entity rows, which need a board
  // and its stages. Idempotent, so the tests that seed it themselves still do.
  svc.seedDefaultBoard(PROJECT_ID);
  router = new TaskChangeRouter(dbAdapter(raw));
});

afterEach(() => {
  raw.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Fake adapter
// ---------------------------------------------------------------------------

interface UpdateCall {
  externalId: string;
  stateId: string;
  /** The guarded-update pre-send token, when the caller forwarded one. */
  expectedToken?: string;
}
interface CreateCall {
  /** Null on a top-level `createIssue` (the push direction). */
  parentExternalId: string | null;
  draft: IssueDraft;
  clientKey: string;
  /** The source container a top-level create was filed into; null on a sub-issue. */
  containerId?: string | null;
  /**
   * The concrete container a Dart space group's create must be filed against —
   * undefined for every selection whose own container is already one.
   */
  pushContainerId?: string;
}

/** Scriptable TrackerAdapter: records every call, throws whatever a test queues. */
class FakeAdapter implements TrackerAdapter {
  provider: TrackerProvider = 'linear';
  capabilities: TrackerAdapterCapabilities = {
    nativeParentAutoClose: true,
    selfHostedBaseUrl: false,
    idempotentCreate: true,
    contentWrite: { title: true, description: true, priority: true, category: false },
    archive: 'trash',
    requiresIdReconciliation: false,
    guardedUpdates: false,
  };

  states: TrackerState[] = STATES;
  issues: TrackerIssue[] = [];
  /** Point-lookup table for getIssue (Linear's client key IS the issue id). */
  issuesById = new Map<string, TrackerIssue>();

  /** Per-method scripted failure; consumed on the next call. */
  failUpdate: Error | null = null;
  failCreate: Error | null = null;
  failLookup: Error | null = null;
  failContent: Error | null = null;
  failArchive: Error | null = null;

  /**
   * The contract-violating case `TrackerAdapter.updateIssueContent` reserves
   * `null` for — no adapter here takes it, so the worker's loud fallback needs
   * a fake that does.
   */
  contentReturnsNull = false;

  /** A provider that rewrites the markdown it stores. Identity by default. */
  normalizeStored: (description: string | null) => string | null = (description) => description;

  /** Runs INSIDE updateIssueContent — a test's hook for a mid-flight local edit. */
  onContentWrite: (() => void) | undefined = undefined;

  /** Runs INSIDE archiveIssue — a test's hook for a mid-flight connection change. */
  onArchiveWrite: (() => void) | undefined = undefined;

  readonly updateCalls: UpdateCall[] = [];
  readonly createCalls: CreateCall[] = [];
  readonly contentCalls: Array<{
    externalId: string;
    patch: IssueContentPatch;
    expectedToken?: string;
  }> = [];
  readonly archiveCalls: string[] = [];
  listStatesCalls = 0;
  listIssuesCalls = 0;

  async validateCredentials(): Promise<TrackerWorkspaceIdentity> {
    return { workspaceId: 'ws-1', workspaceName: 'Acme', actorLabel: 'K.' };
  }
  async listGroups(): Promise<TrackerGroupTree> {
    return { sections: [] };
  }
  async listContainers(): Promise<TrackerSourceTree> {
    return { containerLabel: 'Team', containers: [] };
  }
  async listNarrows(): Promise<TrackerSourceNarrow[]> {
    return [];
  }
  async listStates(): Promise<TrackerState[]> {
    this.listStatesCalls += 1;
    return this.states;
  }
  /** The provider's live vocabulary — a Dart-shaped fake overrides it. */
  fieldOptions: TrackerFieldOptionsRaw = { priorities: ['0', '1', '2', '3', '4'], categories: null };

  async listFieldOptions(): Promise<TrackerFieldOptionsRaw> {
    return this.fieldOptions;
  }
  async listIssues(): Promise<TrackerIssue[]> {
    this.listIssuesCalls += 1;
    if (this.failLookup) throw this.takeFailure('failLookup');
    return this.issues;
  }
  async listIssueIds(): Promise<string[]> {
    return this.issues.map((i) => i.externalId);
  }
  async getIssue(externalId: string): Promise<TrackerIssue | null> {
    if (this.failLookup) throw this.takeFailure('failLookup');
    return this.issuesById.get(externalId) ?? null;
  }
  async createSubIssue(
    parentExternalId: string,
    draft: IssueDraft,
    clientKey: string,
  ): Promise<TrackerIssue> {
    this.createCalls.push({ parentExternalId, draft, clientKey });
    if (this.failCreate) throw this.takeFailure('failCreate');
    return makeIssue(clientKey, { title: draft.title, parentExternalId });
  }
  async createIssue(
    selection: TrackerSourceSelection,
    draft: IssueDraft,
    clientKey: string,
  ): Promise<TrackerIssue> {
    this.createCalls.push({
      parentExternalId: null,
      containerId: selection.containerId,
      pushContainerId: selection.pushContainerId,
      draft,
      clientKey,
    });
    if (this.failCreate) throw this.takeFailure('failCreate');
    return makeIssue(clientKey, {
      title: draft.title,
      // The provider settles the state: an omitted draft state takes its
      // default, exactly as a real create would.
      stateId: draft.stateId ?? 'state-backlog',
    });
  }
  async updateIssueState(
    externalId: string,
    stateId: string,
    expectedToken?: string,
  ): Promise<void> {
    this.updateCalls.push({ externalId, stateId, expectedToken });
    if (this.failUpdate) throw this.takeFailure('failUpdate');
  }
  /**
   * Echoes the patched issue back, which is what makes it a usable ECHO-
   * SUPPRESSION STAMP SOURCE. `normalizeStored` models a provider that rewrites
   * the markdown it is handed (Dart measurably does) — identity by default.
   */
  async updateIssueContent(
    externalId: string,
    patch: IssueContentPatch,
    expectedToken?: string,
  ): Promise<TrackerIssue | null> {
    this.contentCalls.push({ externalId, patch, expectedToken });
    // The concurrent-edit seam: whatever a test does here happens between the
    // send and the settle, exactly as a real user edit would.
    this.onContentWrite?.();
    if (this.failContent) throw this.takeFailure('failContent');
    if (this.contentReturnsNull) return null;
    const base = this.issuesById.get(externalId) ?? makeIssue(externalId);
    const next: TrackerIssue = {
      ...base,
      ...(patch.title !== undefined ? { title: patch.title } : {}),
      ...(patch.description !== undefined
        ? { description: this.normalizeStored(stripMarker(patch.description)) }
        : {}),
      ...(patch.priority !== undefined ? { priority: patch.priority } : {}),
      ...(patch.category !== undefined ? { category: patch.category } : {}),
    };
    this.issuesById.set(externalId, next);
    this.issues = this.issues.map((issue) => (issue.externalId === externalId ? next : issue));
    return next;
  }
  async archiveIssue(externalId: string): Promise<void> {
    this.archiveCalls.push(externalId);
    // The concurrent seam a disconnect lands through: whatever a test does
    // here happens between the send and the settle, exactly as a real
    // mid-flight disconnect would.
    this.onArchiveWrite?.();
    if (this.failArchive) throw this.takeFailure('failArchive');
  }

  protected takeFailure(
    key: 'failUpdate' | 'failCreate' | 'failLookup' | 'failContent' | 'failArchive',
  ): Error {
    const err = this[key] as Error;
    this[key] = null;
    return err;
  }
}

/**
 * Plane-shaped fake: creates are NOT idempotent, so recovery goes through the
 * client-key marker the adapter stamps into every issue it creates.
 *
 * The key lives in `markers`, not on the TrackerIssue — exactly like the real
 * marker paragraph, which PlaneAdapter strips from every description it
 * returns. A recovery that matched on anything the sync core can see (title,
 * description) would be matching on the wrong thing.
 */
class FakeMarkerAdapter extends FakeAdapter {
  provider: TrackerProvider = 'plane';
  capabilities: TrackerAdapterCapabilities = {
    nativeParentAutoClose: false,
    selfHostedBaseUrl: true,
    idempotentCreate: false,
    contentWrite: { title: true, description: true, priority: true, category: false },
    archive: 'none',
    requiresIdReconciliation: false,
    guardedUpdates: false,
  };

  /** externalId -> the client key stamped into that issue's description. */
  readonly markers = new Map<string, string>();
  clientKeyLookups = 0;
  /** Every scope a recovery lookup was made with, so a test can assert the shape. */
  readonly clientKeyScopes: Array<{
    containerId: string | null;
    narrowKind?: TrackerNarrowKind | null;
    parentExternalId: string | null;
    updatedAfterIso?: string | null;
  }> = [];

  async findIssueByClientKey(
    scope: {
      containerId: string | null;
      narrowKind?: TrackerNarrowKind | null;
      parentExternalId: string | null;
      updatedAfterIso?: string | null;
    },
    clientKey: string,
  ): Promise<TrackerIssue | null> {
    this.clientKeyLookups += 1;
    this.clientKeyScopes.push(scope);
    if (this.failLookup) throw this.takeFailure('failLookup');
    return (
      this.issues.find(
        (issue) =>
          // A null parent means "search the whole container" — the top-level
          // push's shape — so the parent is only compared when one is given.
          (scope.parentExternalId === null ||
            issue.parentExternalId === scope.parentExternalId) &&
          this.markers.get(issue.externalId) === clientKey,
      ) ?? null
    );
  }
}

/**
 * A provider that NORMALIZES the markdown it stores — Dart measurably does (it
 * re-emits emphasis runs, reflows lists and linkifies dotted tokens), so the
 * description a create echoes back is not always the one it was sent.
 *
 * `normalize` is identity by default, which makes the class usable as a plain
 * "echoes the draft description back" adapter too.
 */
class NormalizingAdapter extends FakeAdapter {
  normalize: (sent: string | undefined) => string | null = (sent) => sent ?? null;

  async createSubIssue(
    parentExternalId: string,
    draft: IssueDraft,
    clientKey: string,
  ): Promise<TrackerIssue> {
    this.createCalls.push({ parentExternalId, draft, clientKey });
    if (this.failCreate) throw this.takeFailure('failCreate');
    return makeIssue(clientKey, {
      title: draft.title,
      parentExternalId,
      description: this.normalize(draft.description),
    });
  }

  async createIssue(
    selection: TrackerSourceSelection,
    draft: IssueDraft,
    clientKey: string,
  ): Promise<TrackerIssue> {
    this.createCalls.push({
      parentExternalId: null,
      containerId: selection.containerId,
      pushContainerId: selection.pushContainerId,
      draft,
      clientKey,
    });
    if (this.failCreate) throw this.takeFailure('failCreate');
    return makeIssue(clientKey, {
      title: draft.title,
      stateId: draft.stateId ?? 'state-backlog',
      description: this.normalize(draft.description),
    });
  }
}

/**
 * The lost-response case: the server COMMITS the child and the caller still
 * sees a failure (5xx, timeout, dropped connection). The created issue is
 * recorded — marker and all — exactly as the real remote would hold it, so a
 * blind re-POST shows up as a second child.
 */
class CommitThenFailAdapter extends FakeMarkerAdapter {
  /** Thrown AFTER the child is committed; consumed on the next create. */
  failAfterCommit: Error | null = null;

  async createSubIssue(
    parentExternalId: string,
    draft: IssueDraft,
    clientKey: string,
  ): Promise<TrackerIssue> {
    this.createCalls.push({ parentExternalId, draft, clientKey });
    return this.commit(draft, clientKey, parentExternalId);
  }

  /** Same lost-response shape for the TOP-LEVEL push: committed, then thrown. */
  async createIssue(
    selection: TrackerSourceSelection,
    draft: IssueDraft,
    clientKey: string,
  ): Promise<TrackerIssue> {
    this.createCalls.push({
      parentExternalId: null,
      containerId: selection.containerId,
      draft,
      clientKey,
    });
    return this.commit(draft, clientKey, null);
  }

  private commit(
    draft: IssueDraft,
    clientKey: string,
    parentExternalId: string | null,
  ): TrackerIssue {
    const issue = makeIssue(`proj-1/child-${this.createCalls.length}`, {
      title: draft.title,
      parentExternalId,
      stateId: draft.stateId ?? 'state-backlog',
    });
    this.issues.push(issue);
    this.markers.set(issue.externalId, clientKey);
    if (this.failAfterCommit) {
      const err = this.failAfterCommit;
      this.failAfterCommit = null;
      throw err;
    }
    return issue;
  }
}

function makeIssue(externalId: string, overrides: Partial<TrackerIssue> = {}): TrackerIssue {
  return {
    externalId,
    identifier: `CORE-${externalId.slice(0, 4)}`,
    title: 'Sub issue',
    description: null,
    url: `https://linear.app/acme/issue/${externalId}`,
    stateId: 'state-backlog',
    assignee: null,
    estimate: null,
    parentExternalId: null,
    updatedAt: '2026-07-30T11:59:00.000Z',
    archivedAt: null,
    // The default mapping round-trips '3' (Linear Medium) with the P2 every
    // entity here carries, so an untouched issue never produces a priority diff.
    priority: '3',
    category: null,
    recoveryClientKey: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

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
    // The Step-1 SOURCE choice lives in source_json (selection_json carries the
    // Step-2 tasks-selection payload, which the outbox worker never reads).
    source_json: JSON.stringify(SELECTION),
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

function seedConnection(overrides: Partial<NewConnectionRow> = {}): TrackerConnectionRow {
  return insertConnection(raw, makeConnectionRow(overrides));
}

function makeDeps(adapter: TrackerAdapter, now: string = NOW): OutboxDeps {
  return { db: raw, adapterFor: () => adapter, router, nowIso: () => now };
}

function enqueueStateWrite(
  connectionId: string,
  externalId: string,
  desiredGroup: UpdateStatePayload['desiredGroup'],
  kind: 'update_state' | 'close_parent' = 'update_state',
): TrackerOutboxRow {
  return enqueueOutbox(raw, {
    connection_id: connectionId,
    kind,
    entity_type: 'task',
    entity_id: 'tsk_1',
    external_id: externalId,
    payload_json: JSON.stringify({ desiredGroup } satisfies UpdateStatePayload),
  });
}

function enqueueCreate(connectionId: string, entityId: string, clientKey: string): TrackerOutboxRow {
  const payload: CreateSubIssuePayload = {
    parentExternalId: 'ext-idea',
    title: 'Task TASK-1',
    description: 'body one',
    priority: 'P0',
    category: 'bug',
  };
  return enqueueOutbox(raw, {
    connection_id: connectionId,
    kind: 'create_sub_issue',
    entity_type: 'task',
    entity_id: entityId,
    client_key: clientKey,
    payload_json: JSON.stringify(payload),
  });
}

function fetchOutbox(id: number): TrackerOutboxRow {
  return raw.prepare('SELECT * FROM tracker_outbox WHERE id = ?').get(id) as TrackerOutboxRow;
}

// ---------------------------------------------------------------------------
// Content / archive fixtures
// ---------------------------------------------------------------------------

/** The client key a Plane/Dart create would have stamped into a description. */
const CLIENT_KEY = '11111111-2222-3333-4444-555555555555';

/**
 * A baseline that AGREES with `seedTask`'s defaults on every field except the
 * title — so a test that changes nothing else produces exactly one difference.
 */
const BASE_BASELINE = {
  title: 'Old title',
  description: null,
  stateId: 'state-backlog',
  priority: '3',
  category: null,
};

const BOARD_ID = `board-${PROJECT_ID}-default`;

/** A task row with the content columns a patch is composed from. */
function seedTask(
  id: string,
  opts: {
    title?: string;
    body?: string | null;
    priority?: string;
    category?: string;
    archived?: boolean;
  } = {},
): void {
  raw
    .prepare(
      `INSERT INTO tasks (id, project_id, ref, title, body, board_id, stage_id, priority, category, archived_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      PROJECT_ID,
      id.toUpperCase(),
      opts.title ?? 'Old title',
      opts.body ?? null,
      BOARD_ID,
      resolveStageIds(raw, PROJECT_ID).ready,
      opts.priority ?? 'P2',
      opts.category ?? 'feature',
      opts.archived === true ? '2026-07-30 11:00:00' : null,
    );
}

function seedIdeaRow(id: string): void {
  raw
    .prepare(
      'INSERT INTO ideas (id, project_id, ref, title, board_id, stage_id) VALUES (?, ?, ?, ?, ?, ?)',
    )
    .run(id, PROJECT_ID, id.toUpperCase(), `Idea ${id}`, BOARD_ID, resolveStageIds(raw, PROJECT_ID).idea);
}

function linkTask(
  connectionId: string,
  externalId: string,
  baseline: Record<string, unknown>,
  provider: TrackerProvider = 'linear',
  entityId = 'tsk_1',
): EntityExternalLinkRow {
  return upsertLink(raw, {
    connection_id: connectionId,
    entity_type: 'task',
    entity_id: entityId,
    provider,
    external_id: externalId,
    baseline_json: JSON.stringify(baseline),
  });
}

/**
 * Seed the fake tracker's CURRENT issue to agree with a link's stamped
 * baseline — the steady state the lost-update guard's pre-send read expects.
 * Tests modelling a concurrent remote edit pass `overrides` for the moved
 * field instead.
 */
function seedRemote(
  adapter: FakeAdapter,
  externalId: string,
  baseline: Record<string, unknown>,
  overrides: Partial<TrackerIssue> = {},
): void {
  adapter.issuesById.set(
    externalId,
    makeIssue(externalId, {
      title: typeof baseline.title === 'string' ? baseline.title : 'Sub issue',
      description: typeof baseline.description === 'string' ? baseline.description : null,
      priority: typeof baseline.priority === 'string' ? baseline.priority : null,
      category: typeof baseline.category === 'string' ? baseline.category : null,
      stateId: typeof baseline.stateId === 'string' ? baseline.stateId : 'state-backlog',
      ...overrides,
    }),
  );
}

function enqueueContentWrite(
  connectionId: string,
  externalId: string,
  entityId: string,
): TrackerOutboxRow {
  return enqueueOutbox(raw, {
    connection_id: connectionId,
    kind: 'update_content',
    entity_type: 'task',
    entity_id: entityId,
    external_id: externalId,
    payload_json: '{}',
  });
}

function enqueueArchiveRow(
  connectionId: string,
  externalId: string,
  entityId: string,
): TrackerOutboxRow {
  return enqueueOutbox(raw, {
    connection_id: connectionId,
    kind: 'archive_issue',
    entity_type: 'task',
    entity_id: entityId,
    external_id: externalId,
    payload_json: '{}',
  });
}

function baselineOf(entityId: string): unknown {
  const row = raw
    .prepare('SELECT baseline_json FROM entity_external_links WHERE entity_id = ?')
    .get(entityId) as { baseline_json: string | null } | undefined;
  return JSON.parse(row?.baseline_json ?? '{}') as unknown;
}

function bodyOf(entityId: string): string | null {
  const row = raw.prepare('SELECT body FROM tasks WHERE id = ?').get(entityId) as
    | { body: string | null }
    | undefined;
  return row?.body ?? null;
}

/** The recovery marker the adapters strip from every description they return. */
function stripMarker(description: string | null): string | null {
  if (description === null) return null;
  const cleaned = description.replace(/cyboflow-sync:\s*\S+/gi, '').trim();
  return cleaned.length > 0 ? cleaned : null;
}

/**
 * The `updatedAfterIso` floor a recovery lookup for this row must carry: its
 * own enqueue time, less the day of clock skew the worker allows between our
 * `created_at` and the provider's `updated_at`.
 */
function expectedScanFloor(rowId: number): string {
  const createdAt = fetchOutbox(rowId).created_at;
  return new Date(Date.parse(`${createdAt.replace(' ', 'T')}Z`) - 24 * 60 * 60 * 1000).toISOString();
}

// ---------------------------------------------------------------------------
// Drain — happy paths
// ---------------------------------------------------------------------------

describe('drainOutbox — state writes', () => {
  it('writes the mapped state, settles the row, and stamps the echo-suppression baseline', async () => {
    const connection = seedConnection();
    upsertLink(raw, {
      connection_id: connection.id,
      entity_type: 'task',
      entity_id: 'tsk_1',
      provider: 'linear',
      external_id: 'ext-1',
      baseline_json: JSON.stringify({ stateId: 'state-backlog', title: 'kept' }),
    });
    const row = enqueueStateWrite(connection.id, 'ext-1', 'completed');
    const adapter = new FakeAdapter();

    const report = await drainOutbox(makeDeps(adapter), connection);

    expect(adapter.updateCalls).toEqual([{ externalId: 'ext-1', stateId: 'state-done' }]);
    expect(report.sent).toBe(1);
    expect(fetchOutbox(row.id).state).toBe('done');

    const link = getLinkByEntity(raw, 'task', 'tsk_1', 'linear');
    expect(JSON.parse(link?.baseline_json ?? '{}')).toEqual({
      // Untouched inbound baseline field survives the merge...
      title: 'kept',
      // ...while the state we just wrote replaces the stale one.
      stateId: 'state-done',
      lastWrittenGroup: 'completed',
      lastWrittenAt: NOW,
    });
  });

  it('drains every eligible row and fetches the provider state list ONCE', async () => {
    const connection = seedConnection();
    enqueueStateWrite(connection.id, 'ext-1', 'completed');
    enqueueStateWrite(connection.id, 'ext-2', 'started');
    enqueueStateWrite(connection.id, 'ext-idea', 'completed', 'close_parent');
    const adapter = new FakeAdapter();

    const report = await drainOutbox(makeDeps(adapter), connection);

    expect(report.sent).toBe(3);
    expect(adapter.listStatesCalls).toBe(1);
    expect(adapter.updateCalls.map((c) => c.stateId)).toEqual(['state-done', 'state-progress', 'state-done']);
  });

  it('fails terminally when no provider state maps to the desired group', async () => {
    const connection = seedConnection();
    const row = enqueueStateWrite(connection.id, 'ext-1', 'cancelled');
    const adapter = new FakeAdapter();
    adapter.states = STATES.filter((s) => s.group !== 'cancelled');

    const report = await drainOutbox(makeDeps(adapter), connection);

    expect(adapter.updateCalls).toHaveLength(0);
    expect(report.failedTerminal).toBe(1);
    const settled = fetchOutbox(row.id);
    expect(settled.state).toBe('failed');
    expect(settled.next_attempt_at).toBeNull();
    expect(settled.last_error).toContain('cancelled');
  });
});

describe('drainOutbox — sub-issue creation', () => {
  it('creates the sub-issue and links it to the minted task', async () => {
    const connection = seedConnection();
    const row = enqueueCreate(connection.id, 'tsk_1', 'client-key-1');
    const adapter = new FakeAdapter();

    const report = await drainOutbox(makeDeps(adapter), connection);

    expect(adapter.createCalls).toEqual([
      {
        parentExternalId: 'ext-idea',
        draft: {
          title: 'Task TASK-1',
          description: 'body one',
          // The payload's LOCAL P0, mapped here against the provider's live
          // scale. Category is absent: Linear has no issue type to carry one.
          priority: '1',
        },
        clientKey: 'client-key-1',
      },
    ]);
    expect(report.created).toBe(1);
    expect(fetchOutbox(row.id).state).toBe('done');

    const link = getLinkByEntity(raw, 'task', 'tsk_1', 'linear');
    expect(link?.external_id).toBe('client-key-1');
    expect(link?.external_parent_id).toBe('ext-idea');
    expect(JSON.parse(link?.baseline_json ?? '{}')).toMatchObject({
      stateId: 'state-backlog',
      title: 'Task TASK-1',
      // Seeded from the RESPONSE. An absent key here would read as "never
      // synced" and stand the whole field down on both directions.
      priority: '3',
      category: null,
    });
  });
});

// ---------------------------------------------------------------------------
// Drain — the PUSH direction (create_issue)
// ---------------------------------------------------------------------------

describe('drainOutbox — top-level issue creation (push)', () => {
  /** A real board + idea row: the push draft is composed from them at drain time. */
  function seedIdea(
    id: string,
    opts: {
      title?: string;
      body?: string | null;
      stage?: 'idea' | 'done';
      archived?: boolean;
      priority?: string;
      category?: string;
    } = {},
  ): void {
    svc.seedDefaultBoard(PROJECT_ID);
    const stageIds = resolveStageIds(raw, PROJECT_ID);
    raw
      .prepare(
        `INSERT INTO ideas (id, project_id, ref, title, summary, body, board_id, stage_id, archived_at, priority, category)
         VALUES (?, ?, 'IDEA-1', ?, NULL, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        PROJECT_ID,
        opts.title ?? 'Ship the push direction',
        opts.body ?? null,
        `board-${PROJECT_ID}-default`,
        opts.stage === 'done' ? stageIds.done : stageIds.idea,
        opts.archived === true ? '2026-07-30 11:00:00' : null,
        opts.priority ?? 'P2',
        opts.category ?? 'feature',
      );
  }

  it('carries the MAPPED priority and category per provider, and suppresses what a provider cannot hold', async () => {
    // Dart: both fields land, in the workspace's own spelling.
    const dart = seedConnection({ id: 'conn-dart', provider: 'dart' });
    seedIdea('ide_dart', { priority: 'P0', category: 'bug' });
    enqueuePush(dart.id, 'ide_dart', 'ck-dart');
    const dartAdapter = new FakeAdapter();
    dartAdapter.provider = 'dart';
    dartAdapter.capabilities = {
      ...dartAdapter.capabilities,
      contentWrite: { title: true, description: true, priority: true, category: true },
    };
    dartAdapter.fieldOptions = {
      priorities: ['critical', 'high', 'medium', 'low'],
      categories: ['Task', 'Bug', 'Milestone'],
    };

    await drainOutbox(makeDeps(dartAdapter), dart);

    expect(dartAdapter.createCalls[0].draft).toMatchObject({
      priority: 'critical',
      // The WORKSPACE's spelling, not the local literal — a bogus type 400s.
      category: 'Bug',
    });

    // Linear: same idea, same category, but no issue type exists to put it on.
    const linear = seedConnection({ id: 'conn-linear' });
    raw.prepare("UPDATE ideas SET id = 'ide_lin' WHERE id = 'ide_dart'").run();
    enqueuePush(linear.id, 'ide_lin', 'ck-lin');
    const linearAdapter = new FakeAdapter();

    await drainOutbox(makeDeps(linearAdapter), linear);

    expect(linearAdapter.createCalls[0].draft).toMatchObject({ priority: '1' });
    expect(linearAdapter.createCalls[0].draft).not.toHaveProperty('category');
  });

  it('omits a priority the live mapping can no longer express, rather than guessing', async () => {
    const connection = seedConnection({ id: 'conn-dart2', provider: 'dart' });
    seedIdea('ide_1', { priority: 'P0' });
    enqueuePush(connection.id, 'ide_1', 'ck-1');
    const adapter = new FakeAdapter();
    adapter.provider = 'dart';
    // The workspace renamed 'critical' away — Dart addresses priorities BY
    // TITLE, so the seed's token resolves to nothing.
    adapter.fieldOptions = { priorities: ['high', 'medium', 'low'], categories: null };

    await drainOutbox(makeDeps(adapter), connection);

    // Omitted, so the provider's own default applies. Sending an unknown token
    // is a 400 on Dart (probe D1), which is strictly worse than a default.
    expect(adapter.createCalls[0].draft).not.toHaveProperty('priority');
  });

  function enqueuePush(connectionId: string, entityId: string, clientKey: string): TrackerOutboxRow {
    return enqueueOutbox(raw, {
      connection_id: connectionId,
      kind: 'create_issue',
      entity_type: 'idea',
      entity_id: entityId,
      client_key: clientKey,
      // Empty BY DESIGN — the draft is composed at drain time.
      payload_json: '{}',
    });
  }

  it('composes the draft from the idea AT DRAIN TIME, files it in the source container, and links it', async () => {
    const connection = seedConnection();
    seedIdea('ide_1', {
      title: 'Ship the push direction',
      // A provenance footer must never reach a remote body, even though an idea
      // carrying one is not pushed in the first place.
      body: 'The local description.\n\n---\n<!-- cyboflow:tracker linear:ext-9 -->\nImported from Linear',
    });
    const row = enqueuePush(connection.id, 'ide_1', 'client-key-push');
    const adapter = new FakeAdapter();

    const report = await drainOutbox(makeDeps(adapter), connection);

    expect(adapter.createCalls).toEqual([
      {
        parentExternalId: null,
        containerId: SELECTION.containerId,
        draft: {
          title: 'Ship the push direction',
          description: 'The local description.',
          // Stage 'Idea' maps to no write-back group, so the create falls back
          // to the BACKLOG-group state.
          stateId: 'state-backlog',
          // The idea's own P2, mapped to Linear's Medium.
          priority: '3',
        },
        clientKey: 'client-key-push',
      },
    ]);
    expect(report.created).toBe(1);
    expect(fetchOutbox(row.id).state).toBe('done');

    const link = getLinkByEntity(raw, 'idea', 'ide_1', 'linear');
    expect(link?.external_id).toBe('client-key-push');
    expect(link?.external_parent_id).toBeNull();
    const baseline = JSON.parse(link?.baseline_json ?? '{}') as Record<string, unknown>;
    expect(baseline).toMatchObject({
      stateId: 'state-backlog',
      title: 'Ship the push direction',
      priority: '3',
      category: null,
    });
    // Backlog is not a write-back group, so no stamp — a stale one would
    // suppress the first genuine Done/Won't-do write-back.
    expect(baseline).not.toHaveProperty('lastWrittenGroup');
  });

  it("stamps lastWrittenGroup with the group the issue ACTUALLY landed in", async () => {
    const connection = seedConnection();
    seedIdea('ide_1', { stage: 'done' });
    enqueuePush(connection.id, 'ide_1', 'client-key-done');
    const adapter = new FakeAdapter();

    await drainOutbox(makeDeps(adapter), connection);

    expect(adapter.createCalls[0].draft.stateId).toBe('state-done');
    const link = getLinkByEntity(raw, 'idea', 'ide_1', 'linear');
    expect(JSON.parse(link?.baseline_json ?? '{}')).toMatchObject({
      stateId: 'state-done',
      lastWrittenGroup: 'completed',
    });
  });

  it('settles a push whose idea was deleted or archived, WITHOUT a remote write', async () => {
    const connection = seedConnection();
    // (a) hard-deleted: no row at all.
    const gone = enqueuePush(connection.id, 'ide_gone', 'client-key-gone');
    // (b) archived while the push waited.
    seedIdea('ide_archived', { archived: true });
    const archived = enqueuePush(connection.id, 'ide_archived', 'client-key-archived');
    const adapter = new FakeAdapter();

    const report = await drainOutbox(makeDeps(adapter), connection);

    expect(adapter.createCalls).toEqual([]);
    expect(report.created).toBe(0);
    expect(report.failedTerminal).toBe(0);
    for (const row of [gone, archived]) expect(fetchOutbox(row.id).state).toBe('done');
    expect(getLinkByEntity(raw, 'idea', 'ide_archived', 'linear')).toBeNull();
  });

  it('leaves a push row untouched when the drain does not own the push direction', async () => {
    const connection = seedConnection();
    seedIdea('ide_1');
    const push = enqueuePush(connection.id, 'ide_1', 'client-key-held');
    const state = enqueueStateWrite(connection.id, 'ext-1', 'completed');
    const adapter = new FakeAdapter();

    const report = await drainOutbox(makeDeps(adapter), connection, ['update_state', 'close_parent']);

    expect(adapter.createCalls).toEqual([]);
    expect(report.sent).toBe(1);
    expect(fetchOutbox(state.id).state).toBe('done');
    // Held, not consumed: still pending, still attempt 0.
    expect(fetchOutbox(push.id).state).toBe('pending');
    expect(fetchOutbox(push.id).attempts).toBe(0);
  });

  it("carries the stored pushContainerId through to the adapter — a Dart space's create needs a board", async () => {
    // A space group's containerId is a space NAME no issue can be filed in, so
    // the concrete board travels with the selection.
    const connection = seedConnection({
      provider: 'dart',
      source_json: JSON.stringify({
        containerId: 'Engineering',
        narrowId: 'all',
        narrowKind: 'space',
        pushContainerId: 'Engineering/Sprint',
      }),
    });
    seedIdea('ide_1');
    enqueuePush(connection.id, 'ide_1', 'client-key-space');
    const adapter = new FakeAdapter();
    adapter.provider = 'dart';

    await drainOutbox(makeDeps(adapter), connection);

    expect(adapter.createCalls[0].containerId).toBe('Engineering');
    expect(adapter.createCalls[0].pushContainerId).toBe('Engineering/Sprint');
  });

  it('parks an uncertain push as ambiguous on a provider without idempotent creates', async () => {
    const connection = seedConnection({ provider: 'plane' });
    seedIdea('ide_1');
    const row = enqueuePush(connection.id, 'ide_1', 'client-key-lost');
    const adapter = new CommitThenFailAdapter();
    adapter.failAfterCommit = new TrackerApiError('plane', 'gateway timeout', 504);

    const report = await drainOutbox(makeDeps(adapter), connection);

    // NOT a blind retry: the issue may well exist remotely already.
    expect(fetchOutbox(row.id).state).toBe('ambiguous');
    expect(report.retriesScheduled).toBe(1);
    expect(getLinkByEntity(raw, 'idea', 'ide_1', 'plane')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Drain — post-create description alignment
// ---------------------------------------------------------------------------

describe('drainOutbox — aligning the local body with what the provider stored', () => {
  /** A real idea row, since the alignment writes through the entity chokepoint. */
  function seedIdea(id: string, body: string | null): void {
    svc.seedDefaultBoard(PROJECT_ID);
    const stageIds = resolveStageIds(raw, PROJECT_ID);
    raw
      .prepare(
        `INSERT INTO ideas (id, project_id, ref, title, summary, body, board_id, stage_id)
         VALUES (?, ?, 'IDEA-1', 'Ship the push direction', NULL, ?, ?, ?)`,
      )
      .run(id, PROJECT_ID, body, `board-${PROJECT_ID}-default`, stageIds.idea);
  }

  /** The mirrored TASK a `create_sub_issue` row points at. */
  function seedTask(id: string, body: string | null): void {
    svc.seedDefaultBoard(PROJECT_ID);
    const stageIds = resolveStageIds(raw, PROJECT_ID);
    raw
      .prepare(
        `INSERT INTO tasks (id, project_id, ref, title, summary, body, board_id, stage_id)
         VALUES (?, ?, 'TASK-1', 'Task TASK-1', NULL, ?, ?, ?)`,
      )
      .run(id, PROJECT_ID, body, `board-${PROJECT_ID}-default`, stageIds.ready);
  }

  function enqueuePush(connectionId: string, entityId: string, clientKey: string): TrackerOutboxRow {
    return enqueueOutbox(raw, {
      connection_id: connectionId,
      kind: 'create_issue',
      entity_type: 'idea',
      entity_id: entityId,
      client_key: clientKey,
      payload_json: '{}',
    });
  }

  function readBody(table: 'ideas' | 'tasks', id: string): string | null {
    return (raw.prepare(`SELECT body FROM ${table} WHERE id = ?`).get(id) as { body: string | null }).body;
  }

  /** Every event the tracker itself wrote for an entity — the audit half of the fix. */
  function providerEvents(entityId: string): Array<{ kind: string; actor: string }> {
    return raw
      .prepare('SELECT kind, actor FROM entity_events WHERE entity_id = ? ORDER BY seq')
      .all(entityId) as Array<{ kind: string; actor: string }>;
  }

  it('rewrites a mirrored task body when the provider normalized what it stored', async () => {
    // The baseline is snapshotted from the RETURNED description, so a local body
    // left holding the authored text disagrees with it from day one — and the
    // next genuine remote edit merges against a baseline the local never
    // matched, whole-field-replacing the local body with the mangled copy.
    const connection = seedConnection({ provider: 'dart' });
    seedTask('tsk_1', 'body one');
    const row = enqueueCreate(connection.id, 'tsk_1', 'client-key-1');
    const adapter = new NormalizingAdapter();
    adapter.provider = 'dart';
    adapter.normalize = (sent) => `*${sent}*`;

    await drainOutbox(makeDeps(adapter), connection);

    expect(fetchOutbox(row.id).state).toBe('done');
    expect(readBody('tasks', 'tsk_1')).toBe('*body one*');
    // Local and baseline now agree, which is the whole point.
    const link = getLinkByEntity(raw, 'task', 'tsk_1', 'dart');
    expect(JSON.parse(link?.baseline_json ?? '{}')).toMatchObject({ description: '*body one*' });
    // Attributed to the tracker, not to a user or an agent.
    expect(providerEvents('tsk_1')).toEqual([{ kind: 'updated', actor: 'dart' }]);
  });

  it('PRESERVES the local provenance footer when it rewrites a pushed idea body', async () => {
    // The footer is cyboflow's half of the body and belongs to no provider, so
    // the alignment replaces the description half only — exactly as an inbound
    // merge would.
    const footer = '---\n<!-- cyboflow:tracker dart:ext-9 -->\nImported from Dart';
    const connection = seedConnection({ provider: 'dart' });
    seedIdea('ide_1', `The local description.\n\n${footer}`);
    enqueuePush(connection.id, 'ide_1', 'client-key-push');
    const adapter = new NormalizingAdapter();
    adapter.provider = 'dart';
    adapter.normalize = (sent) => `${sent} (reflowed)`;

    await drainOutbox(makeDeps(adapter), connection);

    // The footer never reached the wire in the first place...
    expect(adapter.createCalls[0].draft.description).toBe('The local description.');
    // ...and it survives the correction that comes back.
    expect(readBody('ideas', 'ide_1')).toBe(`The local description. (reflowed)\n\n${footer}`);
    const link = getLinkByEntity(raw, 'idea', 'ide_1', 'dart');
    expect(JSON.parse(link?.baseline_json ?? '{}')).toMatchObject({
      description: 'The local description. (reflowed)',
    });
  });

  it('writes NOTHING when the provider echoed the description back unchanged', async () => {
    // The ordinary case on every provider. A local write here would be an entity
    // event with nothing behind it — the merge would never have diffed on it.
    const connection = seedConnection({ provider: 'dart' });
    seedTask('tsk_1', 'body one');
    const adapter = new NormalizingAdapter();
    adapter.provider = 'dart';
    enqueueCreate(connection.id, 'tsk_1', 'client-key-1');

    await drainOutbox(makeDeps(adapter), connection);

    expect(readBody('tasks', 'tsk_1')).toBe('body one');
    expect(providerEvents('tsk_1')).toEqual([]);
  });

  it('leaves the body alone when the local entity was edited after the create was enqueued', async () => {
    // The comparison is against what we SENT, never against the local body: the
    // two differ exactly when the user edited in between, and there the local
    // text is newer than the create's echo.
    const connection = seedConnection({ provider: 'dart' });
    seedTask('tsk_1', 'a newer local edit');
    const adapter = new NormalizingAdapter();
    adapter.provider = 'dart';
    // The payload still carries 'body one' — what the enqueue captured.
    enqueueCreate(connection.id, 'tsk_1', 'client-key-1');

    await drainOutbox(makeDeps(adapter), connection);

    expect(readBody('tasks', 'tsk_1')).toBe('a newer local edit');
    expect(providerEvents('tsk_1')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Drain — supersession
//
// The drain is serial, so two writes are never in flight at once — but they can
// still land out of ORDER across passes, and the tracker keeps whichever
// arrived last.
// ---------------------------------------------------------------------------

describe('a stale state write never lands after a newer one', () => {
  /**
   * Enqueue a state write the way the two real call sites do —
   * writeBack.enqueueStateWrite and TrackerSyncService.enqueueGroupWriteBack —
   * which is `enqueueOutbox` followed by the supersession sweep.
   */
  function enqueueSuperseding(
    connectionId: string,
    externalId: string,
    desiredGroup: UpdateStatePayload['desiredGroup'],
    kind: 'update_state' | 'close_parent' = 'update_state',
  ): TrackerOutboxRow {
    const row = enqueueStateWrite(connectionId, externalId, desiredGroup, kind);
    supersedeQueuedStateWrites(raw, connectionId, externalId, row.id);
    return row;
  }

  it('settles the queued older write the moment a newer one is enqueued', async () => {
    const connection = seedConnection();
    const stale = enqueueSuperseding(connection.id, 'ext-1', 'started');
    const fresh = enqueueSuperseding(connection.id, 'ext-1', 'completed');

    // Settled at ENQUEUE, before any drain: `done`, not `failed`. Nothing went
    // wrong — the instruction was replaced — so there is nothing to retry and
    // nothing to report as a failure.
    const dropped = fetchOutbox(stale.id);
    expect(dropped.state).toBe('done');
    expect(dropped.next_attempt_at).toBeNull();
    expect(dropped.last_error).toContain('superseded');

    const adapter = new FakeAdapter();
    const report = await drainOutbox(makeDeps(adapter), connection);

    expect(adapter.updateCalls).toEqual([{ externalId: 'ext-1', stateId: 'state-done' }]);
    expect(report.sent).toBe(1);
    expect(report.failedTerminal).toBe(0);
    expect(fetchOutbox(fresh.id).state).toBe('done');
  });

  it('drops a stale write whose backoff outlived the newer one that ALREADY LANDED', async () => {
    // THE REGRESSION, in the sequence that produces it: 'started' fails and
    // takes a two-minute backoff; 'completed' is enqueued, is eligible
    // immediately, and drains; then the backoff expires and the stale row is
    // claimed — dragging a Done issue back to In Progress.
    //
    // This is also why the fix cannot live at claim time alone: by then the
    // newer row is `done`, so nothing the drain can query still knows it
    // existed. The enqueue in the middle of this test is the only moment both
    // rows are visible at once.
    const connection = seedConnection();
    const stale = enqueueSuperseding(connection.id, 'ext-1', 'started');
    const adapter = new FakeAdapter();
    adapter.failUpdate = new TrackerApiError('linear', 'bad gateway', 502);
    await drainOutbox(makeDeps(adapter), connection);
    expect(fetchOutbox(stale.id).state).toBe('pending');
    expect(fetchOutbox(stale.id).next_attempt_at).not.toBeNull();

    adapter.failUpdate = null;
    const fresh = enqueueSuperseding(connection.id, 'ext-1', 'completed');
    await drainOutbox(makeDeps(adapter), connection);
    expect(fetchOutbox(fresh.id).state).toBe('done');

    // The backoff expires. Nothing more may go out for this issue.
    raw.prepare('UPDATE tracker_outbox SET next_attempt_at = NULL WHERE id = ?').run(stale.id);
    const report = await drainOutbox(makeDeps(adapter), connection);

    expect(report.sent).toBe(0);
    // The last thing the tracker was told is the CURRENT state, not the stale one.
    expect(adapter.updateCalls.at(-1)).toEqual({ externalId: 'ext-1', stateId: 'state-done' });
    expect(fetchOutbox(stale.id).state).toBe('done');
  });

  it('supersedes ACROSS the two status kinds, and never across different issues', async () => {
    // update_state and close_parent both move the SAME issue's state, so a
    // later one of either kind states the truth the earlier one is wrong about
    // — the same key writeBack's enqueue dedupe uses. A write for a DIFFERENT
    // issue supersedes nothing.
    const connection = seedConnection();
    const stale = enqueueSuperseding(connection.id, 'ext-idea', 'started');
    const other = enqueueSuperseding(connection.id, 'ext-other', 'started');
    enqueueSuperseding(connection.id, 'ext-idea', 'completed', 'close_parent');

    expect(fetchOutbox(stale.id).state).toBe('done');
    expect(fetchOutbox(other.id).state).toBe('pending');

    const adapter = new FakeAdapter();
    const report = await drainOutbox(makeDeps(adapter), connection);

    expect(report.sent).toBe(2);
    expect(adapter.updateCalls).toEqual([
      { externalId: 'ext-other', stateId: 'state-progress' },
      { externalId: 'ext-idea', stateId: 'state-done' },
    ]);
  });

  it('leaves an IN-FLIGHT older write alone — its request is already out', async () => {
    // Settling it would be a lie about an outcome nobody knows, and it needs no
    // handling: the claim is serial, so the newer row is claimed only after the
    // in-flight one finishes and therefore still lands last.
    const connection = seedConnection();
    const older = enqueueStateWrite(connection.id, 'ext-1', 'started');
    raw.prepare("UPDATE tracker_outbox SET state = 'in_flight' WHERE id = ?").run(older.id);

    enqueueSuperseding(connection.id, 'ext-1', 'completed');

    expect(fetchOutbox(older.id).state).toBe('in_flight');
  });

  it('BACKSTOP: the drain refuses a stale row that never met the enqueue sweep', async () => {
    // The invariant re-checked at the point of use, for a row queued before this
    // behaviour existed (or by an enqueue path that forgets the sweep). Raw
    // enqueues here, deliberately — no supersession at write time.
    const connection = seedConnection();
    const stale = enqueueStateWrite(connection.id, 'ext-1', 'started');
    const fresh = enqueueStateWrite(connection.id, 'ext-1', 'completed');
    expect(fetchOutbox(stale.id).state).toBe('pending');
    const adapter = new FakeAdapter();

    const report = await drainOutbox(makeDeps(adapter), connection);

    expect(report.superseded).toBe(1);
    expect(report.sent).toBe(1);
    expect(adapter.updateCalls).toEqual([{ externalId: 'ext-1', stateId: 'state-done' }]);
    expect(fetchOutbox(stale.id).last_error).toContain('superseded');
    expect(fetchOutbox(fresh.id).state).toBe('done');
  });

  it('BACKSTOP: a TERMINALLY FAILED newer row supersedes nothing', async () => {
    // Only an UNSETTLED row can still speak for the issue. A newer write that
    // failed for good will never reach the tracker, so dropping the older one
    // for it would leave the remote at neither value.
    const connection = seedConnection();
    const older = enqueueStateWrite(connection.id, 'ext-1', 'started');
    const newer = enqueueStateWrite(connection.id, 'ext-1', 'completed');
    raw
      .prepare("UPDATE tracker_outbox SET state = 'failed', next_attempt_at = NULL WHERE id = ?")
      .run(newer.id);
    const adapter = new FakeAdapter();

    const report = await drainOutbox(makeDeps(adapter), connection);

    expect(report.superseded).toBe(0);
    expect(adapter.updateCalls).toEqual([{ externalId: 'ext-1', stateId: 'state-progress' }]);
    expect(fetchOutbox(older.id).state).toBe('done');
  });
});

// ---------------------------------------------------------------------------
// Drain — failures
// ---------------------------------------------------------------------------

describe('drainOutbox — failure handling', () => {
  it('schedules an exponential-backoff retry on a 5xx', async () => {
    const connection = seedConnection();
    const row = enqueueStateWrite(connection.id, 'ext-1', 'completed');
    const adapter = new FakeAdapter();
    adapter.failUpdate = new TrackerApiError('linear', 'bad gateway', 502);

    const report = await drainOutbox(makeDeps(adapter), connection);

    expect(report.retriesScheduled).toBe(1);
    const settled = fetchOutbox(row.id);
    // Re-queued as pending, one attempt in, first backoff = 2^1 minutes.
    expect(settled.state).toBe('pending');
    expect(settled.attempts).toBe(1);
    expect(settled.next_attempt_at).toBe('2026-07-30 12:02:00');
    expect(settled.last_error).toContain('bad gateway');
  });

  it('clamps the backoff at 32 minutes', async () => {
    const connection = seedConnection();
    const row = enqueueStateWrite(connection.id, 'ext-1', 'completed');
    raw.prepare('UPDATE tracker_outbox SET attempts = 9 WHERE id = ?').run(row.id);
    const adapter = new FakeAdapter();
    adapter.failUpdate = new TrackerApiError('linear', 'server exploded', 503);

    await drainOutbox(makeDeps(adapter), connection);

    expect(fetchOutbox(row.id).next_attempt_at).toBe('2026-07-30 12:32:00');
  });

  it('does not retry a non-rate-limit 4xx', async () => {
    const connection = seedConnection();
    const row = enqueueStateWrite(connection.id, 'ext-1', 'completed');
    const adapter = new FakeAdapter();
    adapter.failUpdate = new TrackerApiError('linear', 'unknown issue', 404);

    const report = await drainOutbox(makeDeps(adapter), connection);

    expect(report.failedTerminal).toBe(1);
    expect(report.retriesScheduled).toBe(0);
    expect(fetchOutbox(row.id).state).toBe('failed');
  });

  it('pauses the connection and HALTS the drain on an auth failure, HOLDING the rejected row', async () => {
    const connection = seedConnection();
    const first = enqueueStateWrite(connection.id, 'ext-1', 'completed');
    const second = enqueueStateWrite(connection.id, 'ext-2', 'completed');
    const adapter = new FakeAdapter();
    adapter.failUpdate = new TrackerAuthError('linear', 'invalid api key', 401);

    const report = await drainOutbox(makeDeps(adapter), connection);

    expect(report.authPaused).toBe(true);
    expect(getConnection(raw, connection.id)?.status).toBe('paused');

    // NOT terminal: the credentials are wrong, the WRITE is not, and nothing
    // re-derives a stage move whose entity event is long past. The row waits,
    // eligible the instant the connection is usable again — no backoff, because
    // no drain claims a non-active connection's rows in the meantime.
    expect(report.failedTerminal).toBe(0);
    expect(report.retriesScheduled).toBe(1);
    const held = fetchOutbox(first.id);
    expect(held.state).toBe('pending');
    expect(held.next_attempt_at).toBe(NOW);
    expect(held.last_error).toContain('invalid api key');

    // The second row was never claimed — the drain stopped.
    expect(fetchOutbox(second.id).state).toBe('pending');
    expect(fetchOutbox(second.id).attempts).toBe(0);
    expect(adapter.updateCalls).toHaveLength(1);
  });

  it('replays every held write once the connection is resumed with a working key', async () => {
    const connection = seedConnection();
    const first = enqueueStateWrite(connection.id, 'ext-1', 'completed');
    const second = enqueueStateWrite(connection.id, 'ext-2', 'cancelled');
    const adapter = new FakeAdapter();
    adapter.failUpdate = new TrackerAuthError('linear', 'invalid api key', 401);
    await drainOutbox(makeDeps(adapter), connection);
    expect(adapter.updateCalls).toHaveLength(1);

    // The rotation (facade: updateCredentials) stores a fresh key and flips the
    // connection back to 'active'. Both held rows are still queued, in order.
    adapter.failUpdate = null;
    updateConnectionSettings(raw, connection.id, { status: 'active' });
    const resumed = getConnection(raw, connection.id);
    if (resumed === null) throw new Error('connection vanished');

    const report = await drainOutbox(makeDeps(adapter), resumed);

    expect(report.sent).toBe(2);
    // Past the one rejected attempt the paused drain made, both held writes go
    // out — in their original order, which is what holding them preserved.
    expect(adapter.updateCalls.slice(1).map((call) => call.externalId)).toEqual(['ext-1', 'ext-2']);
    expect(fetchOutbox(first.id).state).toBe('done');
    expect(fetchOutbox(second.id).state).toBe('done');
  });

  it('leaves the row in_flight when the local record fails AFTER a successful send', async () => {
    const connection = seedConnection();
    // A DIFFERENT entity already owns this external id under the connection,
    // so upsertLink's (connection_id, external_id) uniqueness blows up after
    // the create has already landed remotely.
    upsertLink(raw, {
      connection_id: connection.id,
      entity_type: 'task',
      entity_id: 'tsk_other',
      provider: 'linear',
      external_id: 'client-key-1',
    });
    const row = enqueueCreate(connection.id, 'tsk_1', 'client-key-1');
    const adapter = new FakeAdapter();

    await expect(drainOutbox(makeDeps(adapter), connection)).rejects.toThrow();

    // NOT failed, NOT retried: the remote write happened, so only boot
    // recovery (in_flight -> ambiguous) may touch this row.
    expect(fetchOutbox(row.id).state).toBe('in_flight');
    expect(adapter.createCalls).toHaveLength(1);
  });

  it('skips a row whose next_attempt_at is still in the future', async () => {
    const connection = seedConnection();
    const row = enqueueStateWrite(connection.id, 'ext-1', 'completed');
    raw
      .prepare("UPDATE tracker_outbox SET next_attempt_at = '2026-07-30 12:30:00' WHERE id = ?")
      .run(row.id);
    const adapter = new FakeAdapter();

    const report = await drainOutbox(makeDeps(adapter), connection);

    expect(report.sent).toBe(0);
    expect(adapter.updateCalls).toHaveLength(0);
    expect(fetchOutbox(row.id).state).toBe('pending');
  });
});

// ---------------------------------------------------------------------------
// Drain — migration 118's new kinds, before Phase 5 wires a real handler
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Drain — update_content
// ---------------------------------------------------------------------------

describe('drainOutbox — update_content', () => {
  it('sends ONLY the fields that differ from the baseline and stamps the response back', async () => {
    const connection = seedConnection();
    seedTask('tsk_1', { title: 'New title', body: 'New body', priority: 'P0' });
    const baseline = {
      title: 'Old title',
      description: 'New body',
      stateId: 'state-backlog',
      priority: '3',
      category: null,
    };
    linkTask(connection.id, 'ext-1', baseline);
    const row = enqueueContentWrite(connection.id, 'ext-1', 'tsk_1');
    const adapter = new FakeAdapter();
    seedRemote(adapter, 'ext-1', baseline);

    const report = await drainOutbox(makeDeps(adapter), connection);

    expect(report.contentWritten).toBe(1);
    expect(fetchOutbox(row.id).state).toBe('done');
    // description matched the baseline after normalization, so it is absent.
    expect(adapter.contentCalls).toEqual([
      { externalId: 'ext-1', patch: { title: 'New title', priority: '1' } },
    ]);

    // The stamp names ONLY what was written; every other baseline key survives.
    expect(baselineOf('tsk_1')).toEqual({
      title: 'New title',
      description: 'New body',
      stateId: 'state-backlog',
      priority: '1',
      category: null,
      lastWrittenAt: NOW,
    });
  });

  it('stamps the PROVIDER-NORMALIZED text, not what we sent, and realigns the local body', async () => {
    const connection = seedConnection();
    seedTask('tsk_1', { title: 'T', body: '*emphasis*' });
    const baseline = {
      title: 'T',
      description: 'was',
      stateId: 'state-backlog',
      priority: '3',
      category: null,
    };
    linkTask(connection.id, 'ext-1', baseline);
    enqueueContentWrite(connection.id, 'ext-1', 'tsk_1');
    const adapter = new FakeAdapter();
    seedRemote(adapter, 'ext-1', baseline);
    // Dart's measured behaviour: the markdown it stores is not the markdown it
    // was handed.
    adapter.normalizeStored = (description) => description?.replace('*emphasis*', '_emphasis_') ?? null;

    await drainOutbox(makeDeps(adapter), connection);

    const stamped = baselineOf('tsk_1') as { description: string };
    expect(stamped.description).toBe('_emphasis_');
    // …and the LOCAL body is corrected to match, so the next genuine remote
    // edit merges cleanly instead of reading as "both sides moved".
    expect(bodyOf('tsk_1')).toBe('_emphasis_');
  });

  it('settles `done` WITHOUT sending when nothing differs any more', async () => {
    const connection = seedConnection();
    seedTask('tsk_1', { title: 'Same', body: 'Same body' });
    linkTask(connection.id, 'ext-1', {
      title: 'Same',
      description: 'Same body',
      stateId: 'state-backlog',
      priority: '3',
      category: null,
    });
    const row = enqueueContentWrite(connection.id, 'ext-1', 'tsk_1');
    const adapter = new FakeAdapter();

    const report = await drainOutbox(makeDeps(adapter), connection);

    expect(adapter.contentCalls).toHaveLength(0);
    expect(report.contentWritten).toBe(0);
    expect(fetchOutbox(row.id).state).toBe('done');
  });

  it('never sends a field the provider cannot write, or one the baseline never synced', async () => {
    const connection = seedConnection({ provider: 'dart' });
    seedTask('tsk_1', { title: 'New title', category: 'bug' });
    // No `priority` / `category` key at all: a link written before the fields
    // were synced. Invariant 3 — an unknown remote is not a difference.
    linkTask(
      connection.id,
      'ext-1',
      { title: 'Old title', description: null, stateId: 'state-backlog' },
      'dart',
    );
    enqueueContentWrite(connection.id, 'ext-1', 'tsk_1');
    const adapter = new FakeAdapter();
    seedRemote(adapter, 'ext-1', { title: 'Old title', description: null, stateId: 'state-backlog' });
    adapter.provider = 'dart';
    // Category IS writable on this provider — the omission below is the
    // backfill arm, not a capability gate.
    adapter.capabilities = {
      ...adapter.capabilities,
      contentWrite: { title: true, description: true, priority: true, category: true },
    };

    await drainOutbox(makeDeps(adapter), connection);

    expect(adapter.contentCalls[0].patch).toEqual({ title: 'New title' });
  });

  it('drops category for a provider that has no issue type', async () => {
    const connection = seedConnection();
    seedTask('tsk_1', { title: 'T', category: 'bug' });
    linkTask(connection.id, 'ext-1', {
      title: 'T',
      description: null,
      stateId: 'state-backlog',
      priority: '3',
      category: 'Task',
    });
    enqueueContentWrite(connection.id, 'ext-1', 'tsk_1');
    const adapter = new FakeAdapter();

    await drainOutbox(makeDeps(adapter), connection);

    // Linear declares contentWrite.category = false, so the only difference the
    // composer could have found is one it must not send — nothing goes out.
    expect(adapter.contentCalls).toHaveLength(0);
  });

  it('re-appends the recovery marker to a body write on a provider that carries one', async () => {
    const connection = seedConnection({ provider: 'plane' });
    seedTask('tsk_1', { title: 'T', body: 'Fresh body' });
    linkTask(
      connection.id,
      'ext-1',
      { title: 'T', description: 'stale', stateId: 'state-backlog', priority: '3', category: null },
      'plane',
    );
    // The create that minted this issue — the only durable record of the key
    // its `cyboflow-sync:` marker carries.
    enqueueOutbox(raw, {
      connection_id: connection.id,
      kind: 'create_issue',
      entity_type: 'task',
      entity_id: 'tsk_1',
      client_key: CLIENT_KEY,
      payload_json: '{}',
    });
    enqueueContentWrite(connection.id, 'ext-1', 'tsk_1');
    const adapter = new FakeAdapter();
    seedRemote(adapter, 'ext-1', { title: 'T', description: 'stale', priority: '3', category: null });
    adapter.provider = 'plane';

    await drainOutbox(makeDeps(adapter), connection);

    expect(adapter.contentCalls[0].patch.description).toBe(`Fresh body\n\ncyboflow-sync: ${CLIENT_KEY}`);
    // The marker is sync plumbing: it must never reach the baseline (the
    // adapters strip it from every description they return).
    expect((baselineOf('tsk_1') as { description: string }).description).toBe('Fresh body');
  });

  it('sends the body verbatim for an IMPORTED issue, which never carried a marker', async () => {
    const connection = seedConnection({ provider: 'plane' });
    seedTask('tsk_1', { title: 'T', body: 'Fresh body' });
    linkTask(
      connection.id,
      'ext-1',
      { title: 'T', description: 'stale', stateId: 'state-backlog', priority: '3', category: null },
      'plane',
    );
    enqueueContentWrite(connection.id, 'ext-1', 'tsk_1');
    const adapter = new FakeAdapter();
    seedRemote(adapter, 'ext-1', { title: 'T', description: 'stale', priority: '3', category: null });
    adapter.provider = 'plane';

    await drainOutbox(makeDeps(adapter), connection);

    expect(adapter.contentCalls[0].patch.description).toBe('Fresh body');
  });

  it('settles `done` unsent when the link is gone, orphaned, or the entity is archived', async () => {
    const connection = seedConnection();
    // (a) no link at all
    seedTask('tsk_1', { title: 'T' });
    const noLink = enqueueContentWrite(connection.id, 'ext-none', 'tsk_1');
    // (b) an orphaned link
    seedTask('tsk_2', { title: 'T' });
    const orphaned = linkTask(connection.id, 'ext-orphan', BASE_BASELINE, 'linear', 'tsk_2');
    markOrphaned(raw, orphaned.id);
    const orphanRow = enqueueContentWrite(connection.id, 'ext-orphan', 'tsk_2');
    // (c) a live link whose entity has been archived
    seedTask('tsk_3', { title: 'Renamed', archived: true });
    linkTask(connection.id, 'ext-gone', BASE_BASELINE, 'linear', 'tsk_3');
    const archivedRow = enqueueContentWrite(connection.id, 'ext-gone', 'tsk_3');
    const adapter = new FakeAdapter();

    const report = await drainOutbox(makeDeps(adapter), connection);

    expect(adapter.contentCalls).toHaveLength(0);
    expect(report.failedTerminal).toBe(0);
    for (const row of [noLink, orphanRow, archivedRow]) {
      expect(fetchOutbox(row.id).state).toBe('done');
    }
  });

  it('retries a 5xx and settles a 4xx terminally, without stamping either', async () => {
    const connection = seedConnection();
    seedTask('tsk_1', { title: 'New title' });
    linkTask(connection.id, 'ext-1', BASE_BASELINE);
    const row = enqueueContentWrite(connection.id, 'ext-1', 'tsk_1');
    const adapter = new FakeAdapter();
    seedRemote(adapter, 'ext-1', BASE_BASELINE);
    adapter.failContent = new TrackerApiError('linear', 'boom', 500);

    const report = await drainOutbox(makeDeps(adapter), connection);

    expect(report.retriesScheduled).toBe(1);
    expect(fetchOutbox(row.id).state).toBe('pending');
    expect(baselineOf('tsk_1')).toEqual(BASE_BASELINE);

    adapter.failContent = new TrackerApiError('linear', 'bad request', 400);
    const second = await drainOutbox(makeDeps(adapter, '2026-07-30 13:00:00'), connection);
    expect(second.failedTerminal).toBe(1);
    expect(fetchOutbox(row.id).state).toBe('failed');
    expect(baselineOf('tsk_1')).toEqual(BASE_BASELINE);
  });

  it('does NOT clobber an edit that lands while the write is in flight', async () => {
    // The window is ORDINARY, not exotic: the pending-only dedupe deliberately
    // enqueues a SUCCESSOR row for exactly this case, so an edit mid-flight is
    // the shape the design expects. Aligning the body here would overwrite the
    // newer text with the older write's echo — and the successor would then
    // compose its patch from the clobbered body and push the loss remotely.
    const connection = seedConnection();
    seedTask('tsk_1', { title: 'T', body: 'first draft' });
    const baseline = {
      title: 'T',
      description: 'was',
      stateId: 'state-backlog',
      priority: '3',
      category: null,
    };
    linkTask(connection.id, 'ext-1', baseline);
    enqueueContentWrite(connection.id, 'ext-1', 'tsk_1');
    const adapter = new FakeAdapter();
    seedRemote(adapter, 'ext-1', baseline);
    // The provider normalizes, so the alignment WOULD fire but for the guard…
    adapter.normalizeStored = (description) => description?.toUpperCase() ?? null;
    // …and the user edits while the request is on the wire.
    adapter.onContentWrite = () => {
      raw.prepare("UPDATE tasks SET body = 'second draft' WHERE id = ?").run('tsk_1');
    };

    await drainOutbox(makeDeps(adapter), connection);

    // The newer edit survives untouched.
    expect(bodyOf('tsk_1')).toBe('second draft');

    // And the successor row composes from THAT text, so the newer edit is what
    // actually reaches the tracker.
    enqueueContentWrite(connection.id, 'ext-1', 'tsk_1');
    adapter.onContentWrite = undefined;
    await drainOutbox(makeDeps(adapter), connection);

    expect(adapter.contentCalls[1].patch.description).toBe('second draft');
  });

  it('falls back to a re-read when the adapter breaks its contract and returns nothing', async () => {
    const connection = seedConnection();
    seedTask('tsk_1', { title: 'New title' });
    linkTask(connection.id, 'ext-1', BASE_BASELINE);
    enqueueContentWrite(connection.id, 'ext-1', 'tsk_1');
    const adapter = new FakeAdapter();
    adapter.contentReturnsNull = true;
    // The pre-send read must see the baseline; only the POST-write re-read may
    // see the written state (contentReturnsNull skips the fake's own store).
    seedRemote(adapter, 'ext-1', BASE_BASELINE);
    adapter.onContentWrite = () => {
      adapter.issuesById.set('ext-1', makeIssue('ext-1', { title: 'New title' }));
    };
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const report = await drainOutbox(makeDeps(adapter), connection);

    expect(report.contentWritten).toBe(1);
    // LOUD: an unstamped write is a phantom conflict on the next pass.
    expect(logged).toHaveBeenCalledOnce();
    expect((baselineOf('tsk_1') as { title: string }).title).toBe('New title');
    logged.mockRestore();
  });

  it('WITHHOLDS the write when the tracker moved a patched field since the stamp', async () => {
    // The lost-update race: local edits title, a tracker user ALSO edits title
    // after the last inbound stamp. Sending would overwrite their edit and the
    // response stamp would erase the evidence — so nothing may be sent.
    const connection = seedConnection();
    seedTask('tsk_1', { title: 'Local new title' });
    linkTask(connection.id, 'ext-1', BASE_BASELINE);
    const row = enqueueContentWrite(connection.id, 'ext-1', 'tsk_1');
    const adapter = new FakeAdapter();
    seedRemote(adapter, 'ext-1', BASE_BASELINE, { title: 'Remote new title' });

    const report = await drainOutbox(makeDeps(adapter), connection);

    expect(adapter.contentCalls).toHaveLength(0);
    expect(report.contentWritten).toBe(0);
    expect(report.contentWithheld).toBe(1);
    const settled = fetchOutbox(row.id);
    expect(settled.state).toBe('done');
    expect(settled.last_error).toContain('withheld');
    expect(settled.last_error).toContain('title');
    // The baseline is untouched: local ≠ baseline ≠ remote survives for the
    // next inbound pass's conflict machinery to consume.
    expect(baselineOf('tsk_1')).toEqual(BASE_BASELINE);
  });

  it('does NOT withhold on a remote edit to a field the patch never touches', async () => {
    // Disjoint edits must not deadlock: the tracker moved priority, the local
    // edit moved only the title — partial patches cannot endanger the former.
    const connection = seedConnection();
    seedTask('tsk_1', { title: 'Local new title' });
    linkTask(connection.id, 'ext-1', BASE_BASELINE);
    const adapter = new FakeAdapter();
    enqueueContentWrite(connection.id, 'ext-1', 'tsk_1');
    seedRemote(adapter, 'ext-1', BASE_BASELINE, { priority: '1' });

    const report = await drainOutbox(makeDeps(adapter), connection);

    expect(report.contentWithheld).toBe(0);
    expect(adapter.contentCalls).toEqual([
      { externalId: 'ext-1', patch: { title: 'Local new title' } },
    ]);
  });

  it('compares provider tokens case-insensitively in the divergence check', async () => {
    // Dart writes 'critical', reads back 'Critical' — casing alone is an echo,
    // never a concurrent edit.
    const connection = seedConnection({ provider: 'dart' });
    seedTask('tsk_1', { title: 'New title', priority: 'P0' });
    const baseline = {
      title: 'Old title',
      description: null,
      stateId: 'state-backlog',
      priority: 'high',
      category: null,
    };
    linkTask(connection.id, 'ext-1', baseline, 'dart');
    enqueueContentWrite(connection.id, 'ext-1', 'tsk_1');
    const adapter = new FakeAdapter();
    adapter.provider = 'dart';
    seedRemote(adapter, 'ext-1', baseline, { priority: 'High' });

    const report = await drainOutbox(makeDeps(adapter), connection);

    expect(report.contentWithheld).toBe(0);
    expect(adapter.contentCalls).toHaveLength(1);
  });

  it('settles `done` unsent when the issue is gone remotely at the pre-send read', async () => {
    const connection = seedConnection();
    seedTask('tsk_1', { title: 'New title' });
    linkTask(connection.id, 'ext-1', BASE_BASELINE);
    const row = enqueueContentWrite(connection.id, 'ext-1', 'tsk_1');
    const adapter = new FakeAdapter();
    // issuesById deliberately NOT seeded: getIssue returns null.

    const report = await drainOutbox(makeDeps(adapter), connection);

    expect(adapter.contentCalls).toHaveLength(0);
    expect(report.failedTerminal).toBe(0);
    expect(fetchOutbox(row.id).state).toBe('done');
    expect(fetchOutbox(row.id).last_error).toContain('gone remotely');
  });

  it('retries when the pre-send read itself fails — nothing was sent', async () => {
    const connection = seedConnection();
    seedTask('tsk_1', { title: 'New title' });
    linkTask(connection.id, 'ext-1', BASE_BASELINE);
    const row = enqueueContentWrite(connection.id, 'ext-1', 'tsk_1');
    const adapter = new FakeAdapter();
    seedRemote(adapter, 'ext-1', BASE_BASELINE);
    adapter.failLookup = new TrackerApiError('linear', 'boom', 500);

    const report = await drainOutbox(makeDeps(adapter), connection);

    expect(adapter.contentCalls).toHaveLength(0);
    expect(report.retriesScheduled).toBe(1);
    expect(fetchOutbox(row.id).state).toBe('pending');
    expect(baselineOf('tsk_1')).toEqual(BASE_BASELINE);
  });
});

// ---------------------------------------------------------------------------
// Drain — archive_issue
// ---------------------------------------------------------------------------

describe('drainOutbox — archive_issue', () => {
  it('archives remotely, stamps the write, and takes the link out of sync', async () => {
    const connection = seedConnection();
    seedTask('tsk_1', { title: 'T', archived: true });
    const link = linkTask(connection.id, 'ext-1', BASE_BASELINE);
    const row = enqueueArchiveRow(connection.id, 'ext-1', 'tsk_1');
    const adapter = new FakeAdapter();

    const report = await drainOutbox(makeDeps(adapter), connection);

    expect(adapter.archiveCalls).toEqual(['ext-1']);
    expect(report.archived).toBe(1);
    expect(fetchOutbox(row.id).state).toBe('done');
    expect((baselineOf('tsk_1') as { archivedWrittenAt: string }).archivedWrittenAt).toBe(NOW);
    expect(getLinkById(raw, link.id)?.orphaned_at).not.toBeNull();
  });

  it('settles a second archive unsent — the stamp is the idempotence', async () => {
    const connection = seedConnection();
    seedTask('tsk_1', { title: 'T', archived: true });
    linkTask(connection.id, 'ext-1', { ...BASE_BASELINE, archivedWrittenAt: NOW });
    const row = enqueueArchiveRow(connection.id, 'ext-1', 'tsk_1');
    const adapter = new FakeAdapter();

    const report = await drainOutbox(makeDeps(adapter), connection);

    expect(adapter.archiveCalls).toHaveLength(0);
    expect(report.archived).toBe(0);
    expect(fetchOutbox(row.id).state).toBe('done');
  });

  it('leaves the link LIVE and retries when the archive fails', async () => {
    const connection = seedConnection();
    seedTask('tsk_1', { title: 'T', archived: true });
    const link = linkTask(connection.id, 'ext-1', BASE_BASELINE);
    const row = enqueueArchiveRow(connection.id, 'ext-1', 'tsk_1');
    const adapter = new FakeAdapter();
    adapter.failArchive = new TrackerApiError('linear', 'boom', 503);

    await drainOutbox(makeDeps(adapter), connection);

    expect(fetchOutbox(row.id).state).toBe('pending');
    // Orphaning on a FAILED archive would leave the twin live in the tracker
    // with nothing left that could retire it.
    expect(getLinkById(raw, link.id)?.orphaned_at).toBeNull();
    expect(baselineOf('tsk_1')).toEqual(BASE_BASELINE);
  });

  it('fails terminally rather than calling an adapter with no archive endpoint', async () => {
    const connection = seedConnection({ provider: 'plane' });
    seedTask('tsk_1', { title: 'T', archived: true });
    linkTask(connection.id, 'ext-1', BASE_BASELINE, 'plane');
    const row = enqueueArchiveRow(connection.id, 'ext-1', 'tsk_1');
    const adapter = new FakeAdapter();
    adapter.provider = 'plane';
    adapter.capabilities = { ...adapter.capabilities, archive: 'none' };

    const report = await drainOutbox(makeDeps(adapter), connection);

    expect(adapter.archiveCalls).toHaveLength(0);
    expect(report.failedTerminal).toBe(1);
    expect(fetchOutbox(row.id).last_error).toContain('no archive endpoint');
  });
});

describe('drainOutbox — a disconnect mid-drain stops sending more', () => {
  it('re-checks connection status before EACH claim, leaving unclaimed rows pending', async () => {
    const connection = seedConnection();
    seedTask('tsk_1', { title: 'T1', archived: true });
    seedTask('tsk_2', { title: 'T2', archived: true });
    linkTask(connection.id, 'ext-1', BASE_BASELINE, 'linear', 'tsk_1');
    linkTask(connection.id, 'ext-2', BASE_BASELINE, 'linear', 'tsk_2');
    const row1 = enqueueArchiveRow(connection.id, 'ext-1', 'tsk_1');
    const row2 = enqueueArchiveRow(connection.id, 'ext-2', 'tsk_2');
    const adapter = new FakeAdapter();
    // Models the user hitting disconnect (or an auth-pause landing) WHILE the
    // first archive is in flight — before the service's own phase-boundary
    // guard (trackerSyncService.ts's isStillActive) ever gets a chance to see
    // it, since that only runs BETWEEN passes.
    adapter.onArchiveWrite = () => {
      raw
        .prepare("UPDATE tracker_connections SET status = 'disconnected' WHERE id = ?")
        .run(connection.id);
    };

    const report = await drainOutbox(makeDeps(adapter), connection);

    // The first archive was already claimed and in flight when the disconnect
    // landed, so it completes — but the drain must not claim the second,
    // equally destructive archive after the user's stop lever has fired.
    expect(adapter.archiveCalls).toEqual(['ext-1']);
    expect(report.archived).toBe(1);
    expect(fetchOutbox(row1.id).state).toBe('done');
    const remaining = fetchOutbox(row2.id);
    expect(remaining.state).toBe('pending');
    expect(remaining.attempts).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Supersession matrix
// ---------------------------------------------------------------------------

describe('drainOutbox — the supersession matrix', () => {
  it('content supersedes content, and NEVER a state write (nor the reverse)', async () => {
    const connection = seedConnection();
    seedTask('tsk_1', { title: 'New title' });
    linkTask(connection.id, 'ext-1', BASE_BASELINE);
    const staleContent = enqueueContentWrite(connection.id, 'ext-1', 'tsk_1');
    const stateWrite = enqueueStateWrite(connection.id, 'ext-1', 'completed');
    const freshContent = enqueueContentWrite(connection.id, 'ext-1', 'tsk_1');
    const adapter = new FakeAdapter();
    seedRemote(adapter, 'ext-1', BASE_BASELINE);

    const report = await drainOutbox(makeDeps(adapter), connection);

    // The older content row is settled by the newer one…
    expect(fetchOutbox(staleContent.id).state).toBe('done');
    expect(report.superseded).toBe(1);
    // …the state write in between is untouched by both and still SENDS…
    expect(fetchOutbox(stateWrite.id).state).toBe('done');
    expect(adapter.updateCalls).toEqual([{ externalId: 'ext-1', stateId: 'state-done' }]);
    // …and the surviving content row sends exactly once.
    expect(fetchOutbox(freshContent.id).state).toBe('done');
    expect(adapter.contentCalls).toHaveLength(1);
  });

  it('an archive supersedes every queued kind for its issue', async () => {
    const connection = seedConnection();
    seedTask('tsk_1', { title: 'New title', archived: true });
    linkTask(connection.id, 'ext-1', BASE_BASELINE);
    const stateWrite = enqueueStateWrite(connection.id, 'ext-1', 'completed');
    const contentWrite = enqueueContentWrite(connection.id, 'ext-1', 'tsk_1');
    const archive = enqueueArchiveRow(connection.id, 'ext-1', 'tsk_1');
    const adapter = new FakeAdapter();

    const report = await drainOutbox(makeDeps(adapter), connection);

    expect(fetchOutbox(stateWrite.id).state).toBe('done');
    expect(fetchOutbox(contentWrite.id).state).toBe('done');
    expect(report.superseded).toBe(2);
    // Nothing but the archive reached the tracker: a state or content write
    // landing after it would resurrect the issue into a listing.
    expect(adapter.updateCalls).toHaveLength(0);
    expect(adapter.contentCalls).toHaveLength(0);
    expect(adapter.archiveCalls).toEqual(['ext-1']);
    expect(fetchOutbox(archive.id).state).toBe('done');
  });

  it('an archive is NOT superseded by a later state or content write', async () => {
    const connection = seedConnection();
    seedTask('tsk_1', { title: 'New title' });
    linkTask(connection.id, 'ext-1', BASE_BASELINE);
    const archive = enqueueArchiveRow(connection.id, 'ext-1', 'tsk_1');
    // Enqueued AFTER the archive, so a naive "newest wins" would settle it.
    raw
      .prepare("INSERT INTO tracker_outbox (connection_id, kind, external_id, payload_json) VALUES (?, 'update_state', 'ext-1', ?)")
      .run(connection.id, JSON.stringify({ desiredGroup: 'completed' }));
    const adapter = new FakeAdapter();

    await drainOutbox(makeDeps(adapter), connection);

    expect(fetchOutbox(archive.id).state).toBe('done');
    expect(adapter.archiveCalls).toEqual(['ext-1']);
  });
});

// ---------------------------------------------------------------------------
// Kind coverage
// ---------------------------------------------------------------------------

describe('drainOutbox — every kind has an explicit handler', () => {
  it('drains one row of EVERY TrackerOutboxRow kind without falling through', async () => {
    const connection = seedConnection();
    seedTask('tsk_state', { title: 'T' });
    seedTask('tsk_content', { title: 'New title' });
    seedTask('tsk_archive', { title: 'T', archived: true });
    seedIdeaRow('idea_push');
    linkTask(connection.id, 'ext-content', BASE_BASELINE, 'linear', 'tsk_content');
    linkTask(connection.id, 'ext-archive', BASE_BASELINE, 'linear', 'tsk_archive');

    const rows: Record<TrackerOutboxRow['kind'], number> = {
      update_state: enqueueStateWrite(connection.id, 'ext-state', 'completed').id,
      close_parent: enqueueStateWrite(connection.id, 'ext-parent', 'completed', 'close_parent').id,
      create_sub_issue: enqueueCreate(connection.id, 'tsk_state', 'ck-sub').id,
      create_issue: enqueueOutbox(raw, {
        connection_id: connection.id,
        kind: 'create_issue',
        entity_type: 'idea',
        entity_id: 'idea_push',
        client_key: 'ck-push',
        payload_json: '{}',
      }).id,
      update_content: enqueueContentWrite(connection.id, 'ext-content', 'tsk_content').id,
      archive_issue: enqueueArchiveRow(connection.id, 'ext-archive', 'tsk_archive').id,
    };
    const adapter = new FakeAdapter();
    seedRemote(adapter, 'ext-content', BASE_BASELINE);

    const report = await drainOutbox(makeDeps(adapter), connection);

    // NOTHING fell through to the state-write dispatch and failed on a payload
    // it could not read — every kind was handled by its own branch.
    expect(report.failedTerminal).toBe(0);
    for (const [kind, id] of Object.entries(rows)) {
      expect(`${kind}:${fetchOutbox(id).state}`).toBe(`${kind}:done`);
    }
    expect(report.sent).toBe(2);
    expect(report.created).toBe(2);
    expect(report.contentWritten).toBe(1);
    expect(report.archived).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Drain — uncertain creates on a non-idempotent provider
// ---------------------------------------------------------------------------

describe('drainOutbox — non-idempotent create failures', () => {
  it('parks a create whose outcome is UNKNOWN as ambiguous instead of re-POSTing it', async () => {
    const connection = seedConnection({ provider: 'plane' });
    const row = enqueueCreate(connection.id, 'tsk_1', 'client-key-1');
    const adapter = new CommitThenFailAdapter();
    // The classic lost create: committed server-side, 500 on the way back.
    adapter.failAfterCommit = new TrackerApiError('plane', 'internal server error', 500);

    const report = await drainOutbox(makeDeps(adapter), connection);

    expect(adapter.createCalls).toHaveLength(1);
    const settled = fetchOutbox(row.id);
    expect(settled.state).toBe('ambiguous');
    expect(settled.last_error).toContain('internal server error');
    // Not eligible for a blind retry: a second drain must claim nothing.
    expect(settled.next_attempt_at).toBeNull();
    expect(report.retriesScheduled).toBe(1);

    await drainOutbox(makeDeps(adapter), connection);
    expect(adapter.createCalls).toHaveLength(1);

    // The next pass reconciles FIRST (trackerSyncService.runWriteBack calls
    // processAmbiguous ahead of drainOutbox) and adopts the child the lost
    // response created...
    const recovery = await processAmbiguous(makeDeps(adapter), connection);
    expect(recovery.created).toBe(1);
    expect(fetchOutbox(row.id).state).toBe('done');
    expect(getLinkByEntity(raw, 'task', 'tsk_1', 'plane')?.external_id).toBe('proj-1/child-1');

    // ...so the drain behind it has nothing to send and the parent holds
    // EXACTLY ONE child.
    const drained = await drainOutbox(makeDeps(adapter), connection);
    expect(drained.created).toBe(0);
    expect(adapter.createCalls).toHaveLength(1);
    expect(adapter.issues).toHaveLength(1);
  });

  it('parks a network failure (no HTTP status) as ambiguous too', async () => {
    const connection = seedConnection({ provider: 'plane' });
    const row = enqueueCreate(connection.id, 'tsk_1', 'client-key-1');
    const adapter = new CommitThenFailAdapter();
    adapter.failAfterCommit = new TrackerApiError('plane', 'socket hang up');

    await drainOutbox(makeDeps(adapter), connection);

    expect(fetchOutbox(row.id).state).toBe('ambiguous');
  });

  it('still fails a non-idempotent create terminally on a 4xx (it provably never landed)', async () => {
    const connection = seedConnection({ provider: 'plane' });
    const row = enqueueCreate(connection.id, 'tsk_1', 'client-key-1');
    const adapter = new FakeMarkerAdapter();
    adapter.failCreate = new TrackerApiError('plane', 'parent issue not found', 404);

    const report = await drainOutbox(makeDeps(adapter), connection);

    expect(report.failedTerminal).toBe(1);
    expect(fetchOutbox(row.id).state).toBe('failed');
  });

  it('keeps the plain backoff retry for a provider with idempotent creates', async () => {
    const connection = seedConnection();
    const row = enqueueCreate(connection.id, 'tsk_1', 'client-key-1');
    const adapter = new FakeAdapter();
    adapter.failCreate = new TrackerApiError('linear', 'bad gateway', 502);

    const report = await drainOutbox(makeDeps(adapter), connection);

    // The client key IS the issue id there, so a repeat create cannot duplicate.
    expect(report.retriesScheduled).toBe(1);
    const settled = fetchOutbox(row.id);
    expect(settled.state).toBe('pending');
    expect(settled.next_attempt_at).toBe('2026-07-30 12:02:00');
  });
});

// ---------------------------------------------------------------------------
// Ambiguous recovery
// ---------------------------------------------------------------------------

describe('processAmbiguous', () => {
  /** Simulate a crash mid-flight: claim the row, then boot-recover it. */
  function makeAmbiguous(rowId: number, connectionId: string): void {
    raw.prepare("UPDATE tracker_outbox SET state = 'in_flight', attempts = 1 WHERE id = ?").run(rowId);
    expect(requeueInFlightAsAmbiguous(raw, connectionId)).toBe(1);
    expect(fetchOutbox(rowId).state).toBe('ambiguous');
  }

  it('adopts a create whose issue the idempotent point-lookup FINDS', async () => {
    const connection = seedConnection();
    const row = enqueueCreate(connection.id, 'tsk_1', 'client-key-1');
    makeAmbiguous(row.id, connection.id);

    const adapter = new FakeAdapter();
    adapter.issuesById.set(
      'client-key-1',
      makeIssue('client-key-1', { title: 'Task TASK-1', parentExternalId: 'ext-idea' }),
    );

    const report = await processAmbiguous(makeDeps(adapter), connection);

    expect(report.created).toBe(1);
    expect(report.ambiguousResolved).toBe(1);
    expect(fetchOutbox(row.id).state).toBe('done');
    expect(adapter.createCalls).toHaveLength(0);
    expect(getLinkByEntity(raw, 'task', 'tsk_1', 'linear')?.external_id).toBe('client-key-1');
  });

  it('returns a create to pending when the point-lookup finds NOTHING', async () => {
    const connection = seedConnection();
    const row = enqueueCreate(connection.id, 'tsk_1', 'client-key-1');
    makeAmbiguous(row.id, connection.id);
    const adapter = new FakeAdapter();

    const report = await processAmbiguous(makeDeps(adapter), connection);

    expect(report.created).toBe(0);
    expect(report.ambiguousResolved).toBe(1);
    const settled = fetchOutbox(row.id);
    expect(settled.state).toBe('pending');
    expect(settled.next_attempt_at).toBe(NOW);
    expect(getLinkByEntity(raw, 'task', 'tsk_1', 'linear')).toBeNull();

    // ...and the follow-up drain safely performs the create exactly once.
    const drainReport = await drainOutbox(makeDeps(adapter), connection);
    expect(drainReport.created).toBe(1);
    expect(adapter.createCalls).toHaveLength(1);
  });

  it('adopts an ambiguous TOP-LEVEL push by its marker, searching the container with no parent', async () => {
    const connection = seedConnection({ provider: 'plane' });
    // The originating idea has to still BE there: recovery re-reads it before
    // adopting, so that a create whose idea was removed mid-crash cannot come
    // back as an active link (see the orphan cases below).
    svc.seedDefaultBoard(PROJECT_ID);
    raw
      .prepare(
        `INSERT INTO ideas (id, project_id, ref, title, board_id, stage_id)
         VALUES ('ide_1', ?, 'IDEA-1', 'Ship the push direction', ?, ?)`,
      )
      .run(PROJECT_ID, `board-${PROJECT_ID}-default`, resolveStageIds(raw, PROJECT_ID).idea);
    const row = enqueueOutbox(raw, {
      connection_id: connection.id,
      kind: 'create_issue',
      entity_type: 'idea',
      entity_id: 'ide_1',
      client_key: 'client-key-push',
      payload_json: '{}',
    });
    makeAmbiguous(row.id, connection.id);

    const adapter = new FakeMarkerAdapter();
    adapter.issues = [
      // A same-title top-level issue somebody else filed. Listed first, so a
      // title match would take it.
      makeIssue('proj-1/theirs', { title: 'Ship the push direction', parentExternalId: null }),
      makeIssue('proj-1/ours', { title: 'Ship the push direction', parentExternalId: null }),
    ];
    adapter.markers.set('proj-1/ours', 'client-key-push');

    const report = await processAmbiguous(makeDeps(adapter), connection);

    expect(report.created).toBe(1);
    expect(fetchOutbox(row.id).state).toBe('done');
    // Linked back to the ORIGINATING idea — the whole point of the row.
    expect(getLinkByEntity(raw, 'idea', 'ide_1', 'plane')?.external_id).toBe('proj-1/ours');
    // Scoped by the connection's source container, with NO parent constraint:
    // a top-level issue has no parent to key on. The narrow KIND rides along so
    // an adapter never has to guess what the container id names (a Dart space
    // and a board can share a title), and the scan floor bounds how much of that
    // container the adapter has to fetch details for.
    expect(adapter.clientKeyScopes).toEqual([
      {
        containerId: SELECTION.containerId,
        narrowKind: SELECTION.narrowKind,
        parentExternalId: null,
        updatedAfterIso: expectedScanFloor(row.id),
      },
    ]);
  });

  it('bounds the recovery scan a DAY BEFORE the row was enqueued, never after it', async () => {
    // The floor is what turns a full-board scan into a slice of it, so it must
    // sit far enough back that the provider's own clock cannot push a landed
    // create underneath it — missing one re-creates the duplicate this whole
    // mechanism exists to prevent.
    const connection = seedConnection({ provider: 'plane' });
    const row = enqueueCreate(connection.id, 'tsk_1', 'client-key-1');
    makeAmbiguous(row.id, connection.id);
    const adapter = new FakeMarkerAdapter();

    await processAmbiguous(makeDeps(adapter), connection);

    const sent = adapter.clientKeyScopes[0].updatedAfterIso;
    expect(sent).toBe(expectedScanFloor(row.id));
    const enqueuedAtMs = Date.parse(`${fetchOutbox(row.id).created_at.replace(' ', 'T')}Z`);
    expect(enqueuedAtMs - Date.parse(sent as string)).toBe(24 * 60 * 60 * 1000);
  });

  /** A board + one idea row, so a recovered push has something to adopt onto. */
  function seedPushIdea(id: string, opts: { archived?: boolean } = {}): void {
    svc.seedDefaultBoard(PROJECT_ID);
    raw
      .prepare(
        `INSERT INTO ideas (id, project_id, ref, title, board_id, stage_id, archived_at)
         VALUES (?, ?, 'IDEA-1', 'Ship the push direction', ?, ?, ?)`,
      )
      .run(
        id,
        PROJECT_ID,
        `board-${PROJECT_ID}-default`,
        resolveStageIds(raw, PROJECT_ID).idea,
        opts.archived === true ? '2026-07-30 11:00:00' : null,
      );
  }

  /** An ambiguous top-level push whose issue DID land, carrying the row's marker. */
  function seedRecoverablePush(connectionId: string, entityId: string): TrackerOutboxRow {
    const row = enqueueOutbox(raw, {
      connection_id: connectionId,
      kind: 'create_issue',
      entity_type: 'idea',
      entity_id: entityId,
      client_key: 'client-key-push',
      payload_json: '{}',
    });
    makeAmbiguous(row.id, connectionId);
    return row;
  }

  it('does NOT link a recovered push whose idea was DELETED during the crash window', async () => {
    // The remote create committed; only its response was lost. By the time
    // recovery runs — potentially a whole app restart later — the user has
    // hard-deleted the idea. Adopting anyway wrote an active link to an entity
    // that no longer exists: a zombie the inbound poller finds, fails to
    // resolve, and skips on every pass forever.
    const connection = seedConnection({ provider: 'plane' });
    const row = seedRecoverablePush(connection.id, 'ide_gone');
    const adapter = new FakeMarkerAdapter();
    adapter.issues = [
      makeIssue('proj-1/ours', { title: 'Ship the push direction', identifier: 'PROJ-8' }),
    ];
    adapter.markers.set('proj-1/ours', 'client-key-push');

    const report = await processAmbiguous(makeDeps(adapter), connection);

    expect(getLinkByEntity(raw, 'idea', 'ide_gone', 'plane')).toBeNull();
    expect(report.created).toBe(0);
    expect(report.orphanedCreates).toBe(1);
    expect(report.ambiguousResolved).toBe(1);

    // Settled, not failed — nothing is left to attempt. The stranded remote
    // issue is named on the row (and counted into the connection's sync log),
    // because this is the only record that it exists at all. It is deliberately
    // NOT deleted or cancelled remotely: the user's local removal said nothing
    // about an issue they never knew had been created.
    const settled = fetchOutbox(row.id);
    expect(settled.state).toBe('done');
    expect(settled.last_error).toContain('gone');
    expect(settled.last_error).toContain('PROJ-8');
  });

  it('does NOT link a recovered push whose idea was ARCHIVED during the crash window', async () => {
    // Archived is the more dangerous of the two: the entity still EXISTS, so an
    // active link would keep inbound sync mutating something the user retired.
    const connection = seedConnection({ provider: 'plane' });
    seedPushIdea('ide_archived', { archived: true });
    const row = seedRecoverablePush(connection.id, 'ide_archived');
    const adapter = new FakeMarkerAdapter();
    adapter.issues = [
      makeIssue('proj-1/ours', { title: 'Ship the push direction', identifier: 'PROJ-8' }),
    ];
    adapter.markers.set('proj-1/ours', 'client-key-push');

    const report = await processAmbiguous(makeDeps(adapter), connection);

    expect(getLinkByEntity(raw, 'idea', 'ide_archived', 'plane')).toBeNull();
    expect(report.orphanedCreates).toBe(1);
    const settled = fetchOutbox(row.id);
    expect(settled.state).toBe('done');
    expect(settled.last_error).toContain('archived');
  });

  it('links a recovered push whose idea is still live', async () => {
    const connection = seedConnection({ provider: 'plane' });
    seedPushIdea('ide_1');
    seedRecoverablePush(connection.id, 'ide_1');
    const adapter = new FakeMarkerAdapter();
    adapter.issues = [
      makeIssue('proj-1/ours', { title: 'Ship the push direction', identifier: 'PROJ-8' }),
    ];
    adapter.markers.set('proj-1/ours', 'client-key-push');

    const report = await processAmbiguous(makeDeps(adapter), connection);

    expect(report.created).toBe(1);
    expect(report.orphanedCreates).toBe(0);
    expect(getLinkByEntity(raw, 'idea', 'ide_1', 'plane')?.external_id).toBe('proj-1/ours');
  });

  it('returns a PROVABLY-UNSENT top-level push to pending, and the drain then creates it once', async () => {
    const connection = seedConnection({ provider: 'plane' });
    svc.seedDefaultBoard(PROJECT_ID);
    raw
      .prepare(
        `INSERT INTO ideas (id, project_id, ref, title, board_id, stage_id)
         VALUES ('ide_1', ?, 'IDEA-1', 'Ship the push direction', ?, ?)`,
      )
      .run(PROJECT_ID, `board-${PROJECT_ID}-default`, resolveStageIds(raw, PROJECT_ID).idea);
    const row = enqueueOutbox(raw, {
      connection_id: connection.id,
      kind: 'create_issue',
      entity_type: 'idea',
      entity_id: 'ide_1',
      client_key: 'client-key-push',
      payload_json: '{}',
    });
    makeAmbiguous(row.id, connection.id);

    // Nothing in the container carries our key, and every create writes one —
    // so the create PROVABLY never landed and a retry cannot duplicate it.
    const adapter = new FakeMarkerAdapter();
    adapter.issues = [makeIssue('proj-1/unrelated', { title: 'Something else' })];

    const report = await processAmbiguous(makeDeps(adapter), connection);

    expect(report.created).toBe(0);
    expect(report.ambiguousResolved).toBe(1);
    expect(fetchOutbox(row.id).state).toBe('pending');
    expect(getLinkByEntity(raw, 'idea', 'ide_1', 'plane')).toBeNull();

    const drainReport = await drainOutbox(makeDeps(adapter), connection);
    expect(drainReport.created).toBe(1);
    expect(adapter.createCalls).toHaveLength(1);
    expect(getLinkByEntity(raw, 'idea', 'ide_1', 'plane')).not.toBeNull();
  });

  it('adopts the Plane child carrying the row CLIENT KEY, not the same-title sibling', async () => {
    const connection = seedConnection({ provider: 'plane' });
    const row = enqueueCreate(connection.id, 'tsk_1', 'client-key-1');
    makeAmbiguous(row.id, connection.id);

    const adapter = new FakeMarkerAdapter();
    adapter.issues = [
      // Listed FIRST and identical on parent + title: a title match adopts it.
      makeIssue('proj-1/sibling', { title: 'Task TASK-1', parentExternalId: 'ext-idea' }),
      makeIssue('proj-1/ours', { title: 'Task TASK-1', parentExternalId: 'ext-idea' }),
    ];
    adapter.markers.set('proj-1/ours', 'client-key-1');

    const report = await processAmbiguous(makeDeps(adapter), connection);

    expect(report.created).toBe(1);
    expect(fetchOutbox(row.id).state).toBe('done');
    expect(getLinkByEntity(raw, 'task', 'tsk_1', 'plane')?.external_id).toBe('proj-1/ours');
    // Recovery goes through the client-key lookup — title is not a criterion.
    expect(adapter.clientKeyLookups).toBe(1);
    expect(adapter.listIssuesCalls).toBe(0);
  });

  it('does NOT adopt a same-title sibling that lacks the marker — the row is requeued', async () => {
    const connection = seedConnection({ provider: 'plane' });
    const row = enqueueCreate(connection.id, 'tsk_1', 'client-key-1');
    makeAmbiguous(row.id, connection.id);

    const adapter = new FakeMarkerAdapter();
    // Routine case: the parent already holds an unrelated child with our title,
    // and our own create never landed.
    adapter.issues = [makeIssue('proj-1/sibling', { title: 'Task TASK-1', parentExternalId: 'ext-idea' })];

    const report = await processAmbiguous(makeDeps(adapter), connection);

    expect(report.created).toBe(0);
    expect(report.ambiguousResolved).toBe(1);
    const settled = fetchOutbox(row.id);
    expect(settled.state).toBe('pending');
    expect(settled.next_attempt_at).toBe(NOW);
    expect(getLinkByEntity(raw, 'task', 'tsk_1', 'plane')).toBeNull();

    // ...and the retry creates OUR child, leaving the sibling alone.
    const drainReport = await drainOutbox(makeDeps(adapter), connection);
    expect(drainReport.created).toBe(1);
    expect(getLinkByEntity(raw, 'task', 'tsk_1', 'plane')?.external_id).toBe('client-key-1');
  });

  it('leaves the row ambiguous when the adapter can neither point-look-up nor match a client key', async () => {
    const connection = seedConnection({ provider: 'plane' });
    const row = enqueueCreate(connection.id, 'tsk_1', 'client-key-1');
    makeAmbiguous(row.id, connection.id);

    const adapter = new FakeAdapter();
    adapter.capabilities = { ...adapter.capabilities, idempotentCreate: false };

    const report = await processAmbiguous(makeDeps(adapter), connection);

    // "Cannot look it up" must never read as "it isn't there" — requeueing here
    // would duplicate the sub-issue.
    expect(report.ambiguousResolved).toBe(0);
    const settled = fetchOutbox(row.id);
    expect(settled.state).toBe('ambiguous');
    expect(settled.last_error).toContain('client-key recovery');
  });

  it('sends an ambiguous state write straight back to pending (idempotent by nature)', async () => {
    const connection = seedConnection();
    const row = enqueueStateWrite(connection.id, 'ext-1', 'completed');
    makeAmbiguous(row.id, connection.id);
    const adapter = new FakeAdapter();

    const report = await processAmbiguous(makeDeps(adapter), connection);

    expect(report.ambiguousResolved).toBe(1);
    expect(fetchOutbox(row.id).state).toBe('pending');
    // No lookup needed — re-writing a state is a no-op if it already landed.
    expect(adapter.listIssuesCalls).toBe(0);
  });

  it('leaves a create ambiguous when the reconciling lookup itself fails', async () => {
    const connection = seedConnection();
    const row = enqueueCreate(connection.id, 'tsk_1', 'client-key-1');
    makeAmbiguous(row.id, connection.id);
    const adapter = new FakeAdapter();
    adapter.failLookup = new TrackerApiError('linear', 'gateway timeout', 504);

    const report = await processAmbiguous(makeDeps(adapter), connection);

    expect(report.ambiguousResolved).toBe(0);
    const settled = fetchOutbox(row.id);
    expect(settled.state).toBe('ambiguous');
    expect(settled.last_error).toContain('gateway timeout');
  });

  it('pauses and halts when the reconciling lookup hits an auth failure', async () => {
    const connection = seedConnection();
    const first = enqueueCreate(connection.id, 'tsk_1', 'client-key-1');
    const second = enqueueCreate(connection.id, 'tsk_2', 'client-key-2');
    raw.prepare("UPDATE tracker_outbox SET state = 'in_flight' WHERE connection_id = ?").run(connection.id);
    requeueInFlightAsAmbiguous(raw, connection.id);
    const adapter = new FakeAdapter();
    adapter.failLookup = new TrackerAuthError('linear', 'revoked key', 401);

    const report = await processAmbiguous(makeDeps(adapter), connection);

    expect(report.authPaused).toBe(true);
    expect(getConnection(raw, connection.id)?.status).toBe('paused');
    // The row STAYS ambiguous — and specifically is not returned to `pending`.
    // An auth failure on the reconciling lookup says nothing about whether the
    // create landed, so retrying it could duplicate a sub-issue; and settling it
    // terminally would abandon a write that is still perfectly valid.
    const held = fetchOutbox(first.id);
    expect(held.state).toBe('ambiguous');
    expect(held.last_error).toContain('revoked key');
    expect(report.failedTerminal).toBe(0);
    expect(fetchOutbox(second.id).state).toBe('ambiguous');
  });
});

// ---------------------------------------------------------------------------
// Timestamp normalization
// ---------------------------------------------------------------------------

describe('toSqliteUtc', () => {
  it("normalizes a JS ISO string to sqlite's datetime('now') shape and leaves that shape alone", () => {
    expect(toSqliteUtc('2026-07-30T12:00:00.000Z')).toBe('2026-07-30 12:00:00');
    expect(toSqliteUtc('2026-07-30 12:00:00')).toBe('2026-07-30 12:00:00');
  });

  it('leaves an unparseable value untouched rather than inventing a timestamp', () => {
    expect(toSqliteUtc('not a date')).toBe('not a date');
  });
});

// ---------------------------------------------------------------------------
// Guarded updates (capabilities.guardedUpdates — beads)
// ---------------------------------------------------------------------------

/**
 * A guarded provider's fake: it declares `guardedUpdates`, so the drain must
 * take a PRE-SEND read, forward that read's `concurrencyToken`, and consume a
 * `TrackerRevisionMismatchError` as the detect-after-write outcome it is —
 * never as a retryable transport failure.
 */
class GuardedAdapter extends FakeAdapter {
  override provider: TrackerProvider = 'beads';
  override capabilities: TrackerAdapterCapabilities = {
    nativeParentAutoClose: false,
    selfHostedBaseUrl: false,
    idempotentCreate: false,
    contentWrite: { title: true, description: true, priority: true, category: true },
    archive: 'none',
    requiresIdReconciliation: true,
    guardedUpdates: true,
  };
  async listIssueRevisions(): Promise<Array<{ id: string; revision: string }>> {
    return this.issues.map((issue) => ({ id: issue.externalId, revision: issue.revision ?? 'r' }));
  }
}

/** An adapter for a requires-guarded provider that CANNOT guard — the degraded pairing. */
class DegradedBeadsAdapter extends GuardedAdapter {
  override capabilities: TrackerAdapterCapabilities = {
    ...new GuardedAdapter().capabilities,
    guardedUpdates: false,
  };
}

function openConflicts(connectionId: string): TrackerConflictRow[] {
  return raw
    .prepare('SELECT * FROM tracker_conflicts WHERE connection_id = ? ORDER BY id ASC')
    .all(connectionId) as TrackerConflictRow[];
}

describe('drainOutbox — guarded state writes', () => {
  it('forwards the pre-send read’s concurrency token to the adapter', async () => {
    const connection = seedConnection({ provider: 'beads' });
    linkTask(connection.id, 'ext-1', BASE_BASELINE, 'beads');
    enqueueStateWrite(connection.id, 'ext-1', 'completed');
    const adapter = new GuardedAdapter();
    adapter.issuesById.set('ext-1', makeIssue('ext-1', { concurrencyToken: 'commit-aaa' }));

    await drainOutbox(makeDeps(adapter), connection);

    expect(adapter.updateCalls).toEqual([
      { externalId: 'ext-1', stateId: 'state-done', expectedToken: 'commit-aaa' },
    ]);
  });

  it('holds a genuine mismatch as a field conflict carrying the recovered remote value', async () => {
    const connection = seedConnection({ provider: 'beads' });
    const link = linkTask(connection.id, 'ext-1', BASE_BASELINE, 'beads');
    const row = enqueueStateWrite(connection.id, 'ext-1', 'completed');
    const adapter = new GuardedAdapter();
    adapter.issuesById.set('ext-1', makeIssue('ext-1', { concurrencyToken: 'commit-aaa' }));
    // A concurrent `bd` write moved the status to CANCELLED; ours overwrote it.
    adapter.failUpdate = new TrackerRevisionMismatchError(
      'interleaved write on stateId',
      ['stateId'],
      makeIssue('ext-1', { stateId: 'state-canceled' }),
    );

    const report = await drainOutbox(makeDeps(adapter), connection);

    expect(report.guardedConflicts).toBe(1);
    expect(report.guardedConverged).toBe(0);
    // NO RETRY: the write landed, so the row is settled, not rescheduled.
    const settled = fetchOutbox(row.id);
    expect(settled.state).toBe('done');
    expect(settled.next_attempt_at).toBeNull();
    expect(settled.last_error).toContain('overwrote a concurrent tracker edit on stateId');

    const conflicts = openConflicts(connection.id);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toMatchObject({
      kind: 'field_conflict',
      // 'stateId' is TrackerIssue's spelling; the conflict table calls it 'stage'.
      field: 'stage',
      link_id: link.id,
      local_value: 'state-done',
      // The clobbered value, recovered from the adapter's own history — the
      // only record it has anywhere.
      remote_value: 'state-canceled',
      state: 'open',
    });
    expect(JSON.parse(conflicts[0].payload_json ?? '{}')).toMatchObject({
      externalId: 'ext-1',
      guardedOverwrite: true,
    });
  });

  it('settles done with no conflict when the concurrent write already set our value', async () => {
    const connection = seedConnection({ provider: 'beads' });
    linkTask(connection.id, 'ext-1', BASE_BASELINE, 'beads');
    const row = enqueueStateWrite(connection.id, 'ext-1', 'completed');
    const adapter = new GuardedAdapter();
    adapter.issuesById.set('ext-1', makeIssue('ext-1', { concurrencyToken: 'commit-aaa' }));
    adapter.failUpdate = new TrackerRevisionMismatchError(
      'interleaved write on stateId',
      ['stateId'],
      // Converged: the other writer moved it to the SAME state we were writing.
      makeIssue('ext-1', { stateId: 'state-done' }),
    );

    const report = await drainOutbox(makeDeps(adapter), connection);

    expect(report.guardedConverged).toBe(1);
    expect(report.guardedConflicts).toBe(0);
    expect(openConflicts(connection.id)).toHaveLength(0);
    const settled = fetchOutbox(row.id);
    expect(settled.state).toBe('done');
    expect(settled.last_error).toContain('converged');
  });

  it('settles a state write done when the pre-send read finds the issue gone', async () => {
    const connection = seedConnection({ provider: 'beads' });
    linkTask(connection.id, 'ext-1', BASE_BASELINE, 'beads');
    const row = enqueueStateWrite(connection.id, 'ext-1', 'completed');
    const adapter = new GuardedAdapter();

    await drainOutbox(makeDeps(adapter), connection);

    expect(adapter.updateCalls).toHaveLength(0);
    expect(fetchOutbox(row.id).state).toBe('done');
  });

  it('an unguarded provider still sends without a pre-send read', async () => {
    const connection = seedConnection();
    linkTask(connection.id, 'ext-1', BASE_BASELINE);
    enqueueStateWrite(connection.id, 'ext-1', 'completed');
    const adapter = new FakeAdapter();

    await drainOutbox(makeDeps(adapter), connection);

    expect(adapter.updateCalls).toEqual([
      { externalId: 'ext-1', stateId: 'state-done', expectedToken: undefined },
    ]);
  });
});

describe('drainOutbox — guarded content writes', () => {
  it('forwards the divergence check’s own read as the guard token', async () => {
    const connection = seedConnection({ provider: 'beads', content_sync_mode: 'auto' });
    seedTask('tsk_1', { title: 'New title' });
    linkTask(connection.id, 'ext-1', BASE_BASELINE, 'beads');
    const adapter = new GuardedAdapter();
    seedRemote(adapter, 'ext-1', BASE_BASELINE, { concurrencyToken: 'commit-bbb' });
    enqueueContentWrite(connection.id, 'ext-1', 'tsk_1');

    await drainOutbox(makeDeps(adapter), connection);

    expect(adapter.contentCalls).toHaveLength(1);
    expect(adapter.contentCalls[0].expectedToken).toBe('commit-bbb');
    // ONE read, not two: the lost-update guard's pre-send fetch IS the token
    // capture.
    expect(adapter.contentCalls[0].patch.title).toBe('New title');
  });

  it('holds a clobbered content field as a conflict and never retries', async () => {
    const connection = seedConnection({ provider: 'beads', content_sync_mode: 'auto' });
    seedTask('tsk_1', { title: 'New title' });
    linkTask(connection.id, 'ext-1', BASE_BASELINE, 'beads');
    const adapter = new GuardedAdapter();
    seedRemote(adapter, 'ext-1', BASE_BASELINE, { concurrencyToken: 'commit-bbb' });
    adapter.failContent = new TrackerRevisionMismatchError(
      'interleaved write on title',
      ['title'],
      makeIssue('ext-1', { title: 'Their title' }),
    );
    const row = enqueueContentWrite(connection.id, 'ext-1', 'tsk_1');

    const report = await drainOutbox(makeDeps(adapter), connection);

    expect(report.guardedConflicts).toBe(1);
    expect(report.contentWritten).toBe(0);
    expect(fetchOutbox(row.id).state).toBe('done');
    expect(fetchOutbox(row.id).next_attempt_at).toBeNull();
    expect(openConflicts(connection.id)[0]).toMatchObject({
      field: 'title',
      local_value: 'New title',
      remote_value: 'Their title',
      state: 'open',
    });
  });

  it('ignores a reported field this write never patched', async () => {
    const connection = seedConnection({ provider: 'beads', content_sync_mode: 'auto' });
    seedTask('tsk_1', { title: 'New title' });
    linkTask(connection.id, 'ext-1', BASE_BASELINE, 'beads');
    const adapter = new GuardedAdapter();
    seedRemote(adapter, 'ext-1', BASE_BASELINE, { concurrencyToken: 'commit-bbb' });
    // The interleave touched the DESCRIPTION; our patch only carried the title,
    // so nothing of ours clobbered anything of theirs.
    adapter.failContent = new TrackerRevisionMismatchError(
      'interleaved write on description',
      ['description'],
      makeIssue('ext-1', { description: 'their notes' }),
    );
    const row = enqueueContentWrite(connection.id, 'ext-1', 'tsk_1');

    const report = await drainOutbox(makeDeps(adapter), connection);

    expect(report.guardedConflicts).toBe(0);
    expect(report.guardedConverged).toBe(1);
    expect(openConflicts(connection.id)).toHaveLength(0);
    expect(fetchOutbox(row.id).state).toBe('done');
  });
});

describe('drainOutbox — a requires-guarded provider whose adapter cannot guard', () => {
  it('REFUSES an update_state row terminally rather than sending it unguarded', async () => {
    const connection = seedConnection({ provider: 'beads' });
    linkTask(connection.id, 'ext-1', BASE_BASELINE, 'beads');
    const row = enqueueStateWrite(connection.id, 'ext-1', 'completed');
    const adapter = new DegradedBeadsAdapter();

    const report = await drainOutbox(makeDeps(adapter), connection);

    expect(adapter.updateCalls).toHaveLength(0);
    expect(report.failedTerminal).toBe(1);
    const settled = fetchOutbox(row.id);
    // TERMINAL, not held: a row no drain will ever send would halt the
    // kind-agnostic inbound blocker at this issue forever.
    expect(settled.state).toBe('failed');
    expect(settled.last_error).toContain('requires guarded updates');
  });

  it('still drains a CREATE — a fresh issue has no concurrent editor to race', async () => {
    const connection = seedConnection({ provider: 'beads' });
    seedIdeaRow('idea_1');
    const row = enqueueCreate(connection.id, 'tsk_1', 'client-key-1');
    seedTask('tsk_1');
    const adapter = new DegradedBeadsAdapter();

    const report = await drainOutbox(makeDeps(adapter), connection);

    expect(report.created).toBe(1);
    expect(fetchOutbox(row.id).state).toBe('done');
  });
});
