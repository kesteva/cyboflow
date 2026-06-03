/**
 * SubstrateDispatchFacade — the boot-seam multiplexer that lets a single
 * RunExecutor `source` EventEmitter serve BOTH CLI substrates (IDEA-013 S4 /
 * TASK-809).
 *
 * Why this exists:
 *   RunExecutor binds ONE `source` EventEmitter at construction (runExecutor.ts:167)
 *   and bridgeEvents() registers its 'output'/'exit' listeners against THAT object
 *   for each run's lifetime (runEventBridge.ts:276). There is no per-run source
 *   hook — the source cannot be swapped. This facade is the only place that can
 *   multiplex two AbstractCliManager instances onto one stable EventEmitter without
 *   touching runExecutor.ts (which must import nothing from services/* — the
 *   standalone-typecheck invariant).
 *
 * What it does:
 *   1. Implements ClaudeSpawnerLike — resolving run.substrate per run (via the
 *      WorkflowRegistry.getRunById(runId) backed resolver, NOT a constructor-fixed
 *      manager) and dispatching spawnCliProcess / abort to the matching manager.
 *   2. Extends EventEmitter and subscribes (fan-in) to BOTH managers' 'output' and
 *      'exit' events, re-emitting each payload object UNCHANGED on itself. Because
 *      the re-emit preserves the payload by reference, the panelId===runId===sessionId
 *      invariant and the `type:'json'` filter in runEventBridge.ts survive identically
 *      regardless of which manager produced the event — so runEventBridge.ts needs
 *      ZERO edits and the cyboflow:stream:<runId> envelope is shape-identical across
 *      substrates.
 *
 * The facade IS the ClaudeSpawnerLike AND IS the EventEmitter source — one object
 * satisfies both RunExecutor seams (spawner arg + source arg), which is exactly why
 * the single-source constraint is honored.
 *
 * Substrate resolution floor: `run?.substrate ?? DEFAULT_SUBSTRATE` (== 'sdk') means
 * every legacy / null workflow_runs row resolves to the SDK manager, so the default
 * path is byte-identical.
 */

import { EventEmitter } from 'node:events';
import type { AbstractCliManager } from './panels/cli/AbstractCliManager';
import type { ClaudeSpawnerLike, ClaudeSpawnerOptions, WorkflowRegistryLike } from '../orchestrator/runExecutor';
import type { LoggerLike } from '../orchestrator/types';
import { type CliSubstrate, DEFAULT_SUBSTRATE } from '../../../shared/types/substrate';

/**
 * Bound event handler signature — both managers emit 'output' and 'exit' payloads
 * as opaque objects (the OutputPayload / CliExitEvent shapes from AbstractCliManager).
 * The facade re-emits them by reference, so it never inspects the payload's fields.
 */
type ForwardHandler = (payload: unknown) => void;

/**
 * Bytes of interactive-PTY output retained per run for replay-on-attach
 * (IDEA-030 blank-xterm fix). Capped to the last N bytes so a long session does
 * not grow unbounded; sized to comfortably hold claude's full-screen TUI repaint
 * (cursor/colour state) so a late-mounting InteractiveTerminalView reconstructs
 * the current screen rather than rendering blank.
 */
const PTY_BACKLOG_CAP_BYTES = 256 * 1024;

/**
 * Narrow capability interface for the interactive manager's PTY resize seam.
 * `AbstractCliManager` does NOT expose a resize method today (PTY geometry is
 * pinned 80×30 at AbstractCliManager.ts:577-578,614-615); the seam ON the
 * manager lands in TASK-818. Until then `relayResize` feature-detects this shape
 * (a `typeof mgr.resizePanel === 'function'` guard, no `any`) and no-ops when it
 * is absent — so resize is wired end-to-end on the renderer side and becomes
 * live the moment the manager seam exists.
 */
interface ResizeCapable {
  resizePanel(panelId: string, cols: number, rows: number): void;
}

/** Type guard: does this manager expose a `resizePanel(panelId, cols, rows)` seam? */
function isResizeCapable(mgr: AbstractCliManager): mgr is AbstractCliManager & ResizeCapable {
  return typeof (mgr as Partial<ResizeCapable>).resizePanel === 'function';
}

/**
 * Narrow capability interface for the interactive manager's explicit
 * end-session seam (TASK-818). `AbstractCliManager` does NOT expose `endSession`
 * (it is an InteractiveClaudeManager-only seam — the SDK manager has no PTY to
 * write EOF/`/exit` into). The facade feature-detects this shape (no `any`) so
 * the close-out path is harmless if the seam is ever absent.
 */
