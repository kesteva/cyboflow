/**
 * trackerSync/writeBack — the OUTBOUND detection half of the sync engine
 * (cyboflow -> tracker). Design: docs/proposals/tracker-sync-integration.md
 * ("Write-back & sub-issue mirroring" + "Durability & failure semantics" #1).
 *
 * This module makes ZERO network calls. It subscribes to the entity-change
 * broadcast (`taskChangeEvents` on TASK_ALL_CHANNEL, emitted by
 * TaskChangeRouter after every committed entity write) and translates the
 * changes that matter into durable `tracker_outbox` rows. outboxWorker.ts is
 * the only thing that talks to a provider — so every remote write has a
 * durable local record BEFORE it is attempted, which is what makes echo
 * suppression and crash recovery possible.
 *
 * MANUAL DELAYS, OFF DECLINES. An enqueue is a durable statement of INTENT, and
 * 'manual' means "hold this direction until the user asks", not "throw the
 * intent away" — so `auto`/`manual` gate the DRAIN (outboxWorker's
 * `allowedKinds`, chosen by trackerSyncService.runPass) and this module records
 * those intents unconditionally. A connection whose status sync is manual still
 * accumulates its stage writes and emits them, in order, on the next "Sync now".
 *
 * `'off'` — which only the two migration-112 modes have — is the ONE exception,
 * and it gates HERE, at the enqueue (invariant 5 of
 * docs/proposals/tracker-field-writeback.md). A row whose direction is off is
 * not delayed, it is UNDRAINABLE: `claimNextPending` never claims its kind, not
 * even under "Sync now", while `collectOutboxBlockers` is kind-agnostic and
 * halts the inbound batch at that issue on every pass. So an off direction
 * declines the intent outright rather than queueing a permanent inbound stall.
 * The other flag still read here is `mirror_subissues`, which is a scope choice
 * ("do sub-issues exist at all"), not a cadence.
 *
 * Six write-back triggers. All but the fourth need "the entity is linked AND its
 * connection is active"; the fourth is the only one that fires for an UNLINKED
 * entity:
 *
 *   1. STAGE MOVES. The entity's stage maps to a write-back group
 *      ('started' / 'completed' / 'cancelled' — `Ready for development`
 *      deliberately maps to nothing: readiness is not started). A group that
 *      differs from the last group we wrote (stamped on the link's baseline by
 *      the worker) enqueues an `update_state`.
 *   2. DECOMPOSITION. A linked idea that just picked up its `decomposed_at`
 *      retire stamp writes 'started' to the origin issue, and — when the
 *      connection has `mirror_subissues = 1` — enqueues one `create_sub_issue`
 *      per minted task that has no link yet.
 *   3. PARENT ROLLUP. A mirrored task reaching a terminal stage — Done OR
 *      Won't do — checks its siblings; once every mirrored child of the same
 *      parent issue is terminal, a `close_parent` is enqueued for the parent
 *      issue, 'completed' unless every child was abandoned, in which case the
 *      parent is cancelled (an idempotent no-op where Linear's native
 *      auto-close already fired; the sole mechanism for Plane).
 *   4. IDEA PUSH. An idea CREATED locally in a connected project enqueues a
 *      `create_issue` — a top-level issue in the connection's source container.
 *      Three skips keep it from filing an issue for something that already has
 *      one: a provider-authored create (the inbound import's own event), an
 *      idea that already carries a link for that provider, and a body carrying
 *      the tracker-import provenance marker (the unattributed-event backstop).
 *   5. CONTENT. A linked entity whose title / description / priority / category
 *      now DIFFERS from the link's baseline enqueues an `update_content`. Its
 *      payload is EMPTY — the drain composes from the entity as it stands then,
 *      the `create_issue` precedent — so a burst of edits collapses into one
 *      write. Gated on `content_sync_mode !== 'off'`.
 *   6. ARCHIVE. A linked entity picking up an `archived_at` stamp enqueues an
 *      `archive_issue` — the remote twin is trashed/archived, NEVER deleted.
 *      Gated on `archive_sync_mode !== 'off'` and on the provider having an
 *      archive endpoint at all. The mirror image, an UNARCHIVE, writes nothing
 *      remotely and only clears the idempotence stamp.
 *
 * TRIGGERS 5 AND 6 ARE PER-LINK, and deliberately do not settle for the FIRST
 * active provider link the way the older three do. An idea pushed to two
 * trackers must get two independent decisions — different modes, different
 * mappings, different baselines — so they enumerate every link through
 * {@link resolveAllLinked}. The three older triggers keep the single-link
 * behavior they have always had; widening them is a separate change with its own
 * dedupe and supersession consequences (recorded as a follow-up in the plan).
 *
 * TWO GUARDS ON EVERY NEW TRIGGER, and neither alone is sufficient. The ACTOR
 * FILTER skips the inbound half's own writes (every inbound apply runs with
 * `actor: connection.provider`), which is precise but optional on the event; the
 * BASELINE DIFF is the correctness backstop for an unattributed event, and is
 * what makes a replayed event a no-op.
 *
 * Every enqueue is DEDUPED against the connection's unresolved outbox rows, so
 * a burst of events (or a replayed one) can never queue the same remote write
 * twice. Combined with the baseline's last-written-group stamp, a stage that
 * flaps back and forth still produces exactly the writes the tracker needs.
 *
 * All tracker-table access goes through store.ts; the only direct SQL here is
 * against the native entity tables (`tasks`), which store.ts does not own.
 */
import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import type {
  BacklogTaskItem,
  EntityCategory,
  Priority,
  TaskChangedEvent,
} from '../../../../shared/types/tasks';
import type {
  EntityExternalLinkRow,
  TrackerConnectionRow,
  TrackerOutboxRow,
} from '../../database/models';
import type { TrackerProvider, TrackerStateGroup } from '../../../../shared/types/trackerSync';
import {
  enqueueOutbox,
  getConnection,
  getLinkByEntity,
  getLinkByExternal,
  listConnections,
  listLinks,
  listLinksByParentExternal,
  listUnresolvedOutbox,
  supersedeQueuedStateWrites,
  supersedeQueuedWrites,
  updateBaseline,
} from './store';
import { resolveStageIds, stageIdToWriteBackGroup, type TrackerStageIds } from './stateMapping';
import { carriesTrackerProvenance, normalizeDescription, splitBody } from './provenance';
import { guardedUpdatesUnavailable, providerSupportsRemoteArchive } from './providerCapabilities';
import {
  providerPriorityToken,
  providerTokensEqual,
  resolveEffectivePriorityMapping,
} from './priorityMapping';
import {
  providerCategoryToken,
  providerSupportsCategorySync,
  resolveEffectiveCategoryMapping,
} from './categoryMapping';

