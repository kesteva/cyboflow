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
 *   1. Implements ClaudeSpawnerLike — resolving each run's LANE (provider ×
 *      transport, see services/panelLane.ts) from its workflow_runs row via
 *      WorkflowRegistry.getRunById(runId), NOT a constructor-fixed manager, and
 *      dispatching spawnCliProcess / abort to that lane's registered manager.
 *   2. Extends EventEmitter and subscribes (fan-in) to every registered manager's
 *      events, re-emitting each payload object UNCHANGED on itself. Because
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
 * Managers arrive as a REGISTRATION LIST ({@link ManagerRegistration}), one entry
 * per lane. They used to arrive by four different routes — two fixed positional
 * parameters, an array, and an optional trailing parameter — with dispatch then
 * testing for the odd one out by name; a third provider meant a fifth route and
 * another name test at every seam. See {@link ManagerRegistration}.
 *
 * Resolution floor: `run.substrate ?? DEFAULT_SUBSTRATE` (== 'sdk') means every
 * legacy / null workflow_runs row still resolves to the Claude SDK manager, so the
 * default path is byte-identical. What is NOT floored silently any more is an
 * unresolvable lane: it throws in dev/test and logs an error before flooring in
 * production (see managerForLane).
 */

import { EventEmitter } from 'node:events';
import type { AbstractCliManager } from './panels/cli/AbstractCliManager';
import type { ClaudeSpawnerLike, ClaudeSpawnerOptions, WorkflowRegistryLike } from '../orchestrator/runExecutor';
import type { LoggerLike } from '../orchestrator/types';
import { type CliSubstrate, DEFAULT_SUBSTRATE } from '../../../shared/types/substrate';
import type { CliSpawnOutcome } from '../../../shared/types/cliPanels';
import type { WorkflowRunRow } from '../../../shared/types/workflows';
import { isPtyLane, type PanelLane } from './panelLane';
import {
  claudeRuntimeFromSubstrate,
  DEFAULT_AGENT_PROVIDER,
  failUnresolvable,
  providerForRuntimeValue,
  type AgentProvider,
} from '../../../shared/types/agentRuntime';

/**
 * Bound event handler signature — both managers emit 'output' and 'exit' payloads
 * as opaque objects (the OutputPayload / CliExitEvent shapes from AbstractCliManager).
 * The facade re-emits them by reference, so it never inspects the payload's fields.
 */
type ForwardHandler = (payload: unknown) => void;

function isFailedExit(payload: unknown): boolean {
  return typeof payload === 'object' && payload !== null &&
    'exitCode' in payload && typeof payload.exitCode === 'number' && payload.exitCode !== 0;
}

/**
 * One manager's registration with the facade: the lane it serves (provider ×
 * transport — see services/panelLane.ts) and the manager serving it.
 *
 * Every manager registers the SAME way. The four managers used to arrive by four
 * DIFFERENT routes — Claude SDK and Claude interactive as fixed positional
 * parameters, Codex PTY inside an `additionalPtyManagers` array, Codex SDK as an
 * optional trailing parameter — and dispatch then tested for Codex by name
 * (`run.agent_runtime === 'codex-sdk'`). A third provider under that shape means
 * another parameter and another name test at every seam; under this one it means
 * another entry in the list.
 */
export interface ManagerRegistration {
  readonly lane: PanelLane;
  readonly manager: AbstractCliManager;
}

/** Everything the facade is constructed with. */
export interface SubstrateDispatchFacadeOptions {
  /**
   * The managers this facade multiplexes, one per lane. Registration ORDER is
   * not meaningful; the lane is the whole identity.
   */
  readonly managers: readonly ManagerRegistration[];
  readonly registry: WorkflowRegistryLike;
  readonly logger: LoggerLike;
  readonly panelOwnerLookup?: PanelOwnerLookup;
}

/**
 * Which of a manager's events the facade fans in, per lane.
 *
 * Not a policy so much as a RECORD: these are the exact subscriptions each lane
 * had before the registry landed, kept verbatim so this refactor moves no bytes
 * on the wire. Two rows are narrower than their transport would suggest and the
 * asymmetry is historical, not considered:
 *
 *   - `codex-sdk` omits 'spawned' even though CodexSdkManager emits it, so a
 *     Codex run never satisfies a turn-start waiter (nudgeRunHandler's
 *     `deliveredAt: 'turn-start'`) the way a Claude run does.
 *   - `codex-pty` omits 'output', so whatever AbstractCliManager emits there
 *     never reaches the structured panel — only the raw 'pty-output' bytes do.
 *
 * Both are worth revisiting on their own; neither should be COPIED. A new
 * provider's lane wants the row its transport implies: an SDK lane forwards
 * output + exit + spawned, a PTY lane those plus pty-output and turn-end.
 *
 * 'exit' is subscribed for every lane and so is not listed. 'pty-output' follows
 * `isPtyLane` exactly, so it is not listed either.
 */
interface LaneWiring {
  readonly output: boolean;
  readonly spawned: boolean;
  readonly turnEnd: boolean;
  /**
   * Keep the PTY backlog when the process exits NON-ZERO, so a terminal that
   * mounts after a failed startup can still replay the error tail. Codex PTY
   * only: a Claude REPL's exit always drops its backlog.
   */
  readonly retainBacklogOnFailedExit: boolean;
}

