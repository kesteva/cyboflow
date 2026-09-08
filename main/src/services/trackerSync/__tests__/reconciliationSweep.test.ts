/**
 * Unit tests for the RECONCILIATION half of `runDeletionSweep`
 * (main/src/services/trackerSync/inboundSync.ts) — the timestamp-independent
 * backstop a provider gets by declaring
 * `TrackerAdapterCapabilities.requiresIdReconciliation`. Design:
 * docs/proposals/tracker-beads-provider.md, "4. Pull reconciliation".
 *
 * Wiring is inboundSync.test.ts's: a REAL temp-file DB through the full
 * migration chain, a REAL TaskChangeRouter over it, and a canned adapter — but
 * a beads-shaped one, whose sweep reports (id, revision) pairs and whose
 * fingerprints the tests move by hand. `getIssue` COUNTS ITS CALLS, because the
 * thing under test is not only what the sweep decides but what it declines to
 * spend: the ledger exists to make an unchanged sweep cost one listing.
 *
 * Covered, per the proposal's named tests:
 *   - a repeat sweep over unchanged ledgered ids performs ZERO point lookups,
 *     and the same for unchanged LINKED ids.
 *   - a changed fingerprint (ledgered or linked) costs exactly one lookup, and
 *     a ledgered id that a remote edit made eligible is imported rather than
 *     suppressed forever.
 *   - a config change (the `config_generation` bump) re-considers exactly the
 *     eligible skipped ids, exactly once.
 *   - an unseen id imports through the ordinary path and gets NO ledger row;
 *     one resolved without a link gets one carrying the gate it took.
 *   - resurrection: an orphaned link whose id reappears is un-archived, and a
 *     link orphaned by anything OTHER than the sweep is left alone.
 *   - opportunistic cleanup of ledger rows whose id left the remote set.
 *   - a provider WITHOUT the flag still takes the bare `listIssueIds` path.
 *   - an adapter that declares the flag but implements no `listIssueRevisions`
 *     fails loudly instead of silently degrading.
 *   - the BEST-EFFORT HEAD guard: a workspace token that moved between the
 *     sweep's start and its first archive defers ONLY the archival subset (the
 *     imports in the same sweep still land), a stable token archives normally
 *     and costs exactly one re-read however many links it archives, and every
 *     way the token can be unavailable — no linked id to address the read with,
 *     a null capture, a null re-read, an adapter with no `workspaceHead` at all
 *     — degrades to NO guard rather than to a blocked sweep.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseService } from '../../../database/database';
import { TaskChangeRouter } from '../../../orchestrator/taskChangeRouter';
import { dbAdapter } from '../../../orchestrator/__test_fixtures__/dbAdapter';
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
  TrackerAdapter,
  TrackerAdapterCapabilities,
  TrackerFieldOptionsRaw,
} from '../adapterTypes';
import type {
  EntityExternalLinkRow,
  TrackerConnectionRow,
  TrackerReconciliationLedgerRow,
} from '../../../database/models';
import {
  bumpConfigGeneration,
  getConnection,
  getLinkByExternal,
  listLedgerEntries,
  markOrphaned,
  updateBaseline,
  updateConnectionSettings,
  insertConnection,
  type NewConnectionRow,
} from '../store';
import {
  runDeletionSweep,
  runInboundSync,
  type InboundSyncDeps,
  type ReviewFindingRouter,
} from '../inboundSync';
import type { ReviewItemCreate } from '../../../orchestrator/reviewItemRouter';

const STATES: TrackerState[] = [
  { id: 'open', name: 'Open', color: null, group: 'unstarted' },
  { id: 'in_progress', name: 'In progress', color: null, group: 'started' },
  { id: 'closed', name: 'Closed', color: null, group: 'completed' },
];

const SOURCE: TrackerSourceSelection = {
  containerId: 'workspace',
  narrowId: 'all',
  narrowKind: 'all',
};

/**
 * A beads-shaped adapter: it reports (id, revision) pairs for the sweep and
 * serves point lookups out of a table the tests drive directly.
 *
 * `getIssueCalls` is the whole point of the fixture. Every assertion about the
 * ledger is ultimately an assertion about this number.
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

  /** The remote workspace: id -> issue. `revision` on each is its fingerprint. */
  readonly remote = new Map<string, TrackerIssue>();
  /** Ids the SWEEP LISTING reports; defaults to everything in `remote`. */
  listedIds: string[] | null = null;
  /** What the incremental fetch returns — deliberately empty in most cases here. */
  incremental: TrackerIssue[] = [];

  getIssueCalls: string[] = [];
  listIssueIdsCalls = 0;
  listIssueRevisionsCalls = 0;

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
    return STATES;
  }
  async listFieldOptions(): Promise<TrackerFieldOptionsRaw> {
    return { priorities: ['0', '1', '2', '3'], categories: ['bug', 'feature', 'task', 'chore'] };
  }
  async listIssues(): Promise<TrackerIssue[]> {
    return this.incremental;
  }
  async listIssueIds(): Promise<string[]> {
    this.listIssueIdsCalls += 1;
    return this.sweptIds();
  }
  /**
   * A PROPERTY, not a method, purely so {@link UnreconcilableAdapter} can null
   * it out — the interface declares it optional, and a subclass cannot widen a
   * method back to `undefined`.
   */
  listIssueRevisions?: () => Promise<Array<{ id: string; revision: string }>> = async () => {
    this.listIssueRevisionsCalls += 1;
    return this.sweptIds().map((id) => ({
      id,
      revision: this.remote.get(id)?.revision ?? 'missing',
    }));
  };
  async getIssue(externalId: string): Promise<TrackerIssue | null> {
    this.getIssueCalls.push(externalId);
    return this.remote.get(externalId) ?? null;
  }
  /**
   * Scripted Dolt HEADs, consumed one per call with the last value repeating —
   * so `['h1', 'h2']` is exactly "the workspace changed between the sweep's
   * capture and its archival re-read". A PROPERTY for the same reason
   * `listIssueRevisions` is one: {@link HeadlessAdapter} nulls it out, and the
   * interface declares it optional.
   */
  headSequence: Array<string | null> = ['head-1'];
  readonly workspaceHeadCalls: string[] = [];
  workspaceHead?: (anyLinkedExternalId: string) => Promise<string | null> = async (id) => {
    this.workspaceHeadCalls.push(id);
    const index = Math.min(this.workspaceHeadCalls.length - 1, this.headSequence.length - 1);
    return this.headSequence[index];
  };
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

  private sweptIds(): string[] {
    return this.listedIds ?? [...this.remote.keys()];
  }
}