// ---------------------------------------------------------------------------
// Payload shapes
// ---------------------------------------------------------------------------

/**
 * The three canonical groups a cyboflow stage can demand of a tracker issue —
 * the non-null arm of stateMapping's `stageIdToWriteBackGroup`. The other three
 * TrackerStateGroup members (triage/backlog/unstarted) are inbound-only: no
 * local stage ever asks an issue to move to them.
 */
export type WriteBackGroup = Extract<TrackerStateGroup, 'started' | 'completed' | 'cancelled'>;

/** `payload_json` for the `update_state` and `close_parent` outbox kinds. */
export interface UpdateStatePayload {
  desiredGroup: WriteBackGroup;
}

/**
 * `payload_json` for the `create_sub_issue` outbox kind.
 *
 * The LOCAL priority/category are snapshotted here beside the title and
 * description, so the whole draft speaks for the one moment the decomposition
 * captured. The provider TOKENS they map to are deliberately NOT stored: a
 * mapping can only be resolved against the workspace's live vocabulary, which
 * exists at drain time and not here (this module makes no network calls).
 *
 * Both are NULLABLE for rows queued before these keys existed — a mirror that
 * has been sitting in a held push direction since an earlier build. A null pair
 * simply omits the fields from the draft, and the provider's own defaults
 * apply, exactly as they did then.
 */
export interface CreateSubIssuePayload {
  parentExternalId: string;
  title: string;
  description: string | null;
  priority: Priority | null;
  category: EntityCategory | null;
}

/**
 * `payload_json` for the `create_issue` outbox kind: EMPTY, deliberately.
 *
 * Unlike a mirrored sub-issue — whose draft is snapshotted here because the
 * decomposition event is the only moment those tasks are known to be fresh — a
 * pushed idea's draft is composed by the WORKER at drain time, from the idea's
 * current title/body/stage. A push can sit queued for a while (the whole point
 * of push_mode 'manual'), and filing the title the idea had when it was first
 * typed, rather than the one it has when the issue is actually created, is a
 * worse first impression than the extra read costs.
 */
export const CREATE_ISSUE_PAYLOAD_JSON = '{}';

/**
 * `payload_json` for the `update_content` kind: EMPTY, for the same reason
 * {@link CREATE_ISSUE_PAYLOAD_JSON} is.
 *
 * The patch is composed by the WORKER at drain time, from the entity's CURRENT
 * title/body/priority/category diffed against the link's baseline. A content
 * row can sit queued for a while ('manual' content sync is the whole point of
 * the mode), and a burst of edits — the ordinary shape of typing — would
 * otherwise queue one remote write per keystroke-batch, each carrying a body
 * that is already stale by the time it is sent. Composing late makes the
 * dedupe below collapse a burst into exactly one write of the final text.
 */
export const UPDATE_CONTENT_PAYLOAD_JSON = '{}';

/**
 * `payload_json` for the `archive_issue` kind: EMPTY, and it has nothing to
 * carry — the row's `(connection_id, external_id)` pair IS the instruction.
 * That is also why the enqueue can happen after a link is about to be orphaned:
 * the drain addresses the issue, not the link.
 */
export const ARCHIVE_ISSUE_PAYLOAD_JSON = '{}';

/**
 * The write-back marker the outbox worker stamps onto a link's
 * `baseline_json` after a successful state write. `stateId` overwrites the
 * baseline's own state field so the inbound poller diffs our own write to
 * "no change" (echo suppression); `lastWrittenGroup` is what this module
 * compares against to avoid re-queueing a group we already wrote.
 *
 * `archivedWrittenAt` belongs to the ARCHIVE write and is optional because the
 * two stamps are written by different paths and must not clobber each other:
 * `{ ...existing, ...stamp }` followed by `JSON.stringify` DELETES any key the
 * patch carries as `undefined`, so a state stamp that named the archive key at
 * all — even as undefined — would silently erase it. The state path therefore
 * builds an object literal without the key, and the archive path builds one
 * with only it. See {@link readArchivedWrittenAt}.
 */
export interface WriteBackBaselineStamp {
  stateId: string;
  lastWrittenGroup: WriteBackGroup;
  lastWrittenAt: string;
  archivedWrittenAt?: string;
}

/**
 * The ARCHIVE half of {@link WriteBackBaselineStamp}, on its own so the archive
 * path can stamp exactly one key. Its presence means "we have already told this
 * provider to trash this issue", which is what makes a replayed archive event a
 * no-op — the provider's own 404-is-success arm covers the rest.
 */
export interface ArchiveBaselineStamp {
  archivedWrittenAt: string;
}

/** When we last wrote a remote archive for this link, or null when we never have. */
export function readArchivedWrittenAt(link: EntityExternalLinkRow): string | null {
  const value = parseJsonObject(link.baseline_json).archivedWrittenAt;
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * Every provider a link can point at — the lookup order for an
 * unknown-provider entity, and the set every outbound trigger iterates.
 *
 * KEYED OFF A `Record<TrackerProvider, …>` RATHER THAN WRITTEN AS AN ARRAY. A
 * bare literal list is invisible to tsc when the provider union grows: a
 * provider missing from it has no link this module can ever find, so EVERY
 * outbound trigger — stage, content, archive, rollup — silently goes dark for
 * it, with nothing failing to compile and no test that does not already know to
 * look. (That is precisely what happened between the beads adapter landing and
 * this engine wiring; the migration's own "provider-keyed sites" catalogue
 * lists only the `Record` sites, because those are the ones tsc finds.) The
 * `Record` makes the next addition a compile error here.
 */
const PROVIDER_LOOKUP_ORDER: Record<TrackerProvider, true> = {
  linear: true,
  plane: true,
  dart: true,
  beads: true,
};

const PROVIDERS: readonly TrackerProvider[] = Object.keys(
  PROVIDER_LOOKUP_ORDER,
) as TrackerProvider[];

// ---------------------------------------------------------------------------
// Baseline / payload helpers (shared with outboxWorker)
// ---------------------------------------------------------------------------

/** Parse a JSON blob into a plain object, or `{}` for null/invalid/non-object input. */
export function parseJsonObject(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // A corrupt baseline/payload must never break an entity write — treat it
    // as "no baseline" and let the next successful sync rewrite it.
  }
  return {};
}

