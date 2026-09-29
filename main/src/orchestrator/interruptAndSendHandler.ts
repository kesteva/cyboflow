/**
 * interruptAndSendHandler — extracted business logic for the `runs.interruptAndSend`
 * tRPC mutation (TASK-301 — interrupt & send parity for flow-run chat).
 *
 * Quick sessions can abort an in-flight turn and drive a new message immediately
 * (`panels:continue` with `interrupt=true`). Flow runs only had "Queue" (buffer for
 * the next turn boundary — see `runs.queueInput`). This handler is the flow-run twin
 * of that quick-session interrupt-and-send path: abort the run's LIVE spawn (if any),
 * then deliver the typed text as the run's very next turn via the SAME nudge
 * re-spawn mechanism `runs.nudge` / the queued-input drain seam already use — so
 * there is exactly one re-spawn, serialized on the per-run `RunQueueRegistry` (no
 * double-spawn race).
 *
 * Deliberately does NOT reimplement the queue+redrive machinery: once the abort (if
 * any) has been requested, delivery is handed straight to {@link nudgeRunHandler} —
 * the exact collaborator `queuedInputDeliverer` already re-drives through at the
 * drained REST seam. That handler owns the terminal/idle/blocked/no_session guards,
 * the awaiting_review -> running flip (or the "parked running" fast path), and the
 * per-run queue discipline; duplicating any of that here would just be a second,
 * driftable copy of the same rules.
 *
 * Lane scoping (constraint #3 — fan-out sprint runs): a fan-out batch's per-lane
 * agents spawn under `${runId}:${taskId}` (see SubstrateDispatchFacade /
 * laneRewindHandler), NOT under the run id itself. This mutation only ever targets
 * ONE spawn key — the run-level orchestrator spawn (`runId`) by default, or a named
 * lane's spawn key when the caller supplies `itemId` (`${runId}:${itemId}`). It
 * NEVER iterates every live spawn key and aborts them all: today's flow-run chat
 * composer (ChatInput.tsx) has no UI to pick a specific lane, so it always omits
 * `itemId` and this always resolves to the run-level key, leaving every lane's
 * spawn untouched — exactly the conservative behavior constraint #3 asks for. The
 * `itemId` parameter exists so a FUTURE lane-scoped composer can target one lane
 * without a second mutation.
 *
 * IMPORTANT: `SubstrateDispatchFacade.abort(spawnKey)` does NOT itself guarantee
 * "run-level only" — `ClaudeCodeManager.killProcess(runId)` -> `killRun(runId)`
 * aborts EVERY spawn key registered under that runId, lane keys included (see
 * claudeCodeManager.ts's `spawnKeysByRunId` fan-in). The ONLY reason this mutation
 * is safe against a fan-out run is the `execution_model === 'programmatic'` guard
 * below: a fan-out batch's lanes are registered exclusively under a PROGRAMMATIC
 * run, and that guard refuses the mutation entirely before any abort is issued.
 * A non-programmatic (orchestrated / quick-session-shaped) run never registers a
 * sibling lane spawn key under its own runId — see pauseRunHandler.ts's parallel
 * `abortProgrammaticWalk` note for the same execution-model split. If that
 * invariant ever stops holding (a non-programmatic run gains a second live spawn
 * key under one runId), this comment's safety claim — and the guard below — must
 * be revisited.
 *
 * Programmatic (Sprint fan-out) runs are refused entirely (constraint #2b): each
 * DAG step of a programmatic run is a FRESH SDK session, so aborting only the
 * current step's spawn does NOT signal the WorkflowController's walk — the
 * aborted step's query() resolves CLEANLY, is recorded 'ok', and the walk keeps
 * spawning subsequent steps as though the interrupted step succeeded, corrupting
 * the run's step history. See pauseRunHandler.ts's header note on
 * `abortProgrammaticWalk` for the full explanation of why a spawn-only abort is
 * unsafe for this execution model. Refused up front with `{ noOp: true, reason:
 * 'programmatic_unsupported' }`, before any abort is attempted.
 *
 * SDK substrate only (constraint #5): an interactive (PTY) run keeps its existing
 * live relay path (`runs.relayInput`) — there is no query()-per-turn boundary to
 * abort-and-redrive there, the PTY already accepts live keystrokes. This mutation
 * refuses a non-sdk run with `{ noOp: true, reason: 'interactive_unsupported' }`
 * before touching any abort seam.
 *
 * "Interrupted" transcript marker: when a live spawn was actually found (and its
 * abort attempted), a synthetic `system/assistant_interrupted` event is inserted
 * into `raw_events` — the SAME synthetic marker shape TASK-297's
 * `AgentThreadEventsSink.recordAssistantInterrupted` mints for the global assistant
 * rail's Stop control. `MessageProjection` (shared/streamParser, the SAME
 * projection pipeline `selectRunUnifiedMessages` runs every flow-run event through)
 * already renders that shape as a muted one-line "Stopped" divider rather than an
 * error card — reusing it here needs no new renderer support and keeps the two
 * surfaces visually consistent. No stale-resume retry is at risk on this path: an
 * aborted SDK query() resolves CLEANLY for RunExecutor.execute() (the abort is
 * observed as a normal 'drained' iterator exit, not a caught error — see
 * runExecutor.ts's execute() try/catch and pauseRunHandler's header note), so there
 * is no error-classification branch here to misfire a retry.
 *
 * Standalone-typecheck invariant: no imports from 'electron', 'better-sqlite3', or
 * any concrete service in main/src/services/*. All collaborators are injected via
 * InterruptAndSendDeps. `shared/streamParser` is already imported by the sibling
 * orchestrator module `runUnifiedMessagesListing.ts`, so importing it here does not
 * widen that invariant.
 */