interface EndSessionCapable {
  endSession(panelId: string): Promise<void>;
}

/** Type guard: does this manager expose an `endSession(panelId)` seam? */
function isEndSessionCapable(mgr: AbstractCliManager): mgr is AbstractCliManager & EndSessionCapable {
  return typeof (mgr as Partial<EndSessionCapable>).endSession === 'function';
}

export class SubstrateDispatchFacade extends EventEmitter implements ClaudeSpawnerLike {
  /**
   * Records which manager spawned each panel, keyed by panelId. abort() looks up
   * the spawning manager here so a kill always hits the manager that owns the
   * process — even if the underlying workflow_runs row mutates after the spawn.
   */
  private readonly panelOwners = new Map<string, AbstractCliManager>();

  // Stored bound handler references so dispose() can off() the exact listeners.
  private readonly sdkOutputHandler: ForwardHandler;
  private readonly sdkExitHandler: ForwardHandler;
  private readonly interactiveOutputHandler: ForwardHandler;
  private readonly interactiveExitHandler: ForwardHandler;
  // Raw-PTY byte fan-in (TASK-814 / IDEA-030) — interactive manager ONLY. The SDK
  // manager has no PTY and never emits 'pty-output', so it is deliberately NOT
  // subscribed here (the path is interactive-only by construction).
  private readonly interactivePtyHandler: ForwardHandler;
  // Turn-end fan-in (TASK-818 / IDEA-030) — interactive manager ONLY. Each
  // persistent-REPL assistant turn boundary emits 'turn-end'; the facade re-emits
  // it by reference to RunExecutor's event-driven rest handler. The SDK manager
  // NEVER emits 'turn-end' (it drains via the query() iterator), so it is
  // deliberately NOT subscribed — the SDK path is structurally untouched.
  private readonly interactiveTurnEndHandler: ForwardHandler;

  /**
   * Per-run rolling backlog of the interactive PTY's VERBATIM output bytes
   * (IDEA-030 blank-xterm fix). The raw `cyboflow:pty:<runId>` channel is
   * fire-and-forget — Electron drops any webContents.send with no listener, so
   * claude's startup TUI paint is lost before InteractiveTerminalView mounts and
   * subscribes. We retain a bounded tail (PTY_BACKLOG_CAP_BYTES) here so the
   * renderer can REPLAY it on attach (getPtyBacklog), reconstructing the current
   * screen. Cleared per run on 'exit'. Interactive-only by construction (only the
   * interactive manager emits 'pty-output').
   */
  private readonly ptyBacklog = new Map<string, string>();

  constructor(
    private readonly sdkManager: AbstractCliManager,
    private readonly interactiveManager: AbstractCliManager,
    private readonly registry: WorkflowRegistryLike,
    private readonly logger: LoggerLike,
  ) {
    super();

    // Fan-in: subscribe to BOTH managers' 'output'/'exit' events and re-emit the
    // payload object UNCHANGED on this facade. One listener per event per manager,
    // so the default 10-listener cap is never hit (no setMaxListeners needed).
    this.sdkOutputHandler = (payload) => this.emit('output', payload);
    this.sdkExitHandler = (payload) => this.emit('exit', payload);
    this.interactiveOutputHandler = (payload) => this.emit('output', payload);
    this.interactiveExitHandler = (payload) => {
      // Drop the run's PTY backlog when its REPL exits (panelId === runId).
      this.clearPtyBacklog(payload);
      this.emit('exit', payload);
    };
    // Raw-PTY fan-in — accumulate a bounded per-run backlog for replay-on-attach
    // (blank-xterm fix), then re-emit 'pty-output' by reference (live channel
    // unchanged). Interactive manager ONLY (the SDK manager is never subscribed).
    this.interactivePtyHandler = (payload) => {
      this.recordPtyBacklog(payload);
      this.emit('pty-output', payload);
    };
    // Turn-end fan-in — re-emit 'turn-end' by reference (TASK-818). Interactive
    // manager ONLY; the SDK manager never emits it.
    this.interactiveTurnEndHandler = (payload) => this.emit('turn-end', payload);

    this.sdkManager.on('output', this.sdkOutputHandler);
    this.sdkManager.on('exit', this.sdkExitHandler);
    this.interactiveManager.on('output', this.interactiveOutputHandler);
    this.interactiveManager.on('exit', this.interactiveExitHandler);
    this.interactiveManager.on('pty-output', this.interactivePtyHandler);
    this.interactiveManager.on('turn-end', this.interactiveTurnEndHandler);

    this.logger.debug('[SubstrateDispatchFacade] subscribed to both substrate managers', {
      defaultSubstrate: DEFAULT_SUBSTRATE,
    });
  }

