/**
 * AgentThreadEventsSink — the SINGLE durable writer for `agent_thread_events`.
 *
 * The global-agent thread is a run-less SDK conversation whose spawn identity is
 * `agent:<threadId>` (panelId === sessionId === runId), so the built-in
 * {@link RawEventsSink} cannot persist its transcript: `raw_events.run_id` is
 * FK'd to `workflow_runs`, which the thread has no row in (every INSERT would
 * fail-soft-drop — S0.2 §2.2). Instead the spawn seam SUPPRESSES the built-in
 * sink and routes the SAME narrowed event stream into this sink
 * (`eventsSink` option → {@link SpawnEventsSink}); this class owns the
 * `agent:<threadId>` → bare `threadId` mapping and writes each event thread-keyed
 * via {@link AgentThreadDbStore.appendEvent}.
 *
 * Fail-soft, mirroring RawEventsSink's posture — an append error must NEVER throw
 * into the spawn pipeline (a transient DB hiccup can't kill the SDK iterator) —
 * but WITHOUT silent drops: every failure is logged at WARN with the thread id.
 *
 * Standalone-safe: depends only on the pure {@link EventRouter} type, the pure
 * `derivePersistedEventType` deriver, and the {@link AgentThreadDbStore}
 * (DatabaseLike-backed). No electron / better-sqlite3 value import.
 */
import type { EventRouter } from '../../services/streamParser/eventRouter';
import { derivePersistedEventType } from '../../services/streamParser/derivers';
import type { SpawnEventsSink } from '../../services/panels/claude/claudeCodeManager';
import type { ClaudeStreamEvent } from '../../../../shared/types/claudeStream';
import type { AgentThreadDbStore } from './agentThreadDbStore';
import type { LoggerLike } from '../types';

/** Spawn-identity prefix for a global-agent thread: `agent:<threadId>`. */
export const AGENT_SPAWN_PREFIX = 'agent:';

/** Compose the synthetic spawn identity (panelId === sessionId === runId) for a thread. */
export function agentSpawnIdentity(threadId: string): string {
  return `${AGENT_SPAWN_PREFIX}${threadId}`;
}

/**
 * Recover the bare threadId from a spawn identity. Strips a leading `agent:`;
 * an id without the prefix is returned unchanged (defensive — the router runId
 * for an agent spawn always carries it, but the mapping must not corrupt a bare
 * id if one ever arrives).
 */
export function threadIdFromSpawnIdentity(spawnIdentity: string): string {
  return spawnIdentity.startsWith(AGENT_SPAWN_PREFIX)
    ? spawnIdentity.slice(AGENT_SPAWN_PREFIX.length)
    : spawnIdentity;
}

export class AgentThreadEventsSink implements SpawnEventsSink {
  /** runId (`agent:<threadId>`) → EventRouter teardown, mirroring RawEventsSink. */
  private readonly teardowns = new Map<string, () => void>();

  constructor(
    private readonly store: AgentThreadDbStore,
    private readonly logger?: LoggerLike,
  ) {}

  /**
   * Subscribe to the router's per-run event stream. `runId` is the spawn identity
   * `agent:<threadId>`; each event is persisted to the mapped bare thread. A
   * second attach for the same runId detaches the first (no duplicate rows) —
   * this happens on a cold RESPAWN (fingerprint drift / stale-resume recovery)
   * that re-runs the pipeline setup with a fresh router.
   */
  attachToRouter(router: EventRouter, runId: string): void {
    const existing = this.teardowns.get(runId);
    if (existing !== undefined) {
      existing();
    }
    const threadId = threadIdFromSpawnIdentity(runId);
    const handler = (event: ClaudeStreamEvent): void => {
      this.handleEvent(threadId, event);
    };
    const teardown = router.onRun(runId, handler);
    this.teardowns.set(runId, teardown);
  }

  /**
   * Detach the router listener(s). With a runId, detach only that run; without,
   * detach all. Idempotent (mirrors RawEventsSink.dispose).
   */
  dispose(runId?: string): void {
    if (runId !== undefined) {
      const teardown = this.teardowns.get(runId);
      if (teardown !== undefined) {
        teardown();
        this.teardowns.delete(runId);
      }
      return;
    }
    for (const teardown of this.teardowns.values()) {
      teardown();
    }
    this.teardowns.clear();
  }

  /**
   * Persist one event thread-keyed. Tolerant of unknown event shapes:
   * `derivePersistedEventType` normalizes an UnknownStreamEvent to 'unknown', and
   * the full event is stored as raw JSON. Fail-soft — a store error is logged at
   * WARN (with the thread id) and swallowed so it can never break the spawn.
   */
  private handleEvent(threadId: string, event: ClaudeStreamEvent): void {
    try {
      const eventType = derivePersistedEventType(event);
      const payloadJson = JSON.stringify(event);
      this.store.appendEvent(threadId, eventType, payloadJson);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger?.warn(`[agentThreadEventsSink] append failed for thread ${threadId}: ${message}`);
    }
  }
}