import type { DatabaseLike, LoggerLike } from './types';
import { TERMINAL_RUN_STATUSES } from '../../../shared/types/cyboflow';
import { nudgeRunHandler, type NudgeRunDeps, type NudgeNoOpReason } from './nudgeRunHandler';
import { derivePersistedEventType } from '../../../shared/streamParser/derivers';
import type { SystemAssistantInterruptedEvent } from '../../../shared/types/claudeStream';

// ---------------------------------------------------------------------------
// Dependency bag
// ---------------------------------------------------------------------------

export interface InterruptAndSendDeps extends NudgeRunDeps {
  /**
   * Abort the live spawn identified by `spawnKey` — backed by
   * `SubstrateDispatchFacade.abort(spawnKey)`, the SAME kill seam Pause/Cancel/
   * lane-rewind use. Called with either `runId` (run-level orchestrator spawn) or
   * `${runId}:${itemId}` (one named lane), never with every live key at once.
   */
  abortRunSpawn: (spawnKey: string) => Promise<void>;
  /**
   * The run's currently-live spawn keys (run-level + any per-lane
   * `${runId}:${taskId}` keys) — backed by
   * `SubstrateDispatchFacade.listLiveSpawnKeys(runId)`. Consulted ONLY to decide
   * whether the ONE targeted spawn key is actually live before aborting it; never
   * iterated to abort every entry.
   */
  listLiveSpawnKeys: (runId: string) => string[];
}

// ---------------------------------------------------------------------------
// Result type
// ---------------------------------------------------------------------------

export type InterruptAndSendResult =
  | { delivered: true; interrupted: boolean }
  | { noOp: true; reason: NudgeNoOpReason | 'interactive_unsupported' | 'programmatic_unsupported' };

// ---------------------------------------------------------------------------
// Internal row type
// ---------------------------------------------------------------------------

interface InterruptAndSendRunRow {
  status: string;
  substrate: string | null;
  execution_model: 'orchestrated' | 'programmatic' | null;
}

const TERMINAL_STATUSES = new Set<string>(TERMINAL_RUN_STATUSES);

/**
 * Insert the synthetic `system/assistant_interrupted` marker for `runId`. Fail-soft:
 * a write failure is logged and swallowed — a missing marker must never block the
 * actual redrive (the whole point of this mutation).
 */