const LANE_WIRING: Readonly<Record<PanelLane, LaneWiring>> = {
  'claude-sdk': { output: true, spawned: true, turnEnd: false, retainBacklogOnFailedExit: false },
  'claude-interactive': { output: true, spawned: true, turnEnd: true, retainBacklogOnFailedExit: false },
  'codex-sdk': { output: true, spawned: false, turnEnd: false, retainBacklogOnFailedExit: false },
  'codex-pty': { output: false, spawned: false, turnEnd: false, retainBacklogOnFailedExit: true },
  // Declared with the OMP lanes, taking the row each transport IMPLIES rather
  // than copying the two Codex asymmetries this comment warns against: the SDK
  // lane forwards output + spawned, the PTY lane those plus turn-end. Both are
  // live — `omp-sdk` additionally serves workflow runs since Phase 2, which is
  // exactly why it keeps `spawned` where codex-sdk drops it: a turn-start waiter
  // (nudgeRunHandler's `deliveredAt: 'turn-start'`) is satisfied on an OMP run.
  // `retainBacklogOnFailedExit` follows codex-pty for codex-pty's reason and not
  // by imitation: OMP is spawned from a user-installed binary found by a
  // discovery ladder, so a failed startup is the expected failure and its error
  // tail has to survive for a terminal that mounts afterwards.
  'omp-sdk': { output: true, spawned: true, turnEnd: false, retainBacklogOnFailedExit: false },
  'omp-pty': { output: true, spawned: true, turnEnd: true, retainBacklogOnFailedExit: true },
  // Pi lanes take the row their TRANSPORT implies, same reasoning as the OMP
  // pair above: the sdk lane (pi --mode json) forwards output + spawned and
  // serves workflow runs; the pty lane adds turn-end and retains the backlog
  // on failed exit because pi is a user-installed binary found by a discovery
  // ladder — a failed startup's error tail has to survive for a terminal that
  // mounts afterwards.
  'pi-sdk': { output: true, spawned: true, turnEnd: false, retainBacklogOnFailedExit: false },
  'pi-pty': { output: true, spawned: true, turnEnd: true, retainBacklogOnFailedExit: true },
};

/**
 * The lane an unresolvable dispatch floors to: the default provider on the
 * default substrate. Spelled through `claudeRuntimeFromSubstrate` rather than as
 * a literal so it tracks DEFAULT_SUBSTRATE, and deliberately CLAUDE — the floor
 * has to be the provider that is always present, which is what
 * DEFAULT_AGENT_PROVIDER means.
 */
const FALLBACK_LANE: PanelLane = claudeRuntimeFromSubstrate(DEFAULT_SUBSTRATE);

/**
 * Look a lane up in a lane→manager table, handing a miss to the shared
 * {@link failUnresolvable} policy (throw in dev/test, log and floor in prod —
 * see its comment for why the throw is opt-IN on those two environments). Never
 * returns the floor SILENTLY: an unrecognized runtime quietly becoming Claude is
 * the whole class of bug this replaces.
 *
 * `floor` must be a safe degradation rather than a guess. The Claude SDK manager
 * is the honest one here — it is what `resolvePanelOwner`'s old `default:` arm
 * fell to, so production behavior is unchanged while development now fails loudly.
 *
 * Generic over the manager type and exported because the boot seam runs the same
 * lookup against the same table BEFORE the facade exists (`resolvePanelOwner` is
 * constructor input), and it must report a miss the same way rather than
 * re-deriving the rule.
 */
export function resolveLaneManager<T>(
  lane: PanelLane | null,
  managers: ReadonlyMap<PanelLane, T>,
  floor: T,
  context: string,
): T {
  const manager = lane === null ? undefined : managers.get(lane);
  if (manager !== undefined) return manager;
  return failUnresolvable(
    `${context}: no manager registered for lane '${lane ?? 'unresolved'}' ` +
      `(registered: ${[...managers.keys()].join(', ')})`,
    floor,
  );
}

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

/**
 * Narrow capability interface for the SDK manager's LIVE-STEER seam (monitor
 * operator guidance into a running step agent). `AbstractCliManager` does NOT
 * declare these — they are ClaudeCodeManager-specific (the SDK query() drive loop
 * owns the steerable input; the interactive manager has no per-turn SDK queue).
 * The facade feature-detects this shape (no `any`) and returns the empty result
 * ([] / false) when it is absent, so the seam is harmless during early boot or if
 * a future non-steering CLI substrate resolves here.
 */
interface SteeringCapable {
  listLiveSpawnKeys(runId: string): string[];
  injectSteering(spawnKey: string, text: string): boolean;
}

/** Type guard: does this manager expose the live-steer seam (listLiveSpawnKeys + injectSteering)? */
function isSteeringCapable(mgr: AbstractCliManager): mgr is AbstractCliManager & SteeringCapable {
  const m = mgr as Partial<SteeringCapable>;
  return typeof m.listLiveSpawnKeys === 'function' && typeof m.injectSteering === 'function';
}

/**
 * Resolve the owning manager for a CHAT PANEL id — the second, non-run identity
 * this facade is addressed by.
 *
 * WHY. `resolveManager` reads `workflow_runs` via the registry, so it can only
 * classify a RUN id; anything else floors to DEFAULT_SUBSTRATE ('sdk'). That was
 * correct while every relay carried the run/gate id. Since chat panels address
 * their own PTY by `panel.id` (TASK-103 Add-chat — a session's panels all share
 * ONE chat_run_id, so the sentinel cannot identify a panel), a panel id reaching
 * `resolveManager` is not a run, floors to 'sdk', and relayInput/relayResize
 * silently NO-OP — swallowing every keystroke into a live PTY whose panel has no
 * `livePtyOwners` entry (that map is seeded only at spawn / first PTY byte and
 * cleared on exit, so it is EMPTY after an app restart). That is the reopened-PTY
 * "hangs and never loads" symptom.
 *
 * This lookup closes the gap: given a panel id it returns the manager that panel's
 * effective substrate (per-panel override → session substrate → floor) resolves
 * to, or `undefined` when the id is not a panel at all (then the run-id floor
 * still applies, byte-identical). Injected rather than reached for so this file
 * keeps its no-database, no-services dependency shape.
 */
export type PanelOwnerLookup = (panelId: string) => AbstractCliManager | undefined;