/** True when `value` is one of the three write-back groups. */
export function isWriteBackGroup(value: unknown): value is WriteBackGroup {
  return value === 'started' || value === 'completed' || value === 'cancelled';
}

/** The group most recently written to this link's issue, or null if we never wrote one. */
export function readLastWrittenGroup(link: EntityExternalLinkRow): WriteBackGroup | null {
  const baseline = parseJsonObject(link.baseline_json);
  const group = baseline.lastWrittenGroup;
  return isWriteBackGroup(group) ? group : null;
}

/** Read `desiredGroup` off an outbox row's payload, or null when absent/invalid. */
export function readDesiredGroup(payloadJson: string): WriteBackGroup | null {
  const group = parseJsonObject(payloadJson).desiredGroup;
  return isWriteBackGroup(group) ? group : null;
}

/**
 * stageIdToWriteBackGroup narrowed to the three groups a write-back can carry.
 * The mapping module returns the full `TrackerStateGroup` union (it is shared
 * with the inbound direction); the extra members are unreachable here, and
 * narrowing keeps that guarantee typed instead of asserted.
 */
export function writeBackGroupForStage(
  stageId: string,
  stageIds: TrackerStageIds,
): WriteBackGroup | null {
  const group = stageIdToWriteBackGroup(stageId, stageIds);
  return isWriteBackGroup(group) ? group : null;
}

// ---------------------------------------------------------------------------
// Listener
// ---------------------------------------------------------------------------

export interface WriteBackDeps {
  db: Database.Database;
  /**
   * Current timestamp, in sqlite's `datetime('now')` shape ('YYYY-MM-DD
   * HH:MM:SS', UTC). Nothing here needs it TODAY — every column this module
   * writes takes the schema's own `datetime('now')` default — but it is part
   * of the sync engine's shared deps shape (outboxWorker.ts does its backoff
   * arithmetic with it), so the service constructs one object for both halves
   * and tests get a single injection point for time.
   */
  nowIso(): string;
}

export interface WriteBackListener {
  /** Handle one TaskChangedEvent. Never throws — a sync bug must not break entity writes. */
  handleTaskChanged(event: TaskChangedEvent): void;
  /** Stop reacting to events (the service still owns removing the emitter subscription). */
  dispose(): void;
}

/**
 * Build the entity-event -> outbox translator. The service layer owns the
 * subscription itself (`taskChangeEvents.on(TASK_ALL_CHANNEL, l.handleTaskChanged)`)
 * so this module stays free of emitter lifecycle and is trivially testable
 * with synthesized events.
 */
export function createWriteBackListener(deps: WriteBackDeps): WriteBackListener {
  let disposed = false;

  function handleTaskChanged(event: TaskChangedEvent): void {
    if (disposed) return;
    try {
      route(deps, event);
    } catch (err) {
      // Swallowed BY DESIGN: this listener runs inline on TaskChangeRouter's
      // post-commit emit, so a throw here would surface as a failed entity
      // write. A missed write-back is recoverable (the next stage move, or a
      // manual "Sync now", re-derives it); a broken backlog write is not.
      console.error('[trackerSync/writeBack] failed to route entity change', err);
    }
  }

  return {
    handleTaskChanged,
    dispose(): void {
      disposed = true;
    },
  };
}

/** The linked-entity context every write-back trigger needs. */
interface LinkedContext {
  link: EntityExternalLinkRow;
  connection: TrackerConnectionRow;
}

/**
 * EVERY live (link, connection) pair for an entity — one per provider at most.
 *
 * An idea pushed to two trackers has two links, two connections, two direction
 * modes, two field mappings and two baselines, and every one of those is a
 * separate decision: content sync may be `auto` on one and `off` on the other,
 * a priority may be mapped on one and renamed away on the other. Answering with
 * the first link would silently make one tracker the only one that ever
 * receives a content or archive write.
 */
function resolveAllLinked(
  db: Database.Database,
  entityType: 'idea' | 'epic' | 'task',
  entityId: string,
): LinkedContext[] {
  const linked: LinkedContext[] = [];
  for (const provider of PROVIDERS) {
    const link = getLinkByEntity(db, entityType, entityId, provider);
    // An orphaned link points at an issue the remote no longer has — the
    // deletion sweep already archived it, so writing back is pointless.
    if (!link || link.orphaned_at !== null) continue;
    const connection = getConnection(db, link.connection_id);
    if (!connection) continue;
    // Status only — no direction mode here. See the file header: a held
    // direction still records its intent, and only `'off'` declines, which the
    // individual triggers gate on.
    if (connection.status !== 'active') continue;
    linked.push({ link, connection });
  }
  return linked;
}

/** Main dispatch for one event — see the three triggers in the file header. */
function route(deps: WriteBackDeps, event: TaskChangedEvent): void {
  // A hard delete is handled by the local-delete prompt ("unlink" vs "cancel
  // the issue"), not by stage-derived write-back.
  if (event.action === 'deleted') return;

  const entityType = event.task.type;
  // Epics are never linked to an issue: imports land as ideas, and mirroring
  // creates sub-issues for TASKS only.
  if (entityType !== 'idea' && entityType !== 'task') return;

  // Trigger 4 runs on its own, BEFORE the linked lookup, because it is the one
  // trigger whose subject is an UNLINKED entity.
  if (entityType === 'idea' && event.action === 'created') {
    handleIdeaPush(deps, event);
  }

  const allLinked = resolveAllLinked(deps.db, entityType, event.taskId);

  // Triggers 5 and 6 run PER LINK (see the header) and skip the provider's own
  // writes — the inbound half applies everything as `actor: <provider>`, and
  // echoing those straight back is the loop this filter exists to cut.
  if (allLinked.length > 0 && !isProviderAuthored(event)) {
    handleArchiveTransition(deps, event, allLinked, entityType);
    // An entity on its way OUT of the tracker gets no content write: the
    // archive above is the last thing we have to say about it, and a title
    // write racing it is a round trip against an issue about to be trashed.
    if (event.task.archived_at === null) {
      handleContentChange(deps, event, allLinked, entityType);
    }
  }

  // The three ORIGINAL triggers answer for one provider only — see
  // {@link resolveAllLinked} for why that is preserved rather than widened here.
  const linked = allLinked[0] ?? null;
  if (!linked) return;

  const stageIds = resolveStageIds(deps.db, event.projectId);
  const group = writeBackGroupForStage(event.task.stage_id, stageIds);

  if (group !== null) {
    enqueueStateWrite(deps, linked, linked.link.external_id, group, {
      entityType,
      entityId: event.taskId,
    });
  }

  if (entityType === 'idea' && event.task.decomposed_at !== null) {
    handleDecomposition(deps, linked, event.taskId, group);
  }

  // BOTH terminal groups trigger the rollup: a breakdown whose last open story
  // is abandoned is just as finished as one whose last story is done, and
  // gating on 'completed' alone would leave that parent open forever.
  if (entityType === 'task' && (group === 'completed' || group === 'cancelled')) {
    handleParentRollup(deps, linked, event, stageIds);
  }
}

