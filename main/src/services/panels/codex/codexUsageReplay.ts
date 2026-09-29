import type Database from 'better-sqlite3';
import type { AppServerJsonValue, RawResponseCompletedNotification } from './appServer/protocol';
import { CodexTurnUsageAccumulator } from './appServer/usageAccumulator';
import { CodexDescendantRegistry } from './appServer/usageLedger';
import { parseCodexUsageSignals } from './appServer/usageNotifications';
import { CODEX_RAW_NOTIFICATION_EVENT_TYPE } from './appServer/rawNotificationSink';
import {
  CODEX_USAGE_ROW_UPSERT_SQL,
  completeUsage,
  type CodexSubagentUsagePayload,
} from './codexUsageTracker';

/**
 * Historical Codex descendant usage, rebuilt from a past run's stored app-server
 * notifications (docs/proposals/codex-workflow-efficiency.md §5.2, 1d) — the
 * replay half of the one-shot boot backfill (orchestrator/runUsageBackfill.ts).
 *
 * Past runs have no invocation ↔ turn link, so the live
 * `codex-subagent:<invocationId>:<threadId>` key cannot be rebuilt. Each
 * descendant thread instead gets one run-level row,
 * `codex-subagent-run:<runId>:<rootThreadId>:<rootTurnId>:<threadId>`, where
 * the root turn is the one during which the thread (or its topmost spawned
 * ancestor) was spawned. A thread with usage that no spawn ever registered gets
 * `codex-unattributed:<runId>:<threadId>`.
 *
 * Root threads are never written: their usage is already the run's historical
 * `agent_result` rows, which stay untouched (root-thread-only, by TurnSession's
 * filter). A thread is a root when one of the run's invocations ran on it —
 * `agent_invocations.external_session_id`, or the `external_session_id` a Codex
 * `agent_result` carries. Structure ("a spawn sender that is never a receiver")
 * is deliberately NOT a root signal: a descendant whose own spawn item is
 * missing would then be taken for a root and its usage dropped, whereas as an
 * unregistered thread it is still counted, run-level.
 *
 * There are no top-ups: `thread/tokenUsage/updated` was stored last-write-wins
 * per (run, turn) (rawNotificationSink.ts), so its per-request history — the
 * thing a top-up pairs against responses — no longer exists. A request whose
 * `rawResponse/completed` never arrived (or carried `usage: null`) is lost.
 */

/** A stored `codex_app_server_notification` row, in raw_events id order. */
export interface CodexReplayNotificationRow {
  payloadJson: string;
  createdAt: string;
}

export interface CodexRunReplayInput {
  runId: string;
  notifications: Iterable<CodexReplayNotificationRow>;
  /** Threads the run's invocations ran as root (see the module header). */
  rootThreadIds: ReadonlySet<string>;
  /** Threads a live usage tracker already wrote a `codex-` row for — never replayed. */
  liveThreadIds: ReadonlySet<string>;
  /**
   * The display model of a root thread (null: the run's latest), used for a
   * descendant whose spawn named none — flagged `model_inferred`.
   */
  rootModel: (rootThreadId: string | null) => string;
}

export interface CodexHistoricalUsageRow {
  dedupKey: string;
  /** The thread's last counted response's stored time, so daily buckets land on the day the tokens were spent. */
  createdAt: string;
  payload: CodexSubagentUsagePayload;
}

export interface CodexRunReplay {
  /**
   * At least one `rawResponse/completed` was stored. False for runs before the
   * app-server emitted them (2026-09-14T19:51Z): their descendants cannot be
   * rebuilt, and the run is root-only.
   */
  hasResponses: boolean;
  rows: CodexHistoricalUsageRow[];
}

/** The root turn a descendant was spawned under — the registry owner. */
interface HistoricalRootTurn {
  rootThreadId: string;
  rootTurnId: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Replays one run's notifications (pure — no DB). Registrations are replayed
 * in stored order first, then every response is attributed, so a response that
 * was stored before its thread's spawn item is still attributed (the live
 * tracker buffers it for the same reason).
 */
