/**
 * Unit tests for KEYLESS CONNECT — the beads lifecycle in which
 * `tracker_connections.secret_ciphertext` is permanently NULL
 * (docs/proposals/tracker-beads-provider.md, "1. Keyless connect").
 *
 * WHY ITS OWN FILE. Every other tracker test starts from a row that HAS a
 * stored key, and the bug this phase exists to prevent is the opposite shape:
 * a guard that reads an absent ciphertext as fatal. Those guards are spread
 * across `connect`, `buildAdapter`, `credentialsForConnection` and
 * `updateCredentials`, and a connect-only fix produces a connection that
 * pauses on its first sync — so the cases here are LIFECYCLE cases (connect →
 * sync → re-enter the wizard → pause → re-detect → restart the app), not
 * per-method ones.
 *
 * Wiring mirrors trackerSyncFacade.test.ts: a REAL temp-file DB through the
 * full migration chain, a REAL TaskChangeRouter, a fake adapter injected via
 * `adapterFactory`, and `safeStorage` mocked with a reversible transform so
 * the encrypt/decrypt seam runs for real — which is what lets a case assert
 * that the keyless path never reached it.
 *
 * Covers:
 *   1. initial connect + first pass on a NULL secret;
 *   2. "Sync now" on the keyless row (buildAdapter must not read the cipher);
 *   3. mapping-management re-entry (credentialsForConnection must not throw);
 *   4. pause → re-detect resume, and the identity change that refuses to;
 *  4b. a workspace the user POINTED AT rather than the project's repo — what
 *      main's folder token buys, and the re-detect that must not undo it;
 *   5. app restart — a fresh service over the same DB drives a pass;
 * plus the negatives that keep the widening from becoming a global loosening:
 *   a keyed provider with no key is still refused at both the connect and the
 *   buildAdapter ends, and a key offered to a keyless row is refused rather
 *   than silently dropped.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The global setup (main/src/test/setup.ts) mocks `electron` without
// safeStorage; override it here (hoisted before imports, mirroring
// trackerSyncFacade.test.ts) so the secret seam runs for real.
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

// `wizardInitWorkspace` spawns through `buildCommandEnv`, which otherwise execs
// a login shell to resolve PATH on first call. Only that probe is replaced —
// same treatment beadsAdapter.test.ts gives it.
vi.mock('../../../utils/shellPath', () => ({
  getShellPath: () => '/usr/bin:/bin',
  clearShellPathCache: () => undefined,
  findExecutableInPath: () => null,
}));

import { DatabaseService } from '../../../database/database';
import { TaskChangeRouter } from '../../../orchestrator/taskChangeRouter';
import { dbAdapter } from '../../../orchestrator/__test_fixtures__/dbAdapter';
import type { TrackerConnectionRow } from '../../../database/models';
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
import { TrackerAuthError } from '../errors';
import type { EntityWriteRouter } from '../inboundSync';
import { getConnection, insertConnection, readSecret, updateConnectionSettings } from '../store';
import {
  MAX_PICKED_WORKSPACE_PATHS,
  TrackerCredentialsError,
  TrackerSyncService,
  beadsWorkspacePath,
  defaultAdapterFactory,
} from '../trackerSyncService';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const PROJECT_ID = 1;
const PROJECT_PATH = '/tmp/keyless-repo';
/** `.beads/metadata.json` → project_id: the immutable database instance id. */
const INSTANCE_ID = '5c2f5a0e-0000-4000-8000-000000000001';
/** The issue prefix — `workspace_name`, and the other half of the invariant. */
const PREFIX = 'kls';
/** The single degenerate container BeadsAdapter.listGroups reports. */
const WORKSPACE_CONTAINER_ID = 'workspace';

const SOURCE: TrackerSourceSelection = {
  containerId: WORKSPACE_CONTAINER_ID,
  narrowId: 'all',
  narrowKind: 'all',
};

