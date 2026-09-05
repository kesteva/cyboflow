/**
 * Unit tests for main/src/services/trackerSync/trackerSyncService.ts — the
 * assembly layer (poll loop, boot crash-recovery, per-connection pass).
 *
 * Wiring: a REAL temp-file DB through the full migration chain (same technique
 * as migration093.test.ts / inboundSync.test.ts) with the project's default
 * board seeded, a REAL TaskChangeRouter over that DB, a REAL write-back
 * listener subscribed to the REAL taskChangeEvents emitter, and a fake
 * TrackerAdapter injected through `adapterFactory`. Only two things are mocked:
 * Electron's `safeStorage` (so the secret decryption seam runs for real against
 * a reversible transform) and the network (there is none — the fake adapter IS
 * the seam).
 *
 * The 60s interval is deliberately NOT exercised; `tick()` is public precisely
 * so the loop is driven directly instead of against wall-clock timers.
 *
 * Covers, per the task brief:
 *   - boot recovery: `in_flight` -> `ambiguous` -> adopted on the next pass, and
 *     the push-target repair that demotes every armed sibling but the oldest.
 *   - due-connection gating: a fresh pass stamps last_sync_at, a second tick
 *     inside the interval skips, and syncNow bypasses the gate.
 *   - phase order (ambiguous -> outbox drain -> inbound -> sweep), observed
 *     through the adapter's call log.
 *   - the inbound ordering backstop: on a provider without idempotent creates,
 *     a create that COMMITS and then loses its response defers inbound (rather
 *     than importing its child as a duplicate idea) until the marker lookup
 *     adopts it — in the same pass when the lookup works, on the next one when
 *     the outage is still up.
 *   - an auth failure pauses the connection and the loop survives it.
 *   - the status guards: a pass never starts for a non-active connection, and a
 *     disconnect landing mid-pass abandons every later phase without persisting.
 *   - the composed sync log lands in last_sync_log_json with the connected-view
 *     markers.
 *   - the per-connection mutex coalesces concurrent syncConnection calls.
 *   - the entity-event listener is really subscribed: a stage move on a linked
 *     idea enqueues an outbox row, and drainConnection writes it back.
 *   - a connection with no stored key is paused rather than throwing.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The global setup (main/src/test/setup.ts) mocks `electron` without
// safeStorage; override it here (hoisted before imports, mirroring
// secrets.test.ts) so the service's decryption seam runs for real.
vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => '/mock/path'),
    getName: vi.fn(() => 'Cyboflow'),
    getVersion: vi.fn(() => '0.1.0'),
  },
  ipcMain: { handle: vi.fn(), on: vi.fn(), removeHandler: vi.fn() },
  BrowserWindow: vi.fn(),
  safeStorage: {
    isEncryptionAvailable: (): boolean => true,
    encryptString: (plain: string): Buffer => Buffer.from(plain, 'utf-8'),
    decryptString: (cipher: Buffer): string => cipher.toString('utf-8'),
  },
}));

import { DatabaseService } from '../../../database/database';
import { TaskChangeRouter } from '../../../orchestrator/taskChangeRouter';
import { dbAdapter } from '../../../orchestrator/__test_fixtures__/dbAdapter';
import type { TrackerConnectionRow, TrackerOutboxRow } from '../../../database/models';
import type {
  TrackerIssue,
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
import { TrackerApiError, TrackerAuthError } from '../errors';
import {
  enqueueOutbox,
  getConnection,
  getLinkByEntity,
  getLinkByExternal,
  insertConnection,
  listUnresolvedOutbox,
  type NewConnectionRow,
} from '../store';
import type { UpdateStatePayload } from '../writeBack';
import {
  SYNC_INTERVAL_MS,
  TrackerSyncService,
  type TrackerSyncLogEntry,
} from '../trackerSyncService';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const PROJECT_ID = 1;
const CONN_ID = 'conn-1';

const STAGE = {
  idea: 'stage-board-1-default-1',
  done: 'stage-board-1-default-9',
};

const STATES: TrackerState[] = [
  { id: 'state-backlog', name: 'Backlog', color: null, group: 'backlog' },
  { id: 'state-progress', name: 'In Progress', color: null, group: 'started' },
  { id: 'state-done', name: 'Done', color: null, group: 'completed' },
  { id: 'state-canceled', name: 'Canceled', color: null, group: 'cancelled' },
];

const SOURCE: TrackerSourceSelection = { containerId: 'team-1', narrowId: 'all', narrowKind: 'all' };

/**
 * Fake TrackerAdapter with a single ORDERED call log — the phase-order test
 * reads that log, so every method records itself before doing anything.
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

  /** Every method call, in order — the phase-sequence assertion. */
  readonly calls: string[] = [];

  states: TrackerState[] = STATES;
  issues: TrackerIssue[] = [];
  /** Point-lookup table for getIssue (Linear's client key IS the created issue id). */
  issuesById = new Map<string, TrackerIssue>();
  /** Overrides the deletion sweep's ground truth; null = derive it from `issues`. */
  remoteIds: string[] | null = null;

  /** Scripted failure for listIssues, thrown on every call until cleared. */
  failListIssues: Error | null = null;
  /** When set, listIssues blocks on this promise (mutex / coalescing test). */
  gate: Promise<void> | null = null;
  /**
   * When set, updateIssueState blocks on this promise. A second gate rather
   * than a shared one because the mid-pass abandon tests need to hold the pass
   * at a SPECIFIC phase boundary (the drain, not the inbound fetch).
   */
  updateStateGate: Promise<void> | null = null;

  readonly updateCalls: Array<{ externalId: string; stateId: string }> = [];
  readonly contentCalls: Array<{ externalId: string; patch: IssueContentPatch }> = [];
  readonly archiveCalls: string[] = [];
  /** Every top-level push, with the container it was filed into and the draft. */
  readonly createIssueCalls: Array<{
    selection: TrackerSourceSelection;
    draft: IssueDraft;
    clientKey: string;
  }> = [];

  async validateCredentials(): Promise<TrackerWorkspaceIdentity> {
    this.calls.push('validateCredentials');
    return { workspaceId: 'ws-1', workspaceName: 'Acme', actorLabel: 'K.' };
  }
  async listGroups(): Promise<TrackerGroupTree> {
    return { sections: [] };
  }
  async listContainers(): Promise<TrackerSourceTree> {
    this.calls.push('listContainers');
    return { containerLabel: 'Team', containers: [] };
  }
  async listNarrows(): Promise<TrackerSourceNarrow[]> {
    this.calls.push('listNarrows');
    return [];
  }
  async listStates(): Promise<TrackerState[]> {
    this.calls.push('listStates');
    return this.states;
  }
  async listFieldOptions(): Promise<TrackerFieldOptionsRaw> {
    this.calls.push('listFieldOptions');
    return { priorities: ['0', '1', '2', '3', '4'], categories: null };
  }
  async listIssues(): Promise<TrackerIssue[]> {
    this.calls.push('listIssues');
    if (this.gate !== null) await this.gate;
    if (this.failListIssues !== null) throw this.failListIssues;
    return this.issues;
  }
  async listIssueIds(): Promise<string[]> {
    this.calls.push('listIssueIds');
    return this.remoteIds ?? this.issues.map((issue) => issue.externalId);
  }
  async getIssue(externalId: string): Promise<TrackerIssue | null> {
    this.calls.push('getIssue');
    // Point lookup and list serve the SAME store, as on a real provider — the
    // content drain's pre-send divergence read must see what listIssues shows.
    return (
      this.issuesById.get(externalId) ??
      this.issues.find((issue) => issue.externalId === externalId) ??
      null
    );
  }
  async createSubIssue(
    parentExternalId: string,
    draft: IssueDraft,
    clientKey: string,
  ): Promise<TrackerIssue> {
    this.calls.push('createSubIssue');
    return makeIssue({ externalId: clientKey, title: draft.title, parentExternalId });
  }
  async createIssue(
    selection: TrackerSourceSelection,
    draft: IssueDraft,
    clientKey: string,
  ): Promise<TrackerIssue> {
    this.calls.push('createIssue');
    this.createIssueCalls.push({ selection, draft, clientKey });
    const issue = makeIssue({ externalId: clientKey, title: draft.title, parentExternalId: null });
    // The tracker now HOLDS it: a created issue has to show up in the listings
    // the deletion sweep reads, or the very pass that filed it would decide the
    // issue had been deleted remotely and archive the idea behind it.
    this.issues.push(issue);
    this.issuesById.set(issue.externalId, issue);
    return issue;
  }
  async updateIssueState(externalId: string, stateId: string): Promise<void> {
    this.calls.push('updateIssueState');
    if (this.updateStateGate !== null) await this.updateStateGate;
    this.updateCalls.push({ externalId, stateId });
  }
  async updateIssueContent(
    externalId: string,
    patch: IssueContentPatch,
  ): Promise<TrackerIssue | null> {
    this.calls.push('updateIssueContent');
    this.contentCalls.push({ externalId, patch });
    const next = applyContentPatch(
      this.issuesById.get(externalId) ?? makeIssue({ externalId }),
      patch,
    );
    this.issuesById.set(externalId, next);
    this.issues = this.issues.map((issue) => (issue.externalId === externalId ? next : issue));
    return next;
  }
  async archiveIssue(externalId: string): Promise<void> {
    this.calls.push('archiveIssue');
    this.archiveCalls.push(externalId);
  }

  /** Calls filtered to the ones the phase-order assertion cares about. */
  phaseCalls(): string[] {
    return this.calls.filter((call) =>
      ['getIssue', 'listStates', 'updateIssueState', 'listIssues', 'listIssueIds'].includes(call),
    );
  }
}

/**
 * A PLANE-shaped adapter: creates are not idempotent, so a lost create is
 * recovered by the description marker instead of a point lookup. Its
 * `createSubIssue` COMMITS the child and then throws — the exact failure the
 * ordering backstop exists for.
 */
class PlaneLikeAdapter implements TrackerAdapter {
  readonly provider = 'plane' as const;
  readonly capabilities: TrackerAdapterCapabilities = {
    nativeParentAutoClose: false,
    selfHostedBaseUrl: true,
    idempotentCreate: false,
    contentWrite: { title: true, description: true, priority: true, category: false },
    archive: 'none',
    requiresIdReconciliation: false,
    guardedUpdates: false,
  };

  /** The tracker's own issue list — createSubIssue appends to it before failing. */
  issues: TrackerIssue[] = [];
  /** The outage that swallowed the create response is still up: recovery lookups fail too. */
  failRecovery = false;