// ---------------------------------------------------------------------------
// Trigger 1 — stage moves
// ---------------------------------------------------------------------------

/**
 * Enqueue an `update_state` (or `close_parent`) for `externalId`, unless we
 * already wrote that group or an unresolved row is carrying it. Returns true
 * when a row was actually written.
 */
function enqueueStateWrite(
  deps: WriteBackDeps,
  linked: LinkedContext,
  externalId: string,
  group: WriteBackGroup,
  opts: {
    entityType?: 'idea' | 'epic' | 'task';
    entityId?: string;
    kind?: 'update_state' | 'close_parent';
  } = {},
): boolean {
  const { db } = deps;
  const { connection } = linked;

  // INVARIANT 5's shape again, for a capability rather than a mode: a provider
  // whose adapter cannot guard an existing-issue write must not have one
  // QUEUED, because the drain would refuse it and the kind-agnostic inbound
  // blocker would then halt this issue's pass forever.
  if (guardedUpdatesUnavailable(connection.provider)) return false;

  // Already the group we last wrote for this issue -> nothing to say.
  const targetLink =
    externalId === linked.link.external_id
      ? linked.link
      : getLinkByExternal(db, connection.id, externalId);
  if (targetLink && readLastWrittenGroup(targetLink) === group) return false;

  // An unresolved row already carries this exact intent. Kind is deliberately
  // NOT part of the dedup key: update_state and close_parent both move the
  // same issue to the same group, so either one satisfies the other.
  const duplicate = listUnresolvedOutbox(db, connection.id).some(
    (row) =>
      row.external_id === externalId &&
      (row.kind === 'update_state' || row.kind === 'close_parent') &&
      readDesiredGroup(row.payload_json) === group,
  );
  if (duplicate) return false;

  const payload: UpdateStatePayload = { desiredGroup: group };
  const enqueued = enqueueOutbox(db, {
    connection_id: connection.id,
    kind: opts.kind ?? 'update_state',
    entity_type: opts.entityType ?? null,
    entity_id: opts.entityId ?? null,
    external_id: externalId,
    payload_json: JSON.stringify(payload),
  });
  // This row is now the truth about the issue's state, so anything still queued
  // for it is not just redundant — it is WRONG, and would regress the tracker if
  // a backoff let it drain last. See store.supersedeQueuedStateWrites.
  supersedeQueuedStateWrites(db, connection.id, externalId, enqueued.id);
  return true;
}

// ---------------------------------------------------------------------------
// Trigger 2 — decomposition + sub-issue mirroring
// ---------------------------------------------------------------------------

/** The columns the sub-issue draft is built from. */
interface MintedTaskRow {
  id: string;
  title: string;
  summary: string | null;
  body: string | null;
  /** Both columns are NOT NULL with defaults on every entity table (migs 015/059). */
  priority: Priority;
  category: EntityCategory;
}

/**
 * Tasks minted from an idea — BOTH the epic-nested ones and the direct
 * children a small-idea decomposition produces (mirroring taskListing's
 * selectIdeaDecomposition, which unions the same two shapes). Archived tasks
 * are skipped: a task retired before the mirror ran should not appear in the
 * tracker at all.
 */
function listMintedTasks(db: Database.Database, ideaId: string): MintedTaskRow[] {
  return db
    .prepare(
      `SELECT id, title, summary, body, priority, category
         FROM tasks
        WHERE originating_idea_id = ? AND archived_at IS NULL
        ORDER BY created_at ASC, ref ASC`,
    )
    .all(ideaId) as MintedTaskRow[];
}

/**
 * A decomposed idea writes 'started' to its origin issue, then (mirroring on)
 * fans its minted tasks out as sub-issues. A task is mirrored exactly once:
 * once it has a link, or once an unresolved create is already queued for it,
 * a replayed decomposition event is a no-op.
 *
 * `stageGroup` is what the idea's own stage already demands. A terminal one
 * (Done / Won't do) WINS: an idea that was decomposed and then closed must not
 * have its issue dragged back to In Progress by a replayed decomposition event.
 */
function handleDecomposition(
  deps: WriteBackDeps,
  linked: LinkedContext,
  ideaId: string,
  stageGroup: WriteBackGroup | null,
): void {
  const { db } = deps;
  const { connection, link } = linked;

  // Decomposition means work started, whatever planning stage the idea sits in.
  if (stageGroup === null) {
    enqueueStateWrite(deps, linked, link.external_id, 'started', {
      entityType: 'idea',
      entityId: ideaId,
    });
  }

  if (connection.mirror_subissues !== 1) return;

  const pendingCreates = new Set(
    listUnresolvedOutbox(db, connection.id)
      .filter((row) => row.kind === 'create_sub_issue' && row.entity_id !== null)
      .map((row) => row.entity_id as string),
  );

  for (const task of listMintedTasks(db, ideaId)) {
    if (getLinkByEntity(db, 'task', task.id, connection.provider) !== null) continue;
    if (pendingCreates.has(task.id)) continue;
    const payload: CreateSubIssuePayload = {
      parentExternalId: link.external_id,
      title: task.title,
      description: task.body ?? task.summary ?? null,
      priority: task.priority,
      category: task.category,
    };
    enqueueOutbox(db, {
      connection_id: connection.id,
      kind: 'create_sub_issue',
      entity_type: 'task',
      entity_id: task.id,
      // The parent issue, so an ambiguous-create reconcile knows where to look
      // without re-parsing the payload.
      external_id: null,
      // The idempotency key: Linear uses it as the created issue's id; Plane
      // matches against the outbox record when a create's response is lost.
      client_key: randomUUID(),
      payload_json: JSON.stringify(payload),
    });
    pendingCreates.add(task.id);
  }
}

