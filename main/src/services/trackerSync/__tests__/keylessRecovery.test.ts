/**
 * Unit tests for KEYLESS WORKSPACE RECOVERY — the state machine a paused beads
 * connection offers when re-detecting cannot fix it
 * (docs/proposals/tracker-beads-provider.md, "Replacement recovery is an
 * explicit state machine, not a resume", rounds 17/18, plus the prefix-rename
 * remap under "1. Keyless connect").
 *
 * WHY ITS OWN FILE, beside keylessConnect.test.ts. That file covers the happy
 * lifecycle, whose one refusal is "re-detect on a changed identity". These are
 * the cases AFTER that refusal — where the connection is stuck and the repair
 * itself is destructive — and every one of them is about what must NOT happen:
 * a link silently repointed at an unrelated database, a queued write replayed
 * against a workspace it was never composed for, an issue imported as a second
 * copy of an item that already exists, a repair applied to a state that has
 * since moved on.
 *
 * Wiring mirrors keylessConnect.test.ts: a REAL temp-file DB through the full
 * migration chain, a REAL TaskChangeRouter, and a beads-shaped fake adapter
 * whose two identity halves the tests move by hand. The review router is a fake
 * that records what was filed, because "surfaced as a finding rather than acted
 * on" is the actual contract for every ambiguous case here.
 *
 * Covered:
 *   1. classification — all four classes, plus the keyed and unknown-id refusals;
 *   2. the prefix remap — links, outbox rows, the connection's own prefix, the
 *      un-remappable id that becomes a finding, and the stale-state refusal;
 *   3. adoption — retire + orphan, cancel-as-findings, the fresh row, and the
 *      pre-import reconciliation's three verdicts (client key, provenance
 *      marker, ambiguous) for both imported- and pushed-origin entities.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The global setup mocks `electron` without safeStorage; override it here
// (hoisted before imports) exactly as keylessConnect.test.ts does, so the
// secret seam runs for real and a case can prove the keyless path never
// reached it.
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
import type {
  EntityExternalLinkRow,
  TrackerConnectionRow,
  TrackerOutboxRow,
} from '../../../database/models';
import type {
  TrackerConnectPayload,
  TrackerGroupTree,
  TrackerIssue,
  TrackerSourceNarrow,
  TrackerSourceSelection,
  TrackerSourceTree,
  TrackerState,
  TrackerWorkspaceIdentity,
} from '../../../../../shared/types/trackerSync';
import type {
  IssueDraft,
  TrackerAdapter,
  TrackerAdapterCapabilities,
  TrackerFieldOptionsRaw,
} from '../adapterTypes';
import {
  TrackerAuthError,
  TrackerConnectionNotFoundError,
  TrackerRecoveryStateError,
  TrackerRecoveryUnavailableError,
} from '../errors';
import type { EntityWriteRouter, ReviewFindingRouter } from '../inboundSync';
import type { ReviewItemCreate } from '../../../orchestrator/reviewItemRouter';
import {
  enqueueOutbox,
  getConnection,
  insertConnection,
  listLedgerEntries,
  listLinks,
  listUnresolvedOutbox,
  type NewConnectionRow,
} from '../store';
import { TrackerSyncService, beadsWorkspacePath } from '../trackerSyncService';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const PROJECT_ID = 1;
const PROJECT_PATH = '/tmp/recovery-repo';
/** `.beads/metadata.json` → project_id, before and after `rm -rf .beads && bd init`. */
const INSTANCE_ID = 'aa000000-0000-4000-8000-000000000001';
const NEW_INSTANCE_ID = 'bb000000-0000-4000-8000-000000000002';
/** The issue prefix, before and after `bd rename-prefix`. */
const PREFIX = 'cf';
const NEW_PREFIX = 'newpfx';
const WORKSPACE_CONTAINER_ID = 'workspace';

const SOURCE: TrackerSourceSelection = {
  containerId: WORKSPACE_CONTAINER_ID,
  narrowId: 'all',
  narrowKind: 'all',
};

const STATES: TrackerState[] = [
  { id: 'open', name: 'Open', color: null, group: 'unstarted' },
  { id: 'closed', name: 'Closed', color: null, group: 'completed' },
];

const GROUPS: TrackerGroupTree = {
  sections: [
    {
      label: 'Workspace',
      groups: [
        {
          id: WORKSPACE_CONTAINER_ID,
          name: PREFIX,
          key: PREFIX,
          sourceLabel: PREFIX,
          selection: SOURCE,
          stateScopeKey: WORKSPACE_CONTAINER_ID,
        },
      ],
    },
  ],
};

