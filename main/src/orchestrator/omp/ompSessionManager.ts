/**
 * OMP Phase-4 increment 3 — `OmpSessionManager`: a sibling of the four
 * `AbstractCliManager` managers (ADR `omp-phase4-coexistence-adr.md` §3),
 * NOT a subclass of `AbstractCliManager`. It has no child process, no PTY,
 * no stdout stream: one panel ≙ one remote OMP worker, supervised over the
 * Phase-3 bridge through the supervise-authorized `OmpCommandAdapter`.
 *
 * Chat-lifecycle mapping (ADR table, §3):
 *
 * | Chat lifecycle            | Fleet tool      | Implementation here |
 * |---------------------------|-----------------|---------------------|
 * | `spawn(panelId, …, prompt)` | `fleet_spawn` | worker id parsed from the detail, stored on the panel |
 * | `sendInput(panelId, text)`  | `fleet_send`    | follow-up turns steer the same worker |
 * | `output` (poll)             | `fleet_read`    | new output since last read, emitted as `output` events |
 * | liveness / exit detection   | `fleet_state`   | leaves a live state ⇒ emit `exit` (terminal) |
 * | `stop(panelId)`             | `fleet_kill`    | deliberate termination |
 *
 * The event payload shapes mirror the (module-private) shapes of
 * `AbstractCliManager` — `output` `{ panelId, sessionId, type, data,
 * timestamp }` and `exit` `{ panelId, sessionId, exitCode, signal }` — so the
 * `AbstractAIPanelManager` forwarding layer can consume this manager unmodified
 * once increment 4 wires it in. Increment 3 itself is standalone: it is not
 * constructed by anything yet, and dispatch wiring is increment 4.
 *
 * `fleet_read` returns a *sliding* recent-lines window with no byte offset, so
 * "new output since last read" is derived by comparing against the last-read
 * transcript (`newOutputSince`): a strict extension emits the delta; a slid
 * window emits only the non-overlapping tail.
 *
 * Fail-closed: the manager is only ever constructed with a RESOLVED adapter
 * (ADR §5 — the wiring checks `resolveOmpBridgeCommandConfig()` first). A
 * failed `spawn` result or an unparseable worker id terminates the panel with
 * an `exit` event instead of leaving a half-spawned record.
 *
 * Standalone-typecheck invariant: node imports only (`node:crypto`,
 * `node:events`); no electron / better-sqlite3 / services imports.
 */
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import type {
  OmpCommandAdapter,
  OmpCommandResult,
} from "../../../../shared/types/ompCommand";
import type { LoggerLike } from "../types";

/** Default poll cadence for `fleet_read`/`fleet_state` per live panel. */
export const OMP_DEFAULT_POLL_MS = 1500;

/**
 * Cap for the sliding-window overlap search in `newOutputSince`. The recent
 * window is bounded upstream; this cap keeps the O(k·n) comparison cheap even
 * for an unbounded transcript. Mirrors the `LAST_OUTPUT_TAIL_BYTES` diagnostic
 * cap on the CLI manager.
 */
const OUTPUT_OVERLAP_CAP = 8192;

/**
 * Terminal OMP worker states — matches the producer's own
 * `isTerminalStatus` (OMP-fleet-management `extensions/fleet/controller.ts`):
 * a worker in one of these will not produce more output on its own and is not
 * accepting input. `idle` (turn done, awaiting input) is deliberately NOT
 * terminal: it is the REPL equivalent.
 */
const OMP_TERMINAL_STATES: ReadonlySet<string> = new Set([
  "done",
  "failed",
  "dead",
  "evicted",
]);

/** Event shapes mirror `AbstractCliManager`'s module-private interfaces. */
export interface OmpOutputEvent {
  panelId: string;
  sessionId: string;
  type: "stdout" | "stderr";
  data: string;
  timestamp: Date;
}

export interface OmpExitEvent {
  panelId: string;
  sessionId: string;
  exitCode: number | null;
  signal: number | null;
}

export interface OmpSpawnedEvent {
  panelId: string;
  sessionId: string;
}

export interface OmpErrorEvent {
  panelId: string;
  sessionId: string;
  error: string;
  /**
   * `true` when the panel SURVIVES this error — a bridge blip, a herder
   * hiccup, a rejected send. The worker is still live and the next poll may
   * succeed, so consumers must not park the panel in a terminal-looking
   * state. Real termination arrives as `exit`, never as `error`.
   */
  transient: boolean;
}

