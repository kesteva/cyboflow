/**
 * Unit tests for the TrackerSyncFacade half of
 * main/src/services/trackerSync/trackerSyncService.ts — everything the
 * Settings > Integrations tRPC surface calls (wizard probes, connect,
 * connected-view reads, settings, disconnect, conflict resolution).
 *
 * Wiring mirrors inboundSync.test.ts / trackerSyncService.test.ts: a REAL
 * temp-file DB through the full migration chain with the project's default
 * board seeded, a REAL TaskChangeRouter over that DB (so archives, title edits
 * and stage moves actually land, entity_events included), and a fake
 * TrackerAdapter injected through `adapterFactory`. Only Electron's
 * `safeStorage` is mocked, with a reversible transform, so the encrypt/decrypt
 * seam runs for real.
 *
 * Covers, per the task brief:
 *   - wizardValidate: adapter passthrough, built from the PASTED key, and
 *     nothing persisted (no connection row, no secret).
 *   - connect: row + encrypted secret + reconcile links/discards + the
 *     fire-and-forget first pass, plus the 'connection' broadcast — and the
 *     ordering that makes it safe: nothing is written when the credential probe
 *     fails, and a reconcile row rejected AFTER the row+secret anchor is logged
 *     and skipped rather than sinking the connection. Plus the revival IDENTITY:
 *     the same workspace slug on a DIFFERENT tracker instance mints a new
 *     connection, while the same instance spelled with a trailing slash (or left
 *     on the provider's default origin) revives the retired row.
 *   - MULTI-PROJECT MAPPING: connect is an idempotent no-op for a mapping that
 *     already exists (the Map step retries failed connects by re-submitting the
 *     set), matched on the FULL source scope so two groups differing only in
 *     their narrow stay two mappings; a different source container mints a
 *     SIBLING row instead, push_target defaults to 1 and is written 0 for a
 *     non-pushing sibling. What a re-submit legitimately re-applies is pinned
 *     too — the push-target choice (either direction, demoting the sibling that
 *     held it) and the freshly-validated key that resumes a PAUSED mapping —
 *     as is the mint path's cross-run demotion. And updateCredentials FANS OUT
 *     across every live row sharing the key, so one paste resumes all the
 *     mappings without re-arming a retired one.
 *   - connections(): the summary's counts, source label, mapping, push target
 *     and defensively-parsed log.
 *   - resolveConflictChoice: all four branches (field remote / field local /
 *     remote_deleted remote / remote_deleted local), plus the description
 *     branch's provenance-footer preservation.
 *   - resolveConflictChoice ACROSS a following inbound pass: a ruling that does
 *     not advance the link's baseline re-opens the same conflict forever, so
 *     title/description/one-way-stage local rulings (and the remote ones) are
 *     each driven through a real second pass with the remote unchanged. The
 *     stage + 'remote' cases additionally run with the REAL write-back listener
 *     subscribed, because accepting a remote stage without first stamping the
 *     raw remote state echoed a write-back that overwrote the accepted state.
 *   - disconnect: status + the cleared secret + delisting.
 *   - unlinkEntity: the ruling applied DIRECTLY — 'keep' orphans with an empty
 *     outbox, 'cancel' queues exactly one deduped cancelled-group write, an
 *     unlinked entity reports { unlinked: false }.
 *   - stageUnlinkRuling: the STAGED ruling the board's delete path uses —
 *     staging alone mutates nothing, the committed delete/archive applies it,
 *     an abandoned one expires, a consumed one is not reused, a delete cascade
 *     orphans its children's links (with or without a ruling) and those children
 *     inherit the root's answer, and an archive with no ruling is left entirely
 *     alone (that is inbound sync's link to manage).
 *   - the three defenses that keep an ABANDONED ruling from being spent by an
 *     unrelated later removal: clearUnlinkRuling (the renderer's explicit
 *     discard), the ACTOR check (only an actor:'user' removal consumes one, so
 *     a provider- or orchestrator-authored archive/delete inside the window
 *     cannot), and the TTL underneath both.
 *   - reconcilePreview: which entities are candidates and how a title matches.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The global setup (main/src/test/setup.ts) mocks `electron` without
// safeStorage; override it here (hoisted before imports, mirroring
// trackerSyncService.test.ts) so the secret seam runs for real.
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
import {
  TASK_ALL_CHANNEL,
  TaskChangeRouter,
  taskChangeEvents,
} from '../../../orchestrator/taskChangeRouter';
import { dbAdapter } from '../../../orchestrator/__test_fixtures__/dbAdapter';
import {
  trackerProjectChannel,
  trackerSyncEvents,
  type TrackerChangedEvent,
} from '../../../orchestrator/trackerSyncBridge';
import type {
  EntityExternalLinkRow,
  TrackerConflictRow,
  TrackerConnectionRow,
  TrackerOutboxRow,
} from '../../../database/models';
import type {
  TrackerConnectPayload,
  TrackerCredentialsInput,
  TrackerGroupTree,
  TrackerIssue,
  TrackerSourceNarrow,
  TrackerSourceSelection,
  TrackerSourceTree,
  TrackerState,
  TrackerWorkspaceIdentity,
} from '../../../../../shared/types/trackerSync';
import type { IssueDraft, TrackerAdapter, TrackerAdapterCapabilities, TrackerFieldOptionsRaw} from '../adapterTypes';
import { TrackerAuthError } from '../errors';
import { joinBody, splitBody, type EntityWriteRouter } from '../inboundSync';
import {
  getConnection,
  getLinkByExternal,
  insertConflict,
  insertConnection,
  readSecret,
  upsertLink,
  type NewConnectionRow,
  type UpsertLinkInput,
} from '../store';
import {
  createWriteBackListener,
  type UpdateStatePayload,
  type WriteBackListener,
} from '../writeBack';
import { TrackerSyncService } from '../trackerSyncService';
import type { TaskChangedEvent } from '../../../../../shared/types/tasks';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const PROJECT_ID = 1;
const CONN_ID = 'conn-1';
const API_KEY = 'lin_api_key_secret';

const STAGE = {
  idea: 'stage-board-1-default-1',
  ready: 'stage-board-1-default-6',
  done: 'stage-board-1-default-9',
};

const STATES: TrackerState[] = [
  { id: 'state-backlog', name: 'Backlog', color: null, group: 'backlog' },
  { id: 'state-progress', name: 'In Progress', color: null, group: 'started' },
  { id: 'state-done', name: 'Done', color: null, group: 'completed' },
];

const SOURCE: TrackerSourceSelection = { containerId: 'team-1', narrowId: 'all', narrowKind: 'all' };

const GROUPS: TrackerGroupTree = {
  sections: [
    {
      label: 'Projects',
      groups: [
        {
          id: 'team-1/proj-1',
          name: 'Platform',
          key: 'COR',
          sourceLabel: 'Platform · Core',
          selection: { containerId: 'team-1', narrowId: 'proj-1', narrowKind: 'project' },
          stateScopeKey: 'team-1',
        },
      ],
    },
  ],
};

const CREDENTIALS: TrackerCredentialsInput = { provider: 'linear', apiKey: API_KEY };

/** Fake adapter recording what the facade asked of it. */
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

  readonly calls: string[] = [];
  /** Every top-level push, with the container it was filed into. */
  readonly createIssueCalls: Array<{
    containerId: string;
    draft: IssueDraft;
    clientKey: string;
  }> = [];
  states: TrackerState[] = STATES;
  issues: TrackerIssue[] = [];
  groups: TrackerGroupTree = GROUPS;
  fieldOptions: TrackerFieldOptionsRaw = { priorities: ['0', '1', '2', '3', '4'], categories: null };
  /** Scripted failure for validateCredentials (the auth-error path). */
  failValidate: Error | null = null;
  /** The workspace the live probe reports — the reconnect identity key. */
  workspaceId = 'ws-1';

  async validateCredentials(): Promise<TrackerWorkspaceIdentity> {
    this.calls.push('validateCredentials');
    if (this.failValidate !== null) throw this.failValidate;
    return { workspaceId: this.workspaceId, workspaceName: 'Acme', actorLabel: 'K. Esteva' };
  }
  async listGroups(): Promise<TrackerGroupTree> {
    this.calls.push('listGroups');
    return this.groups;
  }
  async listContainers(): Promise<TrackerSourceTree> {
    this.calls.push('listContainers');
    return { containerLabel: 'Team', containers: [{ id: 'team-1', name: 'Core', key: 'COR', openIssueCount: 3 }] };
  }
  async listNarrows(containerId: string): Promise<TrackerSourceNarrow[]> {
    this.calls.push(`listNarrows:${containerId}`);
    return [{ id: 'all', kind: 'all', name: 'Whole team', issueCount: 3 }];
  }
  async listStates(): Promise<TrackerState[]> {
    this.calls.push('listStates');
    return this.states;
  }
  async listFieldOptions(): Promise<TrackerFieldOptionsRaw> {
    this.calls.push('listFieldOptions');
    return this.fieldOptions;
  }
  async listIssues(): Promise<TrackerIssue[]> {
    this.calls.push('listIssues');
    return this.issues;
  }
  async listIssueIds(): Promise<string[]> {
    this.calls.push('listIssueIds');
    return this.issues.map((issue) => issue.externalId);
  }
  async getIssue(): Promise<TrackerIssue | null> {
    this.calls.push('getIssue');
    return null;
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
    this.createIssueCalls.push({ containerId: selection.containerId, draft, clientKey });
    return makeIssue({ externalId: clientKey, title: draft.title, parentExternalId: null });
  }
  async updateIssueState(): Promise<void> {
    this.calls.push('updateIssueState');
  }
  async updateIssueContent(): Promise<TrackerIssue | null> {
    throw new Error('not used');
  }
  async archiveIssue(): Promise<void> {
    throw new Error('not used');
  }
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
/** Every (connection, secret) pair the injected factory was called with. */
let factoryCalls: Array<{ connection: TrackerConnectionRow; secret: string }>;
/** Every TrackerChangedEvent broadcast on the project channel. */
let broadcasts: TrackerChangedEvent[];
let onBroadcast: (event: TrackerChangedEvent) => void;
/**
 * The service's injected clock, as a MUTABLE fixture: the staged-ruling TTL
 * reads it, so an expiry case advances this instead of waiting.
 */
let now: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'cyboflow-trackersync-facade-'));
  svc = new DatabaseService(join(tmpDir, 'test.db'));
  svc.initialize();
  raw = svc.getDb();
  raw
    .prepare('INSERT INTO projects (id, name, path) VALUES (?, ?, ?)')
    .run(PROJECT_ID, 'Proj 1', '/tmp/p1');
  svc.seedDefaultBoard(PROJECT_ID);
  router = new TaskChangeRouter(dbAdapter(raw));
  adapter = new FakeAdapter();
  factoryCalls = [];
  broadcasts = [];
  onBroadcast = (event: TrackerChangedEvent): void => {
    broadcasts.push(event);
  };
  trackerSyncEvents.on(trackerProjectChannel(PROJECT_ID), onBroadcast);
  now = '2026-07-30T12:00:00.000Z';
  service = new TrackerSyncService({
    db: raw,
    router,
    nowIso: () => now,
    adapterFactory: (connection, secret) => {
      factoryCalls.push({ connection, secret });
      return adapter;
    },
  });
});

afterEach(() => {
  trackerSyncEvents.off(trackerProjectChannel(PROJECT_ID), onBroadcast);
  service.stop();
  raw.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

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
    secret_ciphertext: Buffer.from(API_KEY, 'utf-8'),
    source_json: JSON.stringify({ ...SOURCE, label: 'Core · Whole team' }),
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
    conflict_mode: 'manual',
    cursor_updated_at: null,
    cursor_external_id: null,
    last_sync_at: null,
    last_sync_log_json: null,
    ...overrides,
  });
}

/**
 * A second cyboflow project, board seeded — `tracker_connections.project_id` is
 * a real FK, so a cross-project mapping set needs the row to exist.
 */
function addProject(id: number): void {
  raw.prepare('INSERT INTO projects (id, name, path) VALUES (?, ?, ?)').run(id, `Proj ${id}`, `/tmp/p${id}`);
  svc.seedDefaultBoard(id);
}

/** Create an entity through the REAL chokepoint and return its id. */
async function createEntity(
  entityType: 'idea' | 'epic' | 'task',
  fields: {
    title: string;
    body?: string | null;
    stageId?: string;
    /** Lineage, so a case can build a real idea -> epic -> task delete cascade. */
    parentEpicId?: string;
    originatingIdeaId?: string;
  },
): Promise<string> {
  const { taskId } = await router.applyChange(PROJECT_ID, {
    actor: 'user',
    entityType,
    title: fields.title,
    body: fields.body ?? null,
    ...(fields.stageId !== undefined ? { initialStageId: fields.stageId } : {}),
    ...(fields.parentEpicId !== undefined ? { parentEpicId: fields.parentEpicId } : {}),
    ...(fields.originatingIdeaId !== undefined
      ? { originatingIdeaId: fields.originatingIdeaId }
      : {}),
  });
  return taskId;
}

interface EntityRow {
  ref: string;
  title: string;
  body: string | null;
  stage_id: string;
  archived_at: string | null;
}

function readIdea(id: string): EntityRow {
  return raw
    .prepare('SELECT ref, title, body, stage_id, archived_at FROM ideas WHERE id = ?')
    .get(id) as EntityRow;
}

/** The two MAPPED fields, read straight off the row (readIdea does not select them). */
function readIdeaPriority(id: string): string {
  return (raw.prepare('SELECT priority FROM ideas WHERE id = ?').get(id) as { priority: string })
    .priority;
}

function readIdeaCategory(id: string): string {
  return (raw.prepare('SELECT category FROM ideas WHERE id = ?').get(id) as { category: string })
    .category;
}

function conflictRow(id: number): TrackerConflictRow {
  return raw.prepare('SELECT * FROM tracker_conflicts WHERE id = ?').get(id) as TrackerConflictRow;
}

/** Every conflict row for the connection, oldest first. */
function allConflicts(): TrackerConflictRow[] {
  return raw
    .prepare('SELECT * FROM tracker_conflicts ORDER BY id ASC')
    .all() as TrackerConflictRow[];
}

/** The one idea a real inbound pass imported (rowid = true insertion order). */
function importedIdeaId(): string {
  const rows = raw.prepare('SELECT id FROM ideas ORDER BY rowid ASC').all() as Array<{ id: string }>;
  if (rows.length !== 1) throw new Error(`expected exactly one imported idea, got ${rows.length}`);
  return rows[0].id;
}

/** A link's `baseline_json`, parsed. */
function baselineOf(externalId: string): Record<string, unknown> {
  const link = getLinkByExternal(raw, CONN_ID, externalId);
  if (!link) throw new Error(`no link for ${externalId}`);
  return JSON.parse(link.baseline_json ?? '{}') as Record<string, unknown>;
}