/**
 * A beads-shaped adapter with MUTABLE identity halves, so a case can rename the
 * prefix or replace the database between one probe and the next — the two events
 * this whole file is about.
 *
 * It enforces NO identity expectation of its own, which is what the recovery
 * probe needs: the real adapter refuses a changed identity, and the service's
 * probe deliberately builds an expectation-free one so the workspace is
 * REPORTED rather than refused.
 */
class FakeBeadsAdapter implements TrackerAdapter {
  readonly provider = 'beads' as const;
  readonly capabilities: TrackerAdapterCapabilities = {
    nativeParentAutoClose: false,
    selfHostedBaseUrl: false,
    idempotentCreate: false,
    contentWrite: { title: true, description: true, priority: true, category: true },
    archive: 'none',
    requiresIdReconciliation: true,
    guardedUpdates: false,
  };

  instanceId = INSTANCE_ID;
  prefix = PREFIX;
  /** The workspace's issues — what listIssues, the sweep and getIssue all answer from. */
  issues: TrackerIssue[] = [];
  /** Scripted validateCredentials failure — the 'redetect' path. */
  failValidate: Error | null = null;
  /** Scripted listIssues failure — the adoption's degraded re-link path. */
  failList: Error | null = null;
  readonly stateWrites: Array<{ externalId: string; stateId: string }> = [];
  readonly createdDrafts: IssueDraft[] = [];

  async validateCredentials(): Promise<TrackerWorkspaceIdentity> {
    if (this.failValidate !== null) throw this.failValidate;
    return {
      workspaceId: this.instanceId,
      workspaceName: this.prefix,
      actorLabel: 'K. Esteva',
    };
  }
  async listGroups(): Promise<TrackerGroupTree> {
    return GROUPS;
  }
  async listContainers(): Promise<TrackerSourceTree> {
    return {
      containerLabel: 'Workspace',
      containers: [
        { id: WORKSPACE_CONTAINER_ID, name: this.prefix, key: this.prefix, openIssueCount: null },
      ],
    };
  }
  async listNarrows(): Promise<TrackerSourceNarrow[]> {
    return [{ id: 'all', kind: 'all', name: 'Whole workspace', issueCount: null }];
  }
  async listStates(): Promise<TrackerState[]> {
    return STATES;
  }
  async listFieldOptions(): Promise<TrackerFieldOptionsRaw> {
    return { priorities: ['0', '1', '2'], categories: ['bug', 'feature', 'task'] };
  }
  async listIssues(): Promise<TrackerIssue[]> {
    if (this.failList !== null) throw this.failList;
    return this.issues;
  }
  async listIssueIds(): Promise<string[]> {
    return this.issues.map((issue) => issue.externalId);
  }
  listIssueRevisions?: () => Promise<Array<{ id: string; revision: string }>> = async () =>
    this.issues.map((issue) => ({ id: issue.externalId, revision: issue.revision ?? 'r' }));
  async getIssue(externalId: string): Promise<TrackerIssue | null> {
    return this.issues.find((issue) => issue.externalId === externalId) ?? null;
  }
  async createIssue(
    _selection: TrackerSourceSelection,
    draft: IssueDraft,
    clientKey: string,
  ): Promise<TrackerIssue> {
    this.createdDrafts.push(draft);
    // beads stamps the key into `cyboflow_client_key` metadata on every create,
    // and every mapped row reads it back — which is what makes the adoption's
    // pushed-origin match conclusive.
    const issue = makeIssue({
      externalId: `${this.prefix}-push`,
      title: draft.title,
      recoveryClientKey: clientKey,
    });
    this.issues.push(issue);
    return issue;
  }
  async createSubIssue(
    _parentExternalId: string,
    draft: IssueDraft,
    clientKey: string,
  ): Promise<TrackerIssue> {
    return this.createIssue(SOURCE, draft, clientKey);
  }
  async updateIssueState(externalId: string, stateId: string): Promise<void> {
    this.stateWrites.push({ externalId, stateId });
  }
  async updateIssueContent(): Promise<TrackerIssue | null> {
    throw new Error('not used');
  }
  async archiveIssue(): Promise<void> {
    throw new Error('not used');
  }
}

