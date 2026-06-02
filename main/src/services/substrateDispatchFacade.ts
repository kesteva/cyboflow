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
    this.interactiveExitHandler = (payload) => this.emit('exit', payload);
    // Raw-PTY fan-in — re-emit 'pty-output' by reference, mirroring the 'output'
    // fan-in. Interactive manager ONLY (the SDK manager is never subscribed).
    this.interactivePtyHandler = (payload) => this.emit('pty-output', payload);

    this.sdkManager.on('output', this.sdkOutputHandler);
    this.sdkManager.on('exit', this.sdkExitHandler);
    this.interactiveManager.on('output', this.interactiveOutputHandler);
    this.interactiveManager.on('exit', this.interactiveExitHandler);
    this.interactiveManager.on('pty-output', this.interactivePtyHandler);

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
    this.removeAllListeners();
    this.panelOwners.clear();
    this.logger.debug('[SubstrateDispatchFacade] disposed — unsubscribed from both managers');
  }
}