// ---------------------------------------------------------------------------
// Trigger 3 — close the parent when every mirrored child is terminal
// ---------------------------------------------------------------------------

/**
 * A mirrored task just went terminal. When every OTHER mirrored child of the
 * same parent issue is terminal too, close the parent.
 *
 * "Terminal" here is Done OR Won't do (write-back groups 'completed' /
 * 'cancelled'): a decomposition where some stories were abandoned is still
 * finished, and waiting for a cancelled child to become Done would strand the
 * parent open forever. The same is true of the TRIGGER — see route(): a final
 * Won't do closes the parent exactly as a final Done does.
 *
 * WHICH group the parent is closed WITH follows its children:
 *   - at least one child completed -> 'completed'. Some of the breakdown was
 *     delivered, so the parent is done even though pieces were dropped.
 *   - every child cancelled        -> 'cancelled'. Nothing was delivered, and
 *     marking a wholly abandoned breakdown "Done" would claim work that never
 *     happened (and, on a report, work that was never even attempted).
 */
function handleParentRollup(
  deps: WriteBackDeps,
  linked: LinkedContext,
  event: TaskChangedEvent,
  stageIds: TrackerStageIds,
): void {
  const { db } = deps;
  const { connection, link } = linked;
  const parentExternalId = link.external_parent_id;
  if (parentExternalId === null) return;

  const siblings = listLinksByParentExternal(db, connection.id, parentExternalId).filter(
    (row) => row.entity_type === 'task' && row.orphaned_at === null,
  );
  if (siblings.length === 0) return;

  const groups = siblings.map((sibling) => {
    // The event's own entity is read from the event: the emit happens after
    // commit, so the DB agrees — but the event is the authoritative statement
    // of what just changed.
    const stageId =
      sibling.entity_id === event.taskId ? event.task.stage_id : readTaskStage(db, sibling.entity_id);
    // A stage that maps nowhere (and a row that is simply gone) is NOT terminal
    // — it holds the parent open rather than closing it on a guess.
    return stageId === null ? null : writeBackGroupForStage(stageId, stageIds);
  });
  if (!groups.every((group) => group === 'completed' || group === 'cancelled')) return;

  const desiredGroup: WriteBackGroup = groups.includes('completed') ? 'completed' : 'cancelled';
  enqueueStateWrite(deps, linked, parentExternalId, desiredGroup, { kind: 'close_parent' });
}

/** A task's current stage id, or null when the row is gone. */
function readTaskStage(db: Database.Database, taskId: string): string | null {
  const row = db.prepare('SELECT stage_id FROM tasks WHERE id = ?').get(taskId) as
    | { stage_id: string }
    | undefined;
  return row?.stage_id ?? null;
}

// ---------------------------------------------------------------------------
// Trigger 4 — push a locally-created idea out as a top-level issue
// ---------------------------------------------------------------------------

/**
 * The PROVIDER actors. A create authored by one of these is the inbound
 * import's own write landing locally — pushing it back out would file a second
 * issue for the issue we just imported.
 */
const PROVIDER_ACTORS: ReadonlySet<string> = new Set<string>(PROVIDERS);

/**
 * Was this event written by the INBOUND half? An `actor` naming a provider says
 * so exactly; an event with no actor at all is merely UNATTRIBUTED, which is
 * why every trigger that consults this also diffs against the baseline — the
 * two guards cover different failure modes and neither is sufficient alone.
 */
function isProviderAuthored(event: TaskChangedEvent): boolean {
  return event.actor !== undefined && PROVIDER_ACTORS.has(event.actor);
}

/**
 * An idea was just created locally: enqueue a `create_issue` for every active
 * connection in its project that should carry it.
 *
 * FOUR REASONS TO SKIP, and each one covers a case the others cannot:
 *   1. PROVIDER ECHO — `actor` is 'linear'/'plane', so this create IS an
 *      inbound import. Precise, but `actor` is optional on the event.
 *   2. ALREADY LINKED — the idea already has a link for this connection's
 *      provider (a Reconcile-step link, a previous push that landed). Whatever
 *      created it, it is already represented in that tracker.
 *   3. IMPORT PROVENANCE — the body carries the import marker. The backstop
 *      under (1) for an unattributed event.
 *   4. AN EXPERIMENT SANDBOX ROW — an A/B sandbox idea is a local artifact of a
 *      comparison run, not a piece of work anyone tracks, and filing one into a
 *      shared workspace is noise nobody asked for.
 *
 * Plus the ordinary dedupe: an unresolved `create_issue` already queued for
 * this idea means a replayed event adds nothing.
 *
 * A FIFTH SKIP IS PER-CONNECTION: `push_target = 0`. Multi-project mapping
 * (design doc "Multi-project mapping (rev 4)") gives one cyboflow project N
 * sibling connection rows — one per mapped tracker group, all on the same
 * workspace — and exactly one of them per provider is the push target. Without
 * the flag every sibling would enqueue its own `create_issue` and one new idea
 * would file N identical issues remotely. The ALREADY-LINKED skip cannot cover
 * this: at enqueue time the idea carries no link for the provider yet, so every
 * sibling reads it as unrepresented.
 *
 * `mirror_subissues` is deliberately NOT consulted — it scopes the DECOMPOSITION
 * fan-out (whether an idea's tasks become children), which is a different
 * question from whether the idea itself is represented at all.
 */