  /**
   * Resolve the manager for a run by reading run.substrate per-run. The
   * `?? DEFAULT_SUBSTRATE` floor makes every legacy/null row resolve to the SDK
   * manager (byte-identical SDK path).
   */
  private resolveManager(runId: string): AbstractCliManager {
    const run = this.registry.getRunById(runId);
    const substrate: CliSubstrate = run?.substrate ?? DEFAULT_SUBSTRATE;
    return substrate === 'interactive' ? this.interactiveManager : this.sdkManager;
  }

  /**
   * Dispatch a spawn to the substrate-matching manager. panelId === runId per the
   * orchestrator invariant, so the substrate is resolved by panelId. Records the
   * spawning manager in panelOwners so abort() finds the same manager later.
   */
  async spawnCliProcess(options: ClaudeSpawnerOptions): Promise<void> {
    const { panelId } = options;
    const mgr = this.resolveManager(panelId);
    const substrate: CliSubstrate = mgr === this.interactiveManager ? 'interactive' : 'sdk';
    this.panelOwners.set(panelId, mgr);
    this.logger.info('[SubstrateDispatchFacade] dispatch spawn', { panelId, substrate });
    // AbstractCliManager.spawnCliProcess accepts the CliSpawnOptions superset of
    // ClaudeSpawnerOptions (it adds an index signature for CLI-specific keys). Binding
    // the method to a ClaudeSpawnerLike-shaped reference narrows the parameter via the
    // same assignment-level variance the legacy single-manager spawnerAdapter relied on
    // (index.ts: defaultCliManager.spawnCliProcess.bind(...)), so no cast is needed.
    const spawn: ClaudeSpawnerLike['spawnCliProcess'] = mgr.spawnCliProcess.bind(mgr);
    await spawn(options);
  }

  /**
   * Abort the run on the manager that actually spawned its panel. Looks up
   * panelOwners (recorded at spawn) rather than re-reading the row — the manager
   * that spawned the panel is the one that must kill it. Falls back to a fresh
   * resolution (with a warn) when the panel was never tracked. killProcess() is
   * the public abort entry on AbstractCliManager (AbstractCliManager.ts:224); the
   * legacy adapter aliased it to abort, so the facade preserves that contract.
   */
  async abort(panelId: string): Promise<void> {
    const owner = this.panelOwners.get(panelId);
    if (owner) {
      this.logger.info('[SubstrateDispatchFacade] dispatch abort to spawning manager', { panelId });
      await owner.killProcess(panelId);
      this.panelOwners.delete(panelId);
      return;
    }
    const mgr = this.resolveManager(panelId);
    this.logger.warn('[SubstrateDispatchFacade] abort for untracked panel — resolving by substrate', { panelId });
    await mgr.killProcess(panelId);
  }

  /**
   * Relay a live-input turn into the SAME running process (IDEA-030 / TASK-817).
   *
   * panelId === runId per the orchestrator invariant. Resolves the manager via
   * the existing resolveManager() seam so substrate dispatch stays in ONE place.
   * For the interactive manager this writes raw to the live node-pty via
   * `sendInput` (AbstractCliManager.ts:205-218 — NO kill, NO respawn; this is
   * NEVER continuePanel/restartPanelWithHistory, which would destroy the
   * persistent session). For the SDK manager it is a strict NO-OP: the SDK has
   * no PTY (`process: undefined as never`), so the structured Workflow panel +
   * SDK iterator path stay byte-identical (Q3 panel-preservation).
   */
  relayInput(panelId: string, text: string): void {
    const mgr = this.resolveManager(panelId);
    if (mgr !== this.interactiveManager) {
      // SDK substrate has no PTY — relaying input is a no-op (Q3 byte-identical).
      this.logger.debug('[SubstrateDispatchFacade] relayInput no-op for SDK substrate', { panelId });
      return;
    }
    mgr.sendInput(panelId, text);
  }