export interface OmpSpawnConfig {
  /** Model id forwarded to `fleet_spawn` (required by the producer). */
  model: string;
  /** Workspace id for spawn serialization. */
  workspace?: string;
  /** Working directory for the spawned agent. */
  cwd?: string;
  /** Optional pane label. */
  label?: string;
}

export interface OmpSessionManagerOptions {
  /** Poll cadence in ms (default {@link OMP_DEFAULT_POLL_MS}). */
  pollMs?: number;
}

interface OmpPanelRecord {
  panelId: string;
  sessionId: string;
  workerId: string | null;
  model: string;
  /** Last `fleet_read` transcript (for sliding-window dedup, not storage). */
  emitted: string;
  terminal: boolean;
  timer: NodeJS.Timeout | null;
  /** True while a tick is mid-flight; the poll loop skips rather than overlaps. */
  polling: boolean;
}

/** `worker=<id>` as rendered by the producer's `fleet_spawn` success detail. */
const WORKER_ID_PATTERN = /worker=([^\s\]]+)/;

/** `state=<status>` as rendered by the producer's `fleet_state` detail lines. */
const STATE_PATTERN = /state=([A-Za-z_]+)/;

function exitCodeForTerminal(state: string): number {
  return state === "done" ? 0 : 1;
}

/**
 * Derive "new output since last read" from a sliding recent-lines window.
 *
 * - `fresh` empty (the producer renders an empty read as `"(empty)"`, which
 *   callers normalize to `""` before arriving here) ⇒ nothing new.
 * - identical ⇒ nothing new.
 * - strict extension (window still contains everything read before) ⇒ the delta.
 * - the window slid off the old head ⇒ only the non-overlapping tail, where the
 *   overlap is the longest suffix of `last` that is also a prefix of `fresh`
 *   (search capped at {@link OUTPUT_OVERLAP_CAP} characters).
 * - no overlap at all (pathological) ⇒ the whole fresh window (one duplicate
 *   edge accepted over silently dropping output).
 */
export function newOutputSince(last: string, fresh: string): string {
  if (fresh.length === 0 || fresh === last) return "";
  if (last.length === 0 || fresh.startsWith(last)) return fresh.slice(last.length);
  const cap = Math.min(OUTPUT_OVERLAP_CAP, last.length, fresh.length);
  for (let k = cap; k > 0; k--) {
    if (fresh.startsWith(last.slice(last.length - k))) {
      return fresh.slice(k);
    }
  }
  return fresh;
}

export class OmpSessionManager extends EventEmitter {
  private readonly records = new Map<string, OmpPanelRecord>();
  private readonly adapter: OmpCommandAdapter;
  private readonly logger?: LoggerLike;
  private readonly pollMs: number;

  constructor(adapter: OmpCommandAdapter, logger?: LoggerLike, options?: OmpSessionManagerOptions) {
    super();
    if (adapter === null || typeof adapter.spawn !== "function") {
      throw new Error("OmpSessionManager requires a resolved OmpCommandAdapter");
    }
    this.adapter = adapter;
    this.logger = logger;
    this.pollMs = options?.pollMs ?? OMP_DEFAULT_POLL_MS;
  }

  /** Number of panels this manager is tracking (any state). */
  get panelCount(): number {
    return this.records.size;
  }

  /** True while the panel has a worker and has not reached a terminal state. */
  isPanelRunning(panelId: string): boolean {
    const record = this.records.get(panelId);
    return record !== undefined && !record.terminal && record.workerId !== null;
  }