function handleIdeaPush(deps: WriteBackDeps, event: TaskChangedEvent): void {
  const { db } = deps;
  if (isProviderAuthored(event)) return;
  if ((event.task.experiment_id ?? null) !== null) return;
  if (carriesTrackerProvenance(event.task.body)) return;

  for (const connection of listConnections(db, event.projectId)) {
    if (connection.status !== 'active') continue;
    if (connection.push_target === 0) continue;
    if (getLinkByEntity(db, 'idea', event.taskId, connection.provider) !== null) continue;

    const duplicate = listUnresolvedOutbox(db, connection.id).some(
      (row) => row.kind === 'create_issue' && row.entity_id === event.taskId,
    );
    if (duplicate) continue;

    enqueueOutbox(db, {
      connection_id: connection.id,
      kind: 'create_issue',
      entity_type: 'idea',
      entity_id: event.taskId,
      // No remote issue yet — that is the whole point of the row.
      external_id: null,
      // The idempotency key: Linear uses it as the created issue's id; Plane
      // stamps it into the description so a lost create can be found again.
      client_key: randomUUID(),
      payload_json: CREATE_ISSUE_PAYLOAD_JSON,
    });
  }
}

// ---------------------------------------------------------------------------
// Trigger 5 — content write-back (title / description / priority / category)
// ---------------------------------------------------------------------------

/** The outbox kinds an `update_content` enqueue supersedes: only its own. */
const CONTENT_SUPERSEDES: readonly TrackerOutboxRow['kind'][] = ['update_content'];

/**
 * The FOUR fields {@link contentDiffersFromBaseline} reads, as a structural
 * subset of {@link BacklogTaskItem}.
 *
 * The event-driven trigger hands it a whole `BacklogTaskItem` (which satisfies
 * this) while {@link backfillContentWrites} reads its four columns straight off
 * the entity table — there is no run overlay, no stage, and no ref in a diff
 * that only ever compares title/description/priority/category, and widening the
 * backfill's SELECT to fabricate a full item would be inventing fields the
 * comparison never looks at.
 */
type ContentFields = Pick<BacklogTaskItem, 'title' | 'body' | 'priority' | 'category'>;

/**
 * A linked entity changed. For every link whose connection has content sync ON,
 * enqueue one `update_content` when the entity now DIFFERS from that link's
 * baseline on a synced field.
 *
 * THE BASELINE DIFF IS THE TRIGGER, not the event's `action`. TaskChangeRouter
 * emits on every committed write — a stage move, a run overlay, an unrelated
 * field — and enqueuing on "something changed" would file a remote write for
 * every one of them. The baseline says where the REMOTE stands, so a field that
 * still matches it has nothing to say to the tracker, and a replayed event is a
 * no-op by construction.
 *
 * PER LINK, and every input is per link: the mode, the effective priority and
 * category mappings (a connection's own overlay), and the baseline itself. Two
 * connections on the same entity reach two independent verdicts.
 */
function handleContentChange(
  deps: WriteBackDeps,
  event: TaskChangedEvent,
  allLinked: LinkedContext[],
  entityType: 'idea' | 'task',
): void {
  for (const linked of allLinked) {
    // INVARIANT 5: 'off' declines the intent rather than queueing it. A queued
    // row of a kind no drain will ever claim is a permanent inbound stall, not
    // a delay — see the module header.
    if (linked.connection.content_sync_mode === 'off') continue;
    if (!contentDiffersFromBaseline(linked, event.task)) continue;
    enqueueContentWrite(deps, linked, entityType, event.taskId);
  }
}

/**
 * Does this entity now differ from the link's baseline on ANY field the content
 * write-back carries?
 *
 * FOUR FIELDS, EACH WITH ITS OWN NOTION OF "DIFFERENT":
 *
 *  - TITLE is literal text.
 *  - DESCRIPTION is the remote-owned HALF of the body (the provenance footer is
 *    cyboflow's and never crosses), compared through the same
 *    {@link normalizeDescription} the inbound merge uses — anything that would
 *    not become a three-way diff must not become a remote write either.
 *  - PRIORITY and CATEGORY are compared in PROVIDER SPACE (invariant 2): the
 *    local value is mapped OUT and the tokens compared case-insensitively. A
 *    local-space comparison would read "P3 here, P2 there" on an entity nobody
 *    touched, because seven local levels collapse onto four or five rungs.
 *
 * AN ABSENT BASELINE KEY IS NOT A DIFFERENCE (invariant 3, the outbound face of
 * the backfill arm). `undefined` means the field was never synced, so we do not
 * know where the remote stands — and "send ours" is exactly as unfounded as
 * "take theirs". The next inbound pass overlays a real snapshot, and the edit
 * after that triggers normally. Without this, the first event on every
 * pre-feature link would push its local priority into the tracker.
 *
 * THE MAPPINGS ARE RESOLVED WITHOUT A LIVE OPTION LIST, because this module
 * makes no network calls: the seed's canonical tokens plus the connection's
 * persisted overlay. That is the same "stored overlay, defensively parsed"
 * reading `summarizeConnection` takes of the state mapping, and it is safe
 * BECAUSE THIS IS ONLY A TRIGGER — the drain re-resolves against the provider's
 * live vocabulary and composes the actual patch from that, dropping any field
 * the live list can no longer express. The worst a stale token here can do is
 * enqueue a row the drain then settles with nothing to send.
 */
function contentDiffersFromBaseline(linked: LinkedContext, task: ContentFields): boolean {
  const { connection, link } = linked;
  const baseline = parseJsonObject(link.baseline_json);

  if (typeof baseline.title === 'string' && baseline.title !== task.title) return true;

  if ('description' in baseline) {
    const remote = typeof baseline.description === 'string' ? baseline.description : null;
    if (normalizeDescription(splitBody(task.body).description) !== normalizeDescription(remote)) {
      return true;
    }
  }

  if ('priority' in baseline) {
    const mapping = resolveEffectivePriorityMapping(
      connection.provider,
      null,
      connection.priority_mapping_json,
    );
    const local = providerPriorityToken(mapping, task.priority);
    if (!providerTokensEqual(local, baselineToken(baseline.priority))) return true;
  }

  // Category is Dart-only by the locked scope decision, and the provider table
  // — not a `provider === 'dart'` branch — is what says so.
  if (providerSupportsCategorySync(connection.provider) && 'category' in baseline) {
    const mapping = resolveEffectiveCategoryMapping(
      connection.provider,
      null,
      connection.category_mapping_json,
    );
    const local = providerCategoryToken(mapping, task.category);
    if (!providerTokensEqual(local, baselineToken(baseline.category))) return true;
  }

  return false;
}