export class SubstrateDispatchFacade extends EventEmitter implements ClaudeSpawnerLike {
  /**
   * Records which manager spawned each panel, keyed by panelId. abort() looks up
   * the spawning manager here so a kill always hits the manager that owns the
   * process — even if the underlying workflow_runs row mutates after the spawn.
   */
  private readonly panelOwners = new Map<string, AbstractCliManager>();

  /**
   * Every fan-in subscription this facade owns, in registration order, so
   * dispose() can off() the exact bound listeners it on()'d. One entry per
   * (manager, event) pair.
   */
  private readonly subscriptions: Array<{
    manager: AbstractCliManager;
    event: string;
    handler: ForwardHandler;
  }> = [];

  /**
   * Per-run rolling backlog of the interactive PTY's VERBATIM output bytes
   * (IDEA-030 blank-xterm fix). The raw `cyboflow:pty:<runId>` channel is
   * fire-and-forget — Electron drops any webContents.send with no listener, so
   * claude's startup TUI paint is lost before InteractiveTerminalView mounts and
   * subscribes. We retain a bounded tail (PTY_BACKLOG_CAP_BYTES) here so the
   * renderer can REPLAY it on attach (getPtyBacklog), reconstructing the current
   * screen. Cleared per run on 'exit'. PTY lanes only by construction — an SDK
   * lane has no terminal and never emits 'pty-output'.
   */
  private readonly ptyBacklog = new Map<string, string>();

  /**
   * runId → LIVE interactive panelId (plus the panelId → runId reverse used for
   * exit-time cleanup). For workflow runs the orchestrator invariant
   * panelId === runId holds, so entries here are identity mappings — or absent,
   * in which case lookups fall back to runId (byte-identical behavior). For PTY
   * QUICK sessions the process is spawned via
   * InteractiveClaudeManager.startPanel(claudePanel.id, ...) while the manager
   * resolves runId from sessions.run_id (the `__quick__` sentinel), so
   * panelId ≠ runId — without translation the inherited sendInput would throw
   * "No claude process found for panel <sentinelRunId>". Fed from the
   * 'pty-output' and 'turn-end' payloads of every PTY lane (both carry
   * { panelId, runId }; the 'output' payload has NO runId so it is not a
   * source); evicted when that lane's 'exit' fires for the panel.
   */
  private readonly interactiveRunToPanel = new Map<string, string>();
  private readonly interactivePanelToRun = new Map<string, string>();
  private readonly livePtyOwners = new Map<string, AbstractCliManager>();

  /** lane → the manager serving it. THE dispatch table; nothing else routes. */
  private readonly managersByLane = new Map<PanelLane, AbstractCliManager>();
  /** The reverse, for the seams that start from a manager (spawn stamp, provider match). */
  private readonly lanesByManager = new Map<AbstractCliManager, PanelLane>();
  /** lane → its owning provider, resolved ONCE at registration (see registerManager). */
  private readonly providersByLane = new Map<PanelLane, AgentProvider>();

  /**
   * Every manager that drives a real PTY. The relay/close-out seams used to test
   * `mgr !== this.interactiveManager` to mean "SDK — no PTY, no-op", which was
   * true while the interactive manager was the only PTY owner. With Codex PTY
   * wired too that test wrongly classifies a live Codex PTY as SDK. Membership
   * here — `isPtyLane` of the registered lane — is the real question those seams
   * are asking.
   */
  private readonly ptyManagers = new Set<AbstractCliManager>();

  /** Does this manager own a PTY (i.e. is it registered on a PTY lane)? */
  private isPtyManager(mgr: AbstractCliManager): boolean {
    return this.ptyManagers.has(mgr);
  }

  private readonly registry: WorkflowRegistryLike;
  private readonly logger: LoggerLike;
  private readonly panelOwnerLookup?: PanelOwnerLookup;

  /**
   * The Claude interactive manager, resolved once from its lane. Named because
   * `registerInteractivePanel` IS the Claude-interactive quick-session seam (the
   * Codex twin calls `registerPtyPanel` with its own manager); undefined when
   * that lane is not registered, which makes the seam a no-op rather than a crash.
   */
  private readonly interactiveManager: AbstractCliManager | undefined;

  constructor(options: SubstrateDispatchFacadeOptions) {
    super();
    this.registry = options.registry;
    this.logger = options.logger;
    this.panelOwnerLookup = options.panelOwnerLookup;

    for (const registration of options.managers) {
      this.registerManager(registration);
    }
    if (!this.managersByLane.has(FALLBACK_LANE)) {
      throw new Error(
        `[SubstrateDispatchFacade] no manager registered for the fallback lane '${FALLBACK_LANE}' — ` +
          'an unresolvable dispatch would have nowhere to floor',
      );
    }
    this.interactiveManager = this.managersByLane.get('claude-interactive');

    this.logger.debug('[SubstrateDispatchFacade] subscribed to registered lane managers', {
      lanes: [...this.managersByLane.keys()],
      defaultSubstrate: DEFAULT_SUBSTRATE,
    });
  }

