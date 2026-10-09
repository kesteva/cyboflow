/**
 * Unit tests for the TRACKER CLAIM GATE seam (claimGate.ts): with
 * cross-machine backlog sync on, a tracker connection runs on only the device
 * holding its claim, so every path that makes a connection run asks the gate
 * first and leaves the row PAUSED — connected, never running — when denied.
 *
 * Wiring mirrors keylessConnect.test.ts: a REAL temp-file DB through the full
 * migration chain, a REAL TaskChangeRouter, and a beads-shaped fake adapter
 * (the keyless path needs no network or key mocks). The gate is a recording
 * fake whose answer each case scripts.
 *
 * "No pass ran" is asserted on the `syncNow` kick itself, not on adapter
 * calls: a pass against a paused row is a no-op anyway, so only the kick
 * proves the denied path skipped it.
 *
 * Covers: no gate (today's behaviour), allow, deny (paused + hold reason, no
 * kick), a throwing gate (fails closed), pause/resume, disconnect → release,
 * key rotation over siblings in two projects, the prefix remap, workspace
 * adoption, and listLive.
 */
import { describe, it, expect, beforeEach, afterEach, vi, type MockInstance } from 'vitest';
import type Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The global setup mocks `electron` without safeStorage; override it here
// (hoisted before imports) exactly as keylessConnect.test.ts does.
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
import {
  trackerProjectChannel,
  trackerSyncEvents,
  type TrackerChangedEvent,
} from '../../../orchestrator/trackerSyncBridge';
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
import type { TrackerClaimDecision, TrackerClaimGate, TrackerClaimSubject } from '../claimGate';
import type { EntityWriteRouter } from '../inboundSync';
import { getConnection } from '../store';
import { TrackerSyncService } from '../trackerSyncService';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const PROJECT_ID = 1;
const PROJECT_PATH = '/tmp/claim-repo';
const OTHER_PROJECT_ID = 2;
const OTHER_PROJECT_PATH = '/tmp/claim-repo-2';
const INSTANCE_ID = 'cc000000-0000-4000-8000-000000000001';
const NEW_INSTANCE_ID = 'dd000000-0000-4000-8000-000000000002';
const PREFIX = 'clm';
const NEW_PREFIX = 'newclm';
const WORKSPACE_CONTAINER_ID = 'workspace';
const HOLD = 'Runs on Studio';

const SOURCE: TrackerSourceSelection = {
  containerId: WORKSPACE_CONTAINER_ID,
  narrowId: 'all',
  narrowKind: 'all',
};

const STATES: TrackerState[] = [
  { id: 'open', name: 'Open', color: null, group: 'backlog' },
  { id: 'closed', name: 'Closed', color: null, group: 'completed' },
];