/**
 * The HTTP-provider shape: no reconciliation, so the sweep must take the bare
 * `listIssueIds` path it always did. Still nominally 'beads' so it can drive
 * the same connection fixture — the flag, not the provider name, is what the
 * sweep branches on.
 */
class NonReconcilingAdapter extends FakeBeadsAdapter {
  override readonly capabilities: TrackerAdapterCapabilities = {
    nativeParentAutoClose: false,
    selfHostedBaseUrl: false,
    idempotentCreate: false,
    contentWrite: { title: true, description: true, priority: true, category: true },
    archive: 'none',
    requiresIdReconciliation: false,
    guardedUpdates: false,
  };
}

/**
 * The programming error the sweep's assertion exists for: the capability says
 * "reconcile me" and the seam is not there. `listIssueRevisions` is OPTIONAL on
 * the interface, so structural typing lets exactly this compile — which is why
 * the check has to be a runtime one.
 */
class UnreconcilableAdapter extends FakeBeadsAdapter {
  override readonly listIssueRevisions: undefined = undefined;
}

/**
 * A reconciling adapter that cannot report a workspace token — the shape every
 * provider had before the HEAD guard existed. The guard must degrade to nothing
 * for it, not to a skipped archival.
 */
class HeadlessAdapter extends FakeBeadsAdapter {
  override readonly workspaceHead: undefined = undefined;
}

class FakeReviewRouter implements ReviewFindingRouter {
  readonly created: ReviewItemCreate[] = [];
  async applyReviewItem(_projectId: number, change: ReviewItemCreate): Promise<{ reviewItemId: string }> {
    this.created.push(change);
    return { reviewItemId: `rvw_${this.created.length}` };
  }
}