  /**
   * Wire one lane's manager: record it in the dispatch table and fan its events
   * in, re-emitting each payload object UNCHANGED on this facade. Because the
   * re-emit preserves the payload by reference, the panelId===runId===sessionId
   * invariant and runEventBridge's `type:'json'` filter survive identically
   * whichever manager produced the event. One listener per event per manager, so
   * the default 10-listener cap is never hit (no setMaxListeners needed).
   */
  private registerManager({ lane, manager }: ManagerRegistration): void {
    const existing = this.managersByLane.get(lane);
    if (existing !== undefined && existing !== manager) {
      throw new Error(`[SubstrateDispatchFacade] lane '${lane}' registered twice with different managers`);
    }
    if (existing === manager) return;

    this.managersByLane.set(lane, manager);
    this.lanesByManager.set(manager, lane);
    // Resolve the lane's provider EAGERLY: a lane id whose prefix matches no
    // registered provider is a wiring bug, and construction is when a developer
    // can still see it (providerForRuntimeValue throws in dev/test).
    this.providersByLane.set(lane, providerForRuntimeValue(lane, `SubstrateDispatchFacade lane '${lane}'`));

    const wiring = LANE_WIRING[lane];
    const pty = isPtyLane(lane);
    if (wiring.output) this.subscribe(manager, 'output', (payload) => this.emit('output', payload));
    // Per-logical-turn start fan-in — a manager emits 'spawned' once per turn
    // (SDK: cold spawn AND warm push; PTY: process spawn). Re-emitted by
    // reference so boot wiring can await a run's turn-start (nudgeRunHandler's
    // `deliveredAt: 'turn-start'` waiter) without reaching past the facade.
    if (wiring.spawned) this.subscribe(manager, 'spawned', (payload) => this.emit('spawned', payload));
    this.subscribe(manager, 'exit', (payload) => {
      if (pty) {
        // Drop the run's PTY backlog when its REPL exits (resolved through the
        // panel→run mapping so quick sessions — panelId ≠ runId — clear too),
        // THEN evict the panel's runId↔panelId mapping (order matters: the
        // backlog clear consumes the mapping).
        if (!(wiring.retainBacklogOnFailedExit && isFailedExit(payload))) this.clearPtyBacklog(payload);
        this.clearInteractivePanelMapping(payload);
      }
      this.emit('exit', payload);
    });
    if (pty) {
      // Raw-PTY fan-in (TASK-814 / IDEA-030) — record the runId↔panelId mapping
      // (the payload carries both ids), accumulate a bounded per-run backlog for
      // replay-on-attach (blank-xterm fix), then re-emit by reference (live
      // channel unchanged). An SDK lane has no PTY and never emits this.
      this.subscribe(manager, 'pty-output', (payload) => {
        this.recordInteractivePanelMapping(payload, manager);
        this.recordPtyBacklog(payload);
        this.emit('pty-output', payload);
      });
    }
    if (wiring.turnEnd) {
      // Turn-end fan-in (TASK-818 / IDEA-030) — each persistent-REPL assistant
      // turn boundary emits 'turn-end'; re-emitted by reference to RunExecutor's
      // event-driven rest handler. The payload also carries { panelId, runId } —
      // a second mapping source, live even before any PTY byte flows.
      this.subscribe(manager, 'turn-end', (payload) => {
        this.recordInteractivePanelMapping(payload, manager);
        this.emit('turn-end', payload);
      });
    }
    if (pty) this.ptyManagers.add(manager);
  }

  /** on() the handler and remember the exact pair for dispose(). */
  private subscribe(manager: AbstractCliManager, event: string, handler: ForwardHandler): void {
    manager.on(event, handler);
    this.subscriptions.push({ manager, event, handler });
  }

  /**
   * The manager for a lane, or the production floor when that lane has none.
   *
   * An unregistered lane is a routing bug — the run asked for a provider this
   * build cannot serve — so it throws in dev/test where a developer will see it,
   * and in production logs an error and floors to {@link FALLBACK_LANE}. It never
   * floors SILENTLY, which is what the old `=== 'codex-sdk'` chain did for every
   * runtime it did not recognize.
   */
  private managerForLane(lane: PanelLane | null, context: string): AbstractCliManager {
    return resolveLaneManager(
      lane,
      this.managersByLane,
      // Non-null: the constructor refuses to build without the fallback lane.
      this.managersByLane.get(FALLBACK_LANE) as AbstractCliManager,
      `[SubstrateDispatchFacade] ${context}`,
    );
  }

  /**
   * The registered lane serving `provider` on `substrate`, or null when the
   * provider has no lane at all.
   *
   * Selects among REGISTERED lanes rather than composing a lane id from strings:
   * transports are not named uniformly across providers (`claude-interactive` vs
   * `codex-pty`), and a lane with no manager behind it is not an answer.
   * A provider that IS registered but not on the requested transport falls back
   * to its other lane — better a right provider on the wrong transport than a
   * silent flip to Claude.
   */
  private laneFor(provider: AgentProvider, substrate: CliSubstrate): PanelLane | null {
    const wantPty = substrate === 'interactive';
    let firstForProvider: PanelLane | null = null;
    for (const lane of this.managersByLane.keys()) {
      if (this.providersByLane.get(lane) !== provider) continue;
      if (isPtyLane(lane) === wantPty) return lane;
      firstForProvider ??= lane;
    }
    return firstForProvider;
  }

  /**
   * The lane a `workflow_runs` row names.
   *
   * The row's own runtime stamp IS a lane id whenever it names a registered one
   * ('claude-sdk' | 'claude-interactive' | 'codex-sdk'), so it wins outright —
   * that is the row's explicit answer, and re-deriving it from the two axes could
   * only disagree. Otherwise provider and substrate are resolved separately and
   * combined: the provider from the runtime's prefix via the shared registry (an
   * unknown non-empty runtime fails loudly there rather than resolving to Claude),
   * falling back to the row's own provider column, and the substrate from
   * `run.substrate` with the legacy `?? DEFAULT_SUBSTRATE` floor that keeps every
   * pre-provider-axis row on the SDK manager.
   *
   * Note the one row shape whose reading changed: a row naming a NON-default
   * provider with no runtime AND `substrate: 'interactive'` now resolves to that
   * provider's PTY lane where it used to resolve to its SDK one. No writer
   * produces it — `createRun` stamps provider and runtime together, and the only
   * storable Codex runtime is pinned to `substrate: 'sdk'`.
   */
  private laneForRun(run: WorkflowRunRow, context: string): { lane: PanelLane | null; provider: AgentProvider } {
    const runtime: string | undefined = run.agent_runtime;
    if (runtime !== undefined && this.managersByLane.has(runtime as PanelLane)) {
      const lane = runtime as PanelLane;
      // Non-null: providersByLane is populated for every registered lane.
      return { lane, provider: this.providersByLane.get(lane) as AgentProvider };
    }
    const provider = runtime
      ? providerForRuntimeValue(runtime, context)
      : (run.agent_provider ?? DEFAULT_AGENT_PROVIDER);
    return { lane: this.laneFor(provider, run.substrate ?? DEFAULT_SUBSTRATE), provider };
  }