const STATES: TrackerState[] = [
  { id: 'open', name: 'Open', color: null, group: 'backlog' },
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
 * A beads-shaped adapter. The two identity halves are MUTABLE so a case can
 * simulate the workspace being replaced (`rm -rf .beads && bd init`) between
 * one probe and the next, which is the only thing re-detect is allowed to
 * refuse.
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
    guardedUpdates: true,
  };

  readonly calls: string[] = [];
  instanceId = INSTANCE_ID;
  prefix = PREFIX;
  issues: TrackerIssue[] = [];
  /** Scripted failure for validateCredentials — the detect-failed path. */
  failValidate: Error | null = null;

  async validateCredentials(): Promise<TrackerWorkspaceIdentity> {
    this.calls.push('validateCredentials');
    if (this.failValidate !== null) throw this.failValidate;
    return {
      workspaceId: this.instanceId,
      workspaceName: this.prefix,
      actorLabel: 'K. Esteva',
    };
  }
  async listGroups(): Promise<TrackerGroupTree> {
    this.calls.push('listGroups');
    return GROUPS;
  }
  async listContainers(): Promise<TrackerSourceTree> {
    this.calls.push('listContainers');
    return {
      containerLabel: 'Workspace',
      containers: [
        { id: WORKSPACE_CONTAINER_ID, name: this.prefix, key: this.prefix, openIssueCount: null },
      ],
    };
  }
  async listNarrows(): Promise<TrackerSourceNarrow[]> {
    this.calls.push('listNarrows');
    return [{ id: 'all', kind: 'all', name: 'Whole workspace', issueCount: null }];
  }
  async listStates(): Promise<TrackerState[]> {
    this.calls.push('listStates');
    return STATES;
  }
  async listFieldOptions(): Promise<TrackerFieldOptionsRaw> {
    this.calls.push('listFieldOptions');
    return { priorities: ['0', '1', '2'], categories: ['bug', 'feature', 'task'] };
  }
  async listIssues(): Promise<TrackerIssue[]> {
    this.calls.push('listIssues');
    return this.issues;
  }
  async listIssueIds(): Promise<string[]> {
    this.calls.push('listIssueIds');
    return this.issues.map((issue) => issue.externalId);
  }
  /**
   * Required, not optional, for THIS fake: it declares
   * `requiresIdReconciliation`, and the sweep asserts that pairing rather than
   * falling back to a bare id diff (an adapter with the flag and no method
   * would silently lose the reconciliation the flag exists to declare).
   */
  async listIssueRevisions(): Promise<Array<{ id: string; revision: string }>> {
    this.calls.push('listIssueRevisions');
    return this.issues.map((issue) => ({
      id: issue.externalId,
      revision: issue.revision ?? `rev-${issue.externalId}`,
    }));
  }
  async getIssue(): Promise<TrackerIssue | null> {
    this.calls.push('getIssue');
    return null;
  }
  async createIssue(
    _selection: TrackerSourceSelection,
    draft: IssueDraft,
    clientKey: string,
  ): Promise<TrackerIssue> {
    this.calls.push('createIssue');
    return makeIssue({ externalId: clientKey, title: draft.title });
  }
  async createSubIssue(
    _parentExternalId: string,
    draft: IssueDraft,
    clientKey: string,
  ): Promise<TrackerIssue> {
    this.calls.push('createSubIssue');
    return makeIssue({ externalId: clientKey, title: draft.title });
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
    externalId: `${PREFIX}-a1b2`,
    identifier: `${PREFIX}-a1b2`,
    title: 'Wire the keyless connect',
    description: 'No key, one workspace.',
    // beads issues have no web URL; the adapter reports the id itself, which is
    // what the ref chip renders.
    url: `${PREFIX}-a1b2`,
    stateId: 'open',
    assignee: null,
    estimate: null,
    parentExternalId: null,
    updatedAt: '2026-08-27T10:00:00.000Z',
    archivedAt: null,
    priority: '1',
    category: 'task',
    recoveryClientKey: null,
    ...overrides,
  };
}

let tmpDir: string;
let svc: DatabaseService;
let raw: Database.Database;
let router: TaskChangeRouter;
let adapter: FakeBeadsAdapter;
let service: TrackerSyncService;
/** Every (connection, secret) pair the injected factory was handed. */
let factoryCalls: Array<{ connection: TrackerConnectionRow; secret: string }>;
/** Project id → repo path, as the boot wiring's resolver would answer. */
let projectPaths: Map<number, string>;
/**
 * Every project id the service asked the resolver about. The custom-anchor
 * cases assert this stays EMPTY — "did not re-resolve from the project" is the
 * behaviour, and an assertion on the resulting path alone would also pass if
 * the project happened to sit at the same place.
 */