class FakeReviewRouter implements ReviewFindingRouter {
  readonly created: ReviewItemCreate[] = [];
  async applyReviewItem(
    _projectId: number,
    change: ReviewItemCreate,
  ): Promise<{ reviewItemId: string }> {
    this.created.push(change);
    return { reviewItemId: `rvw_${this.created.length}` };
  }
}

function makeIssue(overrides: Partial<TrackerIssue> = {}): TrackerIssue {
  const externalId = overrides.externalId ?? `${PREFIX}-a1b`;
  return {
    externalId,
    identifier: externalId,
    title: 'Wire the recovery',
    description: 'body',
    url: '',
    stateId: 'open',
    assignee: null,
    estimate: null,
    parentExternalId: null,
    updatedAt: '2026-08-27T10:00:00.000Z',
    archivedAt: null,
    priority: '1',
    category: 'task',
    recoveryClientKey: null,
    revision: `rev-${externalId}`,
    ...overrides,
  };
}

let tmpDir: string;
let svc: DatabaseService;
let raw: Database.Database;
let router: TaskChangeRouter;
let reviewRouter: FakeReviewRouter;
let adapter: FakeBeadsAdapter;
let service: TrackerSyncService;
let projectPaths: Map<number, string>;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'cyboflow-trackersync-recovery-'));
  svc = new DatabaseService(join(tmpDir, 'test.db'));
  svc.initialize();
  raw = svc.getDb();
  raw
    .prepare('INSERT INTO projects (id, name, path) VALUES (?, ?, ?)')
    .run(PROJECT_ID, 'Proj 1', PROJECT_PATH);
  svc.seedDefaultBoard(PROJECT_ID);
  router = new TaskChangeRouter(dbAdapter(raw));
  reviewRouter = new FakeReviewRouter();
  adapter = new FakeBeadsAdapter();
  projectPaths = new Map([[PROJECT_ID, PROJECT_PATH]]);
  service = new TrackerSyncService({
    db: raw,
    router: router as EntityWriteRouter,
    reviewRouter,
    nowIso: () => '2026-08-27T12:00:00.000Z',
    resolveProjectPath: (id) => projectPaths.get(id) ?? null,
    adapterFactory: () => adapter,
  });
});