  /**
   * Resolve the manager for a run by reading run.substrate per-run. The
   * `?? DEFAULT_SUBSTRATE` floor makes every legacy/null row resolve to the SDK
   * manager (byte-identical SDK path).
   *
   * When the id matches NO run row it may still be a CHAT PANEL id (chat panels
   * address their own PTY by panel.id — see PanelOwnerLookup for why). Consult
   * the injected panel lookup BEFORE flooring, so a PTY panel with no live
   * `livePtyOwners` registration (after an app restart, or before its first PTY
   * byte) resolves to its real manager instead of silently degrading to the SDK
   * no-op. An id that is neither a run nor a panel still floors to SDK exactly
   * as before.
   */
  private resolveManager(runId: string): AbstractCliManager {
    const run = this.registry.getRunById(runId);
    if (run) {
      const context = `run ${runId}`;
      const { lane, provider } = this.laneForRun(run, context);
      return this.managerForLane(lane, lane === null ? `${context} (provider '${provider}')` : context);
    }
    const byPanel = this.panelOwnerLookup?.(runId);
    if (byPanel) {
      this.logger.debug('[SubstrateDispatchFacade] resolved a non-run id as a chat panel', { panelId: runId });
      return byPanel;
    }
    return this.managerForLane(FALLBACK_LANE, `id ${runId}`);
  }

  /**
   * Resolve the manager for ONE spawn, honoring a per-call `agentProvider`/
   * `agentRuntime` override (per-step provider mixing) before falling back to the
   * run-level `resolveManager(panelId)` resolution. The override lets the
   * programmatic step runner send a single step to another provider inside an
   * otherwise-Claude run without mutating the run's `workflow_runs` stamp. Absent
   * override ⇒ identical to the pre-existing run-level path.
   *
   * A runtime override names a lane outright. A provider override with NO runtime
   * only redirects when it DISAGREES with the provider the run already resolves
   * to: when they agree the run-level resolution is already in the right provider
   * and keeps its substrate choice, which is why a same-provider override has
   * always been a no-op here.
   */
  private resolveManagerForSpawn(options: ClaudeSpawnerOptions): AbstractCliManager {
    const context = `spawn for panel ${options.panelId}`;
    if (options.agentRuntime) {
      const lane = this.managersByLane.has(options.agentRuntime as PanelLane)
        ? (options.agentRuntime as PanelLane)
        : this.laneFor(providerForRuntimeValue(options.agentRuntime, context), DEFAULT_SUBSTRATE);
      return this.managerForLane(lane, context);
    }
    if (options.agentProvider) {
      const runManager = this.resolveManager(options.panelId);
      const runLane = this.lanesByManager.get(runManager);
      if (runLane !== undefined && this.providersByLane.get(runLane) === options.agentProvider) {
        return runManager;
      }
      return this.managerForLane(this.laneFor(options.agentProvider, DEFAULT_SUBSTRATE), context);
    }
    return this.resolveManager(options.panelId);
  }