function makeIssue(externalId: string, overrides: Partial<TrackerIssue> = {}): TrackerIssue {
  return {
    externalId,
    identifier: externalId,
    title: `Issue ${externalId}`,
    description: 'body',
    url: '',
    stateId: 'open',
    assignee: null,
    estimate: null,
    parentExternalId: null,
    updatedAt: '2026-07-30T10:00:00.000Z',
    archivedAt: null,
    priority: '2',
    category: null,
    recoveryClientKey: null,
    revision: `rev-${externalId}-1`,
    ...overrides,
  };
}

let tmpDir: string;
let svc: DatabaseService;
let raw: Database.Database;
let router: TaskChangeRouter;
let adapter: FakeBeadsAdapter;
let reviewRouter: FakeReviewRouter;
let deps: InboundSyncDeps;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'cyboflow-trackersync-reconcile-'));
  svc = new DatabaseService(join(tmpDir, 'test.db'));
  svc.initialize();
  raw = svc.getDb();
  raw.prepare('INSERT INTO projects (id, name, path) VALUES (1, ?, ?)').run('Proj 1', '/tmp/p1');
  svc.seedDefaultBoard(1);
  router = new TaskChangeRouter(dbAdapter(raw));
  adapter = new FakeBeadsAdapter();
  reviewRouter = new FakeReviewRouter();
  deps = { db: raw, adapter, router, reviewRouter, nowIso: () => '2026-07-30T12:00:00.000Z' };
});