export function replayCodexRunNotifications(input: CodexRunReplayInput): CodexRunReplay {
  const owners = new Map<string, HistoricalRootTurn>();
  const registry = new CodexDescendantRegistry<HistoricalRootTurn>((threadId, turnId) => {
    if (!input.rootThreadIds.has(threadId)) return null;
    const key = `${threadId}\u0000${turnId}`;
    let owner = owners.get(key);
    if (!owner) {
      owner = { rootThreadId: threadId, rootTurnId: turnId };
      owners.set(key, owner);
    }
    return owner;
  });
  const responses: Array<{ notification: RawResponseCompletedNotification; createdAt: string }> = [];
  let hasResponses = false;

  for (const row of input.notifications) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.payloadJson);
    } catch {
      continue;
    }
    if (!isRecord(parsed) || typeof parsed.method !== 'string') continue;
    // A parsed JSON document is a JSON value by construction.
    const params = parsed.params as AppServerJsonValue | undefined;
    for (const signal of parseCodexUsageSignals({ method: parsed.method, params })) {
      if (signal.kind === 'spawn') {
        registry.register(
          signal.senderThreadId,
          signal.turnId,
          signal.receiverThreadIds.map((threadId) => ({ threadId, model: signal.model })),
        );
      } else if (signal.kind === 'subAgentStarted') {
        registry.register(signal.threadId, signal.turnId, [{ threadId: signal.agentThreadId, model: null }]);
      } else if (signal.kind === 'response') {
        hasResponses = true;
        responses.push({ notification: signal.notification, createdAt: row.createdAt });
      }
    }
  }

  // One accumulator for the whole run: it deduplicates by responseId across
  // every thread and keeps one disjoint total per thread.
  const accumulator = new CodexTurnUsageAccumulator(null);
  const lastCountedAt = new Map<string, string>();
  for (const { notification, createdAt } of responses) {
    const { threadId } = notification;
    if (input.rootThreadIds.has(threadId) || input.liveThreadIds.has(threadId)) continue;
    if (notification.usage === null) continue;
    if (accumulator.observeResponse(threadId, notification.responseId, notification.usage)) {
      lastCountedAt.set(threadId, createdAt);
    }
  }

  const rows: CodexHistoricalUsageRow[] = [];
  for (const [threadId, usage] of accumulator.descendantSnapshots()) {
    const record = registry.get(threadId);
    const createdAt = lastCountedAt.get(threadId) ?? '';
    if (record) {
      const model = registry.resolveModel(threadId, input.rootModel(record.owner.rootThreadId));
      rows.push({
        dedupKey: `codex-subagent-run:${input.runId}:${record.owner.rootThreadId}:${record.owner.rootTurnId}:${threadId}`,
        createdAt,
        payload: {
          type: 'subagent_usage',
          provider: 'codex',
          thread_id: threadId,
          parent_thread_id: record.parentThreadId,
          invocation_id: null,
          model_inferred: model.inferred,
          message: { model: model.model, usage: completeUsage(usage) },
        },
      });
    } else {
      rows.push({
        dedupKey: `codex-unattributed:${input.runId}:${threadId}`,
        createdAt,
        payload: {
          type: 'subagent_usage',
          provider: 'codex',
          thread_id: threadId,
          parent_thread_id: null,
          invocation_id: null,
          model_inferred: true,
          message: { model: input.rootModel(null), usage: completeUsage(usage) },
        },
      });
    }
  }
  return { hasResponses, rows };
}

export interface CodexRunUsageReplayOutcome {
  hasResponses: boolean;
  /** Historical `codex-subagent-run:` / `codex-unattributed:` rows upserted. */
  rowsWritten: number;
}

/** The display model a model-less spawn falls back to when nothing names one (as the live tracker). */
const CODEX_DEFAULT_MODEL = 'codex-default';

/**
 * Only the notifications the replay reads: responses and the two item kinds
 * that register descendants. The prefix test relies on the sink storing
 * `JSON.stringify({ method, params })` — method first (true of every stored
 * row); it keeps the scan to a prefix compare on the ~99% of rows that are
 * something else. The replay re-checks every row's method itself.
 */
const REPLAY_NOTIFICATIONS_SQL = `
  SELECT payload_json AS payloadJson, created_at AS createdAt
    FROM raw_events
   WHERE run_id = ?
     AND event_type = '${CODEX_RAW_NOTIFICATION_EVENT_TYPE}'
     AND created_at < ?
     AND (
       payload_json LIKE '{"method":"rawResponse/completed"%'
       OR (
         (payload_json LIKE '{"method":"item/started"%' OR payload_json LIKE '{"method":"item/completed"%')
         AND (instr(payload_json, '"collabAgentToolCall"') > 0 OR instr(payload_json, '"subAgentActivity"') > 0)
       )
     )
   ORDER BY id
`;