  /**
   * Dispatch a spawn to the substrate-matching manager. panelId === runId per the
   * orchestrator invariant, so the substrate is resolved by panelId (or by the
   * per-call override — see resolveManagerForSpawn). Records the spawning manager
   * in panelOwners so abort() finds the same manager later.
   */
  async spawnCliProcess(options: ClaudeSpawnerOptions): Promise<CliSpawnOutcome | void> {
    const { panelId } = options;
    const mgr = this.resolveManagerForSpawn(options);
    // The registration knows its own lane, so the log names the resolved lane
    // (provider × transport) instead of re-deriving a runtime by identity test.
    const lane = this.lanesByManager.get(mgr);
    const substrate: CliSubstrate = lane !== undefined && isPtyLane(lane) ? 'interactive' : 'sdk';
    this.panelOwners.set(panelId, mgr);
    this.logger.info('[SubstrateDispatchFacade] dispatch spawn', { panelId, substrate, lane });
    // AbstractCliManager.spawnCliProcess accepts the CliSpawnOptions superset of
    // ClaudeSpawnerOptions (it adds an index signature for CLI-specific keys). Binding
    // the method to a ClaudeSpawnerLike-shaped reference narrows the parameter via the
    // same assignment-level variance the legacy single-manager spawnerAdapter relied on
    // (index.ts: defaultCliManager.spawnCliProcess.bind(...)), so no cast is needed.
    // Forward the dispatched manager's resolved value UNCHANGED so the SDK
    // manager's captured result text (§5.3) reaches the step runner; the
    // interactive/codex managers resolve void, so this stays byte-identical there.
    const spawn: ClaudeSpawnerLike['spawnCliProcess'] = mgr.spawnCliProcess.bind(mgr);
    return await spawn(options);
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
   * True when ANY substrate manager reports an agent turn in flight for the
   * session. Best-effort by construction: PTY managers structurally answer
   * `false` (see AbstractCliManager.hasTurnInFlightForSession). Consumed as the
   * settleQuickArm write barrier (experiments router), where a false negative
   * degrades to the pre-barrier behavior rather than blocking the settle.
   */
  hasTurnInFlightForSession(sessionId: string): boolean {
    return [...this.managersByLane.values()].some((m) => m.hasTurnInFlightForSession(sessionId));
  }

  /**
   * Relay a live-input turn into the SAME running process (IDEA-030 / TASK-817).
   *
   * Takes the RUN id (workflow runs: panelId === runId per the orchestrator
   * invariant; PTY quick sessions: panelId ≠ runId, translated via
   * toLivePanelId). Resolves the manager via the existing resolveManager() seam
   * so substrate dispatch stays in ONE place. For the interactive manager this
   * writes raw to the live node-pty via `sendInput` (AbstractCliManager.ts:205-218
   * — NO kill, NO respawn; this is NEVER continuePanel/restartPanelWithHistory,
   * which would destroy the persistent session). For the SDK manager it is a
   * strict NO-OP: the SDK has no PTY (`process: undefined as never`), so the
   * structured Workflow panel + SDK iterator path stay byte-identical (Q3
   * panel-preservation).
   */
  relayInput(runId: string, text: string): void {
    const liveOwner = this.livePtyOwners.get(runId);
    if (liveOwner) {
      const panelId = this.toLivePanelId(runId);
      if (!liveOwner.isPanelRunning(panelId)) {
        this.logger.debug('[SubstrateDispatchFacade] relayInput dropped — live PTY not running', {
          runId,
          panelId,
        });
        return;
      }
      liveOwner.sendInput(panelId, text);
      return;
    }

    const mgr = this.resolveManager(runId);
    if (!this.isPtyManager(mgr)) {
      // SDK substrate has no PTY — relaying input is a no-op (Q3 byte-identical).
      this.logger.debug('[SubstrateDispatchFacade] relayInput no-op for SDK substrate', { runId });
      return;
    }
    const panelId = this.toLivePanelId(runId);
    // Dead-REPL guard: after an app restart (or a crashed REPL) the persistent
    // interactive process is gone, yet the xterm still accepts keystrokes and
    // relays them here verbatim. Writing to a missing process throws
    // "No <tool> process found for panel <id>" (AbstractCliManager.sendInput),
    // which surfaces as an "unexpected error" modal in the renderer. Raw
    // byte-by-byte keystrokes can't meaningfully respawn a session, so swallow
    // them when the REPL is not live — recovery happens through a COMPOSER turn
    // (sessions:input dead-REPL respawn / --resume), not direct typing.
    if (!mgr.isPanelRunning(panelId)) {
      this.logger.debug('[SubstrateDispatchFacade] relayInput dropped — interactive REPL not running', {
        runId,
        panelId,
      });
      return;
    }
    mgr.sendInput(panelId, text);
  }

  /**
   * Relay a PTY geometry change into the live node-pty (IDEA-030 / TASK-817).
   *
   * Takes the RUN id (quick sessions translate runId → live panelId via
   * toLivePanelId; workflow runs are identity). Resolves the manager via
   * resolveManager(). For the interactive manager it feature-detects a
   * `resizePanel(panelId, cols, rows)` seam (the seam ON the manager lands in
   * TASK-818) and calls it when present; otherwise NO-OP. The SDK manager is a
   * strict NO-OP (no PTY). No `any` — the narrow ResizeCapable interface +
   * `isResizeCapable` guard own the feature detection.
   */
  relayResize(runId: string, cols: number, rows: number): void {
    const liveOwner = this.livePtyOwners.get(runId);
    if (liveOwner) {
      if (isResizeCapable(liveOwner)) {
        liveOwner.resizePanel(this.toLivePanelId(runId), cols, rows);
      }
      return;
    }

    const mgr = this.resolveManager(runId);
    if (!this.isPtyManager(mgr)) {
      this.logger.debug('[SubstrateDispatchFacade] relayResize no-op for SDK substrate', { runId });
      return;
    }
    if (isResizeCapable(mgr)) {
      mgr.resizePanel(this.toLivePanelId(runId), cols, rows);
      return;
    }
    // The manager resize seam (TASK-818) is not yet present — no-op so the
    // renderer ResizeObserver wiring is harmless until it lands.
    this.logger.debug('[SubstrateDispatchFacade] relayResize no-op — interactive manager has no resize seam yet', {
      runId,
      cols,
      rows,
    });
  }

  /**
   * List the run's spawnKeys with a LIVE, steerable SDK turn (monitor live-steer).
   *
   * Takes the RUN id and resolves the substrate via resolveManager() so dispatch
   * stays in ONE place. Programmatic runs — the only ones the monitor steers — are
   * SDK-substrate ONLY, so the interactive manager never owns a steerable turn:
   * it returns [] here. For the SDK manager this delegates to its live-steer seam
   * (feature-detected via isSteeringCapable, no `any`); a manager without the seam
   * (early boot / a future CLI substrate) also returns []. The delegate reports
   * each spawnKey (one per fan-out lane, or the single spawnKey === runId on a
   * non-fan-out run) whose turn is in flight and not tearing down.
   */
  listLiveSpawnKeys(runId: string): string[] {
    const mgr = this.resolveManager(runId);
    if (this.isPtyManager(mgr)) {
      // A PTY substrate has no per-turn SDK steering queue — nothing steerable.
      return [];
    }
    return isSteeringCapable(mgr) ? mgr.listLiveSpawnKeys(runId) : [];
  }

  /**
   * Interject an operator steering message into the turn a single spawn is running
   * (monitor live-steer). Returns `true` only when the delegate actually pushed the
   * message into the live turn.
   *
   * The runId is threaded SEPARATELY from the spawnKey (a fan-out lane's spawnKey is
   * `${runId}:${itemId}`, not the runId) solely to resolve the substrate via
   * resolveManager() — the SDK manager's injectSteering keys on the spawnKey. The
   * interactive manager is a strict NO-OP (`false`): programmatic runs never resolve
   * the interactive substrate, and it has no SDK steering queue to push into. For the
   * SDK manager this delegates through the isSteeringCapable guard (no `any`);
   * absent the seam it also returns `false`. Delivery is the SDK steering queue
   * (priority 'now') — see ClaudeCodeManager.injectSteering.
   */
  injectSteering(spawnKey: string, runId: string, text: string): boolean {
    const mgr = this.resolveManager(runId);
    if (this.isPtyManager(mgr)) {
      // A PTY substrate has no SDK steering queue — never steerable.
      return false;
    }
    return isSteeringCapable(mgr) ? mgr.injectSteering(spawnKey, text) : false;
  }

  /**
   * Explicitly end a LIVE run's persistent process (IDEA-030 / TASK-818).
   *
   * For the interactive manager this is the ONLY non-kill spawn-promise resolver:
   * it routes to `endSession`, which writes the EOF/`/exit` control sequence so
   * the inherited onExit settles the run's spawn promise and teardownRun fires.
   * For the SDK manager there is no equivalent graceful shutdown (no PTY stdin to
   * write EOF into), so this routes to the SAME `killProcess` abort primitive as
   * killSession — under SDK-process persistence a warm query() otherwise outlives
   * this close-out. Wired from the run close-out mutations (Merge / Dismiss /
   * Create-PR) via the RelayDeps bag. Close-out passes the RUN id; workflow runs
   * hit the manager directly (panelId === runId per the orchestrator invariant),
   * PTY quick sessions translate via toLivePanelId, and SDK quick sessions
   * resolve their own runId→spawnKey bridge internally (killProcess accepts
   * either a panelId or a runId — see ClaudeCodeManager.killProcess). Interactive
   * `endSession` stays feature-detected via the narrow EndSessionCapable
   * interface (no `any`) so it is harmless if that manager ever lacks the seam.
   */
  async endSession(runId: string): Promise<void> {
    const liveOwner = this.livePtyOwners.get(runId);
    if (liveOwner) {
      const panelId = this.toLivePanelId(runId);
      if (isEndSessionCapable(liveOwner)) {
        await liveOwner.endSession(panelId);
        return;
      }
      await liveOwner.killProcess(panelId);
      return;
    }

    const mgr = this.resolveManager(runId);
    if (!this.isPtyManager(mgr)) {
      this.logger.info('[SubstrateDispatchFacade] endSession dispatch kill for SDK substrate', { runId });
      await mgr.killProcess(runId);
      return;
    }
    if (isEndSessionCapable(mgr)) {
      await mgr.endSession(this.toLivePanelId(runId));
      return;
    }
    this.logger.warn('[SubstrateDispatchFacade] endSession no-op — interactive manager has no endSession seam', {
      runId,
    });
  }

  /**
   * HARD-terminate a LIVE run's persistent process (IDEA-030).
   *
   * The discard twin of `endSession`: where interactive `endSession` writes a
   * GRACEFUL EOF/`/exit` (which a RUNNING claude — busy, not reading PTY stdin —
   * never reads, so the process would linger orphaned in the Claude app), this
   * routes to the manager's inherited `killProcess`, which runs
   * cleanupCliResources/teardownRun AND kills the process tree. Idempotent
   * (no-op when the process is already gone). Used by the Dismiss close-out,
   * where the run is being discarded and a polite request is the wrong tool. For
   * the SDK manager this is ALSO the only close-out primitive (no PTY to write a
   * graceful EOF into) — under SDK-process persistence a warm query() otherwise
   * outlives the discard. Takes the RUN id: workflow runs and SDK quick sessions
   * hit the manager directly (killProcess accepts either a panelId or a runId —
   * see ClaudeCodeManager.killProcess), PTY quick sessions translate via
   * toLivePanelId. `killProcess` is on `AbstractCliManager` so no
   * feature-detection is needed.
   */
  async killSession(runId: string): Promise<void> {
    const liveOwner = this.livePtyOwners.get(runId);
    if (liveOwner) {
      await liveOwner.killProcess(this.toLivePanelId(runId));
      return;
    }

    const mgr = this.resolveManager(runId);
    if (!this.isPtyManager(mgr)) {
      this.logger.info('[SubstrateDispatchFacade] killSession dispatch kill for SDK substrate', { runId });
      await mgr.killProcess(runId);
      return;
    }
    await mgr.killProcess(this.toLivePanelId(runId));
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

  /**
   * Append a 'pty-output' chunk to the run's bounded backlog (last N bytes
   * kept). Accumulated under BOTH the event's gate `runId` (legacy — a
   * session's PRIMARY chat panel still addresses its PTY by the shared
   * chatSentinelProvider sentinel) and its `panelId` (every chat panel's own
   * id, including added ones — TASK-103 Add-chat panels have no shared-sentinel
   * consumer and always address their PTY by panelId). For workflow-run panels
   * these are the same key (orchestrator invariant), so this is a harmless
   * single write there.
   */
  private recordPtyBacklog(payload: unknown): void {
    const evt = payload as { panelId?: unknown; runId?: unknown; data?: unknown };
    if (typeof evt.data !== 'string') return;
    const append = (key: string): void => {
      const next = (this.ptyBacklog.get(key) ?? '') + (evt.data as string);
      this.ptyBacklog.set(key, next.length > PTY_BACKLOG_CAP_BYTES ? next.slice(-PTY_BACKLOG_CAP_BYTES) : next);
    };
    if (typeof evt.runId === 'string') append(evt.runId);
    if (typeof evt.panelId === 'string' && evt.panelId !== evt.runId) append(evt.panelId);
  }

  /**
   * Drop a run's backlog on REPL exit. CliExitEvent carries panelId only.
   * Deletes both the panelId-keyed entry directly and, when a reverse mapping
   * exists (PTY quick sessions: panelId ≠ the shared gate runId), the gate
   * runId-keyed entry too — see recordPtyBacklog for why both keys exist.
   */
  private clearPtyBacklog(payload: unknown): void {
    const evt = payload as { panelId?: unknown };
    if (typeof evt.panelId !== 'string') return;
    this.ptyBacklog.delete(evt.panelId);
    const runId = this.interactivePanelToRun.get(evt.panelId);
    if (runId !== undefined) this.ptyBacklog.delete(runId);
  }

  /**
   * Translate a RUN id to the LIVE interactive panelId for manager calls.
   * Workflow runs either miss the map (→ fallback runId, identical behavior —
   * panelId === runId per the orchestrator invariant) or map runId→runId; PTY
   * quick sessions map the sentinel `__quick__` runId to the claudePanel id the
   * process was actually spawned under.
   */
  private toLivePanelId(runId: string): string {
    return this.interactiveRunToPanel.get(runId) ?? runId;
  }

  /**
   * Deterministic at-spawn registration of the runId↔panelId pair for a PTY
   * QUICK session. The event-fed mapping below ('pty-output'/'turn-end') only
   * exists after the FIRST PTY byte / turn boundary — a relay or close-out call
   * racing that first event would fall back to the sentinel `__quick__` runId
   * and throw "No claude process found". sessions:create-quick (eager spawn)
   * and the sessions:input dead-REPL re-spawn call this immediately BEFORE the
   * fire-and-forget startPanel so the translation is live from t0. Seeds BOTH
   * maps with the exact shape recordInteractivePanelMapping writes; idempotent
   * (the event-fed path re-records the identical pair) and evicted on the
   * interactive 'exit' like any event-fed entry.
   */
  registerInteractivePanel(runId: string, panelId: string): void {
    if (!this.interactiveManager) {
      this.logger.warn('[SubstrateDispatchFacade] registerInteractivePanel no-op — claude-interactive lane not registered', {
        runId,
        panelId,
      });
      return;
    }
    this.registerPtyPanel(runId, panelId, this.interactiveManager);
  }

  /**
   * Deterministic at-spawn registration for any live PTY-backed quick-session
   * runtime. Claude interactive remains the workflow-capable owner; Codex PTY
   * uses this session-scoped path so xterm input/backlog can share the existing
   * `cyboflow:pty:<runId>` channel without widening the legacy substrate enum.
   *
   * Also seeds an IDENTITY entry keyed by `panelId` itself (when it differs
   * from `runId`) — an added (non-primary) chat panel (TASK-103) has no shared
   * gate-runId consumer of its own and always addresses its live PTY by its own
   * panelId, so it needs `toLivePanelId(panelId)`/`livePtyOwners.get(panelId)`
   * to resolve directly, independent of whichever OTHER panel the session's
   * shared gate runId currently happens to be registered against.
   */
  registerPtyPanel(runId: string, panelId: string, manager: AbstractCliManager): void {
    this.interactiveRunToPanel.set(runId, panelId);
    this.interactivePanelToRun.set(panelId, runId);
    this.livePtyOwners.set(runId, manager);
    if (panelId !== runId) {
      this.interactiveRunToPanel.set(panelId, panelId);
      this.livePtyOwners.set(panelId, manager);
    }
  }

  /**
   * Record the runId↔panelId pair carried by an interactive event payload
   * ('pty-output' / 'turn-end' — both carry { panelId, runId }). Idempotent;
   * silently skips payloads missing either id. Also seeds the panelId identity
   * entry (see registerPtyPanel) so a panel whose event fires before any
   * deterministic at-spawn registration ran (or that has none — added chat
   * panels go through ClaudePanelManager, not the sessions:create-quick /
   * sessions:input eager-spawn seams) still resolves by its own panelId.
   */
  private recordInteractivePanelMapping(payload: unknown, manager?: AbstractCliManager): void {
    const evt = payload as { panelId?: unknown; runId?: unknown };
    if (typeof evt.panelId !== 'string' || typeof evt.runId !== 'string') return;
    this.interactiveRunToPanel.set(evt.runId, evt.panelId);
    this.interactivePanelToRun.set(evt.panelId, evt.runId);
    if (manager) this.livePtyOwners.set(evt.runId, manager);
    if (evt.panelId !== evt.runId) {
      this.interactiveRunToPanel.set(evt.panelId, evt.panelId);
      if (manager) this.livePtyOwners.set(evt.panelId, manager);
    }
  }

  /**
   * Evict a panel's runId↔panelId mapping on REPL exit. CliExitEvent carries
   * panelId only. Clears the panelId identity entry directly (registerPtyPanel/
   * recordInteractivePanelMapping) AND, via the reverse map, whichever shared
   * gate-runId entry pointed at this panel.
   */
  private clearInteractivePanelMapping(payload: unknown): void {
    const evt = payload as { panelId?: unknown };
    if (typeof evt.panelId !== 'string') return;
    const runId = this.interactivePanelToRun.get(evt.panelId);
    if (runId !== undefined) {
      this.interactiveRunToPanel.delete(runId);
      this.livePtyOwners.delete(runId);
    }
    this.interactiveRunToPanel.delete(evt.panelId);
    this.livePtyOwners.delete(evt.panelId);
    this.interactivePanelToRun.delete(evt.panelId);
  }

  /**
   * Tear down the fan-in subscriptions so a re-init does not leak listeners. Off()s
   * the exact bound handlers stored at construction and clears the facade's own
   * listeners + the panelOwners map. Idempotent.
   */
  dispose(): void {
    for (const { manager, event, handler } of this.subscriptions) {
      manager.off(event, handler);
    }
    this.removeAllListeners();
    this.panelOwners.clear();
    this.ptyBacklog.clear();
    this.interactiveRunToPanel.clear();
    this.interactivePanelToRun.clear();
    this.livePtyOwners.clear();
    this.subscriptions.length = 0;
    this.logger.debug('[SubstrateDispatchFacade] disposed — unsubscribed from every registered manager');
  }
}