let resolvedProjectIds: number[];
/** What the injected native folder dialog answers with; null = the user cancelled. */
let pickedDirectory: string | null;
/** Every `bd` spawn the injected transport saw, for the init-button cases. */
let bdSpawns: Array<{ args: string[]; cwd: string }>;

/** A service over the SAME db — the "app restarted" shape. */
function buildService(): TrackerSyncService {
  return new TrackerSyncService({
    db: raw,
    router: router as EntityWriteRouter,
    nowIso: () => '2026-08-27T12:00:00.000Z',
    resolveProjectPath: (id) => {
      resolvedProjectIds.push(id);
      return projectPaths.get(id) ?? null;
    },
    pickWorkspaceDirectory: async () => pickedDirectory,
    beadsExec: async (_bin, args, options) => {
      bdSpawns.push({ args: [...args], cwd: options.cwd });
      return { stdout: '', stderr: '' };
    },
    adapterFactory: (connection, secret) => {
      factoryCalls.push({ connection, secret });
      return adapter;
    },
  });
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'cyboflow-trackersync-keyless-'));
  svc = new DatabaseService(join(tmpDir, 'test.db'));
  svc.initialize();
  raw = svc.getDb();
  raw
    .prepare('INSERT INTO projects (id, name, path) VALUES (?, ?, ?)')
    .run(PROJECT_ID, 'Proj 1', PROJECT_PATH);
  svc.seedDefaultBoard(PROJECT_ID);
  router = new TaskChangeRouter(dbAdapter(raw));
  adapter = new FakeBeadsAdapter();
  factoryCalls = [];
  projectPaths = new Map([[PROJECT_ID, PROJECT_PATH]]);
  resolvedProjectIds = [];
  pickedDirectory = null;
  bdSpawns = [];
  service = buildService();
});

