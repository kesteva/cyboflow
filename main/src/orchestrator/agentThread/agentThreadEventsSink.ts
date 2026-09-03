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
import type { EventRouter } from '../../../../shared/streamParser/eventRouter';
import { derivePersistedEventType } from '../../../../shared/streamParser/derivers';
import type { SpawnEventsSink } from '../../services/panels/claude/claudeCodeManager';
import type { ClaudeStreamEvent, ResultEvent, UserEvent } from '../../../../shared/types/claudeStream';
import type { AgentStreamEvent } from '../../../../shared/types/agentStream';
import { buildUserTextEvent } from '../programmatic/syntheticEvents';
import type { AgentThreadDbStore } from './agentThreadDbStore';
import type { LoggerLike } from '../types';
import { AGENT_THREAD_SPAWN_PREFIX, isAgentThreadSpawnId } from '../../../../shared/types/agentThread';

/** Spawn-identity prefix for a global-agent thread: `agent:<threadId>`. */
export const AGENT_SPAWN_PREFIX = AGENT_THREAD_SPAWN_PREFIX;

/** Compose the synthetic spawn identity (panelId === sessionId === runId) for a thread. */
export function agentSpawnIdentity(threadId: string): string {
  return `${AGENT_THREAD_SPAWN_PREFIX}${threadId}`;
}

/**
 * Recover the bare threadId from a spawn identity. Strips a leading `agent:`;
 * an id without the prefix is returned unchanged (defensive — the router runId
 * for an agent spawn always carries it, but the mapping must not corrupt a bare
 * id if one ever arrives).
 */
export function threadIdFromSpawnIdentity(spawnIdentity: string): string {
  return isAgentThreadSpawnId(spawnIdentity)
    ? spawnIdentity.slice(AGENT_THREAD_SPAWN_PREFIX.length)
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
   * Subscribe to the router's per-run event stream, in whichever provider shape
   * the hosting manager routes (Claude's `ClaudeStreamEvent` or Codex's
   * `AgentStreamEvent`) — ONE injected sink serves the thread on either runtime.
   * `runId` is the spawn identity `agent:<threadId>`; each event is persisted to
   * the mapped bare thread. A second attach for the same runId detaches the first (no duplicate rows) —
   * this happens on a cold RESPAWN (fingerprint drift / stale-resume recovery)
   * that re-runs the pipeline setup with a fresh router.
   */
  attachToRouter(
    router: EventRouter<ClaudeStreamEvent> | EventRouter<AgentStreamEvent>,
    runId: string,
  ): void {
    const existing = this.teardowns.get(runId);
    if (existing !== undefined) {
      existing();
    }
    const threadId = threadIdFromSpawnIdentity(runId);
    const handler = (event: ClaudeStreamEvent | AgentStreamEvent): void => {
      this.handleEvent(threadId, event);
    };
    // Calling `onRun` on the union resolves to the INTERSECTION of the two
    // handler parameters, which is exactly what the union-typed handler above
    // satisfies — so no narrowing cast is needed here.
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
   * Persist the human's composer input as a synthetic user-text turn, and return
   * the event so the caller can publish it on live-tail.
   *
   * The SDK stream never echoes the prompt back — its only `user` events are
   * tool_result plumbing — so without this write the person's own messages are
   * absent from the reconstructed transcript entirely (the chat reads as a
   * monologue of assistant replies). Routed through the SAME `handleEvent` path
   * as stream events so `agent_thread_events` keeps exactly one writer, and
   * built with the same `buildUserTextEvent` shape the programmatic monitor
   * injects, which `MessageProjection` already renders as a `role:'user'` turn.
   */
  recordUserTurn(threadId: string, text: string): UserEvent {
    const event = buildUserTextEvent(text);
    this.handleEvent(threadId, event);
    return event;
  }

  /**
   * Persist a failed turn as a terminal error result, and return the event so
   * the caller can publish it on live-tail — the twin of {@link recordUserTurn}
   * for the OTHER end of a turn.
   *
   * Without this a spawn failure is invisible in the UI: `sendMessage` rethrows
   * and the rail has no dedicated error slot, so the person sees their own
   * message and then nothing at all. That matters far more now that the
   * assistant can run on Codex, whose two most likely first-turn failures
   * (ChatGPT auth required, Codex not installed) are exactly the ones a new
   * user hits. Shaped as a `result` / `error_during_execution` event because
   * MessageProjection already renders that as the turn's terminal error — no
   * renderer change, and it reads identically on both providers.
   *
   * Routed through the same single-writer {@link handleEvent} path as every
   * other row, so it is fail-soft too: recording the error can never itself
   * throw over the original failure the caller is about to rethrow.
   */
  recordAssistantError(threadId: string, message: string): ResultEvent {
    const event: ResultEvent = {
      type: 'result',
      subtype: 'error_during_execution',
      is_error: true,
      // The turn never ran, so there is no measured duration and no completed
      // turn to count — zeros, not fabricated values.
      duration_ms: 0,
      num_turns: 0,
      result: message,
    };
    this.handleEvent(threadId, event);
    return event;
  }

  /**
   * Persist one event thread-keyed, in EITHER provider's shape: the Claude SDK
   * substrate routes `ClaudeStreamEvent`, the Codex app-server substrate routes
   * `AgentStreamEvent`. Storage is verbatim for both —
   * `derivePersistedEventType` already maps the `agent_*` variants onto their own
   * `agent_*` persisted types, and the listing projection converts stored
   * `agent_*` payloads on read — so nothing here needs to normalize shapes.
   * Tolerant of unknown ones too: `derivePersistedEventType` normalizes an
   * UnknownStreamEvent to 'unknown', and the full event is stored as raw JSON.
   *
   * Fail-soft — a store error is logged at WARN (with the thread id) and
   * swallowed so it can never break the spawn.
   */
  private handleEvent(threadId: string, event: ClaudeStreamEvent | AgentStreamEvent): void {
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