  readonly calls: string[] = [];

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
    this.calls.push('listStates');
    return STATES;
  }
  async listFieldOptions(): Promise<TrackerFieldOptionsRaw> {
    this.calls.push('listFieldOptions');
    return { priorities: ['urgent', 'high', 'medium', 'low', 'none'], categories: null };
  }
  async listIssues(): Promise<TrackerIssue[]> {
    this.calls.push('listIssues');
    return this.issues;
  }
  async listIssueIds(): Promise<string[]> {
    this.calls.push('listIssueIds');
    return this.issues.map((issue) => issue.externalId);
  }
  async getIssue(externalId: string): Promise<TrackerIssue | null> {
    this.calls.push('getIssue');
    return this.issues.find((issue) => issue.externalId === externalId) ?? null;
  }
  async createSubIssue(
    parentExternalId: string,
    draft: IssueDraft,
    clientKey: string,
  ): Promise<TrackerIssue> {
    this.calls.push('createSubIssue');
    // COMMITTED — under a provider-minted id that matches neither the outbox
    // row's external_id nor its client_key — and only THEN lost.
    this.issues.push(
      makeIssue({
        externalId: 'proj1/child',
        identifier: 'PROJ-7',
        title: draft.title,
        parentExternalId,
        recoveryClientKey: clientKey,
      }),
    );
    throw new TrackerApiError('plane', 'request failed (500)', 500);
  }
  /** The TOP-LEVEL push, with the same commit-then-lose-the-response failure. */
  async createIssue(
    _selection: TrackerSourceSelection,
    draft: IssueDraft,
    clientKey: string,
  ): Promise<TrackerIssue> {
    this.calls.push('createIssue');
    this.issues.push(
      makeIssue({
        externalId: 'proj1/pushed',
        identifier: 'PROJ-8',
        title: draft.title,
        parentExternalId: null,
        recoveryClientKey: clientKey,
      }),
    );
    throw new TrackerApiError('plane', 'request failed (500)', 500);
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

  /** The marker lookup the outbox's ambiguous recovery uses (see outboxWorker). */
  async findIssueByClientKey(
    scope: { containerId: string | null; parentExternalId: string | null },
    clientKey: string,
  ): Promise<TrackerIssue | null> {
    this.calls.push('findIssueByClientKey');
    if (this.failRecovery) throw new TrackerApiError('plane', 'request failed (500)', 500);
    return (
      this.issues.find(
        (issue) =>
          (scope.parentExternalId === null ||
            issue.parentExternalId === scope.parentExternalId) &&
          issue.recoveryClientKey === clientKey,
      ) ?? null
    );
  }
}

/**
 * The post-write issue a provider echoes back — the ECHO-SUPPRESSION STAMP
 * SOURCE. Absent fields are left alone, exactly as `IssueContentPatch`
 * specifies, so a fake that applied the whole patch blindly would hide the
 * "only send what changed" property these tests rely on.
 */
function applyContentPatch(issue: TrackerIssue, patch: IssueContentPatch): TrackerIssue {
  return {
    ...issue,
    ...(patch.title !== undefined ? { title: patch.title } : {}),
    ...(patch.description !== undefined ? { description: patch.description } : {}),
    ...(patch.priority !== undefined ? { priority: patch.priority } : {}),
    ...(patch.category !== undefined ? { category: patch.category } : {}),
  };
}