afterEach(() => {
  raw.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

function makeConnection(overrides: Partial<NewConnectionRow> = {}): TrackerConnectionRow {
  return insertConnection(raw, {
    id: 'conn-1',
    project_id: 1,
    provider: 'beads',
    status: 'active',
    workspace_id: 'inst-1',
    workspace_name: 'proj',
    actor_label: 'K.',
    base_url: null,
    secret_ciphertext: null,
    source_json: JSON.stringify({ ...SOURCE, workspacePath: '/tmp/p1' }),
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

function reload(id = 'conn-1'): TrackerConnectionRow {
  const row = getConnection(raw, id);
  if (!row) throw new Error(`connection ${id} vanished`);
  return row;
}

function ledgerRows(): TrackerReconciliationLedgerRow[] {
  return [...listLedgerEntries(raw, 'conn-1').values()].sort((a, b) =>
    a.external_id.localeCompare(b.external_id),
  );
}

function ideaCount(): number {
  const row = raw.prepare('SELECT COUNT(*) AS n FROM ideas').get() as { n: number };
  return row.n;
}

function ideaArchivedAt(entityId: string): string | null {
  const row = raw.prepare('SELECT archived_at FROM ideas WHERE id = ?').get(entityId) as
    | { archived_at: string | null }
    | undefined;
  return row?.archived_at ?? null;
}

/** Import one remote issue the ordinary way, so the sweep meets a real link. */
async function importIssue(issue: TrackerIssue): Promise<EntityExternalLinkRow> {
  adapter.remote.set(issue.externalId, issue);
  adapter.incremental = [issue];
  await runInboundSync(deps, reload());
  adapter.incremental = [];
  const link = getLinkByExternal(raw, 'conn-1', issue.externalId);
  if (link === null) throw new Error(`${issue.externalId} did not import`);
  return link;
}

// ---------------------------------------------------------------------------
// The zero-lookup guarantee
// ---------------------------------------------------------------------------

describe('reconciliation sweep — the ledger’s zero-lookup guarantee', () => {
  it('ledgers an id it resolves WITHOUT a link, then spends nothing on it again', async () => {
    makeConnection({ state_mapping_json: JSON.stringify({ closed: 'dont' }) });
    // Mapped to 'dont' — considered and permanently declined, which is exactly
    // what the ledger is for.
    adapter.remote.set('bd-1', makeIssue('bd-1', { stateId: 'closed' }));

    const first = await runDeletionSweep(deps, reload());

    expect(first.reconcileFetched).toBe(1);
    expect(first.reconcileLedgered).toBe(1);
    expect(first.reconcileImported).toBe(0);
    expect(ideaCount()).toBe(0);
    expect(ledgerRows()).toHaveLength(1);
    expect(ledgerRows()[0]).toMatchObject({
      external_id: 'bd-1',
      reason: 'unmapped-state',
      last_seen_revision: 'rev-bd-1-1',
      config_generation: 0,
    });

    adapter.getIssueCalls = [];
    const second = await runDeletionSweep(deps, reload());

    expect(adapter.getIssueCalls).toEqual([]);
    expect(second.reconcileFetched).toBe(0);
    expect(second.reconcileSkipped).toBe(1);
  });

  it('spends nothing on a LINKED id whose fingerprint has not moved', async () => {
    makeConnection();
    await importIssue(makeIssue('bd-1'));

    adapter.getIssueCalls = [];
    const sweep = await runDeletionSweep(deps, reload());

    expect(adapter.getIssueCalls).toEqual([]);
    expect(sweep.reconcileFetched).toBe(0);
    expect(sweep.reconcileSkipped).toBe(1);
  });

  it('uses listIssueRevisions, never the bare id listing, for a reconciling adapter', async () => {
    makeConnection();
    await importIssue(makeIssue('bd-1'));

    await runDeletionSweep(deps, reload());

    expect(adapter.listIssueRevisionsCalls).toBe(1);
    expect(adapter.listIssueIdsCalls).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Changed fingerprints
// ---------------------------------------------------------------------------

describe('reconciliation sweep — a moved fingerprint', () => {
  it('point-fetches a LINKED id whose fingerprint changed and merges the change', async () => {
    makeConnection();
    const link = await importIssue(makeIssue('bd-1'));
    // A backdated remote edit: the CONTENT moved but `updatedAt` did not, which
    // is precisely what the cursor cannot see.
    adapter.remote.set(
      'bd-1',
      makeIssue('bd-1', { title: 'Retitled remotely', revision: 'rev-bd-1-2' }),
    );

    adapter.getIssueCalls = [];
    const sweep = await runDeletionSweep(deps, reload());

    expect(adapter.getIssueCalls).toEqual(['bd-1']);
    expect(sweep.reconcileFetched).toBe(1);
    const idea = raw.prepare('SELECT title FROM ideas WHERE id = ?').get(link.entity_id) as {
      title: string;
    };
    expect(idea.title).toBe('Retitled remotely');
    // The new fingerprint is stamped, so the NEXT sweep is free again.
    adapter.getIssueCalls = [];
    const second = await runDeletionSweep(deps, reload());
    expect(adapter.getIssueCalls).toEqual([]);
    expect(second.reconcileSkipped).toBe(1);
  });

  it('re-evaluates a LEDGERED id whose fingerprint changed, importing it when it became eligible', async () => {
    makeConnection({ state_mapping_json: JSON.stringify({ closed: 'dont' }) });
    adapter.remote.set('bd-1', makeIssue('bd-1', { stateId: 'closed' }));
    await runDeletionSweep(deps, reload());
    expect(ideaCount()).toBe(0);

    // A backdated remote edit moved it into a state the mapping DOES import.
    adapter.remote.set('bd-1', makeIssue('bd-1', { stateId: 'open', revision: 'rev-bd-1-2' }));

    adapter.getIssueCalls = [];
    const sweep = await runDeletionSweep(deps, reload());

    expect(adapter.getIssueCalls).toEqual(['bd-1']);
    expect(sweep.reconcileImported).toBe(1);
    expect(ideaCount()).toBe(1);
    // The link is the record now, so the ledger row is dropped.
    expect(ledgerRows()).toHaveLength(0);
  });

  it('re-ledgers a still-ineligible id at its NEW fingerprint rather than re-fetching forever', async () => {
    makeConnection({ state_mapping_json: JSON.stringify({ closed: 'dont' }) });
    adapter.remote.set('bd-1', makeIssue('bd-1', { stateId: 'closed' }));
    await runDeletionSweep(deps, reload());

    adapter.remote.set(
      'bd-1',
      makeIssue('bd-1', { stateId: 'closed', title: 'edited', revision: 'rev-bd-1-2' }),
    );
    const second = await runDeletionSweep(deps, reload());
    expect(second.reconcileFetched).toBe(1);
    expect(ledgerRows()[0].last_seen_revision).toBe('rev-bd-1-2');

    adapter.getIssueCalls = [];
    const third = await runDeletionSweep(deps, reload());
    expect(adapter.getIssueCalls).toEqual([]);
    expect(third.reconcileSkipped).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// config_generation
// ---------------------------------------------------------------------------

describe('reconciliation sweep — config_generation invalidation', () => {
  it('re-considers exactly the skipped ids, exactly once, after a config change', async () => {
    makeConnection({ state_mapping_json: JSON.stringify({ closed: 'dont' }) });
    adapter.remote.set('bd-1', makeIssue('bd-1', { stateId: 'closed' }));
    adapter.remote.set('bd-2', makeIssue('bd-2', { stateId: 'closed' }));
    // A third id that IMPORTS, so the assertion below can prove the bump does
    // not re-fetch things the ledger never owned.
    adapter.remote.set('bd-3', makeIssue('bd-3'));
    await runDeletionSweep(deps, reload());
    expect(ledgerRows().map((row) => row.external_id)).toEqual(['bd-1', 'bd-2']);

    // The user widens the mapping. Both skipped ids are now eligible.
    updateConnectionSettings(raw, 'conn-1', { state_mapping_json: '{}' });
    bumpConfigGeneration(raw, 'conn-1');

    adapter.getIssueCalls = [];
    const afterBump = await runDeletionSweep(deps, reload());

    // EXACTLY the two ledgered ids — bd-3 is linked and unchanged, so it costs
    // nothing even across a generation bump.
    expect([...adapter.getIssueCalls].sort()).toEqual(['bd-1', 'bd-2']);
    expect(afterBump.reconcileImported).toBe(2);
    expect(afterBump.reconcileSkipped).toBe(1);

    // EXACTLY ONCE: the next sweep is free again.
    adapter.getIssueCalls = [];
    await runDeletionSweep(deps, reload());
    expect(adapter.getIssueCalls).toEqual([]);
  });

  it('re-ledgers a still-skipped id at the NEW generation so the bump is spent once', async () => {
    makeConnection({ state_mapping_json: JSON.stringify({ closed: 'dont' }) });
    adapter.remote.set('bd-1', makeIssue('bd-1', { stateId: 'closed' }));
    await runDeletionSweep(deps, reload());

    bumpConfigGeneration(raw, 'conn-1');
    const afterBump = await runDeletionSweep(deps, reload());
    expect(afterBump.reconcileFetched).toBe(1);
    expect(ledgerRows()[0].config_generation).toBe(1);

    adapter.getIssueCalls = [];
    await runDeletionSweep(deps, reload());
    expect(adapter.getIssueCalls).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Unseen ids
// ---------------------------------------------------------------------------

describe('reconciliation sweep — unseen ids', () => {
  it('imports an id the incremental cursor never delivered, and writes NO ledger row', async () => {
    makeConnection();
    // Never offered to listIssues — the pull-merged, backdated case.
    adapter.remote.set('bd-1', makeIssue('bd-1'));

    const sweep = await runDeletionSweep(deps, reload());

    expect(sweep.reconcileImported).toBe(1);
    expect(ideaCount()).toBe(1);
    expect(getLinkByExternal(raw, 'conn-1', 'bd-1')).not.toBeNull();
    // Its LINK is the record; a ledger row would be a second, staler one.
    expect(ledgerRows()).toHaveLength(0);
  });

  it('stamps the fingerprint on the imported link, so the next sweep is free', async () => {
    makeConnection();
    adapter.remote.set('bd-1', makeIssue('bd-1'));
    await runDeletionSweep(deps, reload());

    adapter.getIssueCalls = [];
    const second = await runDeletionSweep(deps, reload());

    expect(adapter.getIssueCalls).toEqual([]);
    expect(second.reconcileSkipped).toBe(1);
  });

  it('does NOT ledger an id a held import direction deferred — it is asked again next sweep', async () => {
    makeConnection();
    adapter.remote.set('bd-1', makeIssue('bd-1'));

    const held = await runDeletionSweep({ ...deps, importNewIssues: false }, reload());

    expect(held.reconcileFetched).toBe(1);
    expect(held.reconcileImported).toBe(0);
    expect(held.reconcileLedgered).toBe(0);
    expect(ledgerRows()).toHaveLength(0);
    expect(ideaCount()).toBe(0);

    // A later pass with the direction running imports it.
    const running = await runDeletionSweep(deps, reload());
    expect(running.reconcileImported).toBe(1);
  });

  it('records the GATE an unlinked id actually took as the ledger reason', async () => {
    makeConnection({
      selection_mode: 'manual',
      selection_json: JSON.stringify({ externalIds: ['bd-2'] }),
    });
    adapter.remote.set('bd-1', makeIssue('bd-1'));
    adapter.remote.set('bd-3', makeIssue('bd-3', { archivedAt: '2026-07-29T00:00:00.000Z' }));

    await runDeletionSweep(deps, reload());

    expect(ledgerRows().map((row) => [row.external_id, row.reason])).toEqual([
      ['bd-1', 'out-of-selection'],
      // An archived remote issue never seeds a new idea, and that gate sits
      // AHEAD of the selection filter.
      ['bd-3', 'archived'],
    ]);
  });
});

describe('reconciliation sweep — a link parked behind an open conflict', () => {
  it('re-offers it every sweep instead of stamping a fingerprint nothing was applied at', async () => {
    makeConnection({ conflict_mode: 'manual' });
    const link = await importIssue(makeIssue('bd-1'));
    // Both sides moved: local edit + a backdated remote one. Manual mode parks
    // the item and applies nothing.
    raw.prepare('UPDATE ideas SET title = ? WHERE id = ?').run('Local title', link.entity_id);
    adapter.remote.set(
      'bd-1',
      makeIssue('bd-1', { title: 'Their title', revision: 'rev-bd-1-2' }),
    );

    const first = await runDeletionSweep(deps, reload());
    expect(first.conflictsOpened).toBe(1);

    // NOT stamped: nothing was applied, so "up to date with this issue" would
    // be a lie, and the cursor may never deliver this issue again.
    adapter.getIssueCalls = [];
    const second = await runDeletionSweep(deps, reload());
    expect(adapter.getIssueCalls).toEqual(['bd-1']);
    // …and it opens no duplicate row while the first is still open.
    expect(second.conflictsOpened).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Reversible archival
// ---------------------------------------------------------------------------

describe('reconciliation sweep — reversible archival', () => {
  it('un-archives a twin the sweep archived when its id reappears', async () => {
    makeConnection();
    const link = await importIssue(makeIssue('bd-1'));

    // The issue vanishes from the listing AND the point lookup — a restore
    // racing the sweep, or a hard delete.
    adapter.remote.delete('bd-1');
    const archived = await runDeletionSweep(deps, reload());
    expect(archived.sweepArchived).toBe(1);
    expect(ideaArchivedAt(link.entity_id)).not.toBeNull();
    expect(getLinkByExternal(raw, 'conn-1', 'bd-1')?.orphaned_at).not.toBeNull();

    // It comes back (a concurrent `bd dolt pull` restored it).
    adapter.remote.set('bd-1', makeIssue('bd-1'));
    const back = await runDeletionSweep(deps, reload());

    expect(back.resurrected).toBe(1);
    expect(ideaArchivedAt(link.entity_id)).toBeNull();
    expect(getLinkByExternal(raw, 'conn-1', 'bd-1')?.orphaned_at).toBeNull();
    expect(reviewRouter.created.map((item) => item.title)).toEqual([
      'Tracker sync un-archived bd-1 — the issue came back',
    ]);
  });

  it('resurrects at most once — a second sweep over the same live id does nothing', async () => {
    makeConnection();
    await importIssue(makeIssue('bd-1'));
    adapter.remote.delete('bd-1');
    await runDeletionSweep(deps, reload());
    adapter.remote.set('bd-1', makeIssue('bd-1'));
    await runDeletionSweep(deps, reload());

    const third = await runDeletionSweep(deps, reload());

    expect(third.resurrected).toBe(0);
    expect(reviewRouter.created).toHaveLength(1);
  });

  it('leaves a link the SWEEP did not orphan alone — a user removal is not reversed', async () => {
    makeConnection();
    const link = await importIssue(makeIssue('bd-1'));
    // The "remove from sync" ruling's shape: orphaned, with no sweep marker.
    markOrphaned(raw, link.id);

    const sweep = await runDeletionSweep(deps, reload());

    expect(sweep.resurrected).toBe(0);
    expect(getLinkByExternal(raw, 'conn-1', 'bd-1')?.orphaned_at).not.toBeNull();
    expect(reviewRouter.created).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// The best-effort HEAD guard on archival
// ---------------------------------------------------------------------------

describe('reconciliation sweep — the archival HEAD guard', () => {
  /**
   * One linked issue that has VANISHED (so the sweep wants to archive it) plus
   * one unlinked issue that is new (so the same sweep wants to import
   * something). The two halves are what make "only the archival subset is
   * deferred" observable at all.
   */
  async function archivalAndImportPending(): Promise<EntityExternalLinkRow> {
    makeConnection();
    const link = await importIssue(makeIssue('bd-1'));
    adapter.remote.delete('bd-1');
    adapter.remote.set('bd-2', makeIssue('bd-2'));
    return link;
  }

  it('defers ONLY the archival subset when the head moved, and still applies the import', async () => {
    const link = await archivalAndImportPending();
    adapter.headSequence = ['head-1', 'head-2'];

    const sweep = await runDeletionSweep(deps, reload());

    expect(sweep.archivalDeferred).toBe(1);
    expect(sweep.sweepArchived).toBe(0);
    // Nothing at all was written for the deferred link: not the archive, not
    // the orphaning, not a conflict row.
    expect(ideaArchivedAt(link.entity_id)).toBeNull();
    expect(getLinkByExternal(raw, 'conn-1', 'bd-1')?.orphaned_at).toBeNull();
    // ...while the import in the SAME sweep landed, which is the whole point of
    // scoping the guard to archival.
    expect(sweep.reconcileImported).toBe(1);
    expect(getLinkByExternal(raw, 'conn-1', 'bd-2')).not.toBeNull();
  });

  it('archives normally when the head is unchanged, and re-reads it exactly twice', async () => {
    const link = await archivalAndImportPending();
    adapter.workspaceHeadCalls.length = 0;
    adapter.headSequence = ['head-1'];

    const sweep = await runDeletionSweep(deps, reload());

    expect(sweep.sweepArchived).toBe(1);
    expect(sweep.archivalDeferred).toBe(0);
    expect(ideaArchivedAt(link.entity_id)).not.toBeNull();
    // Capture + ONE lazy re-read. The verdict is per-sweep, so a second archived
    // link must not cost a second spawn.
    expect(adapter.workspaceHeadCalls).toEqual(['bd-1', 'bd-1']);
  });

  it('re-reads the head only ONCE for a sweep archiving several links', async () => {
    makeConnection();
    await importIssue(makeIssue('bd-1'));
    await importIssue(makeIssue('bd-2'));
    adapter.remote.clear();
    adapter.workspaceHeadCalls.length = 0;

    const sweep = await runDeletionSweep(deps, reload());

    expect(sweep.sweepArchived).toBe(2);
    expect(adapter.workspaceHeadCalls).toHaveLength(2);
  });

  it('deferral is transient — the next sweep over a quiet workspace archives', async () => {
    const link = await archivalAndImportPending();
    adapter.headSequence = ['head-1', 'head-2'];
    expect((await runDeletionSweep(deps, reload())).archivalDeferred).toBe(1);

    adapter.headSequence = ['head-2'];
    const second = await runDeletionSweep(deps, reload());

    expect(second.archivalDeferred).toBe(0);
    expect(second.sweepArchived).toBe(1);
    expect(ideaArchivedAt(link.entity_id)).not.toBeNull();
  });

  it('skips the guard entirely when there is no linked id to address the read with', async () => {
    makeConnection();
    adapter.remote.set('bd-1', makeIssue('bd-1'));

    await runDeletionSweep(deps, reload());

    // A connection with no active link has nothing to archive either, so the
    // guard is moot as well as unavailable — and must cost no spawn.
    expect(adapter.workspaceHeadCalls).toEqual([]);
  });

  it('archives anyway when the head cannot be read — best-effort, never a blocked sweep', async () => {
    const link = await archivalAndImportPending();
    // Captured null (no history to anchor on): the guard never arms.
    adapter.headSequence = [null];

    const sweep = await runDeletionSweep(deps, reload());

    expect(sweep.sweepArchived).toBe(1);
    expect(sweep.archivalDeferred).toBe(0);
    expect(ideaArchivedAt(link.entity_id)).not.toBeNull();
  });

  it('reads an unreadable head at the RE-CHECK as "not moved", not as moved', async () => {
    const link = await archivalAndImportPending();
    adapter.headSequence = ['head-1', null];

    const sweep = await runDeletionSweep(deps, reload());

    // One flaky spawn must not be able to suppress deletion handling forever.
    expect(sweep.sweepArchived).toBe(1);
    expect(sweep.archivalDeferred).toBe(0);
    expect(ideaArchivedAt(link.entity_id)).not.toBeNull();
  });

  it('archives normally for a reconciling adapter that reports no head at all', async () => {
    const headless = new HeadlessAdapter();
    const headlessDeps: InboundSyncDeps = { ...deps, adapter: headless };
    makeConnection();
    headless.remote.set('bd-1', makeIssue('bd-1'));
    headless.incremental = [makeIssue('bd-1')];
    await runInboundSync(headlessDeps, reload());
    headless.incremental = [];
    headless.remote.delete('bd-1');

    const sweep = await runDeletionSweep(headlessDeps, reload());

    expect(sweep.sweepArchived).toBe(1);
    expect(sweep.archivalDeferred).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Housekeeping + the non-reconciling path
// ---------------------------------------------------------------------------

describe('reconciliation sweep — housekeeping', () => {
  it('deletes ledger rows whose id left the remote set', async () => {
    makeConnection({ state_mapping_json: JSON.stringify({ closed: 'dont' }) });
    adapter.remote.set('bd-1', makeIssue('bd-1', { stateId: 'closed' }));
    adapter.remote.set('bd-2', makeIssue('bd-2', { stateId: 'closed' }));
    await runDeletionSweep(deps, reload());
    expect(ledgerRows()).toHaveLength(2);

    adapter.remote.delete('bd-2');
    await runDeletionSweep(deps, reload());

    expect(ledgerRows().map((row) => row.external_id)).toEqual(['bd-1']);
  });
});

describe('runDeletionSweep — a provider WITHOUT requiresIdReconciliation', () => {
  it('takes the bare id listing and touches neither the ledger nor a point lookup', async () => {
    const plain = new NonReconcilingAdapter();
    const plainDeps: InboundSyncDeps = { ...deps, adapter: plain };
    makeConnection();
    plain.remote.set('bd-1', makeIssue('bd-1'));
    plain.incremental = [makeIssue('bd-1')];
    await runInboundSync(plainDeps, reload());
    plain.incremental = [];
    plain.getIssueCalls = [];

    const sweep = await runDeletionSweep(plainDeps, reload());

    expect(plain.listIssueIdsCalls).toBe(1);
    expect(plain.listIssueRevisionsCalls).toBe(0);
    expect(plain.getIssueCalls).toEqual([]);
    expect(sweep.reconcileFetched).toBe(0);
    expect(sweep.reconcileSkipped).toBe(0);
    expect(ledgerRows()).toHaveLength(0);
  });
});

describe('runDeletionSweep — an adapter that declares the flag without the method', () => {
  it('fails loudly rather than degrading to a bare id diff', async () => {
    makeConnection();
    await expect(runDeletionSweep({ ...deps, adapter: new UnreconcilableAdapter() }, reload())).rejects.toThrow(
      /declares requiresIdReconciliation but implements no listIssueRevisions/,
    );
  });
});

// ---------------------------------------------------------------------------
// The baseline fingerprint the ordinary pass stamps
// ---------------------------------------------------------------------------

describe('baseline fingerprints', () => {
  it('the ordinary inbound pass stamps the fingerprint it imported at', async () => {
    makeConnection();
    const link = await importIssue(makeIssue('bd-1'));
    const baseline = JSON.parse(
      getLinkByExternal(raw, 'conn-1', 'bd-1')?.baseline_json ?? '{}',
    ) as Record<string, unknown>;

    expect(baseline.revision).toBe('rev-bd-1-1');
    expect(link.entity_type).toBe('idea');
  });

  it('a link carrying no fingerprint is point-fetched once, then settles', async () => {
    makeConnection();
    const link = await importIssue(makeIssue('bd-1'));
    // A pre-feature link: baseline with no `revision` key at all.
    const blob = JSON.parse(link.baseline_json ?? '{}') as Record<string, unknown>;
    delete blob.revision;
    updateBaseline(raw, link.id, JSON.stringify(blob));

    adapter.getIssueCalls = [];
    const first = await runDeletionSweep(deps, reload());
    expect(adapter.getIssueCalls).toEqual(['bd-1']);
    expect(first.reconcileFetched).toBe(1);

    adapter.getIssueCalls = [];
    await runDeletionSweep(deps, reload());
    expect(adapter.getIssueCalls).toEqual([]);
  });
});