  /**
   * Relay a PTY geometry change into the live node-pty (IDEA-030 / TASK-817).
   *
   * panelId === runId per the orchestrator invariant. Resolves the manager via
   * resolveManager(). For the interactive manager it feature-detects a
   * `resizePanel(panelId, cols, rows)` seam (the seam ON the manager lands in
   * TASK-818) and calls it when present; otherwise NO-OP. The SDK manager is a
   * strict NO-OP (no PTY). No `any` — the narrow ResizeCapable interface +
   * `isResizeCapable` guard own the feature detection.
   */
  relayResize(panelId: string, cols: number, rows: number): void {
    const mgr = this.resolveManager(panelId);
    if (mgr !== this.interactiveManager) {
      this.logger.debug('[SubstrateDispatchFacade] relayResize no-op for SDK substrate', { panelId });
      return;
    }
    if (isResizeCapable(mgr)) {
      mgr.resizePanel(panelId, cols, rows);
      return;
    }
    // The manager resize seam (TASK-818) is not yet present — no-op so the
    // renderer ResizeObserver wiring is harmless until it lands.
    this.logger.debug('[SubstrateDispatchFacade] relayResize no-op — interactive manager has no resize seam yet', {
      panelId,
      cols,
      rows,
    });
  }

  /**
   * Explicitly end a LIVE interactive run's persistent REPL (IDEA-030 / TASK-818).
   *
   * The ONLY non-kill spawn-promise resolver for a persistent interactive run:
   * routes to the interactive manager's `endSession`, which writes the EOF/`/exit`
   * control sequence so the inherited onExit settles the run's spawn promise and
   * teardownRun fires. Wired from the run close-out mutations (Merge / Dismiss /
   * Create-PR) via the RelayDeps bag. Strict NO-OP for the SDK substrate (no PTY,
   * the SDK iterator owns its own drain) — Q3 byte-identity holds. panelId ===
   * runId per the orchestrator invariant, so close-out passes runId straight
   * through. Feature-detected via the narrow EndSessionCapable interface (no
   * `any`) so it is harmless if the manager ever lacks the seam.
   */
  async endSession(panelId: string): Promise<void> {
    const mgr = this.resolveManager(panelId);
    if (mgr !== this.interactiveManager) {
      this.logger.debug('[SubstrateDispatchFacade] endSession no-op for SDK substrate', { panelId });
      return;
    }
    if (isEndSessionCapable(mgr)) {
      await mgr.endSession(panelId);
      return;
    }
    this.logger.warn('[SubstrateDispatchFacade] endSession no-op — interactive manager has no endSession seam', {
      panelId,
    });
  }

  /**
   * Return the retained interactive-PTY backlog for a run so a newly-mounted
   * InteractiveTerminalView can REPLAY it and reconstruct claude's current screen
   * (IDEA-030 blank-xterm fix). Empty string for an unknown/SDK run (the SDK
   * substrate never emits 'pty-output', so it never has a backlog entry).
   */
  getPtyBacklog(runId: string): string {
    return this.ptyBacklog.get(runId) ?? '';
  }

  /** Append a 'pty-output' chunk to the run's bounded backlog (last N bytes kept). */
  private recordPtyBacklog(payload: unknown): void {
    const evt = payload as { runId?: unknown; data?: unknown };
    if (typeof evt.runId !== 'string' || typeof evt.data !== 'string') return;
    const next = (this.ptyBacklog.get(evt.runId) ?? '') + evt.data;
    this.ptyBacklog.set(
      evt.runId,
      next.length > PTY_BACKLOG_CAP_BYTES ? next.slice(-PTY_BACKLOG_CAP_BYTES) : next,
    );
  }

  /** Drop a run's backlog on REPL exit (CliExitEvent.panelId === runId). */
  private clearPtyBacklog(payload: unknown): void {
    const evt = payload as { panelId?: unknown };
    if (typeof evt.panelId === 'string') this.ptyBacklog.delete(evt.panelId);
  }

  /**
   * Tear down the fan-in subscriptions so a re-init does not leak listeners. Off()s
   * the exact bound handlers stored at construction and clears the facade's own
   * listeners + the panelOwners map. Idempotent.
   */
  dispose(): void {
    this.sdkManager.off('output', this.sdkOutputHandler);
    this.sdkManager.off('exit', this.sdkExitHandler);
    this.interactiveManager.off('output', this.interactiveOutputHandler);
    this.interactiveManager.off('exit', this.interactiveExitHandler);
    this.interactiveManager.off('pty-output', this.interactivePtyHandler);
    this.interactiveManager.off('turn-end', this.interactiveTurnEndHandler);
    this.removeAllListeners();
    this.panelOwners.clear();
    this.ptyBacklog.clear();
    this.logger.debug('[SubstrateDispatchFacade] disposed — unsubscribed from both managers');
  }
}