afterEach(() => {
  service.stop();
  raw.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

/** A minimal keyless connect payload — no `credentials.apiKey` anywhere. */
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

/** Connect keylessly and wait for the fire-and-forget first pass to settle. */
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

// ---------------------------------------------------------------------------
// 1 · initial connect
// ---------------------------------------------------------------------------

describe('keyless connect — the row it writes', () => {
  it('stores a NULL secret, the instance id as workspace_id, and the resolved workspace path', async () => {
    const connectionId = await connectKeyless();
    const stored = row(connectionId);

    // The whole point: nothing key-shaped was written. `readSecret` answers
    // null both for "column is NULL" and "no such row", so the row itself is
    // asserted alongside it.
    expect(readSecret(raw, connectionId)).toBeNull();
    expect(stored.secret_ciphertext).toBeNull();
    expect(stored.status).toBe('active');
    // The IMMUTABLE database id, not the prefix — a same-path reinit changes
    // this one, which is what makes the identity check able to refuse.
    expect(stored.workspace_id).toBe(INSTANCE_ID);
    expect(stored.workspace_name).toBe(PREFIX);
    expect(stored.base_url).toBeNull();
    // Anchored to the project's repo, resolved MAIN-side from the project id
    // the payload carried.
    expect(beadsWorkspacePath(stored)).toBe(PROJECT_PATH);
  });

  it('leaves the source scope readable, so revival and the idempotent re-submit still work', async () => {
    const connectionId = await connectKeyless();

    // The workspace path rides on the same blob as the Step-1 selection; the
    // extra key must not disturb what reads that blob by name. The proof is
    // behavioural: a second identical connect recognizes the mapping and
    // returns the SAME id instead of minting a sibling.
    const again = await service.connect(keylessPayload());
    expect(again.connectionId).toBe(connectionId);
    expect(
      (raw.prepare('SELECT COUNT(*) AS n FROM tracker_connections').get() as { n: number }).n,
    ).toBe(1);
    // Still no secret after the re-submit path, which for a keyed provider is
    // exactly where the freshly validated key is re-stored.
    expect(readSecret(raw, connectionId)).toBeNull();
  });

  it('runs the first pass on the NULL secret, with an empty secret handed to the factory', async () => {
    adapter.issues = [makeIssue()];
    const connectionId = await connectKeyless();

    expect(adapter.calls).toContain('listIssues');
    expect(row(connectionId).last_sync_at).not.toBeNull();
    // Every construction — the wizard probe and the pass — went through with
    // '' rather than a decrypted key. The length assertion is what keeps this
    // from passing vacuously on a run that built no adapter at all.
    expect(factoryCalls.length).toBeGreaterThan(1);
    expect(factoryCalls.every((call) => call.secret === '')).toBe(true);
  });

  it('refuses to connect when the named project has no path on disk', async () => {
    projectPaths.clear();

    await expect(service.connect(keylessPayload())).rejects.toThrow(TrackerCredentialsError);
    expect(
      (raw.prepare('SELECT COUNT(*) AS n FROM tracker_connections').get() as { n: number }).n,
    ).toBe(0);
  });

  it('refuses to connect when the credentials name no project at all', async () => {
    await expect(
      service.connect(keylessPayload({ credentials: { provider: 'beads' } })),
    ).rejects.toThrow(TrackerCredentialsError);
  });
});

// ---------------------------------------------------------------------------
// 2 · "Sync now"
// ---------------------------------------------------------------------------

describe('keyless connect — Sync now', () => {
  it('drives a forced pass without reading a cipher', async () => {
    const connectionId = await connectKeyless();
    factoryCalls.length = 0;
    adapter.calls.length = 0;

    const result = await service.syncNow(connectionId);

    expect(result.ran).toBe(true);
    expect(result.paused).toBe(false);
    expect(result.error).toBeNull();
    expect(factoryCalls).toHaveLength(1);
    expect(factoryCalls[0].secret).toBe('');
    expect(row(connectionId).status).toBe('active');
  });
});

// ---------------------------------------------------------------------------
// 3 · mapping-management re-entry
// ---------------------------------------------------------------------------

describe('keyless connect — mapping management re-entry', () => {
  it('probes from the connection id without a stored key', async () => {
    const connectionId = await connectKeyless();

    // The add-mapping wizard names the connection instead of pasting a key.
    // For a keyed provider this resolves the stored cipher; for a keyless one
    // there is none, and throwing here would dead-end the surface entirely.
    const tree = await service.wizardGroups({ connectionId });

    expect(tree).toEqual(GROUPS);
  });

  it('anchors the re-entered probe to the connection’s own project, not the caller’s', async () => {
    const connectionId = await connectKeyless();
    // A second project exists, and a sibling mapping would target it — but the
    // WORKSPACE stays the one the connection was detected against.
    raw.prepare('INSERT INTO projects (id, name, path) VALUES (?, ?, ?)').run(2, 'Proj 2', '/tmp/other');
    projectPaths.set(2, '/tmp/other');
    factoryCalls.length = 0;

    await service.wizardGroups({ connectionId });

    expect(factoryCalls).toHaveLength(1);
    expect(beadsWorkspacePath(factoryCalls[0].connection)).toBe(PROJECT_PATH);
  });
});

// ---------------------------------------------------------------------------
// 4 · pause + re-detect
// ---------------------------------------------------------------------------

describe('keyless connect — re-detect', () => {
  it('resumes a paused connection when the workspace identity still matches', async () => {
    const connectionId = await connectKeyless();
    updateConnectionSettings(raw, connectionId, { status: 'paused' });

    const identity = await service.updateCredentials(connectionId);

    expect(identity.workspaceId).toBe(INSTANCE_ID);
    expect(row(connectionId).status).toBe('active');
    // Still nothing stored: re-detect is a probe, not a rotation.
    expect(readSecret(raw, connectionId)).toBeNull();
  });

  it('refuses when the `.beads` database was replaced, leaving the connection paused', async () => {
    const connectionId = await connectKeyless();
    updateConnectionSettings(raw, connectionId, { status: 'paused' });
    // `rm -rf .beads && bd init` — same path, same prefix, NEW database. Every
    // retained link points at issues that no longer exist.
    adapter.instanceId = '5c2f5a0e-0000-4000-8000-000000000002';

    await expect(service.updateCredentials(connectionId)).rejects.toThrow(
      /different workspace/i,
    );
    expect(row(connectionId).status).toBe('paused');
    expect(row(connectionId).workspace_id).toBe(INSTANCE_ID);
  });

  it('surfaces a failed detect without resuming', async () => {
    const connectionId = await connectKeyless();
    updateConnectionSettings(raw, connectionId, { status: 'paused' });
    adapter.failValidate = new TrackerAuthError(
      'beads',
      '`bd` was not found on PATH — install beads (github.com/gastownhall/beads) and re-detect this connection.',
    );

    await expect(service.updateCredentials(connectionId)).rejects.toThrow(/not found on PATH/);
    expect(row(connectionId).status).toBe('paused');
  });

  it('RE-ANCHORS a workspace whose repo moved on disk, so the next pass spawns in the right place', async () => {
    const connectionId = await connectKeyless();
    expect(beadsWorkspacePath(row(connectionId))).toBe(PROJECT_PATH);
    updateConnectionSettings(raw, connectionId, { status: 'paused' });

    // The repo was renamed/relocated. Same beads database (same instance id),
    // new location — so the identity check passes and re-detect succeeds.
    const MOVED = '/tmp/p1-renamed';
    raw.prepare('UPDATE projects SET path = ? WHERE id = ?').run(MOVED, PROJECT_ID);
    projectPaths.set(PROJECT_ID, MOVED);

    await service.updateCredentials(connectionId);

    // WITHOUT the re-stamp this is where the loop starts: re-detect keeps
    // succeeding against the new path while the row keeps naming the old one,
    // so every following pass spawns in a directory with no workspace and
    // pauses again, with no way out.
    expect(beadsWorkspacePath(row(connectionId))).toBe(MOVED);

    // And it is the path the NEXT adapter build actually sees — the thing that
    // was broken, since a pass reads the anchor off the stored row.
    factoryCalls.length = 0;
    await service.wizardGroups({ connectionId });
    expect(beadsWorkspacePath(factoryCalls[0].connection)).toBe(MOVED);
  });

  it('re-anchoring preserves the rest of source_json', async () => {
    const connectionId = await connectKeyless();
    const before = JSON.parse(row(connectionId).source_json ?? '{}') as Record<string, unknown>;
    projectPaths.set(PROJECT_ID, '/tmp/p1-renamed');
    raw.prepare('UPDATE projects SET path = ? WHERE id = ?').run('/tmp/p1-renamed', PROJECT_ID);

    await service.updateCredentials(connectionId);

    const after = JSON.parse(row(connectionId).source_json ?? '{}') as Record<string, unknown>;
    // Step-1 choice, label, and everything else the blob carries survive — only
    // the anchor moved.
    expect(after).toEqual({ ...before, workspacePath: '/tmp/p1-renamed' });
  });

  it('leaves a KEYED provider’s source_json untouched — it has no workspace path to anchor', async () => {
    insertConnection(raw, {
      id: 'conn-linear',
      project_id: PROJECT_ID,
      provider: 'linear',
      status: 'paused',
      workspace_id: 'ws-linear',
      workspace_name: 'Acme',
      actor_label: 'K.',
      base_url: null,
      secret_ciphertext: null,
      source_json: JSON.stringify({ containerId: 'team-1', narrowId: 'all', narrowKind: 'all' }),
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
    });
    const before = row('conn-linear').source_json;
    adapter.instanceId = 'ws-linear';

    await service.updateCredentials('conn-linear', 'lin_api_key');

    expect(row('conn-linear').source_json).toBe(before);
  });

  it('refuses a key offered to a keyless connection rather than silently dropping it', async () => {
    const connectionId = await connectKeyless();

    // Accepting-and-ignoring would leave the user believing a credential is
    // now stored and rotating, when nothing of the sort happened.
    await expect(service.updateCredentials(connectionId, 'lin_api_key')).rejects.toThrow(
      TrackerCredentialsError,
    );
    expect(readSecret(raw, connectionId)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 4b · a workspace the user pointed at
//
// The wizard can anchor a keyless connection to a folder that is NOT the
// project's repo (a monorepo subdirectory, a workspace kept outside the repo).
// Main runs the dialog and hands out a TOKEN, so the path never has to come
// from the renderer; the cases below are about what that token buys and what it
// must never let through.
// ---------------------------------------------------------------------------

/** Somewhere the project's repo path could never resolve to. */
const CUSTOM_PATH = '/tmp/monorepo/packages/api';

/** Drive the injected dialog and return the token+path main minted. */
async function pickWorkspace(path: string): Promise<{ token: string; path: string }> {
  pickedDirectory = path;
  const picked = await service.wizardPickWorkspace('beads');
  if (picked === null) throw new Error('the picker answered null for a folder it was given');
  return picked;
}

/** Connect anchored to a picked folder rather than to the project's repo. */
async function connectPicked(token: string): Promise<string> {
  const { connectionId } = await service.connect(
    keylessPayload({
      credentials: { provider: 'beads', projectId: PROJECT_ID, workspaceDirToken: token },
    }),
  );
  return connectionId;
}

/** The whole `source_json` blob, for the extras that ride beside the scope. */
function sourceBlob(connectionId: string): Record<string, unknown> {
  return JSON.parse(row(connectionId).source_json ?? '{}') as Record<string, unknown>;
}

describe('keyless connect — a picked workspace folder', () => {
  it('refuses to pick a folder for a KEYED provider', async () => {
    // There is no local workspace to point a Linear connection at; the question
    // does not apply to it, so it is refused rather than answered with a dialog.
    await expect(service.wizardPickWorkspace('linear')).rejects.toThrow(TrackerCredentialsError);
  });

  it('answers null when the user cancels, minting nothing', async () => {
    pickedDirectory = null;

    await expect(service.wizardPickWorkspace('beads')).resolves.toBeNull();
  });

  it('anchors the connection to the picked folder and records that it is custom', async () => {
    const { token, path } = await pickWorkspace(CUSTOM_PATH);
    expect(path).toBe(CUSTOM_PATH);

    const connectionId = await connectPicked(token);

    expect(beadsWorkspacePath(row(connectionId))).toBe(CUSTOM_PATH);
    // The provenance, without which re-detect would drag the connection back to
    // the project's repo — see the re-detect case below.
    expect(sourceBlob(connectionId).workspaceSource).toBe('custom');
    // The Step-1 scope still reads off the same blob, so revival and the
    // idempotent re-submit are undisturbed by the second extra key.
    expect(sourceBlob(connectionId).containerId).toBe(WORKSPACE_CONTAINER_ID);
    // And the pass builds its adapter against the picked folder, not the repo.
    expect(beadsWorkspacePath(factoryCalls[0].connection)).toBe(CUSTOM_PATH);
  });

  it('leaves a project-anchored connect with no provenance key at all', async () => {
    const connectionId = await connectKeyless();

    // Absent, not `'project'`: that is what every row minted before the picker
    // existed says, and the two must stay indistinguishable.
    expect(sourceBlob(connectionId)).not.toHaveProperty('workspaceSource');
    expect(beadsWorkspacePath(row(connectionId))).toBe(PROJECT_PATH);
  });

  it('refuses a token it never minted rather than quietly probing the project repo', async () => {
    // Falling through to the project path is the one way this could mislead:
    // the wizard would report a successful detect for a DIFFERENT workspace
    // than the folder the user picked.
    await expect(
      service.connect(
        keylessPayload({
          credentials: {
            provider: 'beads',
            projectId: PROJECT_ID,
            workspaceDirToken: 'not-a-token-main-minted',
          },
        }),
      ),
    ).rejects.toThrow(/pick it again/);
    expect(
      (raw.prepare('SELECT COUNT(*) AS n FROM tracker_connections').get() as { n: number }).n,
    ).toBe(0);
  });

  it('evicts the oldest token once the cap is reached, and the evicted one fails closed', async () => {
    const { token: oldest } = await pickWorkspace(CUSTOM_PATH);
    for (let i = 0; i < MAX_PICKED_WORKSPACE_PATHS; i += 1) {
      await pickWorkspace(`${CUSTOM_PATH}-${i}`);
    }

    await expect(
      service.connect(
        keylessPayload({
          credentials: { provider: 'beads', projectId: PROJECT_ID, workspaceDirToken: oldest },
        }),
      ),
    ).rejects.toThrow(/pick it again/);
  });

  it('re-detects against the STORED path, never re-resolving the project', async () => {
    const { token } = await pickWorkspace(CUSTOM_PATH);
    const connectionId = await connectPicked(token);
    updateConnectionSettings(raw, connectionId, { status: 'paused' });

    // The project's repo moves. Irrelevant to a workspace that never lived
    // there — and following it would re-point the connection at whatever beads
    // database happens to sit in the repo, which is worse than failing.
    projectPaths.set(PROJECT_ID, '/tmp/p1-renamed');
    resolvedProjectIds.length = 0;
    factoryCalls.length = 0;

    await service.updateCredentials(connectionId);

    expect(resolvedProjectIds).toEqual([]);
    expect(beadsWorkspacePath(factoryCalls[0].connection)).toBe(CUSTOM_PATH);
    expect(beadsWorkspacePath(row(connectionId))).toBe(CUSTOM_PATH);
    // Still custom after the re-stamp, so the NEXT re-detect makes the same
    // choice rather than reverting to the project on the second pass.
    expect(sourceBlob(connectionId).workspaceSource).toBe('custom');
    expect(row(connectionId).status).toBe('active');
  });

  it('re-detects a PROJECT-anchored connection from the project, as it always did', async () => {
    const connectionId = await connectKeyless();
    updateConnectionSettings(raw, connectionId, { status: 'paused' });
    projectPaths.set(PROJECT_ID, '/tmp/p1-renamed');
    resolvedProjectIds.length = 0;

    await service.updateCredentials(connectionId);

    // The other side of the branch: the custom arm must not have swallowed the
    // moved-repo re-anchor the ordinary case depends on.
    expect(resolvedProjectIds).toContain(PROJECT_ID);
    expect(beadsWorkspacePath(row(connectionId))).toBe('/tmp/p1-renamed');
    expect(sourceBlob(connectionId)).not.toHaveProperty('workspaceSource');
  });

  it('re-enters mapping management against the picked folder, not the project repo', async () => {
    const { token } = await pickWorkspace(CUSTOM_PATH);
    const connectionId = await connectPicked(token);
    factoryCalls.length = 0;

    // The add-mapping wizard names the connection instead of pasting a key, and
    // main resolves the anchor itself. Resolving it from the project here would
    // probe one workspace and then mint the sibling mapping against another.
    await service.wizardGroups({ connectionId });

    expect(beadsWorkspacePath(factoryCalls[0].connection)).toBe(CUSTOM_PATH);
  });

  it('fails a custom anchor whose folder no longer holds the workspace, with no special arm', async () => {
    const { token } = await pickWorkspace(CUSTOM_PATH);
    const connectionId = await connectPicked(token);
    updateConnectionSettings(raw, connectionId, { status: 'paused' });
    adapter.failValidate = new TrackerAuthError(
      'beads',
      'no beads database found — run `bd init` in this repo',
    );

    await expect(service.updateCredentials(connectionId)).rejects.toThrow(/no beads database/);
    expect(row(connectionId).status).toBe('paused');
    // The anchor is untouched by a failed probe: re-pointing it is the user's
    // call, made with the picker, not something a failure does on its own.
    expect(beadsWorkspacePath(row(connectionId))).toBe(CUSTOM_PATH);
  });
});

// ---------------------------------------------------------------------------
// 4c · initializing the workspace Detect could not find
//
// The wizard's "Initialize beads here" button. It resolves its folder through
// exactly the same private path the Detect probe does, so the cases here are
// about WHERE the CLI is spawned — the one thing the renderer must never get to
// decide — rather than about what `bd init` writes.
// ---------------------------------------------------------------------------

describe('keyless connect — initializing a workspace', () => {
  it('refuses a keyed provider, which has no local workspace to create', async () => {
    await expect(
      service.wizardInitWorkspace({ provider: 'linear', apiKey: 'lin_1' }),
    ).rejects.toThrow(TrackerCredentialsError);
    expect(bdSpawns).toEqual([]);
  });

  it('initializes in the PICKED folder, never re-resolving the project', async () => {
    const { token } = await pickWorkspace(CUSTOM_PATH);
    resolvedProjectIds.length = 0;

    await service.wizardInitWorkspace({
      provider: 'beads',
      projectId: PROJECT_ID,
      workspaceDirToken: token,
    });

    // Both halves matter: init runs with the folder as CWD and NO `-C` (bd
    // refuses `-C` on init), and the resolver was never asked — a project-path
    // fallback here would create a workspace in a repo the user did not point at.
    expect(bdSpawns.map((spawn) => spawn.args)).toEqual([
      ['init', '--stealth'],
      ['metrics', 'off'],
    ]);
    expect(bdSpawns.every((spawn) => spawn.cwd === CUSTOM_PATH)).toBe(true);
    expect(resolvedProjectIds).toEqual([]);
  });

  it('initializes in the project repo when no folder was picked', async () => {
    await service.wizardInitWorkspace({ provider: 'beads', projectId: PROJECT_ID });

    expect(bdSpawns[0].cwd).toBe(PROJECT_PATH);
    expect(resolvedProjectIds).toContain(PROJECT_ID);
  });

  it('fails closed on a token main never minted, spawning nothing', async () => {
    // Same refusal the connect path makes, and for the stronger reason: falling
    // through to the project repo would `bd init` a directory the user never
    // named.
    await expect(
      service.wizardInitWorkspace({
        provider: 'beads',
        projectId: PROJECT_ID,
        workspaceDirToken: 'not-a-token-main-minted',
      }),
    ).rejects.toThrow(/pick it again/);
    expect(bdSpawns).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 5 · app restart
// ---------------------------------------------------------------------------

describe('keyless connect — app restart', () => {
  it('syncs a NULL-secret row loaded fresh from the database', async () => {
    const connectionId = await connectKeyless();
    // Nothing in memory carries over a restart; the row is all there is.
    service.stop();
    factoryCalls.length = 0;
    service = buildService();

    const result = await service.syncNow(connectionId);

    expect(result.ran).toBe(true);
    expect(result.paused).toBe(false);
    expect(result.error).toBeNull();
    expect(factoryCalls[0].secret).toBe('');
  });
});

// ---------------------------------------------------------------------------
// Negatives — the widening must not become a global loosening
// ---------------------------------------------------------------------------

describe('keyed providers are unaffected by the keyless widening', () => {
  /** A linear row whose ciphertext is NULL — the state keyless rows live in. */
  function insertKeylessLinearRow(): string {
    insertConnection(raw, {
      id: 'trk_linear_nokey',
      project_id: PROJECT_ID,
      provider: 'linear',
      status: 'active',
      workspace_id: 'ws-1',
      workspace_name: 'Acme',
      actor_label: 'K. Esteva',
      base_url: null,
      secret_ciphertext: null,
      source_json: JSON.stringify({ ...SOURCE, label: 'Core' }),
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
      mirror_subissues: 0,
      conflict_mode: 'auto',
      cursor_updated_at: null,
      cursor_external_id: null,
      last_sync_at: null,
      last_sync_log_json: null,
    });
    return 'trk_linear_nokey';
  }

  it('still treats a NULL ciphertext on a KEYED connection as fatal', async () => {
    const connectionId = insertKeylessLinearRow();

    const result = await service.syncNow(connectionId);

    // The pass does not reject — every failure is folded into the result — but
    // it must not have built an adapter, and it must pause the row.
    expect(factoryCalls).toHaveLength(0);
    expect(result.paused).toBe(true);
    expect(row(connectionId).status).toBe('paused');
  });

  it('refuses a keyed connect that carries no key', async () => {
    await expect(
      service.connect(
        keylessPayload({
          // The shape the wire type now permits and the provider does not.
          credentials: { provider: 'linear' },
        }),
      ),
    ).rejects.toThrow(TrackerCredentialsError);
  });

  it('refuses a keyed re-connect that carries no key', async () => {
    const connectionId = insertKeylessLinearRow();

    await expect(service.updateCredentials(connectionId)).rejects.toThrow(TrackerCredentialsError);
  });
});

// ---------------------------------------------------------------------------
// The real factory's beads branch
// ---------------------------------------------------------------------------

describe('defaultAdapterFactory — beads', () => {
  function beadsRow(sourceJson: string | null): TrackerConnectionRow {
    return {
      id: 'trk_beads',
      project_id: PROJECT_ID,
      provider: 'beads',
      status: 'active',
      workspace_id: INSTANCE_ID,
      workspace_name: PREFIX,
      actor_label: 'K. Esteva',
      base_url: null,
      secret_ciphertext: null,
      source_json: sourceJson,
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
      mirror_subissues: 0,
      conflict_mode: 'auto',
      cursor_updated_at: null,
      cursor_external_id: null,
      last_sync_at: null,
      last_sync_log_json: null,
      created_at: '',
      updated_at: '',
    };
  }

  it('builds a BeadsAdapter from the workspace path on the row', () => {
    const adapterUnderTest = defaultAdapterFactory(
      beadsRow(JSON.stringify({ ...SOURCE, workspacePath: PROJECT_PATH })),
      '',
    );

    expect(adapterUnderTest.provider).toBe('beads');
  });

  it('refuses a row with no recorded workspace path, naming re-detect as the fix', () => {
    expect(() => defaultAdapterFactory(beadsRow(JSON.stringify(SOURCE)), '')).toThrow(
      /re-detect/i,
    );
    expect(() => defaultAdapterFactory(beadsRow(null), '')).toThrow(TrackerCredentialsError);
  });
});