afterEach(() => {
  service.stop();
  raw.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

function keylessPayload(overrides: Partial<TrackerConnectPayload> = {}): TrackerConnectPayload {
  return {
    projectId: PROJECT_ID,
    credentials: { provider: 'beads', projectId: PROJECT_ID },
    source: SOURCE,
    sourceLabel: PREFIX,
    selectionMode: 'all',
    selectionJson: null,
    stateMapping: { open: 'idea', closed: 'done' },
    statusSyncMode: 'auto',
    pullMode: 'auto',
    pushMode: 'auto',
    mirrorSubissues: false,
    conflictMode: 'auto',
    reconcile: [],
    ...overrides,
  };
}

/** Connect keylessly and settle the first pass, so imports have happened. */
async function connectKeyless(): Promise<string> {
  const { connectionId } = await service.connect(keylessPayload());
  await service.syncNow(connectionId);
  return connectionId;
}

function row(connectionId: string): TrackerConnectionRow {
  const found = getConnection(raw, connectionId);
  if (found === null) throw new Error(`no connection ${connectionId}`);
  return found;
}

function links(connectionId: string): EntityExternalLinkRow[] {
  return listLinks(raw, connectionId);
}

function linkFor(connectionId: string, externalId: string): EntityExternalLinkRow {
  const found = links(connectionId).find((link) => link.external_id === externalId);
  if (found === undefined) throw new Error(`no link ${externalId} on ${connectionId}`);
  return found;
}

function ideaCount(): number {
  return (raw.prepare('SELECT COUNT(*) AS n FROM ideas').get() as { n: number }).n;
}

function ideaBody(entityId: string): string | null {
  const found = raw.prepare('SELECT body FROM ideas WHERE id = ?').get(entityId) as
    | { body: string | null }
    | undefined;
  return found?.body ?? null;
}

function ideaArchivedAt(entityId: string): string | null {
  const found = raw.prepare('SELECT archived_at FROM ideas WHERE id = ?').get(entityId) as
    | { archived_at: string | null }
    | undefined;
  return found?.archived_at ?? null;
}

/** Every outbox row for a connection, settled ones included. */
function outboxRows(connectionId: string): TrackerOutboxRow[] {
  return raw
    .prepare('SELECT * FROM tracker_outbox WHERE connection_id = ? ORDER BY id ASC')
    .all(connectionId) as TrackerOutboxRow[];
}

/** The connection the app would have after the workspace was replaced: paused. */
function pauseFor(connectionId: string): void {
  raw.prepare("UPDATE tracker_connections SET status = 'paused' WHERE id = ?").run(connectionId);
}

// ---------------------------------------------------------------------------
// 1 · classification
// ---------------------------------------------------------------------------

describe('probeRecovery — which recovery a paused keyless connection needs', () => {
  it("reports 'healthy' when both identity halves still match", async () => {
    const connectionId = await connectKeyless();
    pauseFor(connectionId);

    await expect(service.probeRecovery(connectionId)).resolves.toMatchObject({
      connectionId,
      recovery: 'healthy',
      boundWorkspaceId: INSTANCE_ID,
      currentWorkspaceId: INSTANCE_ID,
      boundWorkspaceName: PREFIX,
      currentWorkspaceName: PREFIX,
      probeError: null,
    });
  });

  it("reports 'redetect' with the probe's own message when the workspace cannot be read", async () => {
    const connectionId = await connectKeyless();
    pauseFor(connectionId);
    adapter.failValidate = new TrackerAuthError(
      'beads',
      'this project has no resolvable beads workspace',
      null,
    );

    const probe = await service.probeRecovery(connectionId);

    expect(probe.recovery).toBe('redetect');
    expect(probe.currentWorkspaceId).toBeNull();
    // Verbatim: "bd is not installed" and "no workspace here" have different
    // fixes, and a generic line would erase both.
    expect(probe.probeError).toContain('no resolvable beads workspace');
  });

  it("reports 'renamed' for the same instance under a new prefix", async () => {
    const connectionId = await connectKeyless();
    pauseFor(connectionId);
    adapter.prefix = NEW_PREFIX;

    await expect(service.probeRecovery(connectionId)).resolves.toMatchObject({
      recovery: 'renamed',
      boundWorkspaceName: PREFIX,
      currentWorkspaceName: NEW_PREFIX,
      boundWorkspaceId: INSTANCE_ID,
      currentWorkspaceId: INSTANCE_ID,
    });
  });

  it("reports 'replaced' for a new instance, even when the prefix is unchanged", async () => {
    const connectionId = await connectKeyless();
    pauseFor(connectionId);
    // The ordinary shape of `rm -rf .beads && bd init`: the prefix is committed
    // config and comes back identical, so a prefix-first test would read this as
    // healthy and resume onto ids that no longer exist.
    adapter.instanceId = NEW_INSTANCE_ID;

    await expect(service.probeRecovery(connectionId)).resolves.toMatchObject({
      recovery: 'replaced',
      boundWorkspaceId: INSTANCE_ID,
      currentWorkspaceId: NEW_INSTANCE_ID,
      currentWorkspaceName: PREFIX,
    });
  });

  it("reads a row with NO recorded identity as 'redetect', never as a replacement", async () => {
    const connectionId = await connectKeyless();
    pauseFor(connectionId);
    raw
      .prepare('UPDATE tracker_connections SET workspace_id = NULL WHERE id = ?')
      .run(connectionId);

    const probe = await service.probeRecovery(connectionId);

    // Offering to RETIRE the connection and cancel its writes over missing
    // metadata would be the most destructive answer to the least informative
    // input.
    expect(probe.recovery).toBe('redetect');
    expect(probe.probeError).toContain('no recorded workspace identity');
  });

  it("reads a row with no recorded PREFIX as 'healthy', not as a rename", async () => {
    const connectionId = await connectKeyless();
    pauseFor(connectionId);
    raw
      .prepare('UPDATE tracker_connections SET workspace_name = NULL WHERE id = ?')
      .run(connectionId);

    // A remap has nothing to rewrite FROM here, so it would report every link
    // as un-remappable; re-detect stamps the prefix, which is the real repair.
    await expect(service.probeRecovery(connectionId)).resolves.toMatchObject({
      recovery: 'healthy',
    });
  });

  it('refuses a KEYED connection and an unknown id', async () => {
    insertConnection(raw, keyedRow());

    await expect(service.probeRecovery('keyed-1')).rejects.toThrow(TrackerRecoveryUnavailableError);
    await expect(service.probeRecovery('nope')).rejects.toThrow(TrackerConnectionNotFoundError);
  });
});

/** A Linear row — the keyed shape recovery classification refuses. */
function keyedRow(): NewConnectionRow {
  return {
    id: 'keyed-1',
    project_id: PROJECT_ID,
    provider: 'linear',
    status: 'paused',
    workspace_id: 'org-1',
    workspace_name: 'Acme',
    actor_label: 'K.',
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
    push_target: 0,
    content_sync_mode: 'off',
    archive_sync_mode: 'off',
    priority_mapping_json: '{}',
    category_mapping_json: '{}',
    config_generation: 0,
    mirror_subissues: 0,
    conflict_mode: 'auto',
    cursor_updated_at: null,
    cursor_external_id: null,
    last_sync_at: null,
    last_sync_log_json: null,
  };
}

// ---------------------------------------------------------------------------
// 2 · the prefix remap
// ---------------------------------------------------------------------------

describe('remapRenamedPrefix — a `bd rename-prefix` mid-state', () => {
  /** Two imported issues plus one queued state write naming one of them. */
  async function renamedWorkspace(): Promise<string> {
    adapter.issues = [makeIssue({ externalId: 'cf-2lz' }), makeIssue({ externalId: 'cf-88w' })];
    const connectionId = await connectKeyless();
    enqueueOutbox(raw, {
      connection_id: connectionId,
      kind: 'update_state',
      entity_type: 'idea',
      entity_id: linkFor(connectionId, 'cf-2lz').entity_id,
      external_id: 'cf-2lz',
      payload_json: JSON.stringify({ desiredGroup: 'done' }),
    });
    enqueueOutbox(raw, {
      connection_id: connectionId,
      kind: 'create_sub_issue',
      entity_type: 'task',
      entity_id: 't-1',
      external_id: null,
      client_key: 'ck-1',
      payload_json: JSON.stringify({
        parentExternalId: 'cf-88w',
        title: 'A mirrored child',
        description: null,
        priority: null,
        category: null,
      }),
    });
    pauseFor(connectionId);
    // The rename: same database, every issue id rewritten suffix-preserved.
    adapter.prefix = NEW_PREFIX;
    adapter.issues = [
      makeIssue({ externalId: 'newpfx-2lz' }),
      makeIssue({ externalId: 'newpfx-88w' }),
    ];
    return connectionId;
  }

  it('rewrites every link and unresolved outbox reference, and resumes', async () => {
    const connectionId = await renamedWorkspace();

    const result = await service.remapRenamedPrefix(connectionId);

    expect(result).toEqual({
      remappedLinks: 2,
      remappedOutboxRows: 2,
      workspaceName: NEW_PREFIX,
      unmatchedExternalIds: [],
    });
    expect(links(connectionId).map((link) => link.external_id).sort()).toEqual([
      'newpfx-2lz',
      'newpfx-88w',
    ]);
    // The identifier column travels with the id — on beads the two are the same
    // string, and a stale one would render a dead ref chip.
    expect(links(connectionId).map((link) => link.external_identifier).sort()).toEqual([
      'newpfx-2lz',
      'newpfx-88w',
    ]);

    const outbox = outboxRows(connectionId);
    expect(outbox[0].external_id).toBe('newpfx-2lz');
    // The mirrored child's parent lives INSIDE the payload; leaving it would
    // file the child under an id bd no longer knows.
    expect(JSON.parse(outbox[1].payload_json)).toMatchObject({ parentExternalId: 'newpfx-88w' });

    expect(row(connectionId).workspace_name).toBe(NEW_PREFIX);
    expect(row(connectionId).status).toBe('active');
  });

  it('leaves the next pass clean — nothing re-imports and nothing is archived', async () => {
    const connectionId = await renamedWorkspace();
    const before = ideaCount();

    await service.remapRenamedPrefix(connectionId);
    const pass = await service.syncNow(connectionId);

    expect(pass.error).toBeNull();
    // The whole point of the remap: without it the sweep would read every old id
    // as deleted and archive its twin, and the listing would import every new id
    // as a fresh idea.
    expect(ideaCount()).toBe(before);
    for (const link of links(connectionId)) expect(link.orphaned_at).toBeNull();
  });

  it('leaves an id that never carried the old prefix alone, and files it as a finding', async () => {
    const connectionId = await renamedWorkspace();
    raw
      .prepare("UPDATE entity_external_links SET external_id = 'other-99' WHERE external_id = 'cf-88w'")
      .run();

    const result = await service.remapRenamedPrefix(connectionId);

    expect(result.remappedLinks).toBe(1);
    expect(result.unmatchedExternalIds).toEqual(['other-99']);
    expect(linkFor(connectionId, 'other-99').external_id).toBe('other-99');
    expect(reviewRouter.created.map((item) => item.title)).toContain(
      'Tracker sync left 1 link un-remapped',
    );
  });

  it('refuses when the re-probe no longer reports a rename', async () => {
    const connectionId = await renamedWorkspace();
    // The user renamed it back while the banner was on screen.
    adapter.prefix = PREFIX;

    await expect(service.remapRenamedPrefix(connectionId)).rejects.toThrow(TrackerRecoveryStateError);
    // Nothing was rewritten — a refusal must not be a partial apply.
    expect(links(connectionId).map((link) => link.external_id).sort()).toEqual(['cf-2lz', 'cf-88w']);
    expect(row(connectionId).workspace_name).toBe(PREFIX);
    expect(row(connectionId).status).toBe('paused');
  });

  it('refuses a REPLACED workspace, which needs adoption rather than a rewrite', async () => {
    const connectionId = await renamedWorkspace();
    adapter.instanceId = NEW_INSTANCE_ID;

    await expect(service.remapRenamedPrefix(connectionId)).rejects.toThrow(/replaced/);
    expect(links(connectionId).map((link) => link.external_id).sort()).toEqual(['cf-2lz', 'cf-88w']);
  });
});

// ---------------------------------------------------------------------------
// 3 · adoption
// ---------------------------------------------------------------------------

describe('adoptNewWorkspace — a replaced database at the same path', () => {
  /**
   * One IMPORTED idea (its body carries the provenance marker) and one PUSHED
   * idea (its create row carries the client key), then the workspace is
   * replaced. The two origins are the two conclusive match channels, and the
   * proposal names both by name.
   */
  async function replacedWorkspace(): Promise<{
    connectionId: string;
    importedEntityId: string;
    pushedEntityId: string;
  }> {
    adapter.issues = [makeIssue({ externalId: 'cf-imp' })];
    const connectionId = await connectKeyless();
    const importedEntityId = linkFor(connectionId, 'cf-imp').entity_id;

    // A PUSH, through the real outbox drain: the idea is local, the create row
    // is queued, and the worker performs the create and writes the link. That
    // is the state a push leaves, and it is what makes the client key durable.
    const pushed = await router.applyChange(PROJECT_ID, {
      actor: 'user',
      entityType: 'idea',
      fields: { title: 'A locally filed idea' },
    });
    enqueueOutbox(raw, {
      connection_id: connectionId,
      kind: 'create_issue',
      entity_type: 'idea',
      entity_id: pushed.taskId,
      external_id: null,
      client_key: 'ck-pushed',
      payload_json: '{}',
    });
    await service.syncNow(connectionId);

    pauseFor(connectionId);
    return { connectionId, importedEntityId, pushedEntityId: pushed.taskId };
  }

  it('retires the old connection, orphans its links, and never archives an entity', async () => {
    const { connectionId, importedEntityId } = await replacedWorkspace();
    adapter.instanceId = NEW_INSTANCE_ID;
    adapter.issues = [];

    const result = await service.adoptNewWorkspace(connectionId);

    expect(row(connectionId).status).toBe('disconnected');
    expect(result.orphanedLinks).toBe(2);
    for (const link of links(connectionId)) expect(link.orphaned_at).not.toBeNull();
    // Their remote halves are gone; that is not the user deciding the work is
    // done, so the local entities stand.
    expect(ideaArchivedAt(importedEntityId)).toBeNull();
    expect(ideaCount()).toBe(2);
  });

  it('never resolves a retained link against the new instance without a proven match', async () => {
    const { connectionId, importedEntityId } = await replacedWorkspace();
    adapter.instanceId = NEW_INSTANCE_ID;
    // The new database holds ONE unrelated issue and nothing that belongs to us.
    adapter.issues = [makeIssue({ externalId: 'cf-zzz', title: 'Somebody else' })];

    const result = await service.adoptNewWorkspace(connectionId);
    await service.syncNow(result.newConnectionId);

    expect(result.relinked).toBe(0);
    expect(result.ambiguous).toBe(0);
    // Every retained link is still on the RETIRED row, orphaned, pointing at its
    // old id — never silently repointed at the unrelated issue.
    for (const link of links(connectionId)) {
      expect(link.connection_id).toBe(connectionId);
      expect(link.orphaned_at).not.toBeNull();
    }
    expect(links(result.newConnectionId).map((link) => link.external_id)).toEqual(['cf-zzz']);
    expect(ideaArchivedAt(importedEntityId)).toBeNull();
  });

  it('cancels every unresolved write as a finding, and never replays one', async () => {
    const { connectionId } = await replacedWorkspace();
    const linkedId = linkFor(connectionId, 'cf-imp').external_id;
    enqueueOutbox(raw, {
      connection_id: connectionId,
      kind: 'update_state',
      entity_type: 'idea',
      entity_id: linkFor(connectionId, 'cf-imp').entity_id,
      external_id: linkedId,
      payload_json: JSON.stringify({ desiredGroup: 'done' }),
    });
    adapter.instanceId = NEW_INSTANCE_ID;
    adapter.issues = [];
    adapter.stateWrites.length = 0;

    const result = await service.adoptNewWorkspace(connectionId);
    await service.syncNow(result.newConnectionId);

    expect(result.cancelledWrites).toBe(1);
    expect(listUnresolvedOutbox(raw, connectionId)).toHaveLength(0);
    // The write was composed against a database that no longer exists; replaying
    // it would have addressed an unrelated issue in the new one.
    expect(adapter.stateWrites).toEqual([]);
    expect(reviewRouter.created.map((item) => item.title)).toContain(
      `Tracker write cancelled — update_state on ${linkedId}`,
    );
  });

  it('mints a fresh connection on the new instance with the same scope and a null cursor', async () => {
    const { connectionId } = await replacedWorkspace();
    adapter.instanceId = NEW_INSTANCE_ID;
    adapter.issues = [];
    const before = row(connectionId);

    const { newConnectionId } = await service.adoptNewWorkspace(connectionId);
    const created = row(newConnectionId);

    expect(newConnectionId).not.toBe(connectionId);
    expect(created.workspace_id).toBe(NEW_INSTANCE_ID);
    expect(created.status).toBe('active');
    expect(created.secret_ciphertext).toBeNull();
    expect(created.config_generation).toBe(0);
    expect(created.cursor_updated_at).toBeNull();
    // Same project, same source scope, same workspace path, same settings.
    expect(created.project_id).toBe(before.project_id);
    expect(created.source_json).toBe(before.source_json);
    expect(created.state_mapping_json).toBe(before.state_mapping_json);
    expect(beadsWorkspacePath(created)).toBe(PROJECT_PATH);
    // The push-target role travels with the connection, so the project is never
    // left with live rows and no pusher.
    expect(created.push_target).toBe(1);
  });

  it('re-links a PUSHED item by its client key instead of duplicating it', async () => {
    const { connectionId, pushedEntityId } = await replacedWorkspace();
    adapter.instanceId = NEW_INSTANCE_ID;
    // The replacement holds the pushed issue under a DIFFERENT id — the key is
    // what proves it is the same item, and only the key could.
    adapter.issues = [
      makeIssue({ externalId: 'cf-newid', title: 'A locally filed idea', recoveryClientKey: 'ck-pushed' }),
    ];
    const before = ideaCount();

    const result = await service.adoptNewWorkspace(connectionId);
    await service.syncNow(result.newConnectionId);

    expect(result.relinked).toBe(1);
    expect(ideaCount()).toBe(before);
    const relinked = linkFor(result.newConnectionId, 'cf-newid');
    expect(relinked.entity_id).toBe(pushedEntityId);
    expect(relinked.orphaned_at).toBeNull();
    expect(reviewRouter.created.map((item) => item.title)).toContain(
      'Tracker sync re-linked cf-newid in the adopted workspace',
    );
  });

  it('re-links an IMPORTED item by its provenance marker instead of duplicating it', async () => {
    const { connectionId, importedEntityId } = await replacedWorkspace();
    expect(ideaBody(importedEntityId)).toContain('cyboflow:tracker beads:cf-imp');
    adapter.instanceId = NEW_INSTANCE_ID;
    // A re-init from an export: same content, same ids, new database.
    adapter.issues = [makeIssue({ externalId: 'cf-imp' })];
    const before = ideaCount();

    const result = await service.adoptNewWorkspace(connectionId);
    await service.syncNow(result.newConnectionId);

    expect(result.relinked).toBe(1);
    expect(ideaCount()).toBe(before);
    const relinked = linkFor(result.newConnectionId, 'cf-imp');
    expect(relinked.entity_id).toBe(importedEntityId);
    expect(relinked.orphaned_at).toBeNull();
    // A fresh baseline from the NEW issue, not the retired one's blob.
    expect(JSON.parse(relinked.baseline_json ?? '{}')).toMatchObject({ revision: 'rev-cf-imp' });
  });

  it('files an ambiguous id-only match as a finding and holds it out of the import', async () => {
    const { connectionId, pushedEntityId } = await replacedWorkspace();
    const pushedExternalId = linkFor(connectionId, 'cf-push').external_id;
    adapter.instanceId = NEW_INSTANCE_ID;
    // The SAME id as the pushed item's issue, but no client key and no import
    // marker on the local body: suggestive, unprovable.
    adapter.issues = [makeIssue({ externalId: pushedExternalId, title: 'Could be anything' })];
    const before = ideaCount();

    const result = await service.adoptNewWorkspace(connectionId);
    await service.syncNow(result.newConnectionId);

    expect(result.ambiguous).toBe(1);
    expect(result.relinked).toBe(0);
    // NOT re-linked...
    expect(links(result.newConnectionId)).toHaveLength(0);
    expect(linkFor(connectionId, pushedExternalId).entity_id).toBe(pushedEntityId);
    // ...and NOT imported as a second copy, in this pass or any later one: the
    // hold is a ledger row both detection paths read.
    expect(ideaCount()).toBe(before);
    expect([...listLedgerEntries(raw, result.newConnectionId).values()]).toMatchObject([
      { external_id: pushedExternalId, reason: 'awaiting-adoption' },
    ]);
    expect(reviewRouter.created.map((item) => item.title)).toContain(
      `Confirm whether ${pushedExternalId} is still this item's issue`,
    );
  });

  it('keeps holding the ambiguous issue across a later reconciliation sweep', async () => {
    const { connectionId } = await replacedWorkspace();
    const pushedExternalId = linkFor(connectionId, 'cf-push').external_id;
    adapter.instanceId = NEW_INSTANCE_ID;
    adapter.issues = [makeIssue({ externalId: pushedExternalId, title: 'Could be anything' })];
    const { newConnectionId } = await service.adoptNewWorkspace(connectionId);
    const before = ideaCount();

    // "Sync now" always sweeps, which is the path that would otherwise import a
    // held id minutes after the finding was filed.
    await service.syncNow(newConnectionId);
    await service.syncNow(newConnectionId);

    expect(ideaCount()).toBe(before);
    expect(links(newConnectionId)).toHaveLength(0);
  });

  it('imports an unrelated issue in the adopted workspace the ordinary way', async () => {
    const { connectionId } = await replacedWorkspace();
    adapter.instanceId = NEW_INSTANCE_ID;
    adapter.issues = [makeIssue({ externalId: 'cf-brand-new', title: 'Genuinely new work' })];
    const before = ideaCount();

    const result = await service.adoptNewWorkspace(connectionId);
    await service.syncNow(result.newConnectionId);

    // Nothing pointed at it, so nothing held it back: the first pass owns it.
    expect(result.relinked).toBe(0);
    expect(result.ambiguous).toBe(0);
    expect(ideaCount()).toBe(before + 1);
    expect(linkFor(result.newConnectionId, 'cf-brand-new')).toBeDefined();
  });

  it('refuses when the re-probe no longer reports a replacement', async () => {
    const { connectionId } = await replacedWorkspace();

    // Still the original instance — the pause was transient after all.
    await expect(service.adoptNewWorkspace(connectionId)).rejects.toThrow(TrackerRecoveryStateError);
    expect(row(connectionId).status).toBe('paused');
    for (const link of links(connectionId)) expect(link.orphaned_at).toBeNull();
    expect(
      (raw.prepare('SELECT COUNT(*) AS n FROM tracker_connections').get() as { n: number }).n,
    ).toBe(1);
  });

  it('pauses the fresh connection when the adopted workspace cannot be listed', async () => {
    const { connectionId } = await replacedWorkspace();
    adapter.instanceId = NEW_INSTANCE_ID;
    adapter.failList = new TrackerAuthError('beads', 'the database is locked', null);

    const result = await service.adoptNewWorkspace(connectionId);

    // The adoption itself landed, but running blind would import the whole
    // workspace as new ideas — exactly what the re-link exists to prevent.
    expect(result.relinked).toBe(0);
    expect(row(result.newConnectionId).status).toBe('paused');
  });
});