  /**
   * Spawn the panel's OMP worker (`fleet_spawn`). Emits `spawned` on success;
   * a failed result or an unparseable worker id emits `exit` (fail-closed) and
   * the panel is dropped.
   *
   * Returns whether a live worker is now tracked for the panel, so the IPC
   * caller can report the turn honestly rather than answering `success: true`
   * to a spawn that failed closed.
   *
   * One panel ≙ one LIVE worker: when the panel's previous worker has reached
   * a terminal state (or the record was never live), a new spawn REPLACES the
   * dead record — this is the ADR's "the first message spawns" respawn path.
   * Spawning a panel whose worker is still live is rejected: steering a live
   * worker is `sendInput`'s job.
   */
  async spawn(panelId: string, sessionId: string, prompt: string, config: OmpSpawnConfig): Promise<boolean> {
    if (prompt.trim() === "") {
      throw new TypeError("OmpSessionManager.spawn requires a non-empty prompt");
    }
    if (config.model.trim() === "") {
      throw new TypeError("OmpSessionManager.spawn requires a model");
    }
    // Reserve the panel BEFORE the (awaited) adapter call: a double-click
    // spawns two concurrent calls, and both would pass a pure "existing"
    // guard before either sets `this.records` — orphaning a second remote
    // worker. A pending record (workerId still null) makes the in-flight
    // spawn visible to a concurrent spawn, which rejects.
    const existing = this.records.get(panelId);
    if (existing !== undefined && !existing.terminal) {
      throw new Error(`OmpSessionManager: panel ${panelId} already spawned`);
    }
    if (existing !== undefined) {
      // The previous worker is dead; replace its record. Clear any lingering
      // poll timer (defensive — finishTerminal/stopPanel already did).
      this.clearPolling(existing);
    }
    const pending: OmpPanelRecord = {
      panelId,
      sessionId,
      workerId: null,
      model: config.model,
      emitted: "",
      terminal: false,
      timer: null,
      polling: false,
    };
    this.records.set(panelId, pending);

    let result: OmpCommandResult;
    try {
      result = await this.adapter.spawn({
        operationId: randomUUID(),
        model: config.model,
        task: prompt,
        label: config.label,
        workspace: config.workspace,
        cwd: config.cwd,
      });
    } catch (err) {
      this.logger?.error(`[OmpSessionManager] fleet_spawn threw for panel ${panelId}`, {
        sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
      if (this.records.get(panelId) === pending) this.records.delete(panelId);
      this.emitExit(panelId, sessionId, 1);
      return false;
    }

    if (!result.ok) {
      this.logger?.error(`[OmpSessionManager] fleet_spawn failed for panel ${panelId}`, {
        sessionId,
        error: result.error,
        detail: result.detail,
      });
      if (this.records.get(panelId) === pending) this.records.delete(panelId);
      this.emitExit(panelId, sessionId, 1);
      return false;
    }

    const workerMatch = WORKER_ID_PATTERN.exec(result.detail);
    const workerId = workerMatch ? workerMatch[1] : null;
    if (workerId === null) {
      this.logger?.error(`[OmpSessionManager] fleet_spawn returned no worker id for panel ${panelId}`, {
        sessionId,
        detail: result.detail,
      });
      if (this.records.get(panelId) === pending) this.records.delete(panelId);
      this.emitExit(panelId, sessionId, 1);
      return false;
    }

    // The pending reservation becomes the live record in place. stopPanel
    // marks it terminal while spawn is still in flight; honor that instead of
    // reviving the panel.
    if (pending.terminal) {
      // stopPanel/stopAll ran while `fleet_spawn` was in flight, so it saw a
      // null workerId and had nothing to kill — the worker was born AFTER the
      // kill sweep passed. Untracked and unkilled, it would keep working the
      // worktree forever. Reap it here: this is the only frame that has ever
      // held its id.
      this.logger?.info(`[OmpSessionManager] panel ${panelId} stopped while spawn was in flight; killing the orphaned worker`, {
        sessionId,
        workerId,
      });
      const killed = await this.adapter.kill({ operationId: randomUUID(), workerId });
      if (!killed.ok) {
        this.logger?.warn(`[OmpSessionManager] fleet_kill failed for orphaned worker ${workerId} (panel ${panelId})`, {
          sessionId,
          detail: killed.detail,
        });
      }
      return false;
    }
    pending.workerId = workerId;
    this.records.set(panelId, pending);
    this.emit("spawned", { panelId, sessionId } satisfies OmpSpawnedEvent);
    this.startPolling(pending);
    this.logger?.info(`[OmpSessionManager] spawned ${workerId} for panel ${panelId}`, {
      sessionId,
      model: config.model,
    });
    return true;
  }

  /**
   * Send a follow-up turn to the panel's worker (`fleet_send`). Returns `true`
   * when the input was handed to a live worker (or the send reached the
   * adapter), `false` when the panel has no live worker and a spawn is needed
   * instead — mirroring the relay-or-spawn convention of the other runtimes.
   */
  async sendInput(panelId: string, text: string): Promise<boolean> {
    const record = this.requireLiveRecord(panelId);
    if (record === null) return false;
    const result = await this.adapter.send({
      operationId: randomUUID(),
      workerId: record.workerId as string,
      text,
    });
    if (!result.ok) {
      this.logger?.error(`[OmpSessionManager] fleet_send failed for panel ${panelId}`, {
        sessionId: record.sessionId,
        workerId: record.workerId,
        error: result.error,
        detail: result.detail,
      });
      this.emitError(record, `fleet_send failed: ${result.detail}`);
      // The turn did NOT reach the worker: report failure to the caller so
      // the IPC layer can surface it instead of claiming success. The panel
      // stays live (requireLiveRecord still passes) so the user can retry.
      return false;
    }
    return true;
  }

  /**
   * Deliberate termination (`fleet_kill`). Emits `exit` exactly once and stops
   * polling. A failed kill still terminates locally: the panel is unusable
   * from Cyboflow's side either way.
   */
  async stopPanel(panelId: string): Promise<void> {
    const record = this.records.get(panelId);
    if (record === undefined || record.terminal) return;
    this.clearPolling(record);
    record.terminal = true;
    if (record.workerId !== null) {
      const result = await this.adapter.kill({
        operationId: randomUUID(),
        workerId: record.workerId,
      });
      if (!result.ok) {
        this.logger?.warn(`[OmpSessionManager] fleet_kill failed for panel ${panelId} (terminating locally)`, {
          sessionId: record.sessionId,
          workerId: record.workerId,
          detail: result.detail,
        });
      }
    }
    this.emitExit(panelId, record.sessionId, null);
    this.logger?.info(`[OmpSessionManager] stopped panel ${panelId}`, {
      sessionId: record.sessionId,
      workerId: record.workerId,
    });
  }

  /** Stop every tracked panel (best-effort `fleet_kill` on each live worker). */
  async stopAll(): Promise<void> {
    const records = [...this.records.values()];
    this.records.clear();
    await Promise.all(records.map((record) => this.stopRecord(record)));
  }

  /**
   * One poll cycle for a panel: `fleet_read` (emit new output) then
   * `fleet_state` (detect terminal). Exposed for tests and for incremental
   * drivers; the internal timer is the production caller.
   */
  async tick(panelId: string): Promise<void> {
    const record = this.records.get(panelId);
    if (record === undefined || record.terminal || record.workerId === null) return;
    // One tick per panel at a time. Each cycle makes two awaited bridge round
    // trips; when those outlast the poll interval the timer would start a
    // second tick that races the first on `record.emitted` — the two would
    // read the same window and both emit it, or interleave their writes and
    // drop a chunk. Skipping a beat is the correct answer: the next tick sees
    // the same sliding window and picks up whatever is new.
    if (record.polling) return;
    record.polling = true;
    try {
      await this.pollOnce(record);
    } finally {
      record.polling = false;
    }
  }

  /** One poll cycle for a record already claimed by {@link tick}. */
  private async pollOnce(record: OmpPanelRecord): Promise<void> {
    const workerId = record.workerId;
    if (workerId === null) return;
    let stateResult: OmpCommandResult;
    try {
      stateResult = await this.adapter.state({ operationId: randomUUID(), workerId });
    } catch (err) {
      this.emitError(record, `fleet_state failed: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    // A transport-level state failure (`ok:false`) is TRANSIENT — a bridge
    // blip, a herder offline. Surface it and keep the panel alive; only a
    // genuinely unparseable live-state line or a vanished worker is terminal.
    if (!stateResult.ok) {
      this.emitError(record, `fleet_state failed: ${stateResult.detail}`);
      return;
    }
    const state = this.parseState(stateResult);
    const workerGone = state !== null && !OMP_TERMINAL_STATES.has(state) && /not found/i.test(stateResult.detail);
    if (state === null || workerGone) {
      // Unparseable or vanished worker: terminal from this side. No final drain
      // — a worker that is gone has no transcript left to read.
      this.finishTerminal(record, workerGone ? "evicted" : "failed");
      return;
    }
    if (OMP_TERMINAL_STATES.has(state)) {
      // Drain BEFORE terminating. Everything the worker emitted between the
      // previous poll and its exit is still only in the recent-lines window,
      // and terminating first would drop it — which for a `done` worker is
      // precisely its final answer, the one message the user is waiting for.
      await this.drainOutput(record, workerId);
      this.finishTerminal(record, state);
      return;
    }

    // Live worker: surface any new output since the last read.
    await this.drainOutput(record, workerId);
  }

  /**
   * `fleet_read` once and emit whatever is new. A failed read is transient and
   * non-fatal: `fleet_state` is the authority for terminal detection, so a read
   * blip must not end the panel.
   */
  private async drainOutput(record: OmpPanelRecord, workerId: string): Promise<void> {
    let readResult: OmpCommandResult;
    try {
      readResult = await this.adapter.read({ operationId: randomUUID(), workerId });
    } catch (err) {
      this.emitError(record, `fleet_read failed: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    if (!readResult.ok) {
      this.emitError(record, `fleet_read failed: ${readResult.detail}`);
      return;
    }
    const fresh = readResult.detail === "(empty)" ? "" : readResult.detail;
    const chunk = newOutputSince(record.emitted, fresh);
    record.emitted = fresh;
    if (chunk !== "") {
      this.emitOutput(record, chunk);
    }
  }

  // ── internals ──────────────────────────────────────────────────────────

  private requireLiveRecord(panelId: string): OmpPanelRecord | null {
    const record = this.records.get(panelId);
    if (record === undefined || record.terminal) return null;
    if (record.workerId === null) return null;
    return record;
  }

  private async stopRecord(record: OmpPanelRecord): Promise<void> {
    if (record.terminal) return;
    this.clearPolling(record);
    record.terminal = true;
    if (record.workerId !== null) {
      const result = await this.adapter.kill({
        operationId: randomUUID(),
        workerId: record.workerId,
      });
      if (!result.ok) {
        this.logger?.warn(`[OmpSessionManager] fleet_kill failed during stopAll for panel ${record.panelId}`, {
          sessionId: record.sessionId,
          workerId: record.workerId,
          detail: result.detail,
        });
      }
    }
    this.emitExit(record.panelId, record.sessionId, null);
  }

  private finishTerminal(record: OmpPanelRecord, state: string): void {
    if (record.terminal) return;
    this.clearPolling(record);
    record.terminal = true;
    this.emitExit(record.panelId, record.sessionId, exitCodeForTerminal(state));
    this.logger?.info(`[OmpSessionManager] worker ${record.workerId} terminal (${state}) for panel ${record.panelId}`, {
      sessionId: record.sessionId,
    });
  }

  private emitExit(panelId: string, sessionId: string, exitCode: number | null): void {
    this.emit("exit", { panelId, sessionId, exitCode, signal: null } satisfies OmpExitEvent);
  }

  private emitOutput(record: OmpPanelRecord, data: string): void {
    // A concurrent stopPanel can terminate the record while an awaited
    // fleet_read is in flight; `exit` has already been emitted by then, and
    // output arriving after it reopens a panel the consumer has closed out.
    if (record.terminal) return;
    this.emit(
      "output",
      {
        panelId: record.panelId,
        sessionId: record.sessionId,
        type: "stdout",
        data,
        timestamp: new Date(),
      } satisfies OmpOutputEvent,
    );
  }

  /**
   * Every current call site is a LIVE-panel failure (poll blip, failed send):
   * the record stays non-terminal and the panel remains usable, so the event
   * is marked transient. Terminal outcomes go through {@link finishTerminal}.
   */
  private emitError(record: OmpPanelRecord, error: string): void {
    if (record.terminal) return;
    this.emit("error", {
      panelId: record.panelId,
      sessionId: record.sessionId,
      error,
      transient: true,
    } satisfies OmpErrorEvent);
  }

  private parseState(result: OmpCommandResult): string | null {
    if (!result.ok) return null;
    const match = STATE_PATTERN.exec(result.detail);
    return match ? match[1] : null;
  }

  private startPolling(record: OmpPanelRecord): void {
    if (record.timer !== null) return;
    record.timer = setInterval(() => {
      void this.tick(record.panelId);
    }, this.pollMs);
    // A per-panel poll must not pin the main process open.
    record.timer.unref?.();
  }

  private clearPolling(record: OmpPanelRecord): void {
    if (record.timer !== null) {
      clearInterval(record.timer);
      record.timer = null;
    }
  }
}