function makeIssue(overrides: Partial<TrackerIssue> = {}): TrackerIssue {
  return {
    externalId: 'ext-1',
    identifier: 'CORE-142',
    title: 'Ship the tracker sync',
    description: 'Two-way sync with Linear.',
    url: 'https://linear.app/acme/issue/CORE-142',
    stateId: 'state-backlog',
    assignee: null,
    estimate: null,
    parentExternalId: null,
    updatedAt: '2026-07-30T10:00:00.000Z',
    archivedAt: null,
    // The default mapping round-trips '3' (Linear Medium) with the P2 every
    // entity here carries, so an untouched issue never produces a priority diff.
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
let service: TrackerSyncService;
let now: string;

/** The injected clock, advanced by tests that exercise the due-connection gate. */
function setNow(iso: string): void {
  now = iso;
}

function makeConnection(overrides: Partial<NewConnectionRow> = {}): TrackerConnectionRow {
  return insertConnection(raw, {
    id: CONN_ID,
    project_id: PROJECT_ID,
    provider: 'linear',
    status: 'active',
    workspace_id: 'ws-1',
    workspace_name: 'Acme',
    actor_label: 'K. Esteva',
    base_url: null,
    secret_ciphertext: Buffer.from('lin_api_key', 'utf-8'),
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

function outboxRows(connectionId = CONN_ID): TrackerOutboxRow[] {
  return raw
    .prepare('SELECT * FROM tracker_outbox WHERE connection_id = ? ORDER BY id ASC')
    .all(connectionId) as TrackerOutboxRow[];
}

/** Every idea in the project — "nothing was imported" must mean zero rows. */
function ideas(): Array<{ id: string; title: string }> {
  return raw.prepare('SELECT id, title FROM ideas ORDER BY rowid ASC').all() as Array<{
    id: string;
    title: string;
  }>;
}

function storedLog(connectionId = CONN_ID): TrackerSyncLogEntry[] {
  const json = getConnection(raw, connectionId)?.last_sync_log_json;
  return json === null || json === undefined ? [] : (JSON.parse(json) as TrackerSyncLogEntry[]);
}

/** The rendered log, one 'marker line' string per entry — what the assertions read. */
function renderedLog(connectionId = CONN_ID): string[] {
  return storedLog(connectionId).map((entry) => `${entry.marker} ${entry.line}`);
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'cyboflow-trackersync-service-'));
  svc = new DatabaseService(join(tmpDir, 'test.db'));
  svc.initialize();
  raw = svc.getDb();
  raw
    .prepare('INSERT INTO projects (id, name, path) VALUES (?, ?, ?)')
    .run(PROJECT_ID, 'Proj 1', '/tmp/p1');
  svc.seedDefaultBoard(PROJECT_ID);
  router = new TaskChangeRouter(dbAdapter(raw));
  adapter = new FakeAdapter();
  setNow('2026-07-30T12:00:00.000Z');
  service = new TrackerSyncService({
    db: raw,
    router,
    nowIso: () => now,
    adapterFactory: () => adapter,
  });
});

afterEach(() => {
  service.stop();
  raw.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Boot recovery
// ---------------------------------------------------------------------------

describe('TrackerSyncService boot recovery', () => {
  it('requeues in-flight writes as ambiguous at boot and adopts them on the next pass', async () => {
    makeConnection();
    const queued = enqueueOutbox(raw, {
      connection_id: CONN_ID,
      kind: 'create_sub_issue',
      entity_type: 'task',
      entity_id: 'tsk-1',
      client_key: 'ck-1',
      payload_json: JSON.stringify({
        parentExternalId: 'ext-parent',
        title: 'Mirrored task',
        description: null,
      }),
    });
    // The state a crash mid-API-call leaves behind.
    raw.prepare("UPDATE tracker_outbox SET state = 'in_flight' WHERE id = ?").run(queued.id);

    // The create DID land remotely — the response was just never seen.
    adapter.issuesById.set('ck-1', makeIssue({ externalId: 'ck-1', parentExternalId: 'ext-parent' }));
    adapter.remoteIds = ['ck-1'];

    service.start();

    expect(outboxRows()[0].state).toBe('ambiguous');

    const result = await service.syncConnection(CONN_ID);

    expect(result.error).toBeNull();
    expect(outboxRows()[0].state).toBe('done');
    const link = getLinkByEntity(raw, 'task', 'tsk-1', 'linear');
    expect(link?.external_id).toBe('ck-1');
    expect(link?.external_parent_id).toBe('ext-parent');
    expect(renderedLog()).toContain('· recovered 1 in-flight write');
  });

  it('leaves a paused connection alone at boot', () => {
    makeConnection({ status: 'paused' });
    const queued = enqueueOutbox(raw, {
      connection_id: CONN_ID,
      kind: 'update_state',
      external_id: 'ext-1',
      payload_json: JSON.stringify({ desiredGroup: 'completed' } satisfies UpdateStatePayload),
    });
    raw.prepare("UPDATE tracker_outbox SET state = 'in_flight' WHERE id = ?").run(queued.id);

    service.start();

    expect(outboxRows()[0].state).toBe('in_flight');
  });

  it('demotes duplicate push targets at boot, keeping the OLDEST row armed', () => {
    // The defect a ledger-wiped migration replay manufactures: 105's table
    // recreate predates 109, so a replay drops push_target and 109 re-adds it at
    // DEFAULT 1 on EVERY row. Left alone, the next pushed idea files one remote
    // issue per armed sibling. Not reachable through connect(), which is exactly
    // why boot has to repair it.
    makeConnection();
    makeConnection({
      id: 'conn-sibling',
      source_json: JSON.stringify({ containerId: 'team-2', narrowId: 'all', narrowKind: 'all' }),
    });
    // Out of scope: another provider's row keeps its flag, duplicate or not.
    makeConnection({ id: 'conn-plane', provider: 'plane' });
    // `datetime('now')` has one-second resolution, so two inserts in the same
    // test tie — stamp them apart rather than sleeping.
    const stamp = raw.prepare('UPDATE tracker_connections SET created_at = ? WHERE id = ?');
    stamp.run('2026-07-01 00:00:00', CONN_ID);
    stamp.run('2026-07-02 00:00:00', 'conn-sibling');

    service.start();

    expect(getConnection(raw, CONN_ID)?.push_target).toBe(1);
    expect(getConnection(raw, 'conn-sibling')?.push_target).toBe(0);
    expect(getConnection(raw, 'conn-plane')?.push_target).toBe(1);
  });

  it('boot repair keeps the oldest ARMED row — a deliberately demoted older row is never re-armed', () => {
    // Mixed state: the OLDEST row was explicitly demoted (a user's push-target
    // choice), and two younger siblings are both armed (the replay defect). The
    // repair must pick among the ARMED rows only — re-arming the demoted one
    // would overturn an explicit choice to fix an unrelated inconsistency.
    makeConnection({ push_target: 0 });
    makeConnection({
      id: 'conn-armed-a',
      source_json: JSON.stringify({ containerId: 'team-2', narrowId: 'all', narrowKind: 'all' }),
    });
    makeConnection({
      id: 'conn-armed-b',
      source_json: JSON.stringify({ containerId: 'team-3', narrowId: 'all', narrowKind: 'all' }),
    });
    const stamp = raw.prepare('UPDATE tracker_connections SET created_at = ? WHERE id = ?');
    stamp.run('2026-07-01 00:00:00', CONN_ID);
    stamp.run('2026-07-02 00:00:00', 'conn-armed-a');
    stamp.run('2026-07-03 00:00:00', 'conn-armed-b');

    service.start();

    expect(getConnection(raw, CONN_ID)?.push_target).toBe(0);
    expect(getConnection(raw, 'conn-armed-a')?.push_target).toBe(1);
    expect(getConnection(raw, 'conn-armed-b')?.push_target).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Cadence
// ---------------------------------------------------------------------------

describe('TrackerSyncService cadence', () => {
  it('syncs a never-synced connection, then skips it until the interval elapses', async () => {
    makeConnection();
    service.start();

    await service.tick();
    const first = getConnection(raw, CONN_ID);
    expect(first?.last_sync_at).not.toBeNull();
    expect(adapter.calls.filter((c) => c === 'listIssues')).toHaveLength(1);

    // Same instant -> not due.
    await service.tick();
    expect(adapter.calls.filter((c) => c === 'listIssues')).toHaveLength(1);

    // One second short of the interval -> still not due.
    setNow(new Date(Date.parse('2026-07-30T12:00:00.000Z') + SYNC_INTERVAL_MS - 1000).toISOString());
    await service.tick();
    expect(adapter.calls.filter((c) => c === 'listIssues')).toHaveLength(1);

    // A full interval later -> due again.
    setNow(new Date(Date.parse('2026-07-30T12:00:00.000Z') + SYNC_INTERVAL_MS).toISOString());
    await service.tick();
    expect(adapter.calls.filter((c) => c === 'listIssues')).toHaveLength(2);
  });

  it('syncNow bypasses the due gate', async () => {
    makeConnection();
    service.start();

    await service.tick();
    expect(adapter.calls.filter((c) => c === 'listIssues')).toHaveLength(1);

    // Clock unchanged: the tick would skip, but a manual sync must not.
    await service.tick();
    expect(adapter.calls.filter((c) => c === 'listIssues')).toHaveLength(1);

    const result = await service.syncNow(CONN_ID);
    expect(result.ran).toBe(true);
    expect(result.swept).toBe(true);
    expect(adapter.calls.filter((c) => c === 'listIssues')).toHaveLength(2);
  });

  it('skips connections that are not active', async () => {
    makeConnection({ status: 'paused' });
    service.start();

    await service.tick();

    expect(adapter.calls).toHaveLength(0);
    expect(getConnection(raw, CONN_ID)?.last_sync_at).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Phase order
// ---------------------------------------------------------------------------

describe('TrackerSyncService pass sequence', () => {
  it('runs ambiguous recovery, then the outbox drain, then inbound, then the sweep', async () => {
    makeConnection();

    // (1) an ambiguous create -> resolved by a point lookup (getIssue).
    const create = enqueueOutbox(raw, {
      connection_id: CONN_ID,
      kind: 'create_sub_issue',
      entity_type: 'task',
      entity_id: 'tsk-1',
      client_key: 'ck-1',
      payload_json: JSON.stringify({
        parentExternalId: 'ext-parent',
        title: 'Mirrored task',
        description: null,
      }),
    });
    raw.prepare("UPDATE tracker_outbox SET state = 'in_flight' WHERE id = ?").run(create.id);
    adapter.issuesById.set('ck-1', makeIssue({ externalId: 'ck-1', parentExternalId: 'ext-parent' }));

    // (2) a pending state write -> listStates + updateIssueState.
    enqueueOutbox(raw, {
      connection_id: CONN_ID,
      kind: 'update_state',
      external_id: 'ext-parent',
      payload_json: JSON.stringify({ desiredGroup: 'completed' } satisfies UpdateStatePayload),
    });

    // (3) inbound has nothing to import; (4) the sweep still sees the adopted link.
    adapter.remoteIds = ['ck-1'];

    service.start();
    const result = await service.syncConnection(CONN_ID);

    expect(result.error).toBeNull();
    expect(adapter.phaseCalls()).toEqual([
      'getIssue', // 1. ambiguous recovery
      'listStates', // 2. outbox drain
      'updateIssueState',
      'listStates', // 3. inbound
      'listIssues',
      'listIssueIds', // 4. deletion sweep
    ]);
    expect(adapter.updateCalls).toEqual([{ externalId: 'ext-parent', stateId: 'state-done' }]);
    expect(outboxRows().every((row) => row.state === 'done')).toBe(true);
  });

  it('only sweeps on the first pass and on a forced one', async () => {
    makeConnection();
    service.start();

    // Pass 0 sweeps (the boot pass — the app was closed while deletes happened).
    setNow('2026-07-30T12:00:00.000Z');
    expect((await service.syncConnection(CONN_ID)).swept).toBe(true);

    // Pass 1 does not.
    setNow('2026-07-30T12:06:00.000Z');
    expect((await service.syncConnection(CONN_ID)).swept).toBe(false);

    // ...but a forced pass always does.
    expect((await service.syncNow(CONN_ID)).swept).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Inbound ordering backstop
// ---------------------------------------------------------------------------

/**
 * The duplicate-import hazard the two recovery layers close together: a Plane
 * create that COMMITS and then loses its response leaves an ambiguous outbox
 * row AND a live remote child whose external id matches nothing local. If
 * inbound ran anyway, that child would be imported as a brand-new idea.
 */
describe('TrackerSyncService inbound ordering backstop', () => {
  let plane: PlaneLikeAdapter;

  function usePlane(): void {
    makeConnection({ provider: 'plane', workspace_id: 'acme' });
    plane = new PlaneLikeAdapter();
    service = new TrackerSyncService({
      db: raw,
      router,
      nowIso: () => now,
      adapterFactory: () => plane,
    });
    enqueueOutbox(raw, {
      connection_id: CONN_ID,
      kind: 'create_sub_issue',
      entity_type: 'task',
      entity_id: 'tsk-1',
      client_key: 'ck-1',
      payload_json: JSON.stringify({
        parentExternalId: 'proj1/parent',
        title: 'Mirrored task',
        description: null,
      }),
    });
  }

  it('defers inbound while a lost create is unresolved, then adopts it on the next pass', async () => {
    usePlane();
    // The outage that swallowed the create response is still up, so the marker
    // lookup cannot settle the row this pass either.
    plane.failRecovery = true;
    service.start();

    const first = await service.syncConnection(CONN_ID);

    // The create landed remotely; the row parks ambiguous rather than retrying.
    expect(outboxRows()[0].state).toBe('ambiguous');
    expect(plane.issues.map((issue) => issue.externalId)).toEqual(['proj1/child']);
    // Inbound (and the sweep) stood down: the child is NOT a new idea, and the
    // cursor did not move past it.
    expect(ideas()).toHaveLength(0);
    expect(first.error).toBeNull();
    expect(first.swept).toBe(false);
    expect(plane.calls).not.toContain('listIssues');
    const held = getConnection(raw, CONN_ID);
    expect(held?.cursor_updated_at).toBeNull();
    expect(held?.cursor_external_id).toBeNull();
    expect(renderedLog()).toContain('⚠ inbound deferred · unresolved create recovery');

    // Next pass: the outage has cleared, so the marker lookup adopts the child
    // onto the mirrored task and inbound is free to run again.
    plane.failRecovery = false;
    setNow('2026-07-30T12:10:00.000Z');
    const second = await service.syncConnection(CONN_ID);

    expect(second.error).toBeNull();
    expect(outboxRows()[0].state).toBe('done');
    const link = getLinkByEntity(raw, 'task', 'tsk-1', 'plane');
    expect(link?.external_id).toBe('proj1/child');
    expect(link?.external_parent_id).toBe('proj1/parent');
    expect(plane.calls).toContain('listIssues');
    // ...and the adopted child was never imported as a second entity.
    expect(ideas()).toHaveLength(0);
  });

  it('runs inbound while a NEVER-ATTEMPTED push sits queued behind a manual push direction', async () => {
    // THE WEDGE this backstop used to be. `push_mode: 'manual'` is the backfill
    // default for every pre-094 connection, so a Plane user who files an idea
    // gets a `create_issue` row that is never claimed until they drain push by
    // hand. Gating inbound on "an unsettled create exists" then disabled
    // automatic pull AND linked-status sync for as long as that row sat there —
    // which, being manual, is indefinitely.
    //
    // A never-claimed row has a KNOWN outcome: no request was sent, so there is
    // no remote issue to re-import and nothing to be careful about.
    makeConnection({
      provider: 'plane',
      workspace_id: 'acme',
      push_mode: 'manual',
      pull_mode: 'auto',
      status_sync_mode: 'auto',
      status_sync_enabled: 1,
    });
    plane = new PlaneLikeAdapter();
    service = new TrackerSyncService({
      db: raw,
      router,
      nowIso: () => now,
      adapterFactory: () => plane,
    });
    const push = enqueueOutbox(raw, {
      connection_id: CONN_ID,
      kind: 'create_issue',
      entity_type: 'idea',
      entity_id: 'ide-1',
      client_key: 'ck-push',
      payload_json: '{}',
    });
    plane.issues = [makeIssue({ externalId: 'proj1/remote', identifier: 'PROJ-9' })];
    service.start();

    const result = await service.syncConnection(CONN_ID);

    expect(result.error).toBeNull();
    expect(plane.calls).toContain('listIssues');
    expect(renderedLog()).not.toContain('⚠ inbound deferred · unresolved create recovery');
    // The remote issue imported, so the whole inbound half genuinely ran.
    expect(ideas()).toHaveLength(1);
    // ...and the held push is exactly where it was: pending, unattempted, in
    // order, waiting for a "Sync now".
    const held = outboxRows().find((row) => row.id === push.id);
    expect(held?.state).toBe('pending');
    expect(held?.attempts).toBe(0);
    expect(plane.calls).not.toContain('createIssue');
  });

  it('still defers inbound for an ATTEMPTED create that was returned to the queue', async () => {
    // The other side of the same predicate: `attempts > 0` on a pending row
    // means a request DID go out at some point, so the remote outcome is not
    // ours to assume. This must keep gating, or the wedge fix becomes a hole.
    usePlane();
    raw
      .prepare("UPDATE tracker_outbox SET state = 'pending', attempts = 1 WHERE connection_id = ?")
      .run(CONN_ID);
    plane.failRecovery = true;
    service.start();

    const result = await service.syncConnection(CONN_ID);

    expect(result.error).toBeNull();
    expect(plane.calls).not.toContain('listIssues');
    expect(renderedLog()).toContain('⚠ inbound deferred · unresolved create recovery');
  });

  it('still defers inbound for an AMBIGUOUS create', async () => {
    usePlane();
    raw
      .prepare("UPDATE tracker_outbox SET state = 'ambiguous' WHERE connection_id = ?")
      .run(CONN_ID);
    plane.failRecovery = true;
    service.start();

    await service.syncConnection(CONN_ID);

    expect(plane.calls).not.toContain('listIssues');
    expect(renderedLog()).toContain('⚠ inbound deferred · unresolved create recovery');
  });

  it('runs inbound in the SAME pass when the extra reconcile round settles the create', async () => {
    usePlane();
    // The create is lost, but the recovery lookup works — the backstop's one
    // extra processAmbiguous round adopts it and inbound proceeds normally.
    service.start();

    const result = await service.syncConnection(CONN_ID);

    expect(result.error).toBeNull();
    expect(outboxRows()[0].state).toBe('done');
    expect(plane.calls).toContain('listIssues');
    expect(renderedLog()).not.toContain('⚠ inbound deferred · unresolved create recovery');
    expect(ideas()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Failure policy
// ---------------------------------------------------------------------------

describe('TrackerSyncService failure policy', () => {
  it('pauses the connection on an auth failure and keeps the loop alive', async () => {
    makeConnection();
    adapter.failListIssues = new TrackerAuthError('linear', 'token revoked', 401);
    service.start();

    const result = await service.syncConnection(CONN_ID);

    expect(result.paused).toBe(true);
    expect(result.error).toContain('token revoked');
    expect(getConnection(raw, CONN_ID)?.status).toBe('paused');
    expect(renderedLog().some((line) => line.startsWith('⚠ authorization failed'))).toBe(true);

    // The loop survives: a later tick simply skips the now-paused connection.
    setNow('2026-07-30T13:00:00.000Z');
    await expect(service.tick()).resolves.toBeUndefined();
    expect(adapter.calls.filter((c) => c === 'listIssues')).toHaveLength(1);
  });

  it('pauses a connection whose API key was never stored', async () => {
    makeConnection({ secret_ciphertext: null });
    service.start();

    const result = await service.syncConnection(CONN_ID);

    expect(result.paused).toBe(true);
    expect(result.error).toContain('no stored API key');
    expect(getConnection(raw, CONN_ID)?.status).toBe('paused');
    // Nothing reached the provider.
    expect(adapter.calls).toHaveLength(0);
  });

  it('keeps a connection ACTIVE after a non-auth failure so the next tick retries', async () => {
    makeConnection();
    adapter.failListIssues = new Error('socket hang up');
    service.start();

    const result = await service.syncConnection(CONN_ID);

    expect(result.paused).toBe(false);
    expect(getConnection(raw, CONN_ID)?.status).toBe('active');
    expect(renderedLog()).toContain('⚠ sync failed · socket hang up');
    // last_sync_at is stamped even on failure, so the retry waits a full
    // interval instead of hammering every tick.
    expect(getConnection(raw, CONN_ID)?.last_sync_at).not.toBeNull();
  });

  it('returns a not-found result for an unknown connection without persisting anything', async () => {
    const result = await service.syncConnection('nope');
    expect(result).toEqual({
      connectionId: 'nope',
      ran: false,
      swept: false,
      paused: false,
      entries: [],
      error: 'connection not found',
    });
  });
});

// ---------------------------------------------------------------------------
// Status guards
// ---------------------------------------------------------------------------

/** A promise a test releases by hand — used to hold a pass at one phase. */
function openGate(): { promise: Promise<void>; release: () => void } {
  let release: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

describe('TrackerSyncService status guards', () => {
  it('does not run a pass for a connection that is no longer active', async () => {
    makeConnection();
    service.start();
    await service.disconnect(CONN_ID);

    const result = await service.syncNow(CONN_ID);

    expect(result.ran).toBe(false);
    expect(result.error).toBe('connection is disconnected');
    // Nothing reached the provider, and the disconnected row is untouched — in
    // particular it is NOT flipped to 'paused' by a doomed adapter build.
    expect(adapter.calls).toHaveLength(0);
    const row = getConnection(raw, CONN_ID);
    expect(row?.status).toBe('disconnected');
    expect(row?.last_sync_at).toBeNull();
    expect(row?.last_sync_log_json).toBeNull();
  });

  it('abandons the pass before the sweep when the connection is disconnected during inbound', async () => {
    makeConnection();
    adapter.issues = [makeIssue()];
    const gate = openGate();
    adapter.gate = gate.promise;
    service.start();

    const pass = service.syncConnection(CONN_ID);
    // Hold the pass inside the inbound fetch, then disconnect underneath it.
    await vi.waitFor(() => {
      expect(adapter.calls).toContain('listIssues');
    });
    await service.disconnect(CONN_ID);
    gate.release();
    const result = await pass;

    expect(result.ran).toBe(false);
    expect(result.error).toBe('connection is no longer active');
    // The in-flight fetch finished; the NEXT phase (the deletion sweep, which
    // this first pass would otherwise always run) never started.
    expect(adapter.calls).not.toContain('listIssueIds');
    expect(result.swept).toBe(false);
    // Nothing about the abandoned pass was persisted: no poll-clock stamp, no
    // log, and the user's disconnect stands.
    const row = getConnection(raw, CONN_ID);
    expect(row?.status).toBe('disconnected');
    expect(row?.last_sync_at).toBeNull();
    expect(row?.last_sync_log_json).toBeNull();
  });

  it('abandons the pass before inbound when the connection is disconnected during the drain', async () => {
    makeConnection();
    adapter.issues = [makeIssue()];
    enqueueOutbox(raw, {
      connection_id: CONN_ID,
      kind: 'update_state',
      external_id: 'ext-1',
      payload_json: JSON.stringify({ desiredGroup: 'completed' } satisfies UpdateStatePayload),
    });
    const gate = openGate();
    adapter.updateStateGate = gate.promise;
    service.start();

    const pass = service.syncConnection(CONN_ID);
    await vi.waitFor(() => {
      expect(adapter.calls).toContain('updateIssueState');
    });
    await service.disconnect(CONN_ID);
    gate.release();
    const result = await pass;

    expect(result.ran).toBe(false);
    // The remote write already in flight settled (nothing can un-send it), but
    // inbound — the next phase — never fetched.
    expect(adapter.updateCalls).toEqual([{ externalId: 'ext-1', stateId: 'state-done' }]);
    expect(outboxRows()[0].state).toBe('done');
    expect(adapter.calls).not.toContain('listIssues');
    expect(getConnection(raw, CONN_ID)?.last_sync_at).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Sync log
// ---------------------------------------------------------------------------

describe('TrackerSyncService sync log', () => {
  it('persists the pass log to last_sync_log_json with the connected-view markers', async () => {
    makeConnection();
    adapter.issues = [makeIssue()];
    service.start();

    await service.syncConnection(CONN_ID);

    expect(renderedLog()).toEqual([
      // Every connection defaults both migration-112 modes to 'off' until
      // Phase 6 wires a wizard control — surfaced so "sync complete" does not
      // look broken on a connection that never opted into write-back.
      '· content changes off',
      '· archive off',
      '▸ GET issues',
      '· matched 0',
      '✓ created 1 idea',
      '▸ GET issue ids',
      '✓ sync complete · next in 5m',
    ]);

    // Now diverge both sides of one field so the Auto merge records an override.
    const link = getLinkByExternal(raw, CONN_ID, 'ext-1');
    expect(link).not.toBeNull();
    await router.applyChange(PROJECT_ID, {
      actor: 'user',
      entityType: 'idea',
      taskId: link?.entity_id ?? '',
      fields: { title: 'Locally renamed' },
    });
    adapter.issues = [makeIssue({ title: 'Remotely renamed', updatedAt: '2026-07-30T11:00:00.000Z' })];

    await service.syncNow(CONN_ID);

    const lines = renderedLog();
    expect(lines).toContain('▸ GET issues');
    expect(lines).toContain('· matched 1');
    expect(lines).toContain('✓ updated 1 linked item');
    expect(lines).toContain('✎ conflicts 1');
    expect(lines[lines.length - 1]).toBe('✓ sync complete · next in 5m');
  });

  it('warns LOUDLY about a remote value no mapping can express', async () => {
    // Dart addresses priorities by TITLE, so a workspace rename leaves a
    // mapping pointing at a value nothing answers to. Nothing is applied and no
    // conflict is opened — the user is asked to confirm the mapping instead,
    // with the '⚠' the connected view renders as a problem rather than a note.
    makeConnection();
    adapter.issues = [makeIssue({ priority: '1' })];
    service.start();
    await service.syncConnection(CONN_ID);

    adapter.issues = [makeIssue({ priority: '9', updatedAt: '2026-07-30T11:00:00.000Z' })];
    await service.syncNow(CONN_ID);

    expect(renderedLog()).toContain('⚠ 1 unmapped remote value · confirm the mapping');
  });
});

// ---------------------------------------------------------------------------
// Mutex
// ---------------------------------------------------------------------------

describe('TrackerSyncService per-connection mutex', () => {
  it('coalesces concurrent syncConnection calls onto one pass', async () => {
    makeConnection();
    let release: () => void = () => undefined;
    adapter.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    service.start();

    const first = service.syncConnection(CONN_ID);
    const second = service.syncConnection(CONN_ID);
    const third = service.syncNow(CONN_ID);

    release();
    const [a, b, c] = await Promise.all([first, second, third]);

    // One pass, one fetch, one identical result handed to all three callers.
    expect(adapter.calls.filter((call) => call === 'listIssues')).toHaveLength(1);
    expect(b).toBe(a);
    expect(c).toBe(a);

    // The lock releases: a later call runs a fresh pass.
    adapter.gate = null;
    await service.syncNow(CONN_ID);
    expect(adapter.calls.filter((call) => call === 'listIssues')).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Write-back wiring
// ---------------------------------------------------------------------------

describe('TrackerSyncService write-back wiring', () => {
  it('turns a stage move on a linked idea into an outbox row and drains it', async () => {
    makeConnection();
    adapter.issues = [makeIssue()];
    service.start();

    // Pass 1 imports the issue as an idea and links it.
    await service.syncConnection(CONN_ID);
    const link = getLinkByExternal(raw, CONN_ID, 'ext-1');
    expect(link).not.toBeNull();
    const ideaId = link?.entity_id ?? '';

    // A real entity write -> a real TaskChangedEvent on TASK_ALL_CHANNEL ->
    // the subscribed listener enqueues the write-back.
    await router.applyChange(PROJECT_ID, {
      actor: 'user',
      entityType: 'idea',
      taskId: ideaId,
      stageId: STAGE.done,
    });

    const pending = listUnresolvedOutbox(raw, CONN_ID);
    expect(pending).toHaveLength(1);
    expect(pending[0].kind).toBe('update_state');
    expect(pending[0].external_id).toBe('ext-1');

    // The debounced drain's body, invoked directly (the 2s timer is the only
    // part not exercised here).
    const drained = await service.drainConnection(CONN_ID);

    expect(drained.error).toBeNull();
    expect(adapter.updateCalls).toEqual([{ externalId: 'ext-1', stateId: 'state-done' }]);
    expect(listUnresolvedOutbox(raw, CONN_ID)).toHaveLength(0);
    // The drain APPENDS to the pass log and leaves the poll clock alone.
    expect(renderedLog()).toContain('✓ wrote 1 issue state');
    expect(renderedLog()).toContain('▸ GET issues');
  });

  it('stops reacting to entity events after stop()', async () => {
    makeConnection();
    adapter.issues = [makeIssue()];
    service.start();
    await service.syncConnection(CONN_ID);
    const ideaId = getLinkByExternal(raw, CONN_ID, 'ext-1')?.entity_id ?? '';

    service.stop();

    await router.applyChange(PROJECT_ID, {
      actor: 'user',
      entityType: 'idea',
      taskId: ideaId,
      stageId: STAGE.done,
    });

    expect(listUnresolvedOutbox(raw, CONN_ID)).toHaveLength(0);
  });

  it('start() is idempotent — a second start does not double-subscribe', async () => {
    makeConnection();
    adapter.issues = [makeIssue()];
    service.start();
    service.start();
    await service.syncConnection(CONN_ID);
    const ideaId = getLinkByExternal(raw, CONN_ID, 'ext-1')?.entity_id ?? '';

    await router.applyChange(PROJECT_ID, {
      actor: 'user',
      entityType: 'idea',
      taskId: ideaId,
      stageId: STAGE.done,
    });

    // A double subscription would enqueue twice (the dedupe guard would in fact
    // catch it, but the row count is the honest signal for "subscribed once").
    expect(listUnresolvedOutbox(raw, CONN_ID)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// The direction-mode gating matrix (migration 094)
// ---------------------------------------------------------------------------

describe('TrackerSyncService direction modes', () => {
  /** Import an issue as an idea on a fully-automatic connection, then hand back its id. */
  async function importedIdea(connection: TrackerConnectionRow): Promise<string> {
    adapter.issues = [makeIssue()];
    await service.syncConnection(connection.id);
    return getLinkByExternal(raw, connection.id, 'ext-1')?.entity_id ?? '';
  }

  /** Flip a connection's modes after the fixture work is done. */
  function setModes(modes: Partial<Record<'status_sync_mode' | 'pull_mode' | 'push_mode', string>>): void {
    for (const [column, value] of Object.entries(modes)) {
      raw.prepare(`UPDATE tracker_connections SET ${column} = ? WHERE id = ?`).run(value, CONN_ID);
    }
  }

  // ----- pull -----

  it('pull MANUAL defers the import until a manual trigger, holding the cursor meanwhile', async () => {
    makeConnection({ pull_mode: 'manual' });
    adapter.issues = [makeIssue()];

    const auto = await service.syncConnection(CONN_ID);

    expect(ideas()).toHaveLength(0);
    expect(auto.entries.map((e) => e.line)).toEqual(
      expect.arrayContaining([
        'import held · manual — use Sync now',
        '1 new issue held — use Sync now',
      ]),
    );
    // The CURSOR did not move past the held issue — otherwise the manual pass
    // below would filter out the very issue it is supposed to import.
    expect(getConnection(raw, CONN_ID)?.cursor_updated_at).toBeNull();

    const manual = await service.syncNow(CONN_ID);

    expect(manual.error).toBeNull();
    expect(ideas().map((i) => i.title)).toEqual(['Ship the tracker sync']);
    expect(getConnection(raw, CONN_ID)?.cursor_external_id).toBe('ext-1');
  });

  it('status AUTO + pull MANUAL: linked items still merge and sweep, only the NEW issue waits', async () => {
    // The two directions are independent and merely share one fetch, so a
    // connection that pulls manually must NOT lose its automatic status sync.
    const connection = makeConnection();
    const ideaId = await importedIdea(connection);
    setModes({ pull_mode: 'manual' });

    adapter.issues = [
      makeIssue({
        title: 'Ship the tracker sync (v1)',
        stateId: 'state-done',
        updatedAt: '2026-07-30T11:00:00.000Z',
      }),
      makeIssue({
        externalId: 'ext-2',
        title: 'Remote newcomer',
        updatedAt: '2026-07-30T11:00:01.000Z',
      }),
    ];
    // A FRESH service instance: the deletion sweep's cadence counter is
    // in-memory and starts at 0, so its first pass always sweeps (the
    // documented post-boot behaviour). The fixture import above already spent
    // the original service's sweeping pass.
    const rebooted = new TrackerSyncService({
      db: raw,
      router,
      nowIso: () => now,
      adapterFactory: () => adapter,
    });
    const auto = await rebooted.syncConnection(CONN_ID);

    // The linked item got BOTH halves of the status-auto treatment.
    const linked = raw.prepare('SELECT title, stage_id FROM ideas WHERE id = ?').get(ideaId) as {
      title: string;
      stage_id: string;
    };
    expect(linked.title).toBe('Ship the tracker sync (v1)');
    expect(linked.stage_id).toBe(STAGE.done);
    // …and the new issue did not land.
    expect(ideas()).toHaveLength(1);
    expect(auto.entries.map((e) => e.line)).toContain('1 new issue held — use Sync now');
    // The sweep rides along with the inbound phase.
    expect(auto.swept).toBe(true);
    expect(adapter.calls).toContain('listIssueIds');
    // The cursor holds at the last FULLY applied issue, so the held newcomer is
    // re-offered rather than filtered out next time.
    expect(getConnection(raw, CONN_ID)?.cursor_external_id).toBe('ext-1');

    await rebooted.syncNow(CONN_ID);

    expect(ideas().map((i) => i.title)).toContain('Remote newcomer');
    expect(getConnection(raw, CONN_ID)?.cursor_external_id).toBe('ext-2');
  });

  it('status MANUAL + pull AUTO: imports still land while the linked stage waits', async () => {
    const connection = makeConnection();
    const ideaId = await importedIdea(connection);
    setModes({ status_sync_mode: 'manual' });

    adapter.issues = [
      makeIssue({ stateId: 'state-done', updatedAt: '2026-07-30T11:00:00.000Z' }),
      makeIssue({
        externalId: 'ext-2',
        title: 'Remote newcomer',
        updatedAt: '2026-07-30T11:00:01.000Z',
      }),
    ];
    const auto = await service.syncConnection(CONN_ID);

    // The import direction is untouched by the status hold…
    expect(ideas().map((i) => i.title)).toContain('Remote newcomer');
    // …while the linked entity's stage waits.
    expect(
      (raw.prepare('SELECT stage_id FROM ideas WHERE id = ?').get(ideaId) as { stage_id: string })
        .stage_id,
    ).not.toBe(STAGE.done);
    expect(auto.entries.map((e) => e.line)).toContain('1 status change held — use Sync now');
    // A stage deferral pins the cursor at the last fully-applied issue too — it
    // stays where the fixture import left it, so the newcomer AFTER it (which
    // did apply) is simply re-offered next pass rather than lost.
    expect(getConnection(raw, CONN_ID)?.cursor_updated_at).toBe('2026-07-30T10:00:00.000Z');
    expect(getConnection(raw, CONN_ID)?.cursor_external_id).toBe('ext-1');

    await service.syncNow(CONN_ID);

    expect(
      (raw.prepare('SELECT stage_id FROM ideas WHERE id = ?').get(ideaId) as { stage_id: string })
        .stage_id,
    ).toBe(STAGE.done);
    // A re-offered import is a no-op, not a duplicate.
    expect(ideas().filter((i) => i.title === 'Remote newcomer')).toHaveLength(1);
  });

  // ----- status, outbound -----

  it('status MANUAL holds the OUTBOUND stage write, keeping the row queued for a manual trigger', async () => {
    const connection = makeConnection();
    service.start();
    const ideaId = await importedIdea(connection);
    setModes({ status_sync_mode: 'manual' });

    await router.applyChange(PROJECT_ID, {
      actor: 'user',
      entityType: 'idea',
      taskId: ideaId,
      stageId: STAGE.done,
    });

    // The INTENT is durable regardless of the mode.
    expect(listUnresolvedOutbox(raw, CONN_ID)).toHaveLength(1);

    // An automatic pass — and the debounced drain — leave it alone.
    adapter.updateCalls.length = 0;
    await service.syncConnection(CONN_ID);
    await service.drainConnection(CONN_ID);
    expect(adapter.updateCalls).toEqual([]);
    expect(listUnresolvedOutbox(raw, CONN_ID)).toHaveLength(1);
    expect(listUnresolvedOutbox(raw, CONN_ID)[0].state).toBe('pending');

    // "Sync now" runs every direction.
    await service.syncNow(CONN_ID);
    expect(adapter.updateCalls).toEqual([{ externalId: 'ext-1', stateId: 'state-done' }]);
    expect(listUnresolvedOutbox(raw, CONN_ID)).toHaveLength(0);
  });

  // ----- status, inbound -----

  it('status MANUAL holds the INBOUND stage too, while content keeps merging', async () => {
    const connection = makeConnection();
    const ideaId = await importedIdea(connection);
    setModes({ status_sync_mode: 'manual' });

    adapter.issues = [
      makeIssue({
        title: 'Ship the tracker sync (v1)',
        stateId: 'state-done',
        updatedAt: '2026-07-30T11:00:00.000Z',
      }),
    ];
    const held = await service.syncConnection(CONN_ID);

    expect(held.entries.map((e) => e.line)).toContain('status held (manual) · use Sync now');
    const afterHold = raw.prepare('SELECT title, stage_id FROM ideas WHERE id = ?').get(ideaId) as {
      title: string;
      stage_id: string;
    };
    // Content flowed…
    expect(afterHold.title).toBe('Ship the tracker sync (v1)');
    // …the status did not.
    expect(afterHold.stage_id).not.toBe(STAGE.done);

    // The very same remote state is applied by the manual pass — nothing had to
    // change remotely for the held move to survive.
    await service.syncNow(CONN_ID);
    expect(
      (raw.prepare('SELECT stage_id FROM ideas WHERE id = ?').get(ideaId) as { stage_id: string })
        .stage_id,
    ).toBe(STAGE.done);
  });

  // ----- push -----

  it('push MANUAL queues the create and holds it until a manual trigger', async () => {
    makeConnection({ push_mode: 'manual' });
    service.start();

    await router.applyChange(PROJECT_ID, {
      actor: 'user',
      entityType: 'idea',
      fields: { title: 'A locally-filed idea' },
    });

    const queued = listUnresolvedOutbox(raw, CONN_ID);
    expect(queued).toHaveLength(1);
    expect(queued[0].kind).toBe('create_issue');

    // Automatic passes and the debounced drain both leave it queued.
    const auto = await service.syncConnection(CONN_ID);
    await service.drainConnection(CONN_ID);
    expect(auto.entries.map((e) => e.line)).toContain('push held · manual — use Sync now');
    expect(adapter.createIssueCalls).toHaveLength(0);
    expect(listUnresolvedOutbox(raw, CONN_ID)).toHaveLength(1);

    await service.syncNow(CONN_ID);

    expect(adapter.createIssueCalls).toHaveLength(1);
    expect(adapter.createIssueCalls[0].draft.title).toBe('A locally-filed idea');
    expect(adapter.createIssueCalls[0].selection.containerId).toBe(SOURCE.containerId);
    expect(listUnresolvedOutbox(raw, CONN_ID)).toHaveLength(0);
  });

  it('push AUTO files the issue on an ordinary pass and links it to the originating idea', async () => {
    makeConnection();
    service.start();

    const created = await router.applyChange(PROJECT_ID, {
      actor: 'user',
      entityType: 'idea',
      fields: { title: 'A locally-filed idea' },
    });
    const pass = await service.syncConnection(CONN_ID);

    expect(adapter.createIssueCalls).toHaveLength(1);
    const link = getLinkByEntity(raw, 'idea', created.taskId, 'linear');
    expect(link?.external_id).toBe(adapter.createIssueCalls[0].clientKey);
    expect(link?.orphaned_at).toBeNull();
    // A pushed idea is logged as a push, not mislabeled a mirrored sub-issue.
    const lines = pass.entries.map((e) => e.line);
    expect(lines).toContain('pushed 1 idea');
    expect(lines).not.toContain('mirrored 1 sub-issue');
  });

  it('holds every direction at once, and a single Sync now runs all three', async () => {
    const connection = makeConnection();
    service.start();
    const ideaId = await importedIdea(connection);
    setModes({ status_sync_mode: 'manual', pull_mode: 'manual', push_mode: 'manual' });

    // One local status change (outbound), one new idea (push)…
    await router.applyChange(PROJECT_ID, {
      actor: 'user',
      entityType: 'idea',
      taskId: ideaId,
      stageId: STAGE.done,
    });
    await router.applyChange(PROJECT_ID, {
      actor: 'user',
      entityType: 'idea',
      fields: { title: 'A locally-filed idea' },
    });
    // …and one new remote issue (pull).
    adapter.issues = [makeIssue(), makeIssue({ externalId: 'ext-2', title: 'Remote newcomer' })];
    adapter.updateCalls.length = 0;

    const auto = await service.syncConnection(CONN_ID);

    expect(auto.entries.map((e) => e.line)).toEqual(
      expect.arrayContaining([
        'status held (manual) · use Sync now',
        'import held · manual — use Sync now',
        'push held · manual — use Sync now',
      ]),
    );
    expect(adapter.updateCalls).toEqual([]);
    expect(adapter.createIssueCalls).toHaveLength(0);
    expect(ideas()).toHaveLength(2); // the imported one + the locally-filed one

    await service.syncNow(CONN_ID);

    expect(adapter.updateCalls).toEqual([{ externalId: 'ext-1', stateId: 'state-done' }]);
    expect(adapter.createIssueCalls).toHaveLength(1);
    expect(ideas().map((i) => i.title)).toContain('Remote newcomer');
  });
});

// ---------------------------------------------------------------------------
// Content/archive sync modes (migration 118) — the THREE-state gate.
//
// Phase 5 has not wired an enqueue trigger for either kind yet, so these tests
// enqueue an `update_content`/`archive_issue` row directly (exactly the shape
// a Phase-5 trigger will produce) and drive it through the real drain via
// `syncConnection` (auto trigger) / `syncNow` (manual trigger) — proving the
// MODE GATE (drainKinds' claim filter) independently of who does the
// enqueuing. A claimed row terminally fails with the Phase-5 stub error
// (outboxWorker.processUnimplementedContentKind); the point here is only that
// 'off' and 'manual' correctly withhold the CLAIM.
// ---------------------------------------------------------------------------

describe('TrackerSyncService content/archive sync modes', () => {
  function enqueueContentRow(
    connectionId: string,
    kind: 'update_content' | 'archive_issue',
    externalId = 'ext-1',
  ): TrackerOutboxRow {
    return enqueueOutbox(raw, {
      connection_id: connectionId,
      kind,
      entity_type: 'idea',
      entity_id: 'idea-1',
      external_id: externalId,
      payload_json: '{}',
    });
  }

  function outboxRow(id: number): TrackerOutboxRow {
    return raw.prepare('SELECT * FROM tracker_outbox WHERE id = ?').get(id) as TrackerOutboxRow;
  }

  it('content OFF: the row is never CLAIMED — and the pass settles it rather than leaving it', async () => {
    const connection = makeConnection({ content_sync_mode: 'off' });
    const row = enqueueContentRow(connection.id, 'update_content');

    const auto = await service.syncConnection(CONN_ID);

    // Nothing was sent: 'off' is not something a pass — or "Sync now" — can
    // unstick, which is invariant 5's whole point.
    expect(adapter.contentCalls).toHaveLength(0);
    expect(auto.entries.map((e) => e.line)).toContain('content changes off');
    // And it is not left sitting there either. A pending row of an off kind is
    // UNDRAINABLE, and the kind-agnostic inbound blocker would halt the batch
    // at its issue on every pass forever — so the pass settles it on sight.
    expect(outboxRow(row.id).state).toBe('done');
    expect(outboxRow(row.id).last_error).toContain('content sync is off');
    expect(auto.entries.map((e) => e.line)).toContain('1 queued write dropped · that direction is off');

    await service.syncNow(CONN_ID);
    expect(adapter.contentCalls).toHaveLength(0);
  });

  it('status OFF: the update_state row is never CLAIMED, and the pass settles it', async () => {
    // Migration 130 gave status the same 'off' content and archive had. Same
    // invariant 5 shape: undrainable, so the pass must settle it rather than
    // let the kind-agnostic inbound blocker halt this issue forever.
    const connection = makeConnection({ status_sync_enabled: 0 });
    const row = enqueueOutbox(raw, {
      connection_id: connection.id,
      kind: 'update_state',
      entity_type: 'idea',
      entity_id: 'idea-1',
      external_id: 'ext-1',
      payload_json: JSON.stringify({ desiredGroup: 'completed' }),
    });

    const auto = await service.syncConnection(CONN_ID);

    expect(adapter.updateCalls).toEqual([]);
    expect(auto.entries.map((e) => e.line)).toContain('status off');
    expect(outboxRow(row.id).state).toBe('done');
    expect(outboxRow(row.id).last_error).toContain('status sync is off');

    // Not even "Sync now" unsticks it — that is what separates off from manual.
    await service.syncNow(CONN_ID);
    expect(adapter.updateCalls).toEqual([]);
  });

  it('status OFF also stops the INBOUND half — it governs both directions', async () => {
    const connection = makeConnection({ status_sync_enabled: 0, pull_mode: 'auto' });
    adapter.issues = [makeIssue()];
    service.start();
    await service.syncConnection(CONN_ID);
    const link = getLinkByExternal(raw, connection.id, 'ext-1');
    const ideaId = link?.entity_id ?? '';
    const stageBefore = raw
      .prepare('SELECT stage_id AS s FROM ideas WHERE id = ?')
      .get(ideaId) as { s: string };

    // The issue moves to a DONE state remotely; with status sync off, the local
    // stage must not follow.
    adapter.issues = [
      makeIssue({ stateId: 'state-done', updatedAt: '2026-07-30T13:00:00.000Z' }),
    ];
    await service.syncNow(CONN_ID);

    expect(
      (raw.prepare('SELECT stage_id AS s FROM ideas WHERE id = ?').get(ideaId) as { s: string }).s,
    ).toBe(stageBefore.s);
  });

  it('content MANUAL: an automatic pass holds the row; Sync now claims it', async () => {
    const connection = makeConnection({ content_sync_mode: 'manual' });
    const row = enqueueContentRow(connection.id, 'update_content');

    const auto = await service.syncConnection(CONN_ID);
    expect(outboxRow(row.id).state).toBe('pending');
    expect(auto.entries.map((e) => e.line)).toContain('content changes held (manual) · use Sync now');

    await service.syncNow(CONN_ID);
    // CLAIMED is the property this test is about. The row addresses an issue
    // with no link behind it, so the handler settles it `done` with nothing
    // sent — which is exactly how a claim shows up here.
    expect(outboxRow(row.id).state).toBe('done');
  });

  it('content AUTO: an automatic pass claims the row immediately', async () => {
    const connection = makeConnection({ content_sync_mode: 'auto' });
    const row = enqueueContentRow(connection.id, 'update_content');

    const auto = await service.syncConnection(CONN_ID);

    expect(outboxRow(row.id).state).toBe('done');
    expect(auto.entries.map((e) => e.line)).not.toContain('content changes off');
    expect(auto.entries.map((e) => e.line)).not.toContain('content changes held (manual) · use Sync now');
  });

  /** Flip one connection's archive_sync_mode after the fixture work is done. */
  function setArchiveMode(mode: 'auto' | 'manual' | 'off'): void {
    raw.prepare('UPDATE tracker_connections SET archive_sync_mode = ? WHERE id = ?').run(mode, CONN_ID);
  }

  it('archive OFF/MANUAL/AUTO gate the same way, independently of content_sync_mode', async () => {
    makeConnection({ content_sync_mode: 'off', archive_sync_mode: 'off' });
    const offRow = enqueueContentRow(CONN_ID, 'archive_issue', 'ext-off');
    const autoPass1 = await service.syncConnection(CONN_ID);
    // Settled unsent, for the same reason the content-off row is — see above.
    expect(adapter.archiveCalls).toHaveLength(0);
    expect(outboxRow(offRow.id).state).toBe('done');
    expect(outboxRow(offRow.id).last_error).toContain('archive sync is off');
    expect(autoPass1.entries.map((e) => e.line)).toContain('archive off');

    setArchiveMode('manual');
    const manualRow = enqueueContentRow(CONN_ID, 'archive_issue', 'ext-manual');
    const autoPass2 = await service.syncConnection(CONN_ID);
    expect(outboxRow(manualRow.id).state).toBe('pending');
    expect(autoPass2.entries.map((e) => e.line)).toContain('archive held (manual) · use Sync now');
    await service.syncNow(CONN_ID);
    expect(outboxRow(manualRow.id).state).toBe('done');
    expect(adapter.archiveCalls).toContain('ext-manual');

    setArchiveMode('auto');
    const autoRow = enqueueContentRow(CONN_ID, 'archive_issue', 'ext-auto');
    await service.syncConnection(CONN_ID);
    expect(outboxRow(autoRow.id).state).toBe('done');
    expect(adapter.archiveCalls).toContain('ext-auto');
  });
});

// ---------------------------------------------------------------------------
// The ECHO SUITE — a local edit must not come back as a remote one
// ---------------------------------------------------------------------------

describe('TrackerSyncService content write-back — echo suppression', () => {
  /** Import one issue and return the idea it landed as. */
  async function importOne(overrides: Partial<TrackerIssue> = {}): Promise<string> {
    adapter.issues = [makeIssue(overrides)];
    adapter.issuesById.set('ext-1', adapter.issues[0]);
    service.start();
    await service.syncConnection(CONN_ID);
    return getLinkByExternal(raw, CONN_ID, 'ext-1')?.entity_id ?? '';
  }

  function baselineOf(): Record<string, unknown> {
    const link = getLinkByExternal(raw, CONN_ID, 'ext-1');
    return JSON.parse(link?.baseline_json ?? '{}') as Record<string, unknown>;
  }

  it('local edit -> enqueue -> drain -> stamp -> the NEXT inbound pass sees no change', async () => {
    makeConnection({ content_sync_mode: 'auto', conflict_mode: 'manual' });
    const ideaId = await importOne();

    // A real local edit through the real chokepoint: the subscribed listener
    // is what turns it into an outbox row.
    await router.applyChange(PROJECT_ID, {
      actor: 'user',
      entityType: 'idea',
      taskId: ideaId,
      fields: { title: 'Locally renamed', priority: 'P0' },
    });
    const queued = listUnresolvedOutbox(raw, CONN_ID);
    expect(queued.map((row) => row.kind)).toEqual(['update_content']);

    await service.drainConnection(CONN_ID);

    expect(adapter.contentCalls).toEqual([
      { externalId: 'ext-1', patch: { title: 'Locally renamed', priority: '1' } },
    ]);
    expect(baselineOf()).toMatchObject({ title: 'Locally renamed', priority: '1' });

    // THE ECHO: the tracker now serves our own write back, with a fresh
    // updatedAt so the incremental window really re-delivers it.
    adapter.issues = [
      makeIssue({
        title: 'Locally renamed',
        priority: '1',
        updatedAt: '2026-07-30T13:00:00.000Z',
      }),
    ];
    await service.syncNow(CONN_ID);

    // No conflict, no counter-write, and the local values stand.
    expect(raw.prepare('SELECT COUNT(*) AS n FROM tracker_conflicts').get()).toEqual({ n: 0 });
    expect(listUnresolvedOutbox(raw, CONN_ID)).toHaveLength(0);
    const idea = raw.prepare('SELECT title, priority FROM ideas WHERE id = ?').get(ideaId);
    expect(idea).toEqual({ title: 'Locally renamed', priority: 'P0' });
  });

  it('the body ALIGNMENT it performs does not itself queue a second write', async () => {
    makeConnection({ content_sync_mode: 'auto' });
    const ideaId = await importOne({ description: 'original' });

    await router.applyChange(PROJECT_ID, {
      actor: 'user',
      entityType: 'idea',
      taskId: ideaId,
      fields: { body: 'rewritten' },
    });
    await service.drainConnection(CONN_ID);

    // The drain's own `applyChange` runs as the PROVIDER actor, which the
    // content trigger skips — otherwise every body write would loop.
    expect(listUnresolvedOutbox(raw, CONN_ID)).toHaveLength(0);
    expect(adapter.contentCalls).toHaveLength(1);
  });

  it("'off' declines the enqueue, so a local edit never stalls the inbound cursor", async () => {
    makeConnection({ content_sync_mode: 'off' });
    const ideaId = await importOne();

    await router.applyChange(PROJECT_ID, {
      actor: 'user',
      entityType: 'idea',
      taskId: ideaId,
      fields: { title: 'Locally renamed' },
    });

    expect(listUnresolvedOutbox(raw, CONN_ID)).toHaveLength(0);
    // The inbound half is unaffected: an unresolved row for this issue would
    // halt the batch at it on every pass, forever.
    adapter.issues = [makeIssue({ updatedAt: '2026-07-30T13:00:00.000Z' })];
    const pass = await service.syncNow(CONN_ID);
    expect(pass.entries.map((entry) => entry.line)).not.toContain('held at ext-1 — our write is in flight');
    expect(getConnection(raw, CONN_ID)?.cursor_external_id).toBe('ext-1');
  });

  it('BACKFILLS that declined edit when the direction is turned back on', async () => {
    // The reported bug, end to end: an edit made under 'off' is declined
    // outright, and before the backfill arm existed, turning content sync on
    // left it stranded forever — nothing re-derives a row for an entity no
    // later event happens to touch.
    makeConnection({ content_sync_mode: 'off' });
    const ideaId = await importOne();
    await router.applyChange(PROJECT_ID, {
      actor: 'user',
      entityType: 'idea',
      taskId: ideaId,
      fields: { title: 'Locally renamed' },
    });
    expect(listUnresolvedOutbox(raw, CONN_ID)).toHaveLength(0);

    await service.updateSettings(CONN_ID, { contentSyncMode: 'auto' });

    const queued = listUnresolvedOutbox(raw, CONN_ID);
    expect(queued).toHaveLength(1);
    expect(queued[0].kind).toBe('update_content');
    expect(queued[0].entity_id).toBe(ideaId);

    // And it actually reaches the tracker on the next pass.
    await service.syncNow(CONN_ID);
    expect(adapter.contentCalls).toHaveLength(1);
    expect(adapter.contentCalls[0].patch.title).toBe('Locally renamed');
  });

  it('turning STATUS sync off settles its queued rows; turning it on backfills the stage', async () => {
    makeConnection({ status_sync_mode: 'auto' });
    const ideaId = await importOne();

    // Off: the stage move is declined outright, not banked.
    await service.updateSettings(CONN_ID, { statusSyncMode: 'off' });
    await router.applyChange(PROJECT_ID, {
      actor: 'user',
      entityType: 'idea',
      taskId: ideaId,
      stageId: STAGE.done,
    });
    expect(listUnresolvedOutbox(raw, CONN_ID)).toHaveLength(0);

    // On again: the declined intent is reconciled, at the cadence it had before.
    await service.updateSettings(CONN_ID, { statusSyncMode: 'auto' });

    const queued = listUnresolvedOutbox(raw, CONN_ID);
    expect(queued).toHaveLength(1);
    expect(queued[0].kind).toBe('update_state');
    expect(JSON.parse(queued[0].payload_json)).toEqual({ desiredGroup: 'completed' });
  });

  it('an off/on round trip RESTORES the manual cadence rather than defaulting it', async () => {
    // The reason the off switch is a second column and not a third enum value:
    // 'off' does not overwrite the cadence, so Manual survives the round trip.
    makeConnection({ status_sync_mode: 'manual' });

    await service.updateSettings(CONN_ID, { statusSyncMode: 'off' });
    expect((await service.connections(PROJECT_ID))[0].statusSyncMode).toBe('off');

    await service.updateSettings(CONN_ID, { statusSyncMode: 'manual' });
    expect((await service.connections(PROJECT_ID))[0].statusSyncMode).toBe('manual');
    expect(
      (raw.prepare('SELECT status_sync_mode AS m FROM tracker_connections WHERE id = ?').get(CONN_ID) as {
        m: string;
      }).m,
    ).toBe('manual');
  });

  it('queues nothing when the direction was ALREADY on, or when it stays off', async () => {
    // Only the off -> on TRANSITION backfills. An unrelated settings save on a
    // live connection must not manufacture writes for every converged link.
    makeConnection({ content_sync_mode: 'auto' });
    await importOne();

    await service.updateSettings(CONN_ID, { contentSyncMode: 'manual' });
    expect(listUnresolvedOutbox(raw, CONN_ID)).toHaveLength(0);

    await service.updateSettings(CONN_ID, { contentSyncMode: 'off' });
    await service.updateSettings(CONN_ID, { conflictMode: 'manual' });
    expect(listUnresolvedOutbox(raw, CONN_ID)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Flip-to-off must not strand a queued row
// ---------------------------------------------------------------------------

describe('TrackerSyncService content/archive flip to off', () => {
  function outboxRow(id: number): TrackerOutboxRow {
    return raw.prepare('SELECT * FROM tracker_outbox WHERE id = ?').get(id) as TrackerOutboxRow;
  }

  it('settles the PENDING rows of the direction being turned off, and leaves in-flight alone', async () => {
    makeConnection({ content_sync_mode: 'auto', archive_sync_mode: 'auto' });
    const pending = enqueueOutbox(raw, {
      connection_id: CONN_ID,
      kind: 'update_content',
      entity_type: 'idea',
      entity_id: 'idea-1',
      external_id: 'ext-1',
      payload_json: '{}',
    });
    const inFlight = enqueueOutbox(raw, {
      connection_id: CONN_ID,
      kind: 'update_content',
      entity_type: 'idea',
      entity_id: 'idea-2',
      external_id: 'ext-2',
      payload_json: '{}',
    });
    raw.prepare("UPDATE tracker_outbox SET state = 'in_flight' WHERE id = ?").run(inFlight.id);
    const archiveRow = enqueueOutbox(raw, {
      connection_id: CONN_ID,
      kind: 'archive_issue',
      entity_type: 'idea',
      entity_id: 'idea-3',
      external_id: 'ext-3',
      payload_json: '{}',
    });

    await service.updateSettings(CONN_ID, { contentSyncMode: 'off' });

    const rows = outboxRows();
    expect(rows.find((row) => row.id === pending.id)?.state).toBe('done');
    expect(rows.find((row) => row.id === pending.id)?.last_error).toContain('turned off');
    // A request already on the wire cannot be recalled, and its resolution is
    // what stamps the baseline.
    expect(rows.find((row) => row.id === inFlight.id)?.state).toBe('in_flight');
    // The OTHER direction is untouched — the user turned off one of them.
    expect(rows.find((row) => row.id === archiveRow.id)?.state).toBe('pending');

    await service.updateSettings(CONN_ID, { archiveSyncMode: 'off' });
    expect(outboxRows().find((row) => row.id === archiveRow.id)?.state).toBe('done');
  });

  it('SELF-HEALS a row that becomes pending AFTER the flip (the retry path)', async () => {
    // The flip-time sweep settles what is pending AT THE FLIP. An in_flight row
    // is deliberately left alone — its request cannot be recalled — and when it
    // fails retryably it lands right back in `pending`, of a kind nothing will
    // ever claim. Left there it halts inbound at that issue forever.
    makeConnection({ content_sync_mode: 'auto' });
    adapter.issues = [makeIssue()];
    service.start();
    await service.syncConnection(CONN_ID);
    const ideaId = getLinkByExternal(raw, CONN_ID, 'ext-1')?.entity_id ?? '';

    const row = enqueueOutbox(raw, {
      connection_id: CONN_ID,
      kind: 'update_content',
      entity_type: 'idea',
      entity_id: ideaId,
      external_id: 'ext-1',
      payload_json: '{}',
    });
    raw.prepare("UPDATE tracker_outbox SET state = 'in_flight' WHERE id = ?").run(row.id);

    await service.updateSettings(CONN_ID, { contentSyncMode: 'off' });
    // Untouched by the flip, exactly as intended…
    expect(outboxRow(row.id).state).toBe('in_flight');

    // …then the in-flight request fails retryably and the row returns to the
    // queue, now undrainable.
    raw
      .prepare("UPDATE tracker_outbox SET state = 'pending', attempts = 1 WHERE id = ?")
      .run(row.id);

    adapter.issues = [makeIssue({ updatedAt: '2026-07-30T13:00:00.000Z' })];
    const pass = await service.syncNow(CONN_ID);

    expect(outboxRow(row.id).state).toBe('done');
    expect(outboxRow(row.id).last_error).toContain('content sync is off');
    // The stall never happens: the sweep runs BEFORE the blocker scan.
    expect(pass.entries.map((entry) => entry.line)).not.toContain(
      'held at ext-1 — our write is in flight',
    );
    expect(getConnection(raw, CONN_ID)?.cursor_updated_at).toBe('2026-07-30T13:00:00.000Z');
  });

  it('SELF-HEALS the boot-recovery path: ambiguous -> requeued -> pending, of an off kind', async () => {
    // The other route back into `pending`: a crash leaves the row `in_flight`,
    // boot recovery demotes it to `ambiguous`, and processAmbiguous requeues
    // every NON-CREATE kind straight to pending (re-performing them is
    // idempotent). Nothing in that chain consults the direction mode.
    makeConnection({ content_sync_mode: 'off', archive_sync_mode: 'off' });
    adapter.issues = [makeIssue()];

    const content = enqueueOutbox(raw, {
      connection_id: CONN_ID,
      kind: 'update_content',
      entity_type: 'idea',
      entity_id: 'idea-1',
      external_id: 'ext-1',
      payload_json: '{}',
    });
    const archive = enqueueOutbox(raw, {
      connection_id: CONN_ID,
      kind: 'archive_issue',
      entity_type: 'idea',
      entity_id: 'idea-2',
      external_id: 'ext-2',
      payload_json: '{}',
    });
    raw.prepare("UPDATE tracker_outbox SET state = 'in_flight'").run();

    // start() demotes both to ambiguous…
    service.start();
    expect(outboxRows().map((r) => r.state)).toEqual(['ambiguous', 'ambiguous']);

    // …and the pass requeues them to pending, then heals them in the same pass.
    const pass = await service.syncConnection(CONN_ID);

    expect(outboxRows().map((r) => r.state)).toEqual(['done', 'done']);
    expect(outboxRow(content.id).last_error).toContain('content sync is off');
    expect(outboxRow(archive.id).last_error).toContain('archive sync is off');
    expect(adapter.contentCalls).toHaveLength(0);
    expect(adapter.archiveCalls).toHaveLength(0);
    expect(pass.entries.map((entry) => entry.line)).not.toContain(
      'held at ext-1 — our write is in flight',
    );
  });

});

// ---------------------------------------------------------------------------
// The removal pipeline, through the REAL handleLocalRemoval -> listener order
// ---------------------------------------------------------------------------

describe('TrackerSyncService removal pipeline', () => {
  async function linkedIdea(): Promise<string> {
    adapter.issues = [makeIssue()];
    service.start();
    await service.syncConnection(CONN_ID);
    return getLinkByExternal(raw, CONN_ID, 'ext-1')?.entity_id ?? '';
  }

  function outboxKinds(): string[] {
    return outboxRows().map((row) => row.kind);
  }

  it('PLAIN archive (no ruling): the listener arm files one archive_issue', async () => {
    makeConnection({ archive_sync_mode: 'auto' });
    const ideaId = await linkedIdea();

    await router.applyChange(PROJECT_ID, {
      actor: 'user',
      entityType: 'idea',
      taskId: ideaId,
      archived: true,
    });

    expect(outboxKinds()).toEqual(['archive_issue']);
    expect(outboxRows()[0].external_id).toBe('ext-1');
    // The link is still LIVE: only a CONFIRMED archive takes it out of sync.
    expect(getLinkByExternal(raw, CONN_ID, 'ext-1')?.orphaned_at).toBeNull();
  });

  it('RULED archive: dropLink files the archive BEFORE orphaning, and the listener adds nothing', async () => {
    makeConnection({ archive_sync_mode: 'auto' });
    const ideaId = await linkedIdea();

    await service.stageUnlinkRuling('idea', ideaId, { cancelRemote: true });
    await router.applyChange(PROJECT_ID, {
      actor: 'user',
      entityType: 'idea',
      taskId: ideaId,
      archived: true,
    });

    // EXACTLY ONE row. handleLocalRemoval runs first and orphans the link, so
    // the listener arm that follows finds nothing to duplicate.
    expect(outboxKinds()).toEqual(['archive_issue']);
    expect(getLinkByExternal(raw, CONN_ID, 'ext-1')?.orphaned_at).not.toBeNull();

    await service.drainConnection(CONN_ID);
    expect(adapter.archiveCalls).toEqual(['ext-1']);
  });

  it('RULED delete: the pre-delete snapshot is the only path, and it still archives', async () => {
    makeConnection({ archive_sync_mode: 'auto' });
    const ideaId = await linkedIdea();

    await service.stageUnlinkRuling('idea', ideaId, { cancelRemote: true });
    await router.applyDelete(PROJECT_ID, { actor: 'user', entityType: 'idea', taskId: ideaId });

    expect(outboxKinds()).toEqual(['archive_issue']);
    await service.drainConnection(CONN_ID);
    expect(adapter.archiveCalls).toEqual(['ext-1']);
  });

  it("a 'keep it' ruling writes nothing remotely", async () => {
    makeConnection({ archive_sync_mode: 'auto' });
    const ideaId = await linkedIdea();

    await service.stageUnlinkRuling('idea', ideaId, { cancelRemote: false });
    await router.applyChange(PROJECT_ID, {
      actor: 'user',
      entityType: 'idea',
      taskId: ideaId,
      archived: true,
    });

    expect(outboxKinds()).toEqual([]);
    expect(getLinkByExternal(raw, CONN_ID, 'ext-1')?.orphaned_at).not.toBeNull();
  });

  it("falls back to the cancelled-state write when the provider cannot archive", async () => {
    makeConnection({ provider: 'plane', archive_sync_mode: 'auto', workspace_id: 'acme' });
    const ideaId = await linkedIdea();

    await service.stageUnlinkRuling('idea', ideaId, { cancelRemote: true });
    await router.applyChange(PROJECT_ID, {
      actor: 'user',
      entityType: 'idea',
      taskId: ideaId,
      archived: true,
    });

    // Plane declares archive: 'none'. The ruling still reaches the tracker —
    // through the one write its API can actually perform.
    expect(outboxKinds()).toEqual(['update_state']);
    expect(JSON.parse(outboxRows()[0].payload_json)).toEqual({ desiredGroup: 'cancelled' });
  });

  it("falls back to the cancelled-state write when archive sync is 'off'", async () => {
    makeConnection({ archive_sync_mode: 'off' });
    const ideaId = await linkedIdea();

    await service.stageUnlinkRuling('idea', ideaId, { cancelRemote: true });
    await router.applyChange(PROJECT_ID, {
      actor: 'user',
      entityType: 'idea',
      taskId: ideaId,
      archived: true,
    });

    // An archive_issue row here could never be claimed, and an unclaimable row
    // halts inbound for this issue forever.
    expect(outboxKinds()).toEqual(['update_state']);
  });
});

// ---------------------------------------------------------------------------
// Conflict resolution -> the tracker converges on the local value
// ---------------------------------------------------------------------------

describe('TrackerSyncService conflict resolution — content convergence', () => {
  /** Import an issue, then diverge BOTH sides so a manual pass opens a conflict. */
  async function openTitleConflict(): Promise<{ ideaId: string; conflictId: number }> {
    adapter.issues = [makeIssue()];
    service.start();
    await service.syncConnection(CONN_ID);
    const ideaId = getLinkByExternal(raw, CONN_ID, 'ext-1')?.entity_id ?? '';

    await router.applyChange(PROJECT_ID, {
      actor: 'user',
      entityType: 'idea',
      taskId: ideaId,
      fields: { title: 'Local title' },
    });
    // Whatever the local edit queued is irrelevant to the conflict itself, and
    // an unresolved row would halt the inbound pass that must open it.
    raw.prepare("UPDATE tracker_outbox SET state = 'done'").run();

    adapter.issues = [makeIssue({ title: 'Remote title', updatedAt: '2026-07-30T13:00:00.000Z' })];
    await service.syncNow(CONN_ID);

    const row = raw.prepare('SELECT id FROM tracker_conflicts WHERE field = ?').get('title') as
      | { id: number }
      | undefined;
    return { ideaId, conflictId: row?.id ?? 0 };
  }

  it("accepting LOCAL stamps the baseline AND queues the convergence write", async () => {
    makeConnection({ conflict_mode: 'manual', content_sync_mode: 'auto' });
    const { conflictId } = await openTitleConflict();
    expect(conflictId).toBeGreaterThan(0);

    await service.resolveConflictChoice(conflictId, 'local');

    const queued = listUnresolvedOutbox(raw, CONN_ID);
    expect(queued.map((row) => row.kind)).toEqual(['update_content']);

    await service.drainConnection(CONN_ID);
    expect(adapter.contentCalls).toEqual([
      { externalId: 'ext-1', patch: { title: 'Local title' } },
    ]);
  });

  it("accepting LOCAL under 'off' stamps ONLY — an enqueued row would be undrainable", async () => {
    makeConnection({ conflict_mode: 'manual', content_sync_mode: 'off' });
    const { conflictId } = await openTitleConflict();

    await service.resolveConflictChoice(conflictId, 'local');

    expect(listUnresolvedOutbox(raw, CONN_ID)).toHaveLength(0);
    // The stamp still lands, so the conflict does not re-open every pass.
    const link = getLinkByExternal(raw, CONN_ID, 'ext-1');
    expect(JSON.parse(link?.baseline_json ?? '{}')).toMatchObject({ title: 'Remote title' });
  });

  it('accepting REMOTE applies the value and queues NOTHING back', async () => {
    makeConnection({ conflict_mode: 'manual', content_sync_mode: 'auto' });
    const { ideaId, conflictId } = await openTitleConflict();

    await service.resolveConflictChoice(conflictId, 'remote');

    // The apply runs as the PROVIDER actor and the stamp precedes it, so the
    // content trigger has neither a reason nor permission to echo it back.
    expect(listUnresolvedOutbox(raw, CONN_ID)).toHaveLength(0);
    expect(raw.prepare('SELECT title FROM ideas WHERE id = ?').get(ideaId)).toEqual({
      title: 'Remote title',
    });
  });
});