function linkRow(id: number): EntityExternalLinkRow {
  return raw
    .prepare('SELECT * FROM entity_external_links WHERE id = ?')
    .get(id) as EntityExternalLinkRow;
}

function outboxRows(connectionId = CONN_ID): TrackerOutboxRow[] {
  return raw
    .prepare('SELECT * FROM tracker_outbox WHERE connection_id = ? ORDER BY id ASC')
    .all(connectionId) as TrackerOutboxRow[];
}

function connectPayload(overrides: Partial<TrackerConnectPayload> = {}): TrackerConnectPayload {
  return {
    projectId: PROJECT_ID,
    credentials: CREDENTIALS,
    source: SOURCE,
    sourceLabel: 'Core · Whole team',
    selectionMode: 'all',
    selectionJson: null,
    stateMapping: { 'state-backlog': 'idea', 'state-done': 'done' },
    statusSyncMode: 'auto',
    pullMode: 'auto',
    pushMode: 'auto',
    mirrorSubissues: true,
    conflictMode: 'auto',
    reconcile: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Wizard probes
// ---------------------------------------------------------------------------

describe('TrackerSyncService wizard probes', () => {
  it('validates through an ad-hoc adapter built from the pasted key and persists nothing', async () => {
    const identity = await service.wizardValidate({
      provider: 'plane',
      apiKey: 'plane_key',
      baseUrl: 'https://plane.acme.dev',
      workspaceSlug: 'acme',
    });

    expect(identity).toEqual({ workspaceId: 'ws-1', workspaceName: 'Acme', actorLabel: 'K. Esteva' });
    expect(adapter.calls).toEqual(['validateCredentials']);

    // The scratch row carries the wizard's credentials verbatim...
    expect(factoryCalls).toHaveLength(1);
    expect(factoryCalls[0].secret).toBe('plane_key');
    expect(factoryCalls[0].connection.provider).toBe('plane');
    expect(factoryCalls[0].connection.base_url).toBe('https://plane.acme.dev');
    expect(factoryCalls[0].connection.workspace_id).toBe('acme');

    // ...and NOTHING was written: no connection row, so no secret either.
    const rows = raw.prepare('SELECT COUNT(*) AS n FROM tracker_connections').get() as { n: number };
    expect(rows.n).toBe(0);
  });

  it('passes the wizard listing calls straight through to the adapter', async () => {
    await expect(service.wizardContainers(CREDENTIALS)).resolves.toEqual({
      containerLabel: 'Team',
      containers: [{ id: 'team-1', name: 'Core', key: 'COR', openIssueCount: 3 }],
    });
    await expect(service.wizardNarrows(CREDENTIALS, 'team-1')).resolves.toHaveLength(1);
    await expect(service.wizardStates({ credentials: CREDENTIALS }, SOURCE)).resolves.toEqual(
      STATES,
    );
    // The Map step's groups, each carrying the selection a connect would persist.
    await expect(service.wizardGroups({ credentials: CREDENTIALS })).resolves.toEqual(GROUPS);

    // The mapping tables' vocabulary. No selection: none of the three providers
    // scopes its priority/type lists to a container. The two default* mappings
    // are computed HERE (seedDefaultPriorityMapping/seedDefaultCategoryMapping
    // over the adapter's raw options) — never left to the wizard to re-derive.
    await expect(service.wizardFieldOptions({ credentials: CREDENTIALS })).resolves.toEqual({
      priorities: ['0', '1', '2', '3', '4'],
      categories: null,
      defaultPriorityMapping: {
        toProvider: { P0: '1', P1: '2', P2: '3', P3: '3', P4: '4', P5: '4', P6: '0' },
        toLocal: { '0': 'P6', '1': 'P0', '2': 'P1', '3': 'P2', '4': 'P4' },
      },
      // Linear has no category concept, so the seed is all-null regardless of
      // liveOptions — providerSupportsCategorySync short-circuits it.
      defaultCategoryMapping: {
        toProvider: { feature: null, bug: null, chore: null },
        toLocal: {},
      },
    });

    adapter.issues = [makeIssue()];
    await expect(service.wizardIssues({ credentials: CREDENTIALS }, SOURCE)).resolves.toHaveLength(
      1,
    );

    expect(adapter.calls).toEqual([
      'listContainers',
      'listNarrows:team-1',
      'listStates',
      'listGroups',
      'listFieldOptions',
      'listIssues',
    ]);
  });

  it('surfaces the adapter auth error unchanged (the router maps it to UNAUTHORIZED)', async () => {
    adapter.failValidate = new TrackerAuthError('linear', 'invalid API key', 401);
    await expect(service.wizardValidate(CREDENTIALS)).rejects.toBeInstanceOf(TrackerAuthError);
  });
});

// ---------------------------------------------------------------------------
// Wizard probes driven by an EXISTING connection's stored key
//
// The mapping-management path: the user is adding a group to a connection they
// already authorized, so there is no key to paste — main resolves the row's own
// encrypted one, and nothing key-shaped crosses IPC in either direction.
// ---------------------------------------------------------------------------

describe('TrackerSyncService wizard probes — { connectionId } credential source', () => {
  it('probes on the stored key, addressed by the ROW’s identity, not the renderer’s', async () => {
    // A Plane row, so the two addressing fields the resolution reads off the row
    // (base_url, workspace_id -> the slug every REST path is scoped under) are
    // both non-null and distinguishable from the linear fixture's defaults.
    makeConnection({
      provider: 'plane',
      base_url: 'https://plane.acme.dev',
      workspace_id: 'acme-slug',
    });

    await expect(service.wizardGroups({ connectionId: CONN_ID })).resolves.toEqual(GROUPS);

    // The DECRYPTED stored key reached the factory — the whole point of the path.
    expect(factoryCalls).toHaveLength(1);
    expect(factoryCalls[0].secret).toBe(API_KEY);
    // …addressed exactly as the sync loop would address that connection.
    expect(factoryCalls[0].connection.provider).toBe('plane');
    expect(factoryCalls[0].connection.base_url).toBe('https://plane.acme.dev');
    expect(factoryCalls[0].connection.workspace_id).toBe('acme-slug');
    expect(adapter.calls).toEqual(['listGroups']);
  });

  it('resolves the stored key for the states + issues probes too', async () => {
    makeConnection();
    adapter.issues = [makeIssue()];

    await expect(service.wizardStates({ connectionId: CONN_ID }, SOURCE)).resolves.toEqual(STATES);
    await expect(service.wizardIssues({ connectionId: CONN_ID }, SOURCE)).resolves.toHaveLength(1);
    await expect(service.wizardFieldOptions({ connectionId: CONN_ID })).resolves.toMatchObject({
      categories: null,
    });

    expect(factoryCalls.map((call) => call.secret)).toEqual([API_KEY, API_KEY, API_KEY]);
  });

  it('reports a DISCONNECTED connection as not-found — its key was deliberately cleared', async () => {
    // Not an auth failure: `disconnect` clears the ciphertext on purpose, so
    // there is no key to reuse and nothing the user could re-authorize here.
    makeConnection({ status: 'disconnected', secret_ciphertext: null });

    await expect(service.wizardGroups({ connectionId: CONN_ID })).rejects.toMatchObject({
      name: 'TrackerConnectionNotFoundError',
    });
    expect(factoryCalls).toHaveLength(0);
  });

  it('reports an unknown connection id as not-found', async () => {
    await expect(service.wizardGroups({ connectionId: 'conn-nope' })).rejects.toMatchObject({
      name: 'TrackerConnectionNotFoundError',
    });
  });

  it('reports a live row with NO stored key as an auth failure (paste a fresh one)', async () => {
    // UNAUTHORIZED rather than NOT_FOUND: the connection exists and the fix is a
    // new key, which is exactly what the router's auth mapping tells the user.
    makeConnection({ secret_ciphertext: null });

    await expect(service.wizardGroups({ connectionId: CONN_ID })).rejects.toBeInstanceOf(
      TrackerAuthError,
    );
  });

  it('refuses a source carrying BOTH keys or NEITHER', async () => {
    makeConnection();

    await expect(
      service.wizardGroups({ credentials: CREDENTIALS, connectionId: CONN_ID }),
    ).rejects.toThrow(/exactly one of credentials \/ connectionId/);
    await expect(service.wizardGroups({})).rejects.toThrow(
      /exactly one of credentials \/ connectionId/,
    );
    expect(factoryCalls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// connect
// ---------------------------------------------------------------------------

describe('TrackerSyncService.connect', () => {
  it('writes the row + encrypted secret, applies reconcile decisions, and kicks the first pass', async () => {
    const keepId = await createEntity('idea', { title: 'Keep me' });
    const linkId = await createEntity('idea', { title: 'Link me' });
    const discardId = await createEntity('idea', { title: 'Discard me' });

    const { connectionId } = await service.connect(
      connectPayload({
        reconcile: [
          { entityType: 'idea', entityId: keepId, action: 'keep' },
          { entityType: 'idea', entityId: linkId, action: 'link', linkExternalId: 'ext-42' },
          { entityType: 'idea', entityId: discardId, action: 'discard' },
        ],
      }),
    );

    const row = getConnection(raw, connectionId);
    expect(row).not.toBeNull();
    expect(row?.project_id).toBe(PROJECT_ID);
    expect(row?.provider).toBe('linear');
    expect(row?.status).toBe('active');
    // Workspace identity comes from the LIVE probe, not from the payload.
    expect(row?.workspace_id).toBe('ws-1');
    expect(row?.workspace_name).toBe('Acme');
    expect(row?.actor_label).toBe('K. Esteva');
    expect(row?.status_sync_mode).toBe('auto');
    expect(row?.pull_mode).toBe('auto');
    expect(row?.push_mode).toBe('auto');
    // This payload omits every Phase-6 field — both modes default to 'off'
    // (the write-back-declined state) and both mappings default to the seed.
    expect(row?.content_sync_mode).toBe('off');
    expect(row?.archive_sync_mode).toBe('off');
    expect(row?.priority_mapping_json).toBe('{}');
    expect(row?.category_mapping_json).toBe('{}');
    expect(row?.mirror_subissues).toBe(1);
    expect(row?.conflict_mode).toBe('auto');
    expect(JSON.parse(row?.source_json ?? '{}')).toEqual({ ...SOURCE, label: 'Core · Whole team' });
    expect(JSON.parse(row?.state_mapping_json ?? '{}')).toEqual({
      'state-backlog': 'idea',
      'state-done': 'done',
    });

    // The key is stored ENCRYPTED (the mocked transform is reversible).
    const cipher = readSecret(raw, connectionId);
    expect(cipher).not.toBeNull();
    expect((cipher as Buffer).toString('utf-8')).toBe(API_KEY);

    // link -> a link row with NO baseline (the first inbound pass adopts one).
    const link = raw
      .prepare('SELECT * FROM entity_external_links WHERE entity_id = ?')
      .get(linkId) as EntityExternalLinkRow | undefined;
    expect(link?.external_id).toBe('ext-42');
    expect(link?.connection_id).toBe(connectionId);
    expect(link?.baseline_json).toBeNull();

    // discard -> archived IN PLACE; keep -> untouched, and never linked.
    expect(readIdea(discardId).archived_at).not.toBeNull();
    expect(readIdea(keepId).archived_at).toBeNull();
    const keepLink = raw
      .prepare('SELECT * FROM entity_external_links WHERE entity_id = ?')
      .get(keepId);
    expect(keepLink).toBeUndefined();

    // The connect broadcast lands immediately; the fire-and-forget first pass
    // stamps last_sync_at and broadcasts 'sync' a tick later.
    expect(broadcasts.some((e) => e.kind === 'connection' && e.connectionId === connectionId)).toBe(
      true,
    );
    await vi.waitFor(() => {
      expect(getConnection(raw, connectionId)?.last_sync_at).not.toBeNull();
    });
    expect(adapter.calls).toContain('listIssues');
    expect(broadcasts.some((e) => e.kind === 'sync')).toBe(true);
  });

  it('persists a priorityMapping/categoryMapping overlay verbatim, and defaults to the seed without one', async () => {
    // Dart, not the fixture's default Linear: category sync is Dart-only
    // (categoryMapping.ts's providerSupportsCategorySync), so only a Dart row's
    // overlay survives resolveEffectiveCategoryMapping's provider gate.
    const { connectionId } = await service.connect(
      connectPayload({
        credentials: { provider: 'dart', apiKey: API_KEY },
        priorityMapping: { toProvider: { P0: 'urgent', P6: null } },
        categoryMapping: { toProvider: { bug: 'Bug' } },
      }),
    );

    const row = getConnection(raw, connectionId);
    expect(JSON.parse(row?.priority_mapping_json ?? '{}')).toEqual({
      toProvider: { P0: 'urgent', P6: null },
    });
    expect(JSON.parse(row?.category_mapping_json ?? '{}')).toEqual({ toProvider: { bug: 'Bug' } });

    // An overlay actually changes what the connection's SUMMARY reports —
    // proof the persisted JSON round-trips through resolveEffective*Mapping,
    // not just that the literal bytes match.
    const [summary] = await service.connections(PROJECT_ID);
    expect(summary.priorityMapping.toProvider.P0).toBe('urgent');
    expect(summary.categoryMapping.toProvider.bug).toBe('Bug');
  });

  it('writes nothing at all when the live credential probe fails', async () => {
    // The probe precedes the durable anchor (row + secret), which itself
    // precedes every reconcile decision — so a bad key leaves no connection row
    // AND no archived entity behind.
    const discardId = await createEntity('idea', { title: 'Discard me' });
    adapter.failValidate = new TrackerAuthError('linear', 'invalid API key', 401);

    await expect(
      service.connect(
        connectPayload({
          reconcile: [{ entityType: 'idea', entityId: discardId, action: 'discard' }],
        }),
      ),
    ).rejects.toBeInstanceOf(TrackerAuthError);

    const rows = raw.prepare('SELECT COUNT(*) AS n FROM tracker_connections').get() as { n: number };
    expect(rows.n).toBe(0);
    expect(readIdea(discardId).archived_at).toBeNull();
  });

  it('keeps the connection when one reconcile discard is rejected, and applies the rest', async () => {
    // The regression: discards used to be committed BEFORE the connection row
    // existed, so a rejection midway through archived the earlier entities and
    // then failed the connect — user data mutated, nothing to sync it with.
    const first = await createEntity('idea', { title: 'Discard one' });
    const rejected = await createEntity('idea', { title: 'Discard two' });
    const third = await createEntity('idea', { title: 'Discard three' });

    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    // A chokepoint that refuses exactly one of the three archives (an active run
    // on the entity is the real-world shape of this rejection).
    const guarded: EntityWriteRouter = {
      applyChange: async (projectId, change) => {
        if (change.taskId === rejected) throw new Error('an active run holds this entity');
        return router.applyChange(projectId, change);
      },
    };
    const guardedService = new TrackerSyncService({
      db: raw,
      router: guarded,
      nowIso: () => '2026-07-30T12:00:00.000Z',
      adapterFactory: () => adapter,
      logger,
    });

    const { connectionId } = await guardedService.connect(
      connectPayload({
        reconcile: [
          { entityType: 'idea', entityId: first, action: 'discard' },
          { entityType: 'idea', entityId: rejected, action: 'discard' },
          { entityType: 'idea', entityId: third, action: 'discard' },
        ],
      }),
    );

    // The connection the user just authorized survives, key included.
    expect(getConnection(raw, connectionId)?.status).toBe('active');
    expect((readSecret(raw, connectionId) as Buffer).toString('utf-8')).toBe(API_KEY);

    // Every OTHER decision still landed — one rejected row does not halt the loop.
    expect(readIdea(first).archived_at).not.toBeNull();
    expect(readIdea(rejected).archived_at).toBeNull();
    expect(readIdea(third).archived_at).not.toBeNull();
    expect(logger.error).toHaveBeenCalledWith(
      '[trackerSync] reconcile discard failed',
      expect.objectContaining({ connectionId, entityId: rejected }),
    );

    // And the connection is live: the fire-and-forget first pass runs.
    await vi.waitFor(() => {
      expect(getConnection(raw, connectionId)?.last_sync_at).not.toBeNull();
    });
  });

  it('SKIPS a reconcile decision naming an entity from another project, and applies the rest', async () => {
    // A wizard submission is a payload of bare entity ids, and it can be minutes
    // stale — composed against one project, submitted after the user switched.
    // Neither the archive nor upsertLink checks project membership on its own,
    // so an id from project B applied under a project-A connection silently
    // archived B's idea, or hung a live link (and therefore inbound mutations,
    // and write-back) off an entity outside this connection's project.
    raw
      .prepare('INSERT INTO projects (id, name, path) VALUES (?, ?, ?)')
      .run(2, 'Proj 2', '/tmp/p2');
    svc.seedDefaultBoard(2);
    const { taskId: foreignDiscard } = await router.applyChange(2, {
      actor: 'user',
      entityType: 'idea',
      title: 'Another project’s idea',
      body: null,
    });
    const { taskId: foreignLink } = await router.applyChange(2, {
      actor: 'user',
      entityType: 'idea',
      title: 'Another project’s second idea',
      body: null,
    });
    const mine = await createEntity('idea', { title: 'Mine to discard' });

    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    const guardedService = new TrackerSyncService({
      db: raw,
      router,
      nowIso: () => now,
      adapterFactory: () => adapter,
      logger,
    });

    const { connectionId } = await guardedService.connect(
      connectPayload({
        reconcile: [
          { entityType: 'idea', entityId: foreignDiscard, action: 'discard' },
          { entityType: 'idea', entityId: foreignLink, action: 'link', linkExternalId: 'ext-42' },
          { entityType: 'idea', entityId: mine, action: 'discard' },
          // A dangling id is the same answer: not something this connection may act on.
          { entityType: 'idea', entityId: 'ide_does_not_exist', action: 'discard' },
        ],
      }),
    );

    // Untouched, and specifically NOT linked — the corruption this prevents.
    expect(readIdea(foreignDiscard).archived_at).toBeNull();
    expect(
      raw.prepare('SELECT * FROM entity_external_links WHERE entity_id = ?').get(foreignLink),
    ).toBeUndefined();
    // The in-project decision still applied.
    expect(readIdea(mine).archived_at).not.toBeNull();

    expect(logger.error).toHaveBeenCalledWith(
      '[trackerSync] reconcile decisions skipped — entity is not in this project',
      expect.objectContaining({ connectionId, projectId: PROJECT_ID }),
    );
    // …and it is visible where the user looks, not only in a log file.
    await vi.waitFor(() => {
      const log = getConnection(raw, connectionId)?.last_sync_log_json ?? '[]';
      expect(log).toContain('reconcile rows skipped · not in this project');
    });
  });

  it('REVIVES the disconnected connection for the same workspace instead of duplicating the backlog', async () => {
    // The regression: disconnect deliberately KEEPS the links, but connect used
    // to always mint a fresh id — so a routine credential rotation (disconnect,
    // paste a new key, connect) stranded every link on the dead connection and
    // re-imported the entire synced backlog as brand-new ideas.
    adapter.issues = [makeIssue()];

    const first = await service.connect(connectPayload());
    await vi.waitFor(() => {
      expect(getConnection(raw, first.connectionId)?.last_sync_at).not.toBeNull();
    });
    const importedId = importedIdeaId();
    const link = getLinkByExternal(raw, first.connectionId, 'ext-1');
    expect(link?.entity_id).toBe(importedId);

    await service.disconnect(first.connectionId);
    const second = await service.connect(connectPayload());

    // Same row, re-armed — not a second connection.
    expect(second.connectionId).toBe(first.connectionId);
    const count = raw.prepare('SELECT COUNT(*) AS n FROM tracker_connections').get() as { n: number };
    expect(count.n).toBe(1);
    const revived = getConnection(raw, first.connectionId);
    expect(revived?.status).toBe('active');
    expect((readSecret(raw, first.connectionId) as Buffer).toString('utf-8')).toBe(API_KEY);

    // The link survived the round trip and still points at the same idea.
    const relinked = getLinkByExternal(raw, first.connectionId, 'ext-1');
    expect(relinked?.id).toBe(link?.id);
    expect(relinked?.entity_id).toBe(importedId);

    // ...so the pass the reconnect kicks MERGES the same remote issue against
    // that link (a no-op diff) instead of importing a duplicate idea.
    await vi.waitFor(() => {
      expect(getConnection(raw, first.connectionId)?.last_sync_at).not.toBeNull();
    });
    expect(importedIdeaId()).toBe(importedId);
  });

  it('still mints a NEW connection when the workspace identity differs', async () => {
    const first = await service.connect(connectPayload());
    await service.disconnect(first.connectionId);

    // A different Linear organization is a different connection, links and all.
    adapter.workspaceId = 'ws-2';
    const second = await service.connect(connectPayload());

    expect(second.connectionId).not.toBe(first.connectionId);
    expect(getConnection(raw, first.connectionId)?.status).toBe('disconnected');
    expect(getConnection(raw, second.connectionId)?.status).toBe('active');
  });

  /** Plane credentials for a given instance — the workspace slug stays constant. */
  function planeCredentials(baseUrl: string | undefined): TrackerCredentialsInput {
    return {
      provider: 'plane',
      apiKey: API_KEY,
      workspaceSlug: 'acme',
      ...(baseUrl !== undefined ? { baseUrl } : {}),
    };
  }

  it('mints a NEW connection when the same workspace slug lives on a DIFFERENT instance', async () => {
    // The regression: the revival key was (project, provider, workspace_id), but
    // a Plane workspace slug is unique only within ONE deployment. Reviving here
    // would rewrite base_url while KEEPING every link, so write-back would target
    // issue ids that belong to the other instance and the deletion sweep would
    // read its 404s as remote deletions.
    const first = await service.connect(
      connectPayload({ credentials: planeCredentials('https://plane.a.example') }),
    );
    await service.disconnect(first.connectionId);

    const second = await service.connect(
      connectPayload({ credentials: planeCredentials('https://plane.b.example') }),
    );

    expect(second.connectionId).not.toBe(first.connectionId);
    // The retired row keeps its links; nothing reads them while it is retired.
    expect(getConnection(raw, first.connectionId)?.status).toBe('disconnected');
    expect(getConnection(raw, first.connectionId)?.base_url).toBe('https://plane.a.example');
    expect(getConnection(raw, second.connectionId)?.base_url).toBe('https://plane.b.example');
  });

  it('still REVIVES when the base URL differs only by a trailing slash', async () => {
    const first = await service.connect(
      connectPayload({ credentials: planeCredentials('https://plane.a.example') }),
    );
    await service.disconnect(first.connectionId);

    const second = await service.connect(
      connectPayload({ credentials: planeCredentials('https://plane.a.example/') }),
    );

    expect(second.connectionId).toBe(first.connectionId);
    const count = raw.prepare('SELECT COUNT(*) AS n FROM tracker_connections').get() as { n: number };
    expect(count.n).toBe(1);
  });

  it('still REVIVES a Plane CLOUD connection whose base URL was left implicit', async () => {
    // The wizard pre-fills the cloud origin, so one life of the same cloud
    // connection can hold the literal string and the next a NULL.
    const first = await service.connect(
      connectPayload({ credentials: planeCredentials('https://api.plane.so') }),
    );
    await service.disconnect(first.connectionId);

    const second = await service.connect(connectPayload({ credentials: planeCredentials(undefined) }));

    expect(second.connectionId).toBe(first.connectionId);
    expect(getConnection(raw, first.connectionId)?.base_url).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// connections()
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// updateCredentials — rotating a key in place
// ---------------------------------------------------------------------------

describe('TrackerSyncService.connect — multi-project mapping', () => {
  it('is an IDEMPOTENT no-op when this exact mapping is already connected', async () => {
    // The Map step connects one mapping at a time and offers a retry, so a
    // partially-failed submit re-runs the mappings that already succeeded.
    const discardId = await createEntity('idea', { title: 'Discard me' });
    const first = await service.connect(
      connectPayload({
        reconcile: [{ entityType: 'idea', entityId: discardId, action: 'discard' }],
      }),
    );
    // Restoring it proves the second call does not re-apply the decisions.
    await router.applyChange(PROJECT_ID, {
      actor: 'user',
      entityType: 'idea',
      taskId: discardId,
      archived: false,
    });

    const again = await service.connect(
      connectPayload({
        reconcile: [{ entityType: 'idea', entityId: discardId, action: 'discard' }],
      }),
    );

    expect(again.connectionId).toBe(first.connectionId);
    const rows = raw.prepare('SELECT COUNT(*) AS n FROM tracker_connections').get() as { n: number };
    expect(rows.n).toBe(1);
    expect(readIdea(discardId).archived_at).toBeNull();
  });

  it('mints a SIBLING row for a different source container in the same project', async () => {
    const first = await service.connect(connectPayload());
    const second = await service.connect(
      connectPayload({
        source: { containerId: 'team-2', narrowId: 'all', narrowKind: 'all' },
        sourceLabel: 'Web · Whole team',
        // Only one row per provider may push, or one filed idea becomes two
        // tracker issues.
        pushTarget: false,
      }),
    );

    expect(second.connectionId).not.toBe(first.connectionId);
    expect(getConnection(raw, first.connectionId)?.push_target).toBe(1);
    expect(getConnection(raw, second.connectionId)?.push_target).toBe(0);
  });

  it('defaults push_target to 1 when the payload omits it (every pre-rev-4 connect)', async () => {
    const { connectionId } = await service.connect(connectPayload());
    expect(getConnection(raw, connectionId)?.push_target).toBe(1);
  });

  it('mints a SECOND row for two groups that differ only in the NARROW under one container', async () => {
    // The defect: the idempotent no-op matched on `containerId` alone, but every
    // Linear project group under one team carries the TEAM's container and
    // differs only in the narrow — so mapping a team's second project group was
    // swallowed as a re-submit of the first, and the user's second mapping
    // silently never existed.
    const first = await service.connect(connectPayload());
    const second = await service.connect(
      connectPayload({
        source: { containerId: 'team-1', narrowId: 'proj-1', narrowKind: 'project' },
        sourceLabel: 'Platform · Core',
        pushTarget: false,
      }),
    );

    expect(second.connectionId).not.toBe(first.connectionId);
    const scopes = raw
      .prepare('SELECT id, source_json FROM tracker_connections ORDER BY rowid ASC')
      .all() as Array<{ id: string; source_json: string }>;
    expect(scopes.map((r) => r.id)).toEqual([first.connectionId, second.connectionId]);
    expect(scopes.map((r) => (JSON.parse(r.source_json) as TrackerSourceSelection).narrowId)).toEqual(
      ['all', 'proj-1'],
    );
  });

  it('a re-submit carrying pushTarget:false DEMOTES the mapping the earlier submit armed', async () => {
    // The defect: the no-op path returned before applying anything, so a retry
    // after re-picking the push target in the Map step dropped the new choice.
    const first = await service.connect(connectPayload());
    expect(getConnection(raw, first.connectionId)?.push_target).toBe(1);

    await service.connect(connectPayload({ pushTarget: false }));

    expect(getConnection(raw, first.connectionId)?.push_target).toBe(0);
  });

  it('a re-submit that CLAIMS the push target demotes the armed sibling of the same project', async () => {
    // Same dropped choice, the other direction: promoting a sibling has to
    // demote whoever held the flag, or one filed idea becomes two remote issues.
    const armed = await service.connect(connectPayload());
    const quiet = await service.connect(
      connectPayload({
        source: { containerId: 'team-2', narrowId: 'all', narrowKind: 'all' },
        sourceLabel: 'Web · Whole team',
        pushTarget: false,
      }),
    );

    await service.connect(
      connectPayload({
        source: { containerId: 'team-2', narrowId: 'all', narrowKind: 'all' },
        sourceLabel: 'Web · Whole team',
      }),
    );

    expect(getConnection(raw, quiet.connectionId)?.push_target).toBe(1);
    expect(getConnection(raw, armed.connectionId)?.push_target).toBe(0);
  });

  it('a NEW mapping that claims the push target demotes the row an EARLIER wizard run armed', async () => {
    // The mint path's half of the same invariant: a later run mapping a second
    // group into an already-mapped project arrives with its own run's cluster
    // default (armed) while the earlier row is still armed.
    const first = await service.connect(connectPayload());
    const second = await service.connect(
      connectPayload({
        source: { containerId: 'team-2', narrowId: 'all', narrowKind: 'all' },
        sourceLabel: 'Web · Whole team',
      }),
    );

    expect(getConnection(raw, second.connectionId)?.push_target).toBe(1);
    expect(getConnection(raw, first.connectionId)?.push_target).toBe(0);
  });

  it('a re-submit of a PAUSED mapping resumes it on the freshly-validated key', async () => {
    // The defect: the no-op path returned the id without storing the key or
    // touching the status, so the one thing a re-connect is FOR — a mapping
    // paused on a stale key — was the one thing it could not fix.
    makeConnection({ status: 'paused' });

    const again = await service.connect(
      connectPayload({ credentials: { provider: 'linear', apiKey: 'lin_rotated_key' } }),
    );

    expect(again.connectionId).toBe(CONN_ID);
    const rows = raw.prepare('SELECT COUNT(*) AS n FROM tracker_connections').get() as { n: number };
    expect(rows.n).toBe(1);
    expect(getConnection(raw, CONN_ID)?.status).toBe('active');
    expect((readSecret(raw, CONN_ID) as Buffer).toString('utf-8')).toBe('lin_rotated_key');
    expect(broadcasts.some((e) => e.kind === 'connection' && e.connectionId === CONN_ID)).toBe(true);
    // …and the pass the resume kicks actually runs, which is what replays every
    // write the auth failure held.
    await vi.waitFor(() => {
      expect(getConnection(raw, CONN_ID)?.last_sync_at).not.toBeNull();
    });
  });
});

// ---------------------------------------------------------------------------
// connect on a BORROWED key — mapping management adding a group to a
// connection the user already authorized.
// ---------------------------------------------------------------------------

describe('TrackerSyncService.connect — sourceConnectionId', () => {
  it('mints a sibling on the stored key, with its own copy of the secret', async () => {
    makeConnection();

    const { connectionId } = await service.connect(
      connectPayload({
        credentials: undefined,
        sourceConnectionId: CONN_ID,
        source: { containerId: 'team-2', narrowId: 'all', narrowKind: 'all' },
        sourceLabel: 'Web · Whole team',
        pushTarget: false,
      }),
    );

    expect(connectionId).not.toBe(CONN_ID);
    const row = getConnection(raw, connectionId);
    // The SAME tracker identity — that is what makes the two rows siblings, and
    // what a credential rotation later fans out across.
    expect(row?.provider).toBe('linear');
    expect(row?.workspace_id).toBe('ws-1');
    expect(row?.base_url).toBeNull();
    expect(row?.status).toBe('active');
    // Its OWN stored ciphertext, not a pointer at the lender's: each row carries
    // the key it syncs with, exactly as a pasted-key connect leaves it.
    expect((readSecret(raw, connectionId) as Buffer).toString('utf-8')).toBe(API_KEY);
    // The borrowed key was still PROBED live before anything was written.
    expect(adapter.calls).toContain('validateCredentials');
    expect(factoryCalls.some((call) => call.secret === API_KEY)).toBe(true);
  });

  it('leaves claimPushTarget semantics untouched — the new mapping demotes the armed sibling', async () => {
    // Nothing about the key's PROVENANCE may change what connect does with it:
    // a borrowed-key mint arrives armed by default like any other, and the
    // one-pusher-per-(project, provider) invariant still holds across the pair.
    makeConnection();
    expect(getConnection(raw, CONN_ID)?.push_target).toBe(1);

    const { connectionId } = await service.connect(
      connectPayload({
        credentials: undefined,
        sourceConnectionId: CONN_ID,
        source: { containerId: 'team-2', narrowId: 'all', narrowKind: 'all' },
        sourceLabel: 'Web · Whole team',
      }),
    );

    expect(getConnection(raw, connectionId)?.push_target).toBe(1);
    expect(getConnection(raw, CONN_ID)?.push_target).toBe(0);
  });

  it('maps a group into ANOTHER project on the same authorization', async () => {
    makeConnection();
    addProject(2);

    const { connectionId } = await service.connect(
      connectPayload({
        projectId: 2,
        credentials: undefined,
        sourceConnectionId: CONN_ID,
        source: { containerId: 'team-2', narrowId: 'all', narrowKind: 'all' },
        sourceLabel: 'Web · Whole team',
      }),
    );

    expect(getConnection(raw, connectionId)?.project_id).toBe(2);
    // Different project, so the pair's own pusher — the lender keeps its flag.
    expect(getConnection(raw, connectionId)?.push_target).toBe(1);
    expect(getConnection(raw, CONN_ID)?.push_target).toBe(1);
  });

  it('refuses a payload carrying BOTH a key and a source connection, or NEITHER', async () => {
    makeConnection();

    await expect(
      service.connect(connectPayload({ sourceConnectionId: CONN_ID })),
    ).rejects.toThrow(/exactly one of credentials \/ connectionId/);
    await expect(service.connect(connectPayload({ credentials: undefined }))).rejects.toThrow(
      /exactly one of credentials \/ connectionId/,
    );
    // Nothing was probed and nothing was written.
    expect(adapter.calls).toHaveLength(0);
    const rows = raw.prepare('SELECT COUNT(*) AS n FROM tracker_connections').get() as { n: number };
    expect(rows.n).toBe(1);
  });

  it('reports a retired source connection as not-found before probing anything', async () => {
    makeConnection({ status: 'disconnected', secret_ciphertext: null });

    await expect(
      service.connect(connectPayload({ credentials: undefined, sourceConnectionId: CONN_ID })),
    ).rejects.toMatchObject({ name: 'TrackerConnectionNotFoundError' });
    expect(adapter.calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// mappings() — one authorization's sibling rows, ACROSS projects
// ---------------------------------------------------------------------------

describe('TrackerSyncService.mappings', () => {
  it('returns every live sibling of the identity, across projects, and no stranger', async () => {
    makeConnection();
    addProject(2);
    makeConnection({
      id: 'conn-p2',
      project_id: 2,
      source_json: JSON.stringify({
        containerId: 'team-2',
        narrowId: 'all',
        narrowKind: 'all',
        label: 'Web · Whole team',
      }),
      push_target: 1,
    });
    // Same workspace string, DIFFERENT provider: not this authorization's row.
    makeConnection({ id: 'conn-dart', provider: 'dart' });

    const rows = await service.mappings(CONN_ID);

    expect(rows.map((row) => row.id)).toEqual([CONN_ID, 'conn-p2']);
    expect(rows.map((row) => row.projectId)).toEqual([PROJECT_ID, 2]);
    // A sibling in another project is exactly what `connections(projectId)`
    // structurally cannot return — the reason this method exists.
    expect((await service.connections(PROJECT_ID)).map((row) => row.id)).toEqual([
      CONN_ID,
      'conn-dart',
    ]);
  });

  it('carries each mapping’s source SCOPE, which is what distinguishes the siblings', async () => {
    makeConnection();
    makeConnection({
      id: 'conn-proj',
      push_target: 0,
      source_json: JSON.stringify({
        containerId: 'team-1',
        narrowId: 'proj-1',
        narrowKind: 'project',
        label: 'Platform · Core',
      }),
    });
    // A legacy row with no recorded source at all.
    makeConnection({ id: 'conn-legacy', push_target: 0, source_json: null });

    const scopes = new Map(
      (await service.mappings(CONN_ID)).map((row) => [row.id, row.sourceScope] as const),
    );

    expect(scopes.get(CONN_ID)).toEqual({
      containerId: 'team-1',
      narrowId: 'all',
      narrowKind: 'all',
    });
    // Same container, different narrow — two mappings, not one.
    expect(scopes.get('conn-proj')).toEqual({
      containerId: 'team-1',
      narrowId: 'proj-1',
      narrowKind: 'project',
    });
    expect(scopes.get('conn-legacy')).toBeNull();
  });

  it('answers for a DISCONNECTED row by leading the list with it', async () => {
    // listConnectionsByIdentity skips retired rows on purpose (a rotation must
    // not re-arm one), but a user who navigated to this connection is owed its
    // own card back.
    makeConnection();
    makeConnection({ id: 'conn-retired', status: 'disconnected', secret_ciphertext: null });

    const rows = await service.mappings('conn-retired');

    expect(rows.map((row) => row.id)).toEqual(['conn-retired', CONN_ID]);
    expect(rows[0].status).toBe('disconnected');
  });

  it('is a set of exactly itself when the row never recorded a workspace identity', async () => {
    makeConnection({ workspace_id: null });
    makeConnection({ id: 'conn-two', workspace_id: null, push_target: 0 });

    // An identity we never learned cannot be claimed BY identity, so these two
    // rows are not siblings of each other however alike they look.
    expect((await service.mappings(CONN_ID)).map((row) => row.id)).toEqual([CONN_ID]);
  });

  it('reports an unknown connection id as a typed not-found', async () => {
    await expect(service.mappings('conn-nope')).rejects.toMatchObject({
      name: 'TrackerConnectionNotFoundError',
    });
  });
});

// ---------------------------------------------------------------------------
// setPushTarget() — re-picking which mapping files new ideas
// ---------------------------------------------------------------------------

describe('TrackerSyncService.setPushTarget', () => {
  it('arms the named mapping, demotes its same-(project, provider) sibling, and broadcasts', async () => {
    makeConnection();
    makeConnection({
      id: 'conn-two',
      push_target: 0,
      source_json: JSON.stringify({ containerId: 'team-2', narrowId: 'all', narrowKind: 'all' }),
    });

    await service.setPushTarget('conn-two');

    expect(getConnection(raw, 'conn-two')?.push_target).toBe(1);
    expect(getConnection(raw, CONN_ID)?.push_target).toBe(0);
    expect(broadcasts).toContainEqual({
      projectId: PROJECT_ID,
      connectionId: 'conn-two',
      kind: 'connection',
    });
  });

  it('leaves another PROJECT’s mapping armed — the invariant is per (project, provider)', async () => {
    makeConnection();
    addProject(2);
    makeConnection({ id: 'conn-p2', project_id: 2, push_target: 1 });

    await service.setPushTarget(CONN_ID);

    expect(getConnection(raw, CONN_ID)?.push_target).toBe(1);
    expect(getConnection(raw, 'conn-p2')?.push_target).toBe(1);
  });

  it('refuses an unknown or DISCONNECTED connection id', async () => {
    // Arming a retired row would leave the project with no LIVE pusher at all.
    makeConnection();
    makeConnection({ id: 'conn-retired', status: 'disconnected', secret_ciphertext: null });

    await expect(service.setPushTarget('conn-nope')).rejects.toMatchObject({
      name: 'TrackerConnectionNotFoundError',
    });
    await expect(service.setPushTarget('conn-retired')).rejects.toMatchObject({
      name: 'TrackerConnectionNotFoundError',
    });
    expect(getConnection(raw, CONN_ID)?.push_target).toBe(1);
  });

  it('refuses to move the role off an ACTIVE pusher onto a PAUSED row', async () => {
    // A paused row enqueues nothing (write-back skips on status before
    // push_target) and creates are never back-filled, so accepting the swap
    // would silently drop every idea filed until the row reconnects.
    makeConnection();
    makeConnection({
      id: 'conn-paused',
      status: 'paused',
      push_target: 0,
      source_json: JSON.stringify({ containerId: 'team-2', narrowId: 'all', narrowKind: 'all' }),
    });

    await expect(service.setPushTarget('conn-paused')).rejects.toMatchObject({
      name: 'TrackerConnectionPausedError',
    });
    // The working pusher kept the role.
    expect(getConnection(raw, CONN_ID)?.push_target).toBe(1);
    expect(getConnection(raw, 'conn-paused')?.push_target).toBe(0);
  });

  it('allows PRE-DESIGNATING a paused row when nothing in the pair is active', async () => {
    // The all-paused-after-key-expiry case: a hard refusal would trap the user.
    // The arm costs nothing now and takes effect the moment a fresh key lands.
    makeConnection({ status: 'paused' });
    makeConnection({
      id: 'conn-paused-2',
      status: 'paused',
      push_target: 0,
      source_json: JSON.stringify({ containerId: 'team-2', narrowId: 'all', narrowKind: 'all' }),
    });

    await service.setPushTarget('conn-paused-2');

    expect(getConnection(raw, 'conn-paused-2')?.push_target).toBe(1);
    expect(getConnection(raw, CONN_ID)?.push_target).toBe(0);
  });
});

describe('TrackerSyncService.updateCredentials', () => {
  it('probes, stores encrypted, RESUMES a paused connection, and kicks a pass', async () => {
    // The reconnect path `connect` cannot serve: against a connection that is
    // still active or paused it mints a SECOND one, strands every link on the
    // first, and re-imports the whole synced backlog as fresh ideas.
    makeConnection({ status: 'paused' });

    const identity = await service.updateCredentials(CONN_ID, 'lin_rotated_key');

    expect(identity).toEqual({
      workspaceId: 'ws-1',
      workspaceName: 'Acme',
      actorLabel: 'K. Esteva',
    });
    // The key was PROBED before anything was written…
    expect(adapter.calls).toContain('validateCredentials');
    expect(factoryCalls.some((call) => call.secret === 'lin_rotated_key')).toBe(true);
    // …stored encrypted, never in the clear…
    expect((readSecret(raw, CONN_ID) as Buffer).toString('utf-8')).toBe('lin_rotated_key');
    // …and the connection is live again, which is what un-gates the poll loop
    // and replays every write the auth failure held.
    const row = getConnection(raw, CONN_ID);
    expect(row?.status).toBe('active');
    expect(row?.actor_label).toBe('K. Esteva');
    expect(broadcasts.some((e) => e.kind === 'connection' && e.connectionId === CONN_ID)).toBe(true);

    await vi.waitFor(() => {
      expect(getConnection(raw, CONN_ID)?.last_sync_at).not.toBeNull();
    });
  });

  it('REFUSES a key for a different workspace, leaving the connection paused and the old key intact', async () => {
    // Storing it would leave every retained link pointing at external ids that
    // belong to somebody else's workspace: write-back would target strangers'
    // issues, and the deletion sweep would read their absence as deletions and
    // archive live local entities.
    makeConnection({ status: 'paused' });
    adapter.workspaceId = 'ws-somebody-else';

    await expect(service.updateCredentials(CONN_ID, 'lin_other_workspace')).rejects.toMatchObject({
      name: 'TrackerIdentityMismatchError',
    });
    await expect(service.updateCredentials(CONN_ID, 'lin_other_workspace')).rejects.toThrow(
      /different workspace/i,
    );

    const row = getConnection(raw, CONN_ID);
    expect(row?.status).toBe('paused');
    expect(row?.workspace_id).toBe('ws-1');
    // The stored key is untouched — a refused rotation changes nothing.
    expect((readSecret(raw, CONN_ID) as Buffer).toString('utf-8')).toBe(API_KEY);
  });

  it('propagates the provider’s auth rejection without touching the connection', async () => {
    makeConnection({ status: 'paused' });
    adapter.failValidate = new TrackerAuthError('linear', 'invalid api key', 401);

    await expect(service.updateCredentials(CONN_ID, 'still_bad')).rejects.toBeInstanceOf(
      TrackerAuthError,
    );
    expect(getConnection(raw, CONN_ID)?.status).toBe('paused');
    expect((readSecret(raw, CONN_ID) as Buffer).toString('utf-8')).toBe(API_KEY);
  });

  it('reports an unknown connection id as a typed not-found', async () => {
    await expect(service.updateCredentials('conn-nope', 'k')).rejects.toMatchObject({
      name: 'TrackerConnectionNotFoundError',
    });
  });

  it('FANS OUT to every sibling mapping sharing the key, and leaves a retired row alone', async () => {
    // One wizard run mints N rows, each holding its own copy of the same key —
    // so rotating only the named one leaves the rest paused on a dead key with
    // no affordance but re-pasting it per mapping.
    makeConnection({ status: 'paused' });
    makeConnection({
      id: 'conn-sibling',
      status: 'paused',
      source_json: JSON.stringify({ containerId: 'team-2', narrowId: 'all', narrowKind: 'all' }),
    });
    // Not a sibling: a DIFFERENT workspace on the same provider.
    makeConnection({ id: 'conn-other-ws', status: 'paused', workspace_id: 'ws-2' });
    // Not a sibling either: retired, and its secret was deliberately cleared.
    makeConnection({ id: 'conn-retired', status: 'disconnected', secret_ciphertext: null });

    await service.updateCredentials(CONN_ID, 'lin_rotated_key');

    for (const id of [CONN_ID, 'conn-sibling']) {
      expect(getConnection(raw, id)?.status).toBe('active');
      expect((readSecret(raw, id) as Buffer).toString('utf-8')).toBe('lin_rotated_key');
    }
    expect(getConnection(raw, 'conn-other-ws')?.status).toBe('paused');
    expect((readSecret(raw, 'conn-other-ws') as Buffer).toString('utf-8')).toBe(API_KEY);
    expect(getConnection(raw, 'conn-retired')?.status).toBe('disconnected');
    expect(readSecret(raw, 'conn-retired')).toBeNull();
  });
});

describe('TrackerSyncService.connections', () => {
  it('summarizes a connection with active-link and open-conflict counts', async () => {
    makeConnection({
      state_mapping_json: JSON.stringify({ 'state-backlog': 'idea', 'state-bogus': 'nonsense' }),
      // A malformed entry mixed into the log: the parse keeps what it can.
      last_sync_log_json: JSON.stringify([{ marker: '✓', line: 'sync complete' }, { nope: 1 }]),
      last_sync_at: '2026-07-30 11:59:00',
    });
    const ideaId = await createEntity('idea', { title: 'Linked idea' });
    const otherId = await createEntity('idea', { title: 'Orphaned idea' });
    const live = upsertLink(raw, {
      connection_id: CONN_ID,
      entity_type: 'idea',
      entity_id: ideaId,
      provider: 'linear',
      external_id: 'ext-1',
    });
    const orphan = upsertLink(raw, {
      connection_id: CONN_ID,
      entity_type: 'idea',
      entity_id: otherId,
      provider: 'linear',
      external_id: 'ext-2',
    });
    raw.prepare(`UPDATE entity_external_links SET orphaned_at = datetime('now') WHERE id = ?`).run(
      orphan.id,
    );
    insertConflict(raw, {
      connection_id: CONN_ID,
      link_id: live.id,
      kind: 'field_conflict',
      field: 'title',
      local_value: 'Ours',
      remote_value: 'Theirs',
    });
    const resolved = insertConflict(raw, {
      connection_id: CONN_ID,
      link_id: live.id,
      kind: 'field_conflict',
      field: 'description',
    });
    raw.prepare(`UPDATE tracker_conflicts SET state = 'resolved' WHERE id = ?`).run(resolved.id);

    const [summary] = await service.connections(PROJECT_ID);

    expect(summary.id).toBe(CONN_ID);
    expect(summary.provider).toBe('linear');
    expect(summary.status).toBe('active');
    expect(summary.workspaceName).toBe('Acme');
    expect(summary.actorLabel).toBe('K. Esteva');
    expect(summary.baseUrl).toBeNull();
    expect(summary.sourceLabel).toBe('Core · Whole team');
    expect(summary.statusSyncMode).toBe('auto');
    expect(summary.pullMode).toBe('auto');
    expect(summary.pushMode).toBe('auto');
    // Every pre-Phase-6 connection carries the write-back-declined default.
    expect(summary.contentSyncMode).toBe('off');
    expect(summary.archiveSyncMode).toBe('off');
    // No overlay stored yet — the resolved mapping is the linear seed, all
    // seven levels present (this fixture's live options are null: no probe
    // ran, matching stateMapping's own no-network-call summary read).
    expect(Object.keys(summary.priorityMapping.toProvider)).toHaveLength(7);
    expect(summary.categoryMapping.toProvider).toEqual({ feature: null, bug: null, chore: null });
    expect(summary.mirrorSubissues).toBe(true);
    expect(summary.conflictMode).toBe('manual');
    expect(summary.pushTarget).toBe(true);
    // The unknown mapping target is dropped, the valid one survives.
    expect(summary.stateMapping).toEqual({ 'state-backlog': 'idea' });
    expect(summary.lastSyncAt).toBe('2026-07-30 11:59:00');
    expect(summary.lastSyncLog).toEqual([{ marker: '✓', line: 'sync complete' }]);
    expect(summary.linkedCount).toBe(1);
    expect(summary.openConflictCount).toBe(1);
  });

  /**
   * `config_generation` is what makes a mapping/selection change re-consider
   * ids the reconciliation ledger has already skipped (migration 123). It is
   * bumped ONCE per patch, and only for the keys that change what is ELIGIBLE
   * — a direction mode changes when work happens, not what qualifies.
   */
  it('bumps config_generation once for a patch that changes what is eligible', async () => {
    makeConnection();
    expect(getConnection(raw, CONN_ID)?.config_generation).toBe(0);

    await service.updateSettings(CONN_ID, {
      stateMapping: { 'state-backlog': 'idea' },
      selectionMode: 'assignee',
      selectionJson: { assigneeIds: ['user-1'] },
    });

    // ONE bump for the whole patch: the ledger's rule is "re-consider every
    // skipped id once per CHANGE", and the change is the patch.
    expect(getConnection(raw, CONN_ID)?.config_generation).toBe(1);
  });

  it('leaves config_generation alone for a direction-only patch', async () => {
    makeConnection();

    await service.updateSettings(CONN_ID, {
      statusSyncMode: 'manual',
      pullMode: 'manual',
      pushMode: 'manual',
      contentSyncMode: 'auto',
      archiveSyncMode: 'manual',
      mirrorSubissues: false,
      conflictMode: 'manual',
    });

    // Nothing about WHICH remote issues qualify changed, so every ledgered skip
    // is still a valid verdict — re-fetching them would be pure cost.
    expect(getConnection(raw, CONN_ID)?.config_generation).toBe(0);
  });

  it('reports a non-pushing sibling mapping as pushTarget false', async () => {
    makeConnection({ push_target: 0 });
    const [summary] = await service.connections(PROJECT_ID);
    expect(summary.pushTarget).toBe(false);
  });

  it('applies a settings patch key-by-key and broadcasts the change', async () => {
    makeConnection();

    await service.updateSettings(CONN_ID, {
      statusSyncMode: 'manual',
      pushMode: 'manual',
      contentSyncMode: 'auto',
      archiveSyncMode: 'manual',
      priorityMapping: { toProvider: { P0: 'urgent' } },
      categoryMapping: { toProvider: { bug: 'Bug' } },
      conflictMode: 'auto',
      selectionMode: 'assignee',
      selectionJson: { assigneeIds: ['user-1'] },
    });

    const row = getConnection(raw, CONN_ID);
    expect(row?.status_sync_mode).toBe('manual');
    expect(row?.push_mode).toBe('manual');
    expect(row?.content_sync_mode).toBe('auto');
    expect(row?.archive_sync_mode).toBe('manual');
    expect(JSON.parse(row?.priority_mapping_json ?? '{}')).toEqual({
      toProvider: { P0: 'urgent' },
    });
    expect(JSON.parse(row?.category_mapping_json ?? '{}')).toEqual({ toProvider: { bug: 'Bug' } });
    // An omitted direction keeps its stored value.
    expect(row?.pull_mode).toBe('auto');
    expect(row?.conflict_mode).toBe('auto');
    expect(row?.selection_mode).toBe('assignee');
    expect(JSON.parse(row?.selection_json ?? '{}')).toEqual({ assigneeIds: ['user-1'] });
    // Untouched keys keep their stored value.
    expect(row?.mirror_subissues).toBe(1);
    expect(broadcasts).toContainEqual({
      projectId: PROJECT_ID,
      connectionId: CONN_ID,
      kind: 'connection',
    });
  });
});

// ---------------------------------------------------------------------------
// disconnect
// ---------------------------------------------------------------------------

describe('TrackerSyncService.disconnect', () => {
  it('marks the connection disconnected, clears the secret, and keeps the links', async () => {
    makeConnection();
    const ideaId = await createEntity('idea', { title: 'Linked idea' });
    upsertLink(raw, {
      connection_id: CONN_ID,
      entity_type: 'idea',
      entity_id: ideaId,
      provider: 'linear',
      external_id: 'ext-1',
    });

    await service.disconnect(CONN_ID);

    expect(getConnection(raw, CONN_ID)?.status).toBe('disconnected');
    expect(readSecret(raw, CONN_ID)).toBeNull();
    const links = raw
      .prepare('SELECT COUNT(*) AS n FROM entity_external_links WHERE connection_id = ?')
      .get(CONN_ID) as { n: number };
    expect(links.n).toBe(1);
    // A disconnected connection is no longer a connected-view card.
    await expect(service.connections(PROJECT_ID)).resolves.toEqual([]);
    expect(broadcasts).toContainEqual({
      projectId: PROJECT_ID,
      connectionId: CONN_ID,
      kind: 'connection',
    });
  });

  it('promotes the oldest surviving sibling when the ARMED mapping is removed', async () => {
    // Without the promotion, writeBack.handleIdeaPush (which skips every
    // push_target = 0 row) would file NO new idea for this (project, provider)
    // ever again — silently, with the boot repair structurally blind to it
    // (it only fixes DUPLICATE claims).
    makeConnection(); // CONN_ID, push_target = 1 — the armed pusher
    makeConnection({
      id: 'conn-heir',
      push_target: 0,
      source_json: JSON.stringify({ containerId: 'team-2', narrowId: 'all', narrowKind: 'all' }),
    });
    makeConnection({
      id: 'conn-younger',
      push_target: 0,
      source_json: JSON.stringify({ containerId: 'team-3', narrowId: 'all', narrowKind: 'all' }),
    });
    // NewConnectionRow omits created_at (the store stamps it), so age is forced
    // directly: conn-younger must genuinely postdate conn-heir for the
    // oldest-first assertion to test ordering rather than id tie-break alone.
    raw
      .prepare(`UPDATE tracker_connections SET created_at = '2030-01-01 00:00:00' WHERE id = ?`)
      .run('conn-younger');

    await service.disconnect(CONN_ID);

    // The retired row's stale claim is cleared with it…
    expect(getConnection(raw, CONN_ID)?.push_target).toBe(0);
    // …and the OLDEST survivor inherits the role (same tie-break as boot repair).
    expect(getConnection(raw, 'conn-heir')?.push_target).toBe(1);
    expect(getConnection(raw, 'conn-younger')?.push_target).toBe(0);
    expect(broadcasts).toContainEqual({
      projectId: PROJECT_ID,
      connectionId: 'conn-heir',
      kind: 'connection',
    });
  });

  it('removing a DEMOTED mapping leaves the armed sibling untouched', async () => {
    makeConnection(); // armed
    makeConnection({
      id: 'conn-demoted',
      push_target: 0,
      source_json: JSON.stringify({ containerId: 'team-2', narrowId: 'all', narrowKind: 'all' }),
    });

    await service.disconnect('conn-demoted');

    expect(getConnection(raw, CONN_ID)?.push_target).toBe(1);
    expect(getConnection(raw, 'conn-demoted')?.status).toBe('disconnected');
  });
});

// ---------------------------------------------------------------------------
// Conflicts
// ---------------------------------------------------------------------------

describe('TrackerSyncService conflict resolution', () => {
  /** A manual-mode connection + a linked idea + one open conflict on it. */
  async function seedConflict(
    conflict: {
      kind: TrackerConflictRow['kind'];
      field?: string | null;
      local_value?: string | null;
      remote_value?: string | null;
      payload_json?: string | null;
    },
    idea: { title?: string; body?: string | null } = {},
  ): Promise<{ ideaId: string; link: EntityExternalLinkRow; conflictId: number }> {
    makeConnection();
    const ideaId = await createEntity('idea', {
      title: idea.title ?? 'Local title',
      body: idea.body ?? null,
    });
    const link = upsertLink(raw, {
      connection_id: CONN_ID,
      entity_type: 'idea',
      entity_id: ideaId,
      provider: 'linear',
      external_id: 'ext-1',
      baseline_json: JSON.stringify({
        title: 'Baseline title',
        description: 'Baseline description',
        stateId: 'state-backlog',
        updatedAt: '2026-07-29T10:00:00.000Z',
        lastWrittenGroup: 'started',
      }),
    });
    const row = insertConflict(raw, {
      connection_id: CONN_ID,
      link_id: link.id,
      kind: conflict.kind,
      field: conflict.field ?? null,
      local_value: conflict.local_value ?? null,
      remote_value: conflict.remote_value ?? null,
      payload_json: conflict.payload_json ?? null,
    });
    return { ideaId, link, conflictId: row.id };
  }

  it('lists open conflicts with the linked entity ref + title', async () => {
    const { ideaId, conflictId } = await seedConflict({
      kind: 'field_conflict',
      field: 'title',
      local_value: 'Local title',
      remote_value: 'Remote title',
    });

    const [summary] = await service.conflicts(CONN_ID);
    expect(summary.id).toBe(conflictId);
    expect(summary.kind).toBe('field_conflict');
    expect(summary.field).toBe('title');
    expect(summary.localValue).toBe('Local title');
    expect(summary.remoteValue).toBe('Remote title');
    expect(summary.entityRef).toBe(readIdea(ideaId).ref);
    expect(summary.entityTitle).toBe('Local title');
  });

  it("field conflict + 'remote': applies the remote title and stamps the baseline", async () => {
    const { ideaId, link, conflictId } = await seedConflict({
      kind: 'field_conflict',
      field: 'title',
      local_value: 'Local title',
      remote_value: 'Remote title',
    });

    await service.resolveConflictChoice(conflictId, 'remote');

    expect(readIdea(ideaId).title).toBe('Remote title');
    const baseline = JSON.parse(linkRow(link.id).baseline_json ?? '{}') as Record<string, unknown>;
    expect(baseline.title).toBe('Remote title');
    // The outbound half's own key on the same blob survives the stamp.
    expect(baseline.lastWrittenGroup).toBe('started');
    expect(conflictRow(conflictId).state).toBe('resolved');
    expect(conflictRow(conflictId).resolution).toBe('manual-remote');
    expect(broadcasts).toContainEqual({
      projectId: PROJECT_ID,
      connectionId: CONN_ID,
      kind: 'conflicts',
    });
  });

  it("field conflict + 'remote' on a description keeps the provenance footer", async () => {
    const body = 'Old description\n\n---\n<!-- cyboflow:tracker -->\nImported from Linear · [CORE-142](https://x)';
    const { ideaId, conflictId } = await seedConflict(
      {
        kind: 'field_conflict',
        field: 'description',
        local_value: 'Old description',
        remote_value: 'Fresh remote description',
      },
      { body },
    );

    await service.resolveConflictChoice(conflictId, 'remote');

    const next = readIdea(ideaId).body ?? '';
    expect(next).toContain('Fresh remote description');
    expect(next).toContain('<!-- cyboflow:tracker -->');
    expect(next).not.toContain('Old description');
  });

  it("field conflict + 'remote' on a PRIORITY applies the level the pass recorded", async () => {
    // The row's `remote_value` is the provider-raw token (invariant 2), so the
    // local level to write comes off the payload the detecting pass wrote —
    // rebuilding the mapping here would mean a live provider probe from a UI
    // click, and one that could answer differently than the pass did.
    const { ideaId, link, conflictId } = await seedConflict({
      kind: 'field_conflict',
      field: 'priority',
      local_value: '1',
      remote_value: '2',
      payload_json: JSON.stringify({ externalId: 'ext-1', mode: 'manual', remoteLocal: 'P1' }),
    });

    await service.resolveConflictChoice(conflictId, 'remote');

    expect(readIdeaPriority(ideaId)).toBe('P1');
    const baseline = JSON.parse(linkRow(link.id).baseline_json ?? '{}') as Record<string, unknown>;
    // The baseline keeps the PROVIDER token, not the local level.
    expect(baseline.priority).toBe('2');
    expect(baseline.lastWrittenGroup).toBe('started');
    expect(conflictRow(conflictId).resolution).toBe('manual-remote');
  });

  it("field conflict + 'remote' on a CATEGORY applies the Dart type the pass resolved", async () => {
    const { ideaId, link, conflictId } = await seedConflict({
      kind: 'field_conflict',
      field: 'category',
      local_value: 'Feature',
      remote_value: 'Bug',
      payload_json: JSON.stringify({ externalId: 'ext-1', mode: 'manual', remoteLocal: 'bug' }),
    });

    await service.resolveConflictChoice(conflictId, 'remote');

    expect(readIdeaCategory(ideaId)).toBe('bug');
    const baseline = JSON.parse(linkRow(link.id).baseline_json ?? '{}') as Record<string, unknown>;
    expect(baseline.category).toBe('Bug');
  });

  it("field conflict + 'remote' on a mapped field applies NOTHING without a recorded level", async () => {
    // A row written before the payload key existed, or hand-edited. Guessing a
    // level is worse than leaving the entity alone: the conflict still
    // resolves, and the next pass re-derives from the baseline.
    const { ideaId, link, conflictId } = await seedConflict({
      kind: 'field_conflict',
      field: 'priority',
      local_value: '1',
      remote_value: '2',
    });

    await service.resolveConflictChoice(conflictId, 'remote');

    expect(readIdeaPriority(ideaId)).toBe('P2');
    const baseline = JSON.parse(linkRow(link.id).baseline_json ?? '{}') as Record<string, unknown>;
    expect(baseline.priority).toBeUndefined();
    expect(conflictRow(conflictId).state).toBe('resolved');
  });

  it("field conflict + 'local' on a mapped field stamps the baseline and writes nothing", async () => {
    // Keeping the local value only sticks if the baseline moves: otherwise the
    // next pass reads both-sides-changed and re-opens the settled conflict.
    const { ideaId, link, conflictId } = await seedConflict({
      kind: 'field_conflict',
      field: 'priority',
      local_value: '1',
      remote_value: '2',
      payload_json: JSON.stringify({ externalId: 'ext-1', mode: 'manual', remoteLocal: 'P1' }),
    });

    await service.resolveConflictChoice(conflictId, 'local');

    // The entity already HOLDS the value being kept.
    expect(readIdeaPriority(ideaId)).toBe('P2');
    const baseline = JSON.parse(linkRow(link.id).baseline_json ?? '{}') as Record<string, unknown>;
    expect(baseline.priority).toBe('2');
    expect(conflictRow(conflictId).resolution).toBe('manual-local');
    // No outbound path for content in this phase.
    expect(outboxRows()).toHaveLength(0);
  });

  it("field conflict + 'local' stamps a NULL priority as-is (Dart's cleared field)", async () => {
    const { link, conflictId } = await seedConflict({
      kind: 'field_conflict',
      field: 'priority',
      local_value: 'High',
      remote_value: null,
    });

    await service.resolveConflictChoice(conflictId, 'local');

    const baseline = JSON.parse(linkRow(link.id).baseline_json ?? '{}') as Record<string, unknown>;
    expect(baseline).toHaveProperty('priority', null);
  });

  it("field conflict + 'local' on a stage queues the write-back that converges the tracker", async () => {
    const { ideaId, conflictId } = await seedConflict({
      kind: 'field_conflict',
      field: 'stage',
      local_value: STAGE.done,
      remote_value: STAGE.ready,
    });

    await service.resolveConflictChoice(conflictId, 'local');

    const rows = outboxRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe('update_state');
    expect(rows[0].external_id).toBe('ext-1');
    expect(rows[0].entity_id).toBe(ideaId);
    expect((JSON.parse(rows[0].payload_json) as UpdateStatePayload).desiredGroup).toBe('completed');
    // The entity itself is untouched — local already IS the accepted value.
    expect(readIdea(ideaId).stage_id).toBe(STAGE.idea);
    expect(conflictRow(conflictId).resolution).toBe('manual-local');
  });

  it("remote_deleted + 'remote': archives the entity and orphans the link", async () => {
    const { ideaId, link, conflictId } = await seedConflict({ kind: 'remote_deleted' });

    await service.resolveConflictChoice(conflictId, 'remote');

    expect(readIdea(ideaId).archived_at).not.toBeNull();
    expect(linkRow(link.id).orphaned_at).not.toBeNull();
    expect(conflictRow(conflictId).resolution).toBe('manual-remote');
  });

  it("remote_deleted + 'local': keeps the entity but stops syncing the link", async () => {
    const { ideaId, link, conflictId } = await seedConflict({ kind: 'remote_deleted' });

    await service.resolveConflictChoice(conflictId, 'local');

    expect(readIdea(ideaId).archived_at).toBeNull();
    expect(linkRow(link.id).orphaned_at).not.toBeNull();
    expect(conflictRow(conflictId).resolution).toBe('manual-local');
  });

  it('is an idempotent no-op for an unknown or already-resolved conflict', async () => {
    const { conflictId } = await seedConflict({ kind: 'remote_deleted' });
    await service.resolveConflictChoice(conflictId, 'remote');
    broadcasts.length = 0;

    await service.resolveConflictChoice(conflictId, 'local');
    await service.resolveConflictChoice(9999, 'remote');

    // Still the FIRST ruling; nothing re-broadcast.
    expect(conflictRow(conflictId).resolution).toBe('manual-remote');
    expect(broadcasts).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Conflicts — the pass AFTER the ruling
// ---------------------------------------------------------------------------

/**
 * A ruling has to SURVIVE the next inbound pass. These drive the whole loop
 * through the real engine — a pass that imports the issue, a local edit, a pass
 * that opens the conflict, the ruling, then ANOTHER pass with the remote
 * unchanged — because the defect they cover is invisible to any test that stops
 * at the ruling: accepting the LOCAL side left the link's baseline on the
 * PRE-conflict snapshot, so the next pass still read both sides as changed and
 * re-opened the conflict the user had just settled, every pass, forever.
 */
describe('TrackerSyncService conflict resolution — the pass AFTER the ruling', () => {
  /** A remote touch (a comment, a label) that carries the SAME merge-relevant fields. */
  const TOUCHED = '2026-07-30T11:00:00.000Z';
  const TOUCHED_AGAIN = '2026-07-30T12:30:00.000Z';

  /**
   * Import an issue through a REAL pass, apply `localEdit`, then run a second
   * pass with `remote` overlaid — which is what opens the conflict in manual
   * mode. Returns the imported idea and the single open conflict.
   */
  async function openConflict(
    remote: Partial<TrackerIssue>,
    localEdit: (ideaId: string) => Promise<unknown>,
    connection: Partial<NewConnectionRow> = {},
    imported: Partial<TrackerIssue> = {},
  ): Promise<{ ideaId: string; conflictId: number }> {
    makeConnection({ conflict_mode: 'manual', ...connection });
    adapter.issues = [makeIssue(imported)];
    await service.syncConnection(CONN_ID);

    const ideaId = importedIdeaId();
    await localEdit(ideaId);

    adapter.issues = [makeIssue({ updatedAt: TOUCHED, ...remote })];
    await service.syncConnection(CONN_ID);

    const opened = allConflicts();
    expect(opened).toHaveLength(1);
    expect(opened[0].state).toBe('open');
    return { ideaId, conflictId: opened[0].id };
  }

  const editTitle =
    (title: string) =>
    (ideaId: string): Promise<{ taskId: string }> =>
      router.applyChange(PROJECT_ID, {
        actor: 'user',
        entityType: 'idea',
        taskId: ideaId,
        fields: { title },
      });

  /** Rewrite the remote-owned HALF of the body, leaving the provenance footer. */
  const editDescription =
    (description: string) =>
    async (ideaId: string): Promise<void> => {
      const { footer } = splitBody(readIdea(ideaId).body);
      await router.applyChange(PROJECT_ID, {
        actor: 'user',
        entityType: 'idea',
        taskId: ideaId,
        fields: { body: joinBody(description, footer) },
      });
    };

  const moveStage =
    (stageId: string) =>
    (ideaId: string): Promise<{ taskId: string }> =>
      router.applyChange(PROJECT_ID, {
        actor: 'user',
        entityType: 'idea',
        taskId: ideaId,
        stageId,
      });

  it("title + 'local': the next pass re-opens nothing and the local title stands", async () => {
    const { ideaId, conflictId } = await openConflict({ title: 'Remote title' }, editTitle('Local title'));

    await service.resolveConflictChoice(conflictId, 'local');

    // The SAME remote title, re-delivered behind a bumped updatedAt — any remote
    // touch does that, and the merge sees the issue again.
    adapter.issues = [makeIssue({ title: 'Remote title', updatedAt: TOUCHED_AGAIN })];
    const pass = await service.syncConnection(CONN_ID);

    expect(pass.error).toBeNull();
    expect(allConflicts()).toHaveLength(1);
    expect(allConflicts()[0].state).toBe('resolved');
    expect(readIdea(ideaId).title).toBe('Local title');
  });

  it("description + 'local': the next pass re-opens nothing and the local body stands", async () => {
    const { ideaId, conflictId } = await openConflict(
      { description: 'Remote description' },
      editDescription('Local description'),
    );

    await service.resolveConflictChoice(conflictId, 'local');

    adapter.issues = [makeIssue({ description: 'Remote description', updatedAt: TOUCHED_AGAIN })];
    const pass = await service.syncConnection(CONN_ID);

    expect(pass.error).toBeNull();
    expect(allConflicts()).toHaveLength(1);
    expect(allConflicts()[0].state).toBe('resolved');
    const body = readIdea(ideaId).body ?? '';
    expect(body).toContain('Local description');
    expect(body).not.toContain('Remote description');
    // The footer the import wrote is still there — the local half was kept whole.
    expect(body).toContain('<!-- cyboflow:tracker linear:ext-1 -->');
  });

  it("stage + 'local': the next pass re-opens nothing while the status direction is HELD", async () => {
    // A manual status direction means the convergence write-back sits in the
    // outbox instead of reaching the tracker, so nothing papers over a baseline
    // that never moved — the baseline stamp is the ONLY thing that can end the
    // loop. The conflict is opened while the direction still runs, then the
    // direction is held, which is exactly the order a user flipping the setting
    // produces.
    const { ideaId, conflictId } = await openConflict(
      { stateId: 'state-progress' },
      moveStage(STAGE.done),
      { status_sync_mode: 'auto' },
    );
    expect(conflictRow(conflictId).field).toBe('stage');
    await service.updateSettings(CONN_ID, { statusSyncMode: 'manual' });

    await service.resolveConflictChoice(conflictId, 'local');
    // QUEUED, not sent: the ruling is durable intent, the mode decides when.
    expect(outboxRows().map((row) => [row.kind, row.state])).toEqual([['update_state', 'pending']]);

    adapter.issues = [makeIssue({ stateId: 'state-progress', updatedAt: TOUCHED_AGAIN })];
    const pass = await service.syncConnection(CONN_ID);

    expect(pass.error).toBeNull();
    expect(allConflicts()).toHaveLength(1);
    expect(allConflicts()[0].state).toBe('resolved');
    expect(readIdea(ideaId).stage_id).toBe(STAGE.done);
    // The stamp says what is TRUE: the remote is at that state, in that group.
    expect(baselineOf('ext-1').stateId).toBe('state-progress');
    expect(baselineOf('ext-1').lastWrittenGroup).toBe('started');
  });

  it("stage + 'local' clears a STALE write-back stamp and still queues the convergence write", async () => {
    // Imported from a started state, so the link's baseline carries
    // lastWrittenGroup='started'. The remote has since dropped back to Backlog,
    // which belongs to no write-back group — the stamp must REMOVE the key, or a
    // later genuine local move to In development would be deduped away against
    // a group the remote no longer sits in.
    const { conflictId } = await openConflict(
      { stateId: 'state-backlog' },
      moveStage(STAGE.done),
      { status_sync_mode: 'auto' },
      { stateId: 'state-progress' },
    );
    expect(baselineOf('ext-1').lastWrittenGroup).toBe('started');

    await service.resolveConflictChoice(conflictId, 'local');

    expect(baselineOf('ext-1')).not.toHaveProperty('lastWrittenGroup');
    expect(baselineOf('ext-1').stateId).toBe('state-backlog');
    // Two-way is on, so the tracker is still asked to converge onto our stage.
    const rows = outboxRows();
    expect(rows).toHaveLength(1);
    expect((JSON.parse(rows[0].payload_json) as UpdateStatePayload).desiredGroup).toBe('completed');
  });

  it('a LATER genuine remote edit still conflicts after a local ruling', async () => {
    const { conflictId } = await openConflict({ title: 'Remote title' }, editTitle('Local title'));
    await service.resolveConflictChoice(conflictId, 'local');

    adapter.issues = [makeIssue({ title: 'Remote title, revised', updatedAt: TOUCHED_AGAIN })];
    await service.syncConnection(CONN_ID);

    const rows = allConflicts();
    expect(rows).toHaveLength(2);
    expect(rows[1].state).toBe('open');
    expect(rows[1].field).toBe('title');
    expect(rows[1].local_value).toBe('Local title');
    expect(rows[1].remote_value).toBe('Remote title, revised');
  });

  it("stage + 'remote': the next pass refreshes the whole baseline by itself", async () => {
    // The stage branch of applyRemoteFieldValue deliberately stamps nothing
    // (`remote_value` is a board stage, not a provider state) and leans on the
    // merge to refresh the baseline once the entity agrees with the remote.
    // Proven here rather than assumed.
    const { ideaId, conflictId } = await openConflict(
      { stateId: 'state-progress' },
      moveStage(STAGE.done),
    );

    await service.resolveConflictChoice(conflictId, 'remote');
    expect(readIdea(ideaId).stage_id).toBe(STAGE.ready);

    adapter.issues = [makeIssue({ stateId: 'state-progress', updatedAt: TOUCHED_AGAIN })];
    const pass = await service.syncConnection(CONN_ID);

    expect(pass.error).toBeNull();
    expect(allConflicts()).toHaveLength(1);
    expect(readIdea(ideaId).stage_id).toBe(STAGE.ready);
    expect(baselineOf('ext-1').stateId).toBe('state-progress');
  });

  it("title + 'remote': the next pass re-opens nothing either", async () => {
    const { ideaId, conflictId } = await openConflict({ title: 'Remote title' }, editTitle('Local title'));

    await service.resolveConflictChoice(conflictId, 'remote');
    expect(readIdea(ideaId).title).toBe('Remote title');

    adapter.issues = [makeIssue({ title: 'Remote title', updatedAt: TOUCHED_AGAIN })];
    const pass = await service.syncConnection(CONN_ID);

    expect(pass.error).toBeNull();
    expect(allConflicts()).toHaveLength(1);
    expect(readIdea(ideaId).title).toBe('Remote title');
  });

  /**
   * The REAL write-back listener on the REAL emitter, wired the way
   * TrackerSyncService.start does (and inboundSync.test.ts's echo-suppression
   * suite) — the only way an enqueue triggered by a resolution's own applyChange
   * is observable, since the listener runs INLINE on TaskChangeRouter's
   * post-commit emit.
   */
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

  it("stage + 'remote' does not echo a write-back over the state the user just accepted", async () => {
    // The regression: accepting the REMOTE stage applied the mapped stage without
    // first stamping the raw remote state onto the baseline, so the inline
    // write-back listener read Done as a LOCAL move and queued an update_state —
    // and the worker picks the FIRST state of the group, dragging the issue off
    // 'Released' (the exact state the user accepted) onto 'Done'.
    adapter.states = [
      ...STATES,
      { id: 'state-released', name: 'Released', color: null, group: 'completed' },
    ];
    subscribeWriteBack();

    const { ideaId, conflictId } = await openConflict(
      { stateId: 'state-released' },
      // Ready for development deliberately writes nothing back, so the LOCAL half
      // of the conflict contributes no outbox row of its own.
      moveStage(STAGE.ready),
    );
    expect(conflictRow(conflictId).field).toBe('stage');
    expect(outboxRows()).toEqual([]);

    await service.resolveConflictChoice(conflictId, 'remote');

    // The entity moves...
    expect(readIdea(ideaId).stage_id).toBe(STAGE.done);
    // ...and NOTHING is queued back at the provider.
    expect(outboxRows()).toEqual([]);
    // The stamp says what is TRUE: the remote sits on that state, in that group.
    expect(baselineOf('ext-1').stateId).toBe('state-released');
    expect(baselineOf('ext-1').lastWrittenGroup).toBe('completed');
  });

  it("stage + 'remote' clears a STALE write-back stamp when the remote leaves the terminal groups", async () => {
    // Imported from a started state, so the baseline carries
    // lastWrittenGroup='started'. The remote has since dropped to Backlog, which
    // belongs to no write-back group — leaving the stale key would suppress a
    // later, genuine local move to In development.
    const { ideaId, conflictId } = await openConflict(
      { stateId: 'state-backlog' },
      moveStage(STAGE.done),
      { status_sync_mode: 'auto' },
      { stateId: 'state-progress' },
    );
    expect(baselineOf('ext-1').lastWrittenGroup).toBe('started');

    await service.resolveConflictChoice(conflictId, 'remote');

    expect(readIdea(ideaId).stage_id).toBe(STAGE.idea);
    expect(baselineOf('ext-1').stateId).toBe('state-backlog');
    expect(baselineOf('ext-1')).not.toHaveProperty('lastWrittenGroup');
  });

  it("stage + 'remote' on a LEGACY conflict row (no recorded remote state) still applies the stage", async () => {
    // Rows written before the payload carried the raw state cannot be stamped
    // without inventing a state id, so they keep the pre-fix behavior.
    const { ideaId, conflictId } = await openConflict(
      { stateId: 'state-progress' },
      moveStage(STAGE.done),
      { status_sync_mode: 'auto' },
    );
    raw
      .prepare('UPDATE tracker_conflicts SET payload_json = ? WHERE id = ?')
      .run(JSON.stringify({ externalId: 'ext-1', mode: 'manual' }), conflictId);

    await service.resolveConflictChoice(conflictId, 'remote');

    expect(readIdea(ideaId).stage_id).toBe(STAGE.ready);
    expect(baselineOf('ext-1')).not.toHaveProperty('lastWrittenGroup');
  });
});

// ---------------------------------------------------------------------------
// reconcilePreview + linksForEntity
// ---------------------------------------------------------------------------

describe('TrackerSyncService.reconcilePreview', () => {
  it('lists active unlinked entities and suggests a normalized-title match', async () => {
    makeConnection();
    const matched = await createEntity('idea', { title: 'Ship the Tracker Sync!' });
    const unmatched = await createEntity('task', { title: 'Rewrite the CSS tokens' });
    const done = await createEntity('idea', { title: 'Already done', stageId: STAGE.done });
    const linked = await createEntity('idea', { title: 'Already linked' });
    upsertLink(raw, {
      connection_id: CONN_ID,
      entity_type: 'idea',
      entity_id: linked,
      provider: 'linear',
      external_id: 'ext-9',
    });
    const archived = await createEntity('idea', { title: 'Archived idea' });
    await router.applyChange(PROJECT_ID, { actor: 'user', taskId: archived, archived: true });

    const items = await service.reconcilePreview(PROJECT_ID, [
      makeIssue({ externalId: 'ext-1', title: 'Ship the tracker sync' }),
      makeIssue({ externalId: 'ext-2', title: 'Upgrade the build pipeline' }),
    ]);

    const ids = items.map((item) => item.entityId);
    expect(ids).toContain(matched);
    expect(ids).toContain(unmatched);
    expect(ids).not.toContain(done);
    expect(ids).not.toContain(linked);
    expect(ids).not.toContain(archived);

    const matchedItem = items.find((item) => item.entityId === matched);
    expect(matchedItem?.entityType).toBe('idea');
    expect(matchedItem?.suggestedExternalId).toBe('ext-1');
    expect(items.find((item) => item.entityId === unmatched)?.suggestedExternalId).toBeNull();
  });

  it('resolves an entity link and skips orphaned ones', async () => {
    makeConnection();
    const ideaId = await createEntity('idea', { title: 'Linked idea' });
    const link = upsertLink(raw, {
      connection_id: CONN_ID,
      entity_type: 'idea',
      entity_id: ideaId,
      provider: 'linear',
      external_id: 'ext-1',
      external_identifier: 'CORE-142',
      external_url: 'https://linear.app/acme/issue/CORE-142',
    });

    await expect(service.linksForEntity('idea', ideaId)).resolves.toEqual([
      {
        provider: 'linear',
        externalIdentifier: 'CORE-142',
        externalUrl: 'https://linear.app/acme/issue/CORE-142',
        // makeConnection's default archive_sync_mode is 'off' — a ruling would
        // fall back to the cancelled-state write, and the ref must say so.
        removalAction: 'cancel',
      },
    ]);
    await expect(service.linksForEntity('idea', 'ide_missing')).resolves.toEqual([]);

    raw.prepare(`UPDATE entity_external_links SET orphaned_at = datetime('now') WHERE id = ?`).run(
      link.id,
    );
    await expect(service.linksForEntity('idea', ideaId)).resolves.toEqual([]);
  });

  it('returns EVERY live provider link, not just the first — the removal-disclosure fix', async () => {
    makeConnection();
    const connDart = makeConnection({ id: 'conn-dart', provider: 'dart' });
    const ideaId = await createEntity('idea', { title: 'Multi-tracker idea' });
    upsertLink(raw, {
      connection_id: CONN_ID,
      entity_type: 'idea',
      entity_id: ideaId,
      provider: 'linear',
      external_id: 'ext-linear-1',
      external_identifier: 'CORE-142',
      external_url: 'https://linear.app/acme/issue/CORE-142',
    });
    upsertLink(raw, {
      connection_id: connDart.id,
      entity_type: 'idea',
      entity_id: ideaId,
      provider: 'dart',
      external_id: 'ext-dart-1',
      external_identifier: 'DART-7',
      external_url: 'https://app.itsdart.com/t/DART-7',
    });

    const links = await service.linksForEntity('idea', ideaId);
    expect(links.map((l) => l.provider).sort()).toEqual(['dart', 'linear']);
    expect(links.find((l) => l.provider === 'dart')?.externalIdentifier).toBe('DART-7');
    expect(links.find((l) => l.provider === 'linear')?.externalIdentifier).toBe('CORE-142');
  });

  it('stamps each link with the removal action the ruling would ACTUALLY take', async () => {
    // Round 3's finding 2: the dialog must promise exactly what
    // enqueueRemovalWriteBack performs. Three connections, three answers:
    // Linear with archive sync ON archives; Linear with the default 'off'
    // falls back to cancel (an archive row could never drain); Plane cancels
    // regardless because its API has no archive at all.
    makeConnection({ archive_sync_mode: 'auto' });
    const connOff = makeConnection({ id: 'conn-off', provider: 'dart', archive_sync_mode: 'off' });
    const connPlane = makeConnection({
      id: 'conn-plane',
      provider: 'plane',
      archive_sync_mode: 'auto',
    });
    const ideaId = await createEntity('idea', { title: 'Everywhere idea' });
    upsertLink(raw, {
      connection_id: CONN_ID,
      entity_type: 'idea',
      entity_id: ideaId,
      provider: 'linear',
      external_id: 'ext-lin',
    });
    upsertLink(raw, {
      connection_id: connOff.id,
      entity_type: 'idea',
      entity_id: ideaId,
      provider: 'dart',
      external_id: 'ext-dart',
    });
    upsertLink(raw, {
      connection_id: connPlane.id,
      entity_type: 'idea',
      entity_id: ideaId,
      provider: 'plane',
      external_id: 'ext-plane',
    });

    const links = await service.linksForEntity('idea', ideaId);
    const actionOf = (p: string): string | undefined =>
      links.find((l) => l.provider === p)?.removalAction;
    expect(actionOf('linear')).toBe('archive');
    expect(actionOf('dart')).toBe('cancel');
    expect(actionOf('plane')).toBe('cancel');
  });
});

// ---------------------------------------------------------------------------
// unlinkEntity — the local-delete ruling
// ---------------------------------------------------------------------------

describe('TrackerSyncService.unlinkEntity', () => {
  /** A linked idea on the default connection, ready to be deleted locally. */
  async function seedLinkedIdea(
    overrides: Partial<UpsertLinkInput> = {},
  ): Promise<{ ideaId: string; link: EntityExternalLinkRow }> {
    const ideaId = await createEntity('idea', { title: 'Linked idea' });
    const link = upsertLink(raw, {
      connection_id: CONN_ID,
      entity_type: 'idea',
      entity_id: ideaId,
      provider: 'linear',
      external_id: 'ext-1',
      external_identifier: 'CORE-142',
      external_url: 'https://linear.app/acme/issue/CORE-142',
      ...overrides,
    });
    return { ideaId, link };
  }

  it("'keep in the tracker' orphans the link and writes NOTHING to the outbox", async () => {
    makeConnection();
    const { ideaId, link } = await seedLinkedIdea();
    broadcasts.length = 0;

    await expect(service.unlinkEntity('idea', ideaId, { cancelRemote: false })).resolves.toEqual({
      unlinked: true,
    });

    expect(linkRow(link.id).orphaned_at).not.toBeNull();
    expect(outboxRows()).toEqual([]);
    // The link is gone as far as every read model is concerned.
    await expect(service.linksForEntity('idea', ideaId)).resolves.toEqual([]);
    expect(broadcasts).toEqual([
      { projectId: PROJECT_ID, connectionId: CONN_ID, kind: 'connection' },
    ]);
  });

  it("'cancel in the tracker' queues exactly one cancelled-group write and orphans the link", async () => {
    makeConnection();
    const { ideaId, link } = await seedLinkedIdea();

    await expect(service.unlinkEntity('idea', ideaId, { cancelRemote: true })).resolves.toEqual({
      unlinked: true,
    });

    const rows = outboxRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe('update_state');
    expect(rows[0].external_id).toBe('ext-1');
    expect(rows[0].entity_type).toBe('idea');
    expect(rows[0].entity_id).toBe(ideaId);
    expect((JSON.parse(rows[0].payload_json) as UpdateStatePayload).desiredGroup).toBe('cancelled');
    expect(linkRow(link.id).orphaned_at).not.toBeNull();
  });

  it('dedupes against an unresolved row already carrying the cancel', async () => {
    makeConnection();
    const { ideaId } = await seedLinkedIdea();

    await service.unlinkEntity('idea', ideaId, { cancelRemote: true });
    // The link is orphaned now, so a second ruling is a no-op — but re-linking
    // and ruling again must still not double-queue the same intent.
    upsertLink(raw, {
      connection_id: CONN_ID,
      entity_type: 'idea',
      entity_id: ideaId,
      provider: 'linear',
      external_id: 'ext-1',
    });
    await service.unlinkEntity('idea', ideaId, { cancelRemote: true });

    expect(outboxRows()).toHaveLength(1);
  });

  it('reports { unlinked: false } for an unlinked or already-orphaned entity, queueing nothing', async () => {
    makeConnection();
    const { ideaId, link } = await seedLinkedIdea();
    raw.prepare(`UPDATE entity_external_links SET orphaned_at = datetime('now') WHERE id = ?`).run(
      link.id,
    );
    broadcasts.length = 0;

    await expect(service.unlinkEntity('idea', ideaId, { cancelRemote: true })).resolves.toEqual({
      unlinked: false,
    });
    await expect(
      service.unlinkEntity('idea', 'ide_missing', { cancelRemote: true }),
    ).resolves.toEqual({ unlinked: false });

    expect(outboxRows()).toEqual([]);
    expect(broadcasts).toEqual([]);
  });

  it('cancels even on a one-way connection — the ruling is about THIS issue, not the sync policy', async () => {
    makeConnection({ status_sync_mode: 'manual' });
    const { ideaId } = await seedLinkedIdea();

    await service.unlinkEntity('idea', ideaId, { cancelRemote: true });

    expect(outboxRows()).toHaveLength(1);
    expect((JSON.parse(outboxRows()[0].payload_json) as UpdateStatePayload).desiredGroup).toBe(
      'cancelled',
    );
  });

  it('skips the cancel on a disconnected connection (its key is gone) but still unlinks', async () => {
    makeConnection({ status: 'disconnected' });
    const { ideaId, link } = await seedLinkedIdea();

    await expect(service.unlinkEntity('idea', ideaId, { cancelRemote: true })).resolves.toEqual({
      unlinked: true,
    });

    expect(outboxRows()).toEqual([]);
    expect(linkRow(link.id).orphaned_at).not.toBeNull();
  });

  it('drops the entity\'s links in EVERY provider so nothing is left pointing at it', async () => {
    makeConnection();
    const planeConnection = makeConnection({ id: 'conn-plane', provider: 'plane' });
    const { ideaId, link } = await seedLinkedIdea();
    const planeLink = upsertLink(raw, {
      connection_id: planeConnection.id,
      entity_type: 'idea',
      entity_id: ideaId,
      provider: 'plane',
      external_id: 'ext-plane-1',
    });

    await expect(service.unlinkEntity('idea', ideaId, { cancelRemote: true })).resolves.toEqual({
      unlinked: true,
    });

    expect(linkRow(link.id).orphaned_at).not.toBeNull();
    expect(linkRow(planeLink.id).orphaned_at).not.toBeNull();
    expect(outboxRows()).toHaveLength(1);
    expect(outboxRows(planeConnection.id)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// stageUnlinkRuling — the STAGED local-removal ruling
//
// The whole point of the staging design: the dialog collects the answer and the
// COMMITTED delete/archive applies it, so a user who backs out of the confirm
// dialog behind it has mutated nothing. `service.start()` is what subscribes the
// consumption half to the entity-change broadcast, so every case here starts it.
// ---------------------------------------------------------------------------

describe('TrackerSyncService staged local-removal ruling', () => {
  /** A linked idea on the default connection, ready to be removed locally. */
  async function seedLinkedIdea(
    overrides: Partial<UpsertLinkInput> = {},
  ): Promise<{ ideaId: string; link: EntityExternalLinkRow }> {
    const ideaId = await createEntity('idea', { title: 'Linked idea' });
    const link = upsertLink(raw, {
      connection_id: CONN_ID,
      entity_type: 'idea',
      entity_id: ideaId,
      provider: 'linear',
      external_id: 'ext-1',
      external_identifier: 'CORE-142',
      ...overrides,
    });
    // Creating the idea ALSO queued a push (`create_issue`) — writeBack's
    // trigger 4, which has its own coverage. These cases are about the removal
    // ruling, so the incidental row is dropped here rather than filtered out of
    // every outbox assertion below.
    raw.prepare(`DELETE FROM tracker_outbox WHERE kind = 'create_issue'`).run();
    return { ideaId, link };
  }

  /** The desired group of every outbox row, oldest first. */
  function queuedGroups(connectionId = CONN_ID): Array<string | undefined> {
    return outboxRows(connectionId).map(
      (row) => (JSON.parse(row.payload_json) as UpdateStatePayload).desiredGroup,
    );
  }

  it('stages WITHOUT mutating anything — no orphan, no outbox row, no broadcast', async () => {
    makeConnection();
    service.start();
    const { ideaId, link } = await seedLinkedIdea();
    broadcasts.length = 0;

    await service.stageUnlinkRuling('idea', ideaId, { cancelRemote: true });

    // The user is still looking at the delete confirm and may dismiss it.
    expect(linkRow(link.id).orphaned_at).toBeNull();
    expect(outboxRows()).toEqual([]);
    expect(broadcasts).toEqual([]);
    await expect(service.linksForEntity('idea', ideaId)).resolves.not.toEqual([]);
  });

  it('applies the ruling only once the delete actually commits', async () => {
    makeConnection();
    service.start();
    const { ideaId, link } = await seedLinkedIdea();

    await service.stageUnlinkRuling('idea', ideaId, { cancelRemote: true });
    await router.applyDelete(PROJECT_ID, { actor: 'user', taskId: ideaId });

    expect(queuedGroups()).toEqual(['cancelled']);
    expect(outboxRows()[0].external_id).toBe('ext-1');
    expect(linkRow(link.id).orphaned_at).not.toBeNull();
  });

  it('a ruling the user backed out of expires instead of surprising a later delete', async () => {
    makeConnection();
    service.start();
    const { ideaId, link } = await seedLinkedIdea();

    await service.stageUnlinkRuling('idea', ideaId, { cancelRemote: true });
    // The confirm was dismissed; much later the idea is deleted for other reasons.
    now = '2026-07-30T12:11:00.000Z';
    await router.applyDelete(PROJECT_ID, { actor: 'user', taskId: ideaId });

    // The link still has to go (its entity is gone) — but nothing was cancelled.
    expect(outboxRows()).toEqual([]);
    expect(linkRow(link.id).orphaned_at).not.toBeNull();
  });

  it('consumes the ruling — a second removal of the same id does not re-apply it', async () => {
    makeConnection();
    service.start();
    const { ideaId } = await seedLinkedIdea();

    await service.stageUnlinkRuling('idea', ideaId, { cancelRemote: true });
    await router.applyDelete(PROJECT_ID, { actor: 'user', taskId: ideaId });
    expect(queuedGroups()).toEqual(['cancelled']);

    // Re-created under the same id with a fresh link, deleted again: the ruling
    // was spent by the first delete, so this one only unlinks.
    raw
      .prepare(
        `INSERT INTO ideas (id, project_id, ref, title, board_id, stage_id)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(ideaId, PROJECT_ID, 'IDEA-999', 'Back again', 'board-1-default', STAGE.idea);
    const relinked = upsertLink(raw, {
      connection_id: CONN_ID,
      entity_type: 'idea',
      entity_id: ideaId,
      provider: 'linear',
      external_id: 'ext-2',
    });
    await router.applyDelete(PROJECT_ID, { actor: 'user', taskId: ideaId });

    expect(queuedGroups()).toEqual(['cancelled']);
    expect(linkRow(relinked.id).orphaned_at).not.toBeNull();
  });

  it('orphans a CASCADED child link even with no ruling anywhere (no zombie links)', async () => {
    makeConnection();
    service.start();
    const ideaId = await createEntity('idea', { title: 'Parent idea' });
    const epicId = await createEntity('epic', {
      title: 'Parent epic',
      originatingIdeaId: ideaId,
    });
    const taskId = await createEntity('task', {
      title: 'Mirrored child',
      parentEpicId: epicId,
      originatingIdeaId: ideaId,
    });
    const childLink = upsertLink(raw, {
      connection_id: CONN_ID,
      entity_type: 'task',
      entity_id: taskId,
      provider: 'linear',
      external_id: 'ext-child',
      external_parent_id: 'ext-1',
    });
    // Same as seedLinkedIdea: the parent idea's creation queued a push, which
    // is trigger 4's business and not this case's.
    raw.prepare(`DELETE FROM tracker_outbox WHERE kind = 'create_issue'`).run();

    // The epic itself is unlinked, so the dialog never even opened — the child
    // link is exactly the one the old design stranded.
    await router.applyDelete(PROJECT_ID, { actor: 'user', taskId: epicId });

    expect(linkRow(childLink.id).orphaned_at).not.toBeNull();
    expect(outboxRows()).toEqual([]);
  });

  it("cascade members inherit the ROOT's ruling: root + child are cancelled, then orphaned", async () => {
    makeConnection();
    service.start();
    const { ideaId, link } = await seedLinkedIdea();
    const epicId = await createEntity('epic', { title: 'Epic', originatingIdeaId: ideaId });
    const childId = await createEntity('task', {
      title: 'Mirrored child',
      parentEpicId: epicId,
      originatingIdeaId: ideaId,
    });
    const childLink = upsertLink(raw, {
      connection_id: CONN_ID,
      entity_type: 'task',
      entity_id: childId,
      provider: 'linear',
      external_id: 'ext-child',
      external_parent_id: 'ext-1',
    });

    await service.stageUnlinkRuling('idea', ideaId, { cancelRemote: true });
    await router.applyDelete(PROJECT_ID, { actor: 'user', taskId: ideaId });

    // Both issues were told to cancel BEFORE their links were orphaned — an
    // enqueue after the orphan would have had no live link to read.
    expect(queuedGroups()).toEqual(['cancelled', 'cancelled']);
    expect(outboxRows().map((row) => row.external_id).sort()).toEqual(['ext-1', 'ext-child']);
    expect(linkRow(link.id).orphaned_at).not.toBeNull();
    expect(linkRow(childLink.id).orphaned_at).not.toBeNull();
  });

  it("'keep' on the root unlinks the whole cascade and queues nothing", async () => {
    makeConnection();
    service.start();
    const { ideaId, link } = await seedLinkedIdea();
    const childId = await createEntity('task', {
      title: 'Mirrored child',
      originatingIdeaId: ideaId,
    });
    const childLink = upsertLink(raw, {
      connection_id: CONN_ID,
      entity_type: 'task',
      entity_id: childId,
      provider: 'linear',
      external_id: 'ext-child',
    });

    await service.stageUnlinkRuling('idea', ideaId, { cancelRemote: false });
    await router.applyDelete(PROJECT_ID, { actor: 'user', taskId: ideaId });

    expect(outboxRows()).toEqual([]);
    expect(linkRow(link.id).orphaned_at).not.toBeNull();
    expect(linkRow(childLink.id).orphaned_at).not.toBeNull();
  });

  it('an ARCHIVE with a staged ruling applies it', async () => {
    makeConnection();
    service.start();
    const { ideaId, link } = await seedLinkedIdea();

    await service.stageUnlinkRuling('idea', ideaId, { cancelRemote: true });
    await router.applyChange(PROJECT_ID, { actor: 'user', taskId: ideaId, archived: true });

    expect(queuedGroups()).toEqual(['cancelled']);
    expect(linkRow(link.id).orphaned_at).not.toBeNull();
  });

  it('an archive with NO staged ruling leaves the link completely alone', async () => {
    makeConnection();
    service.start();
    const { ideaId, link } = await seedLinkedIdea();

    // The shape an inbound remote-archive apply takes: the provider is the actor
    // and no dialog ever staged anything, so the inbound half keeps owning the
    // link (it archives locally and orphans on its own terms).
    await router.applyChange(PROJECT_ID, { actor: 'linear', taskId: ideaId, archived: true });

    expect(outboxRows()).toEqual([]);
    expect(linkRow(link.id).orphaned_at).toBeNull();
    await expect(service.linksForEntity('idea', ideaId)).resolves.not.toEqual([]);
  });

  // -------------------------------------------------------------------------
  // The three defenses against an ABANDONED ruling (TTL above, plus these two)
  // -------------------------------------------------------------------------

  it('clearUnlinkRuling discards a ruling the user backed out of, so a later delete only unlinks', async () => {
    makeConnection();
    service.start();
    const { ideaId, link } = await seedLinkedIdea();

    await service.stageUnlinkRuling('idea', ideaId, { cancelRemote: true });
    // The confirm dialog behind the ruling closed without committing.
    await service.clearUnlinkRuling('idea', ideaId);
    // Well inside the TTL, so nothing but the explicit clear can save this.
    await router.applyDelete(PROJECT_ID, { actor: 'user', taskId: ideaId });

    expect(outboxRows()).toEqual([]);
    expect(linkRow(link.id).orphaned_at).not.toBeNull();
  });

  it('clearing an entity with no staged ruling is a harmless no-op', async () => {
    makeConnection();
    service.start();
    const { ideaId, link } = await seedLinkedIdea();

    await expect(service.clearUnlinkRuling('idea', ideaId)).resolves.toBeUndefined();
    // Nothing was staged and nothing was touched — the link is still live.
    expect(linkRow(link.id).orphaned_at).toBeNull();
    expect(outboxRows()).toEqual([]);
  });

  it('a PROVIDER-authored archive cannot spend a human\'s staged ruling — the user\'s own later archive still can', async () => {
    makeConnection();
    service.start();
    const { ideaId, link } = await seedLinkedIdea();

    // The user staged 'cancel it' and then backed out of the confirm. Inbound
    // sync archives the same idea on the tracker's behalf moments later.
    await service.stageUnlinkRuling('idea', ideaId, { cancelRemote: true });
    await router.applyChange(PROJECT_ID, { actor: 'linear', taskId: ideaId, archived: true });

    // The provider's archive is treated exactly as it would be with no ruling
    // staged at all: inbound sync keeps owning the link, and NOTHING was
    // queued at the tracker.
    expect(outboxRows()).toEqual([]);
    expect(linkRow(link.id).orphaned_at).toBeNull();

    // ...and the ruling is not destroyed either — it is still there for the
    // removal it was actually collected for, well inside the TTL.
    await router.applyChange(PROJECT_ID, { actor: 'linear', taskId: ideaId, archived: false });
    await router.applyChange(PROJECT_ID, { actor: 'user', taskId: ideaId, archived: true });

    expect(queuedGroups()).toEqual(['cancelled']);
    expect(linkRow(link.id).orphaned_at).not.toBeNull();
  });

  it('an ORCHESTRATOR-authored delete orphans the links without spending the ruling', async () => {
    makeConnection();
    service.start();
    const { ideaId, link } = await seedLinkedIdea();

    await service.stageUnlinkRuling('idea', ideaId, { cancelRemote: true });
    await router.applyDelete(PROJECT_ID, { actor: 'orchestrator', taskId: ideaId });

    // A delete ALWAYS orphans (the entity is gone and nothing else ever will),
    // but the cancel the user backed out of is not queued.
    expect(linkRow(link.id).orphaned_at).not.toBeNull();
    expect(outboxRows()).toEqual([]);
  });

  it("a cascade child cannot inherit the root's ruling on a non-user delete", async () => {
    makeConnection();
    service.start();
    const { ideaId, link } = await seedLinkedIdea();
    const childId = await createEntity('task', {
      title: 'Mirrored child',
      originatingIdeaId: ideaId,
    });
    const childLink = upsertLink(raw, {
      connection_id: CONN_ID,
      entity_type: 'task',
      entity_id: childId,
      provider: 'linear',
      external_id: 'ext-child',
    });

    await service.stageUnlinkRuling('idea', ideaId, { cancelRemote: true });
    await router.applyDelete(PROJECT_ID, { actor: 'orchestrator', taskId: ideaId });

    expect(outboxRows()).toEqual([]);
    expect(linkRow(link.id).orphaned_at).not.toBeNull();
    expect(linkRow(childLink.id).orphaned_at).not.toBeNull();
  });

  it('reports whether a delete cascade will take synced children with it', async () => {
    makeConnection();
    const ideaId = await createEntity('idea', { title: 'Parent idea' });
    const epicId = await createEntity('epic', { title: 'Epic', originatingIdeaId: ideaId });
    const childId = await createEntity('task', {
      title: 'Child',
      parentEpicId: epicId,
      originatingIdeaId: ideaId,
    });

    await expect(service.hasLinkedDescendants('idea', ideaId)).resolves.toBe(false);

    const childLink = upsertLink(raw, {
      connection_id: CONN_ID,
      entity_type: 'task',
      entity_id: childId,
      provider: 'linear',
      external_id: 'ext-child',
    });

    // Reachable from the idea (via its epic) AND from the epic itself.
    await expect(service.hasLinkedDescendants('idea', ideaId)).resolves.toBe(true);
    await expect(service.hasLinkedDescendants('epic', epicId)).resolves.toBe(true);
    // A task has no cascade of its own, and an orphaned child does not count.
    await expect(service.hasLinkedDescendants('task', childId)).resolves.toBe(false);
    raw.prepare(`UPDATE entity_external_links SET orphaned_at = datetime('now') WHERE id = ?`).run(
      childLink.id,
    );
    await expect(service.hasLinkedDescendants('idea', ideaId)).resolves.toBe(false);
  });
});