function recordInterruptedMarker(db: DatabaseLike, runId: string, logger?: LoggerLike): void {
  try {
    const event: SystemAssistantInterruptedEvent = { type: 'system', subtype: 'assistant_interrupted' };
    db.prepare(
      `INSERT INTO raw_events (run_id, event_type, payload_json, created_at) VALUES (?, ?, ?, ?)`,
    ).run(runId, derivePersistedEventType(event), JSON.stringify(event), new Date().toISOString());
  } catch (err) {
    logger?.warn('[interruptAndSend] failed to record the "Interrupted" transcript marker', {
      runId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * Abort the targeted live spawn (if any) for `runId`, then deliver `text` as the
 * run's next turn.
 *
 *  1. `trim(text)` empty            → `{ noOp: 'empty' }`.
 *  2. run row missing               → `{ noOp: 'not_found' }`.
 *  3. status terminal               → `{ noOp: 'terminal' }`.
 *  4. `substrate !== 'sdk'`         → `{ noOp: 'interactive_unsupported' }` (the
 *     interactive PTY keeps its own live relay path — see header note).
 *  5. `execution_model === 'programmatic'` → `{ noOp: 'programmatic_unsupported' }`
 *     (see header note — a fan-out run's step-scoped abort cannot signal the
 *     WorkflowController's walk, so this run type is refused outright, before any
 *     abort is attempted).
 *  6. Resolve the ONE spawn key this call targets (`itemId` given → the named
 *     lane's `${runId}:${itemId}`; otherwise the run-level `runId`) and check it
 *     against `listLiveSpawnKeys(runId)`.
 *       - NOT live → nothing to interrupt (the "interrupt" half is an honest
 *         no-op); delegate delivery straight to `nudgeRunHandler(runId, text,
 *         deps)`, which behaves exactly like a plain `runs.nudge` on an idle run.
 *         Any `nudgeRunHandler` noOp reason (e.g. `'blocked'`, `'no_session'`) is
 *         passed straight through.
 *       - LIVE → buffer `text` via `deps.runExecutor.queueInput(runId, text)` —
 *         the SAME TASK-300 queue mechanism `runs.queueInput` uses — BEFORE
 *         requesting the abort, THEN `abortRunSpawn(spawnKey)` (fail-soft: a
 *         rejection is logged, not thrown) and record the "Interrupted"
 *         transcript marker. This handler does NOT also call `nudgeRunHandler`
 *         itself in this branch: `abortRunSpawn` resolving does not guarantee
 *         `RunExecutor.execute()`'s aborted turn has reached its drained arm yet
 *         (onLifecycleTransition('drained') -> teardownRun ->
 *         drainQueuedInputAtRest — see runExecutor.ts), so a second, direct
 *         nudge call here would race that drain and could see
 *         `hasActiveExecution(runId) === true`, get refused `not_idle`, and
 *         silently drop the message. Queuing first means the aborted turn's OWN
 *         drain delivers the buffered text through the existing nudge path, on
 *         the run queue, strictly AFTER teardown completes — no race, no second
 *         redundant spawn attempt.
 *
 * Returns `{ delivered: true; interrupted }` — `interrupted` reports whether a live
 * spawn was actually found and an abort attempted (distinct from whether that abort
 * itself succeeded, which is fail-soft and never blocks delivery). For the LIVE
 * branch, `delivered: true` means "handed off for delivery via the queue+drain
 * seam" — it does not wait for the drain to actually land, mirroring
 * `runs.queueInput`'s own `{ queued: true }` contract (a later guard failure at
 * drain time, e.g. a review item that appeared in the interim, is logged, not
 * surfaced back to this call — the same accepted behavior queued input already
 * has today).
 */
export async function interruptAndSendHandler(
  runId: string,
  text: string,
  deps: InterruptAndSendDeps,
  opts: { itemId?: string } = {},
): Promise<InterruptAndSendResult> {
  const trimmed = text.trim();
  if (trimmed === '') {
    return { noOp: true, reason: 'empty' };
  }

  const row = deps.db
    .prepare('SELECT status, substrate, execution_model FROM workflow_runs WHERE id = ?')
    .get(runId) as InterruptAndSendRunRow | undefined;

  if (!row) {
    return { noOp: true, reason: 'not_found' };
  }
  if (TERMINAL_STATUSES.has(row.status)) {
    return { noOp: true, reason: 'terminal' };
  }
  // Interactive (PTY) runs keep their existing live relay path (runs.relayInput) —
  // there is no per-turn query() boundary to abort-and-redrive. A null substrate
  // predates the substrate column and always meant 'sdk' (see other handlers'
  // `?? 'sdk'` floor).
  if ((row.substrate ?? 'sdk') !== 'sdk') {
    return { noOp: true, reason: 'interactive_unsupported' };
  }
  // Programmatic (Sprint fan-out) runs: refuse up front, before any abort — see
  // header note. Each DAG step is a fresh SDK session, so a step-scoped abort
  // cannot signal the WorkflowController's walk; the walk would keep spawning
  // subsequent steps as though the interrupted one succeeded.
  if (row.execution_model === 'programmatic') {
    return { noOp: true, reason: 'programmatic_unsupported' };
  }

  // Resolve + (maybe) abort the ONE targeted spawn key — never every live key.
  const spawnKey = opts.itemId ? `${runId}:${opts.itemId}` : runId;
  const live = new Set(deps.listLiveSpawnKeys(runId));
  const interrupted = live.has(spawnKey);
  if (interrupted) {
    // Buffer FIRST (see header/docstring note on the abort-then-redrive race).
    // The real RunExecutor always implements queueInput; it is typed optional
    // on NudgeRunExecutorLike only so lighter test fakes sharing that interface
    // (e.g. plain nudge-only fixtures) can omit it.
    deps.runExecutor.queueInput?.(runId, trimmed);
    try {
      await deps.abortRunSpawn(spawnKey);
    } catch (err) {
      deps.logger?.error('[interruptAndSend] abortRunSpawn rejected — the buffered text still awaits delivery at drain', {
        runId,
        spawnKey,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    recordInterruptedMarker(deps.db, runId, deps.logger);
    return { delivered: true, interrupted: true };
  }

  // Nothing live for the targeted spawn key — behaves exactly like a plain
  // runs.nudge on an idle run.
  const nudge = await nudgeRunHandler(runId, trimmed, deps);
  if ('delivered' in nudge) {
    return { delivered: true, interrupted: false };
  }
  return { noOp: true, reason: nudge.reason };
}