/** A stored baseline token, or null for anything that is not a usable string. */
function baselineToken(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/**
 * Queue one content write for a link's issue. Returns true when a row was
 * actually written.
 *
 * THE DEDUPE COLLAPSES `pending` ROWS ONLY, and the exclusion is the whole
 * point. `listUnresolvedOutbox` also returns `in_flight` and `ambiguous` rows —
 * writes whose payload was ALREADY COMPOSED, from the entity as it stood before
 * this edit. Suppressing the new enqueue because one of those exists would lose
 * the edit outright: the in-flight write is going to land the OLD text, and no
 * row would be left to represent the new one. A pending row, by contrast, has
 * composed nothing yet (see {@link UPDATE_CONTENT_PAYLOAD_JSON}) and will pick
 * up this edit for free when it drains — so collapsing onto it is exactly
 * right, and is what makes a burst of typing one remote write.
 *
 * The successor row a non-pending incumbent gets is safe for the same reason:
 * the supersession sweep settles anything it replaces, and drain-time compose
 * means the survivor sends the final text either way.
 *
 * SUPERSESSION IS SCOPED TO ITS OWN KIND. A content write and a state write are
 * ORTHOGONAL statements about the same issue — one moves its status, the other
 * its text — so neither may ever settle the other. Only `archive_issue` crosses
 * kinds, and it does so in the other direction (see
 * {@link enqueueArchiveWrite}).
 *
 * Exported for the service's CONFLICT-RESOLUTION path, which queues the same
 * row when a user accepts the local side of a content conflict — the ruling
 * needs the identical dedupe and sweep, and a second copy of them is how the
 * two would drift.
 */
export function enqueueContentWrite(
  deps: WriteBackDeps,
  linked: LinkedContext,
  entityType: 'idea' | 'task',
  entityId: string,
): boolean {
  const { db } = deps;
  const { connection, link } = linked;

  // See enqueueStateWrite's note — the same gate, for the same reason.
  if (guardedUpdatesUnavailable(connection.provider)) return false;

  const collapsible = listUnresolvedOutbox(db, connection.id).some(
    (row) =>
      row.kind === 'update_content' &&
      row.external_id === link.external_id &&
      row.state === 'pending',
  );
  if (collapsible) return false;

  const enqueued = enqueueOutbox(db, {
    connection_id: connection.id,
    kind: 'update_content',
    entity_type: entityType,
    entity_id: entityId,
    external_id: link.external_id,
    payload_json: UPDATE_CONTENT_PAYLOAD_JSON,
  });
  supersedeQueuedWrites(
    db,
    connection.id,
    link.external_id,
    enqueued.id,
    CONTENT_SUPERSEDES,
    'superseded by a newer content write for the same issue',
  );
  return true;
}

/**
 * The four content columns of one linked entity, or null when the row is gone.
 *
 * A plain SELECT, mirroring inboundSync's `readLocalEntity`: the chokepoint rule
 * governs WRITES, and taskListing's projections carry run overlays a content
 * diff has no use for. `archived_at` rides along because the backfill filters on
 * it — see {@link backfillContentWrites}.
 */
function readEntityContent(
  db: Database.Database,
  entityType: EntityExternalLinkRow['entity_type'],
  entityId: string,
): (ContentFields & { archived_at: string | null }) | null {
  const table = BACKFILL_ENTITY_TABLE[entityType];
  const row = db
    .prepare(
      `SELECT title, body, priority, category, archived_at
         FROM ${table}
        WHERE id = ?`,
    )
    .get(entityId) as (ContentFields & { archived_at: string | null }) | undefined;
  return row ?? null;
}

/**
 * Entity type -> table, the local twin of inboundSync's `ENTITY_TABLE`. Both
 * exist because the table name is interpolated into SQL: a `Record` over the
 * closed union is what keeps that interpolation total and un-injectable.
 */
const BACKFILL_ENTITY_TABLE: Record<
  EntityExternalLinkRow['entity_type'],
  'ideas' | 'epics' | 'tasks'
> = { idea: 'ideas', epic: 'epics', task: 'tasks' };

/**
 * TRIGGER 5's BACKFILL ARM — the missing inverse of invariant 5's enqueue-time
 * decline, run when a connection's content sync leaves `'off'`.
 *
 * WHY IT HAS TO EXIST. `'off'` gates at the ENQUEUE rather than the drain (see
 * the module header), so every local edit made while the direction was off was
 * DECLINED, not delayed: no row was ever written, and nothing else re-derives
 * one. Trigger 5 fires only on the entity-change broadcast, so turning content
 * sync on afterwards changed nothing about entities nobody happened to touch
 * again — their edits stayed local forever, silently, with the tracker showing
 * stale text. Turning a direction ON now reconciles what turning it OFF
 * declined.
 *
 * IT IS THE SAME DECISION TRIGGER 5 MAKES, deliberately reusing
 * {@link contentDiffersFromBaseline} and {@link enqueueContentWrite} rather than
 * restating either: the baseline diff is what says a remote write is owed, and
 * a second copy of that comparison is exactly how the two arms would drift. The
 * dedupe inside `enqueueContentWrite` also makes this safe to run repeatedly —
 * a second flip with rows already pending enqueues nothing.
 *
 * THREE SKIPS, each for its own reason:
 *  - ORPHANED links (`activeOnly`), whose remote issue the deletion sweep has
 *    already archived — writing back is pointless.
 *  - A MISSING entity row: the link outlived its entity, which the sweep owns.
 *  - An ARCHIVED entity. A user turning content sync on is asking for their
 *    live work to reach the tracker, not for text to be pushed onto issues they
 *    retired while the direction was off; the ARCHIVE direction is the one that
 *    owns those, under its own mode and its own consent.
 *
 * DELIBERATELY CONTENT-ONLY. `archive_sync_mode` has the identical gap, and it
 * is NOT fixed here: replaying it would trash every remote twin of everything
 * archived while that direction was off — an irreversible bulk write, on a
 * setting flip, with no preview. That needs its own confirmation UX and is
 * recorded as a follow-up, not smuggled in behind a symmetry argument.
 *
 * Returns how many rows were enqueued, for the caller's log line.
 */
export function backfillContentWrites(
  deps: WriteBackDeps,
  connection: TrackerConnectionRow,
): number {
  if (connection.content_sync_mode === 'off') return 0;
  if (connection.status !== 'active') return 0;

  let enqueued = 0;
  for (const link of listLinks(deps.db, connection.id, { activeOnly: true })) {
    const entity = readEntityContent(deps.db, link.entity_type, link.entity_id);
    if (entity === null) continue;
    if (entity.archived_at !== null) continue;
    // Epics are never linked to an issue (imports land as ideas, mirroring
    // creates sub-issues for TASKS only), so the cast below is narrowing a
    // union the data cannot actually inhabit — but `enqueueContentWrite` takes
    // the two-member entity type, and skipping is the honest way to say so.
    if (link.entity_type === 'epic') continue;
    const linked: LinkedContext = { link, connection };
    if (!contentDiffersFromBaseline(linked, entity)) continue;
    if (enqueueContentWrite(deps, linked, link.entity_type, link.entity_id)) enqueued += 1;
  }
  return enqueued;
}

// ---------------------------------------------------------------------------
// Trigger 6 — remote archive (never a delete)
// ---------------------------------------------------------------------------

/**
 * `archive_issue` supersedes EVERY queued kind for its issue — the one
 * legitimate cross-kind sweep in the engine.
 *
 * Once the twin is going to the tracker's trash, a queued state write ("move it
 * to Done") and a queued content write ("here is the new title") are not merely
 * redundant, they are writes against an issue nobody will look at again — and a
 * backoff that let one of them drain AFTER the archive would resurrect it into
 * a listing. Creates are unaffected: they carry a null `external_id`, so the
 * sweep's key never matches one.
 */
const ARCHIVE_SUPERSEDES: readonly TrackerOutboxRow['kind'][] = [
  'update_state',
  'close_parent',
  'update_content',
  'archive_issue',
];

/**
 * A linked entity was archived or unarchived locally. This is the PLAIN
 * archive path — the board's archive toggle, an orchestrator retirement — with
 * no removal dialog in front of it.
 *
 * THE RULED PATH DOES NOT COME THROUGH HERE, and cannot. TrackerSyncService runs
 * `handleLocalRemoval` BEFORE this listener, and a staged ruling ORPHANS the
 * link on its way past — after which {@link resolveAllLinked} skips it and this
 * arm correctly finds nothing to do. That ordering is what makes a double
 * archive impossible rather than merely unlikely: the ruling's own enqueue
 * (`dropLink`) and this arm are mutually exclusive by construction, not by a
 * flag either of them could forget to check.
 *
 * IDEMPOTENCE IS A STAMP, not an event shape. The event carries the entity's
 * CURRENT `archived_at`, never the transition, and an already-archived entity
 * emits more events (a cascade re-emit, a replay). So the archive fires only
 * when the link carries no `archivedWrittenAt` — and an UNARCHIVE clears that
 * stamp so a later re-archive is a genuine first write again.
 *
 * UNARCHIVE WRITES NOTHING REMOTELY, and the per-provider asymmetry is why:
 * Linear's trash is restorable, Dart's `DELETE` is one-way in its public API,
 * and Plane has no archive endpoint at all. There is no operation the engine
 * could issue that means the same thing on all three, so v1 restores nothing
 * and leaves the tracker to the user. In practice the stamp-clear only matters
 * for a link whose archive row never drained (a mode flip, a held direction):
 * once a remote archive is CONFIRMED, the drain orphans the link, and an
 * orphaned link is not enumerated here at all.
 */
function handleArchiveTransition(
  deps: WriteBackDeps,
  event: TaskChangedEvent,
  allLinked: LinkedContext[],
  entityType: 'idea' | 'task',
): void {
  const archived = event.task.archived_at !== null;

  for (const linked of allLinked) {
    const { connection, link } = linked;
    if (!archived) {
      if (readArchivedWrittenAt(link) !== null) clearArchiveStamp(deps, link);
      continue;
    }
    // INVARIANT 5 again: 'off' declines rather than queueing an undrainable row.
    if (connection.archive_sync_mode === 'off') continue;
    // A provider with no archive endpoint would leave a row its adapter can
    // only throw on — which halts inbound for that issue forever. The ruling
    // path falls back to a cancelled-state write for exactly these; the plain
    // archive path has nothing to fall back TO and simply says nothing.
    if (!providerSupportsRemoteArchive(connection.provider)) continue;
    if (readArchivedWrittenAt(link) !== null) continue;
    enqueueArchiveWrite(deps, linked, entityType, event.taskId);
  }
}

/**
 * Queue one remote archive for a link's issue. Returns true when a row was
 * written. Exported for the service's RULED-removal path, which enqueues the
 * same row from inside `dropLink` — before the link is orphaned, since the
 * dedupe and the supersession sweep both read live rows for that issue.
 */
export function enqueueArchiveWrite(
  deps: WriteBackDeps,
  linked: LinkedContext,
  entityType: 'idea' | 'epic' | 'task',
  entityId: string,
): boolean {
  const { db } = deps;
  const { connection, link } = linked;

  // See enqueueStateWrite's note — the same gate, for the same reason.
  if (guardedUpdatesUnavailable(connection.provider)) return false;

  // Any unresolved archive for this issue already says everything this row
  // would. Unlike the content dedupe there is nothing to re-compose, so an
  // in-flight incumbent is a reason to stay quiet rather than to succeed it.
  const duplicate = listUnresolvedOutbox(db, connection.id).some(
    (row) => row.kind === 'archive_issue' && row.external_id === link.external_id,
  );
  if (duplicate) return false;

  const enqueued = enqueueOutbox(db, {
    connection_id: connection.id,
    kind: 'archive_issue',
    entity_type: entityType,
    entity_id: entityId,
    external_id: link.external_id,
    payload_json: ARCHIVE_ISSUE_PAYLOAD_JSON,
  });
  supersedeQueuedWrites(
    db,
    connection.id,
    link.external_id,
    enqueued.id,
    ARCHIVE_SUPERSEDES,
    'superseded by a remote archive of the same issue',
  );
  return true;
}

/**
 * Drop the `archivedWrittenAt` key from a link's baseline. Written as an
 * explicit `delete` on the parsed blob rather than a patch spread, because a
 * patch carrying `undefined` is how the OTHER stamps are composed and mixing
 * the two idioms on one blob is how a key gets erased by accident.
 */
function clearArchiveStamp(deps: WriteBackDeps, link: EntityExternalLinkRow): void {
  const blob = parseJsonObject(link.baseline_json);
  delete blob.archivedWrittenAt;
  updateBaseline(deps.db, link.id, JSON.stringify(blob));
}