/** A beads-shaped adapter (see keylessConnect.test.ts) with mutable identity halves. */
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

  async validateCredentials(): Promise<TrackerWorkspaceIdentity> {
    this.calls.push('validateCredentials');
    return { workspaceId: this.instanceId, workspaceName: this.prefix, actorLabel: 'K. Esteva' };
  }
  async listGroups(): Promise<TrackerGroupTree> {
    return { sections: [] };
  }
  async listContainers(): Promise<TrackerSourceTree> {
    return { containerLabel: 'Workspace', containers: [] };
  }
  async listNarrows(): Promise<TrackerSourceNarrow[]> {
    return [];
  }
  async listStates(): Promise<TrackerState[]> {
    this.calls.push('listStates');
    return STATES;
  }
  async listFieldOptions(): Promise<TrackerFieldOptionsRaw> {
    return { priorities: ['0', '1', '2'], categories: ['bug', 'feature', 'task'] };
  }
  async listIssues(): Promise<TrackerIssue[]> {
    this.calls.push('listIssues');
    return this.issues;
  }
  async listIssueIds(): Promise<string[]> {
    return this.issues.map((issue) => issue.externalId);
  }
  async listIssueRevisions(): Promise<Array<{ id: string; revision: string }>> {
    return this.issues.map((issue) => ({ id: issue.externalId, revision: `rev-${issue.externalId}` }));
  }
  async getIssue(): Promise<TrackerIssue | null> {
    return null;
  }
  async createIssue(
    _selection: TrackerSourceSelection,
    _draft: IssueDraft,
    _clientKey: string,
  ): Promise<TrackerIssue> {
    throw new Error('not used');
  }
  async createSubIssue(): Promise<TrackerIssue> {
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

/** A recording gate whose acquire answer each case scripts. */
class FakeClaimGate implements TrackerClaimGate {
  decision: TrackerClaimDecision = { allowed: true };
  throwOnAcquire = false;
  hold: string | null = null;
  readonly acquired: TrackerClaimSubject[] = [];
  readonly released: TrackerClaimSubject[] = [];

  async acquire(subject: TrackerClaimSubject): Promise<TrackerClaimDecision> {
    this.acquired.push(subject);
    if (this.throwOnAcquire) throw new Error('relay unreachable');
    return this.decision;
  }
  release(subject: TrackerClaimSubject): void {
    this.released.push(subject);
  }
  holdReason(): string | null {
    return this.hold;
  }

  deny(reason = HOLD): void {
    this.decision = { allowed: false, reason };
    this.hold = reason;
  }
  allow(): void {
    this.decision = { allowed: true };
    this.hold = null;
  }
}

let tmpDir: string;
let svc: DatabaseService;
let raw: Database.Database;
let router: TaskChangeRouter;
let adapter: FakeBeadsAdapter;
let gate: FakeClaimGate;
let service: TrackerSyncService;
let projectPaths: Map<number, string>;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'cyboflow-trackersync-claim-'));
  svc = new DatabaseService(join(tmpDir, 'test.db'));
  svc.initialize();
  raw = svc.getDb();
  for (const [id, path] of [
    [PROJECT_ID, PROJECT_PATH],
    [OTHER_PROJECT_ID, OTHER_PROJECT_PATH],
  ] as const) {
    raw.prepare('INSERT INTO projects (id, name, path) VALUES (?, ?, ?)').run(id, `Proj ${id}`, path);
    svc.seedDefaultBoard(id);
  }
  router = new TaskChangeRouter(dbAdapter(raw));
  adapter = new FakeBeadsAdapter();
  gate = new FakeClaimGate();
  projectPaths = new Map([
    [PROJECT_ID, PROJECT_PATH],
    [OTHER_PROJECT_ID, OTHER_PROJECT_PATH],
  ]);
  service = new TrackerSyncService({
    db: raw,
    router: router as EntityWriteRouter,
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

function keylessPayload(projectId: number = PROJECT_ID): TrackerConnectPayload {
  return {
    projectId,
    credentials: { provider: 'beads', projectId },
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
  };
}

function makeIssue(externalId: string): TrackerIssue {
  return {
    externalId,
    identifier: externalId,
    title: `Issue ${externalId}`,
    description: null,
    url: externalId,
    stateId: 'open',
    assignee: null,
    estimate: null,
    parentExternalId: null,
    updatedAt: '2026-08-27T10:00:00.000Z',
    archivedAt: null,
    priority: '1',
    category: 'task',
    recoveryClientKey: null,
  };
}

/** Spy on the fire-and-forget pass kicks (internal calls go through `this.syncNow`). */
function spyKicks(): MockInstance<TrackerSyncService['syncNow']> {
  return vi.spyOn(service, 'syncNow');
}

/** Connect with no gate wired and settle the first pass. */
async function connectUngated(projectId: number = PROJECT_ID): Promise<string> {
  const { connectionId } = await service.connect(keylessPayload(projectId));
  await service.syncNow(connectionId);
  return connectionId;
}

function row(connectionId: string): TrackerConnectionRow {
  const found = getConnection(raw, connectionId);
  if (found === null) throw new Error(`no connection ${connectionId}`);
  return found;
}

function pauseRaw(connectionId: string): void {
  raw.prepare("UPDATE tracker_connections SET status = 'paused' WHERE id = ?").run(connectionId);
}

function captureChanges(projectId: number): { events: TrackerChangedEvent[]; stop: () => void } {
  const events: TrackerChangedEvent[] = [];
  const listener = (event: TrackerChangedEvent): void => {
    events.push(event);
  };
  trackerSyncEvents.on(trackerProjectChannel(projectId), listener);
  return {
    events,
    stop: () => trackerSyncEvents.off(trackerProjectChannel(projectId), listener),
  };
}

// ---------------------------------------------------------------------------
// connect
// ---------------------------------------------------------------------------

describe('connect — through the tracker claim gate', () => {
  it('with NO gate runs exactly as before: active, and the first pass is kicked', async () => {
    const kicks = spyKicks();
    const { connectionId } = await service.connect(keylessPayload());

    expect(row(connectionId).status).toBe('active');
    expect(kicks).toHaveBeenCalledWith(connectionId);
    await kicks.mock.results[0].value;
    expect(adapter.calls).toContain('listIssues');
    const [summary] = await service.connections(PROJECT_ID);
    expect(summary.claimHold).toBeNull();
  });

  it('with an ALLOWING gate is active, and the gate saw the mapping identity', async () => {
    service.setClaimGate(gate);
    const kicks = spyKicks();
    const { connectionId } = await service.connect(keylessPayload());

    expect(row(connectionId).status).toBe('active');
    expect(kicks).toHaveBeenCalledWith(connectionId);
    await kicks.mock.results[0].value;
    expect(gate.acquired).toEqual([
      {
        projectId: PROJECT_ID,
        provider: 'beads',
        workspaceId: INSTANCE_ID,
        baseUrl: null,
        workspaceName: PREFIX,
      },
    ]);
  });

  it('with a DENYING gate is connected but paused, carries the hold reason, and runs no pass', async () => {
    service.setClaimGate(gate);
    gate.deny();
    const kicks = spyKicks();
    const { connectionId } = await service.connect(keylessPayload());

    expect(row(connectionId).status).toBe('paused');
    expect(kicks).not.toHaveBeenCalled();
    expect(adapter.calls).not.toContain('listIssues');
    expect(row(connectionId).last_sync_at).toBeNull();
    const [summary] = await service.connections(PROJECT_ID);
    expect(summary.status).toBe('paused');
    expect(summary.claimHold).toBe(HOLD);
  });

  it('with a THROWING gate fails closed: paused, no pass', async () => {
    service.setClaimGate(gate);
    gate.throwOnAcquire = true;
    const kicks = spyKicks();
    const { connectionId } = await service.connect(keylessPayload());

    expect(row(connectionId).status).toBe('paused');
    expect(kicks).not.toHaveBeenCalled();
  });

  it('a denied re-submit of a PAUSED mapping leaves it paused and kicks nothing', async () => {
    const connectionId = await connectUngated();
    pauseRaw(connectionId);
    service.setClaimGate(gate);
    gate.deny();
    const kicks = spyKicks();

    const again = await service.connect(keylessPayload());

    expect(again.connectionId).toBe(connectionId);
    expect(row(connectionId).status).toBe('paused');
    expect(kicks).not.toHaveBeenCalled();
  });

  it('a denied REVIVAL of a disconnected mapping comes back paused', async () => {
    const connectionId = await connectUngated();
    await service.disconnect(connectionId);
    service.setClaimGate(gate);
    gate.deny();
    const kicks = spyKicks();

    const again = await service.connect(keylessPayload());

    expect(again.connectionId).toBe(connectionId);
    expect(row(connectionId).status).toBe('paused');
    expect(kicks).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// TrackerClaimConnections — listLive / pause / resume
// ---------------------------------------------------------------------------

describe('listLive / pause / resume', () => {
  it('listLive returns the project’s active and paused rows, never a disconnected one', async () => {
    const live = await connectUngated();
    const retired = await connectUngated(OTHER_PROJECT_ID);
    await service.disconnect(retired);

    expect(service.listLive(PROJECT_ID)).toEqual([
      {
        id: live,
        status: 'active',
        projectId: PROJECT_ID,
        provider: 'beads',
        workspaceId: INSTANCE_ID,
        baseUrl: null,
        workspaceName: PREFIX,
      },
    ]);
    expect(service.listLive(OTHER_PROJECT_ID)).toEqual([]);

    pauseRaw(live);
    expect(service.listLive(PROJECT_ID).map((c) => c.status)).toEqual(['paused']);
  });

  it('pause pauses an active row and broadcasts; a paused row is left alone', async () => {
    const connectionId = await connectUngated();
    const changes = captureChanges(PROJECT_ID);
    try {
      service.pause(connectionId);
      expect(row(connectionId).status).toBe('paused');
      expect(changes.events).toEqual([
        { projectId: PROJECT_ID, connectionId, kind: 'connection' },
      ]);

      service.pause(connectionId);
      expect(changes.events).toHaveLength(1);
    } finally {
      changes.stop();
    }
  });

  it('pause never touches a disconnected row', async () => {
    const connectionId = await connectUngated();
    await service.disconnect(connectionId);
    service.pause(connectionId);
    expect(row(connectionId).status).toBe('disconnected');
  });

  it('a DENIED resume stays paused but still broadcasts the change', async () => {
    const connectionId = await connectUngated();
    service.pause(connectionId);
    service.setClaimGate(gate);
    gate.deny();
    const kicks = spyKicks();
    const changes = captureChanges(PROJECT_ID);
    try {
      await expect(service.resume(connectionId)).resolves.toEqual({ allowed: false, reason: HOLD });
      expect(row(connectionId).status).toBe('paused');
      expect(kicks).not.toHaveBeenCalled();
      expect(changes.events).toHaveLength(1);
    } finally {
      changes.stop();
    }
  });

  it('an ALLOWED resume goes active and kicks a pass', async () => {
    const connectionId = await connectUngated();
    service.pause(connectionId);
    service.setClaimGate(gate);
    const kicks = spyKicks();

    await expect(service.resume(connectionId)).resolves.toEqual({ allowed: true });

    expect(row(connectionId).status).toBe('active');
    expect(kicks).toHaveBeenCalledWith(connectionId);
    await kicks.mock.results[0].value;
  });

  it('resume answers without asking the gate for an active, retired or unknown row', async () => {
    const connectionId = await connectUngated();
    service.setClaimGate(gate);

    await expect(service.resume(connectionId)).resolves.toEqual({ allowed: true });
    await service.disconnect(connectionId);
    await expect(service.resume(connectionId)).resolves.toEqual({
      allowed: false,
      reason: 'Not paused',
    });
    await expect(service.resume('trk_nope')).resolves.toEqual({
      allowed: false,
      reason: 'Not paused',
    });
    expect(gate.acquired).toEqual([]);
    expect(row(connectionId).status).toBe('disconnected');
  });
});

// ---------------------------------------------------------------------------
// disconnect, key rotation, recovery
// ---------------------------------------------------------------------------

describe('the other activation paths', () => {
  it('disconnect releases the claim, and a throwing release never breaks it', async () => {
    const connectionId = await connectUngated();
    service.setClaimGate(gate);

    await service.disconnect(connectionId);

    expect(row(connectionId).status).toBe('disconnected');
    expect(gate.released).toEqual([
      {
        projectId: PROJECT_ID,
        provider: 'beads',
        workspaceId: INSTANCE_ID,
        baseUrl: null,
        workspaceName: PREFIX,
      },
    ]);

    const other = await connectUngated(OTHER_PROJECT_ID);
    gate.release = (): void => {
      throw new Error('boom');
    };
    await expect(service.disconnect(other)).resolves.toBeUndefined();
    expect(row(other).status).toBe('disconnected');
  });

  it('a DENIED key rotation (re-detect) leaves every sibling paused, each asked for its own claim', async () => {
    const first = await connectUngated(PROJECT_ID);
    const second = await connectUngated(OTHER_PROJECT_ID);
    pauseRaw(first);
    pauseRaw(second);
    service.setClaimGate(gate);
    gate.deny();
    const kicks = spyKicks();

    await service.updateCredentials(first);

    expect(row(first).status).toBe('paused');
    expect(row(second).status).toBe('paused');
    expect(kicks).not.toHaveBeenCalled();
    expect(gate.acquired.map((s) => s.projectId).sort()).toEqual([PROJECT_ID, OTHER_PROJECT_ID]);
  });

  it('a key rotation resumes only the siblings whose claim is allowed', async () => {
    const first = await connectUngated(PROJECT_ID);
    const second = await connectUngated(OTHER_PROJECT_ID);
    pauseRaw(first);
    pauseRaw(second);
    service.setClaimGate({
      acquire: async (subject) =>
        subject.projectId === PROJECT_ID ? { allowed: true } : { allowed: false, reason: HOLD },
      release: () => undefined,
      holdReason: () => HOLD,
    });
    const kicks = spyKicks();

    await service.updateCredentials(first);

    expect(row(first).status).toBe('active');
    expect(row(second).status).toBe('paused');
    expect(kicks.mock.calls).toEqual([[first]]);
    await kicks.mock.results[0].value;
  });

  it('a DENIED prefix remap still rewrites the prefix but stays paused', async () => {
    adapter.issues = [makeIssue(`${PREFIX}-2lz`)];
    const connectionId = await connectUngated();
    pauseRaw(connectionId);
    adapter.prefix = NEW_PREFIX;
    adapter.issues = [makeIssue(`${NEW_PREFIX}-2lz`)];
    service.setClaimGate(gate);
    gate.deny();
    const kicks = spyKicks();

    const result = await service.remapRenamedPrefix(connectionId);

    expect(result.remappedLinks).toBe(1);
    expect(row(connectionId).workspace_name).toBe(NEW_PREFIX);
    expect(row(connectionId).status).toBe('paused');
    expect(kicks).not.toHaveBeenCalled();
    expect(gate.acquired.at(-1)?.workspaceName).toBe(NEW_PREFIX);
  });

  it('a DENIED workspace adoption mints the fresh row paused, keyed on the NEW instance', async () => {
    const connectionId = await connectUngated();
    pauseRaw(connectionId);
    adapter.instanceId = NEW_INSTANCE_ID;
    service.setClaimGate(gate);
    gate.deny();
    const kicks = spyKicks();

    const { newConnectionId } = await service.adoptNewWorkspace(connectionId);

    expect(row(connectionId).status).toBe('disconnected');
    expect(row(newConnectionId).status).toBe('paused');
    expect(kicks).not.toHaveBeenCalled();
    expect(gate.acquired.at(-1)?.workspaceId).toBe(NEW_INSTANCE_ID);
    // The retired row's claim was released on the way out.
    expect(gate.released.map((s) => s.workspaceId)).toEqual([INSTANCE_ID]);
  });
});