export interface ReplayCodexRunUsageOptions {
  /**
   * Only notifications stored before this ISO instant are replayed — the boot
   * wiring passes the process start. A run resumed on this boot has a live
   * tracker writing its NEW threads; one of those still buffered unregistered
   * has responses but no row yet, and replaying it would write the same
   * run-scoped `codex-unattributed:` key the tracker later adds onto.
   */
  notifiedBefore: string;
}

/**
 * Reads the run's roots, models and notifications (all indexed by run_id),
 * replays them and upserts the historical rows. Throws on any DB error — the
 * caller runs it inside the run's backfill transaction, so a failure rolls the
 * whole run back. Idempotent: every row is an upsert on its dedup key, and a
 * re-run computes the same values.
 */
export function replayCodexRunUsage(
  db: Database.Database,
  runId: string,
  options: ReplayCodexRunUsageOptions,
): CodexRunUsageReplayOutcome {
  const rootModels = new Map<string, string>();
  const rootThreadIds = new Set<string>();
  let runModel = CODEX_DEFAULT_MODEL;
  const invocations = db
    .prepare(
      `SELECT external_session_id AS threadId, model, agent_runtime AS runtime
         FROM agent_invocations
        WHERE run_id = ? AND external_session_id IS NOT NULL
        ORDER BY id`,
    )
    .all(runId) as Array<{ threadId: string; model: string | null; runtime: string | null }>;
  for (const { threadId, model, runtime } of invocations) {
    rootThreadIds.add(threadId);
    // A mixed run's Claude invocations are harmless roots (no Codex thread has
    // their id) but must not lend a Codex descendant their model.
    if (runtime?.startsWith('codex') !== true || model === null || model.trim() === '') continue;
    rootModels.set(threadId, model);
    runModel = model;
  }
  const resultThreads = db
    .prepare(
      `SELECT DISTINCT json_extract(payload_json, '$.external_session_id') AS threadId
         FROM raw_events
        WHERE run_id = ? AND event_type = 'agent_result'`,
    )
    .all(runId) as Array<{ threadId: unknown }>;
  for (const { threadId } of resultThreads) {
    if (typeof threadId === 'string' && threadId !== '') rootThreadIds.add(threadId);
  }
  // Threads a live tracker already accounted (1a): replaying them too would
  // double count. `codex-subagent-run:` is this replay's own key and is not
  // matched (`codex-subagent:%` needs the colon); a previous replay's
  // unattributed row is, which leaves it as written.
  const liveRows = db
    .prepare(
      `SELECT json_extract(payload_json, '$.thread_id') AS threadId
         FROM raw_events
        WHERE run_id = ? AND event_type = 'subagent_usage'
          AND (dedup_key LIKE 'codex-subagent:%'
               OR dedup_key LIKE 'codex-unattributed:%'
               OR dedup_key LIKE 'codex-usage-topup:%')`,
    )
    .all(runId) as Array<{ threadId: unknown }>;
  const liveThreadIds = new Set<string>();
  for (const { threadId } of liveRows) {
    if (typeof threadId === 'string') liveThreadIds.add(threadId);
  }

  // Streamed: a large run's responses carry per-item attribution metadata
  // (~12 KB each), so the payloads are never all held at once.
  const replay = replayCodexRunNotifications({
    runId,
    notifications: db.prepare(REPLAY_NOTIFICATIONS_SQL).iterate(runId, options.notifiedBefore) as Iterable<CodexReplayNotificationRow>,
    rootThreadIds,
    liveThreadIds,
    rootModel: (rootThreadId) => (rootThreadId !== null ? rootModels.get(rootThreadId) : undefined) ?? runModel,
  });

  const upsert = db.prepare(CODEX_USAGE_ROW_UPSERT_SQL);
  for (const row of replay.rows) {
    upsert.run(runId, JSON.stringify(row.payload), row.createdAt, row.dedupKey);
  }
  return {
    hasResponses: replay.hasResponses,
    rowsWritten: replay.rows.length,
  };
}
