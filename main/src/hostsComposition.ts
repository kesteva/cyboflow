/**
 * hostsComposition — the composition root of Environments (hosts): HostStore, HostRegistry (This Mac + SSH
 * machines), the interactive-terminal manager, the preflight scheduler and the HostsService facade the tRPC
 * router calls. A SIBLING of index.ts (like persistentAgentsComposition.ts), so it may import services and
 * the native PTY module that orchestrator/** may not.
 *
 * Constructing touches no network and spawns nothing. start() only starts the (self-gating) scheduler and
 * relays config changes to the renderer; the feature gates are read live per call by the service.
 * stop() is the synchronous quit-drain hook (it also closes every orchestrator link).
 *
 * Orchestrator links (ssh -R of this Mac's orch socket, spec A7) ride the SAME SshTransport as the registry. The
 * local socket path defaults to the one orchSocketComposition binds (`<cyboflow dir>/sockets/orch.sock`, POSIX
 * only — a Windows named pipe cannot be forwarded); boot may inject a live getter instead.
 *
 * Full tier (spec A5/A6): the toolchain module (resolve → hash → push) is wired into the service, and every SshHost
 * the registry builds gets `preflightExtras` from the service (expected toolchain + link handle), through a late-
 * bound closure: the registry is constructed before the service it calls back into.
 *
 * Remote runtime (spec B1): a RemoteRuntime over the service (gates, links), the registry (ExecutionHosts) and the db
 * (host resolution) is published on services/hosts/remoteRuntimeBridge at start() and cleared at stop(), so the
 * agent managers reach it without a constructor change. The service's run-folder pass (spec F3) goes through the
 * runtime's gcRunDir (late-bound: the runtime is built over the service), and drain() is the async quit hook that
 * runs after the agent managers' shutdown (spec F2: kill the live remote processes, then close the ssh masters).
 *
 * Remote checkouts (spec C2): the ONE MergeBackStore (sole writer of session_merge_backs — its write queue only
 * serializes within one instance) and a RemoteCheckout over it, the HostStore, the registry and the transport; the
 * checkout is published on services/hosts/remoteCheckoutBridge alongside the runtime (taskQueue reaches it there).
 *
 * Merge-back (spec E2): a MergeBackService over the same store, published on services/hosts/mergeBack/mergeBackBridge
 * (gitOps merges / pushes / probes through it; bootRecovery resumes it). Two subscriptions feed it while started:
 *  - checkpoints: every non-terminal run hosted on a remote environment (seeded from the db at start(), then followed
 *    through runStatusEvents) has its sprintLaneChannel watched; a lane going `integrated` requests a coalesced
 *    background fetch of the session branch into refs/cyboflow/checkpoint/<key>;
 *  - archive: a row RemoteCheckout walks abandoned → cleaned (the remote half) gets its local half (import /
 *    checkpoint refs, mirror worktree + branch) removed through the store's change callback.
 *
 * Host terminal lifecycle guards (the renderer modal owns a terminal, but cannot always close it):
 *  - a config change that leaves the feature not running (or remote hosts kill-switched) destroys every terminal;
 *  - the first terminal opened against a main-window webContents attaches (once per webContents id) a main-frame
 *    `did-start-navigation` and a `render-process-gone` listener that destroy every terminal: a renderer reload
 *    or crash unmounts the modal without its terminalClose ever running, which would leak a live ssh PTY.
 */
import * as pty from '@homebridge/node-pty-prebuilt-multiarch';
import type { BrowserWindow } from 'electron';
import type { ConfigManager } from './services/configManager';
import type { DatabaseLike, LoggerLike } from './orchestrator/types';
import { emitHostsChanged, emitHostTerminalExit, setHostsFacade } from './orchestrator/hostsBridge';
import { getCyboflowSubdirectory } from './utils/cyboflowDirectory';
import { HostStore } from './orchestrator/hosts/hostStore';
import { MergeBackStore } from './orchestrator/hosts/mergeBackStore';
import { captureSeamError } from './services/telemetry';
import { HostRegistry } from './services/hosts/hostRegistry';
import { HostsService, type HostTerminalsLike } from './services/hosts/hostsService';
import { SshHost } from './services/hosts/sshHost';
import { buildToolchainManifest, pushToolchain, resolveToolchainSources } from './services/hosts/toolchain';
import { HostTerminalManager, type OwnedHostShell } from './services/hosts/hostTerminalManager';
import { LocalHost } from './services/hosts/localHost';
import { PreflightScheduler } from './services/hosts/preflightScheduler';
import { RemoteCheckout } from './services/hosts/remoteCheckout';
import { getRemoteCheckout, setRemoteCheckout } from './services/hosts/remoteCheckoutBridge';
import { getExecutionHostResolver, setExecutionHostResolver, type ExecutionHostResolver } from './services/hosts/executionHostBridge';
import { RemoteArtifactFetcher } from './services/hosts/remoteArtifactFetcher';
import { getRemoteArtifactFetcher, setRemoteArtifactFetcher } from './orchestrator/hosts/remoteArtifactPull';
import type { MergeBackChange } from './orchestrator/hosts/mergeBackStore';
import { sprintLaneChannel, sprintLaneEvents } from './orchestrator/sprintLaneStore';
import { runStatusEvents } from './orchestrator/trpc/routers/events';
import { MergeBackService } from './services/hosts/mergeBack/mergeBackService';
import { getMergeBackService, setMergeBackService } from './services/hosts/mergeBack/mergeBackBridge';
import { isRemoteHostId } from '../../shared/types/hosts';
import { TERMINAL_RUN_STATUSES, type RunStatusChangedEvent } from '../../shared/types/cyboflow';
import type { SprintLaneChangedEvent } from '../../shared/types/sprintBatch';
import { RemoteRuntime } from './services/hosts/remoteRuntime';
import { getRemoteRuntime, setRemoteRuntime } from './services/hosts/remoteRuntimeBridge';
import { SshTransport } from './services/hosts/sshTransport';

export interface HostsCompositionDeps {
  db: DatabaseLike;
  configManager: Pick<ConfigManager, 'isEnvironmentsAvailable' | 'isEnvironmentsEnabled' | 'on' | 'off'>;
  logger: LoggerLike;
  appVersion: string;
  getMainWindow: () => Pick<BrowserWindow, 'webContents'> | null | undefined;
  /**
   * This Mac's orch socket path for the per-host forwards; null = none to forward. Default: the fixed path
   * orchSocketComposition binds on POSIX (`<cyboflow dir>/sockets/orch.sock`), null on Windows.
   */
  getOrchSocketPath?: () => string | null;
}

/** The path orchSocketComposition binds (POSIX); a Windows named pipe is not forwardable, so null there. */
export function defaultOrchSocketPath(platform: NodeJS.Platform = process.platform): string | null {
  return platform === 'win32' ? null : getCyboflowSubdirectory('sockets', 'orch.sock');
}

export interface HostsComposition {
  service: HostsService;
  /** Published on remoteRuntimeBridge while started. */
  remoteRuntime: RemoteRuntime;
  /** The single session_merge_backs writer (merge-back reuses it). */
  mergeBackStore: MergeBackStore;
  /** Published on remoteCheckoutBridge while started. */
  remoteCheckout: RemoteCheckout;
  /** Published on mergeBackBridge while started. */
  mergeBack: MergeBackService;
  /** PTY shells owned by open host terminals (System view). */
  terminalShells: () => OwnedHostShell[];
  /** Idempotent. */
  start(): void;
  /** Synchronous and idempotent (quit drain): no timers, no listeners, no terminals, no ssh masters. */
  stop(): void;
  /** Quit drain, after the agent managers' shutdown: kills the live remote processes, then closes the ssh masters. */
  drain(): Promise<void>;
}

export function composeHosts(deps: HostsCompositionDeps): HostsComposition {
  const { db, configManager, logger, appVersion, getMainWindow } = deps;

  const store = new HostStore(db, { logger });
  const transport = new SshTransport({ logger });
  const local = new LocalHost({ appVersion, captureError: captureSeamError, logger });
  // Late-bound: SshHosts are only built (and preflighted) after the service below exists.
  let serviceRef: HostsService | null = null;
  // Late-bound: the runtime is built over the service, and the service's run-folder pass (spec F3) calls into it.
  let remoteRuntimeRef: RemoteRuntime | null = null;
  const registry = new HostRegistry({
    store, transport, local, appVersion, captureError: captureSeamError, logger,
    createSshHost: (d) => new SshHost({
      ...d,
      preflightExtras: (mode) => (serviceRef ? serviceRef.preflightExtras(d.id, mode) : Promise.resolve({})),
    }),
  });
  const terminals = new HostTerminalManager(
    (terminalId, chunk) => {
      getMainWindow()?.webContents.send(`cyboflow:shell:${terminalId}`, chunk);
    },
    (file, args, options) => pty.spawn(file, args, options),
    { onExit: (terminalId, exitCode) => emitHostTerminalExit({ terminalId, exitCode }) },
  );

  const destroyTerminals = (reason: string): void => {
    if (terminals.listOwnedShells().length > 0) logger.info(`[hosts] closing host terminals: ${reason}`);
    try {
      terminals.destroyAll();
    } catch (err) {
      logger.warn('[hosts] terminal teardown failed', { error: err instanceof Error ? err.name : 'unknown' });
    }
  };

  // One listener pair per webContents id (a recreated main window has a new id and gets its own pair).
  const guardedWebContents = new Set<number>();
  const guardRenderer = (): void => {
    const wc = getMainWindow()?.webContents;
    if (!wc || guardedWebContents.has(wc.id)) return;
    guardedWebContents.add(wc.id);
    wc.on('did-start-navigation', (details) => {
      if (!details.isMainFrame || details.isSameDocument) return;
      destroyTerminals('renderer navigated');
    });
    wc.on('render-process-gone', () => destroyTerminals('renderer gone'));
  };
  const guardedTerminals: HostTerminalsLike = {
    open: (hostId, sshTarget) => {
      const terminalId = terminals.open(hostId, sshTarget);
      try {
        guardRenderer();
      } catch (err) {
        logger.warn('[hosts] could not watch the renderer for terminal cleanup', {
          error: err instanceof Error ? err.name : 'unknown',
        });
      }
      return terminalId;
    },
    write: (terminalId, text) => terminals.write(terminalId, text),
    resize: (terminalId, cols, rows) => terminals.resize(terminalId, cols, rows),
    getBacklog: (terminalId) => terminals.getBacklog(terminalId),
    closeOne: (terminalId) => terminals.closeOne(terminalId),
    closeForHost: (hostId) => terminals.closeForHost(hostId),
    destroyAll: () => terminals.destroyAll(),
    listOwnedShells: () => terminals.listOwnedShells(),
  };

  const service = new HostsService({
    store,
    registry,
    terminals: guardedTerminals,
    appVersion,
    isAvailable: () => configManager.isEnvironmentsAvailable(),
    isEnabled: () => configManager.isEnvironmentsEnabled(),
    logger,
    captureError: captureSeamError,
    links: { transport, getOrchSocketPath: deps.getOrchSocketPath ?? (() => defaultOrchSocketPath()) },
    toolchain: {
      resolveSources: (arch) => resolveToolchainSources(arch),
      buildManifest: (resolved, opts) => buildToolchainManifest(resolved, opts),
      push: (input) => pushToolchain(input),
      transport,
    },
    runDirGc: (hostId, root) => (remoteRuntimeRef ? remoteRuntimeRef.gcRunDir(hostId, root) : Promise.resolve(null)),
  });
  serviceRef = service;
  const scheduler = new PreflightScheduler({
    listHosts: () => store.list({ includeArchived: false }),
    runPreflight: (hostId) => service.runPreflight(hostId),
    appVersion,
    isRunning: () => service.status().running,
    logger,
  });
  setHostsFacade(service);
  const remoteRuntime = new RemoteRuntime({
    db,
    hosts: service,
    getHost: (hostId) => registry.get(hostId),
    logger,
    captureError: captureSeamError,
  });
  remoteRuntimeRef = remoteRuntime;
  // Late-bound: the merge-back service is built over this store, and its change callback reaches the service.
  let onMergeBackChange: ((change: MergeBackChange) => void) | null = null;
  const mergeBackStore = new MergeBackStore(db, { logger, onChange: (change) => onMergeBackChange?.(change) });
  const remoteCheckout = new RemoteCheckout({
    status: () => service.status(),
    store,
    getHost: (hostId) => registry.get(hostId),
    transport,
    mergeBacks: mergeBackStore,
    logger,
    captureError: captureSeamError,
  });

  const mergeBack = new MergeBackService({
    status: () => service.status(),
    store,
    getHost: (hostId) => registry.get(hostId),
    transport,
    mergeBacks: mergeBackStore,
    projectPathFor: (projectId) => {
      try {
        const row = db.prepare('SELECT path FROM projects WHERE id = ?').get(projectId) as { path?: unknown } | undefined;
        return typeof row?.path === 'string' && row.path !== '' ? row.path : null;
      } catch {
        return null;
      }
    },
    logger,
    captureError: captureSeamError,
  });
  onMergeBackChange = (change) => {
    // Archive: RemoteCheckout removed the remote half; the local half (refs, mirror) goes here. Idempotent.
    if (change.state === 'cleaned' && change.previous === 'abandoned') {
      void mergeBack.cleanupLocal(change.sessionId).catch(() => false);
      void remoteRuntime.onSessionEnded(change.sessionId, change.hostId);
    }
  };

  // Checkpoints: watch the lane channel of every live run hosted on a remote environment.
  const watchedRuns = new Map<string, (event: SprintLaneChangedEvent) => void>();
  const watchRun = (runId: string, sessionId: string): void => {
    if (watchedRuns.has(runId)) return;
    const listener = (event: SprintLaneChangedEvent): void => {
      if (event.status === 'integrated') void mergeBack.requestCheckpoint(sessionId).catch(() => undefined);
    };
    watchedRuns.set(runId, listener);
    sprintLaneEvents.on(sprintLaneChannel(runId), listener);
  };
  const unwatchRun = (runId: string): void => {
    const listener = watchedRuns.get(runId);
    if (!listener) return;
    sprintLaneEvents.off(sprintLaneChannel(runId), listener);
    watchedRuns.delete(runId);
  };
  const isTerminalRunStatus = (status: string): boolean => (TERMINAL_RUN_STATUSES as readonly string[]).includes(status);
  const onRunStatus = (event: RunStatusChangedEvent): void => {
    try {
      if (isTerminalRunStatus(event.status)) {
        unwatchRun(event.runId);
        return;
      }
      const run = db.prepare('SELECT host_id, session_id FROM workflow_runs WHERE id = ?').get(event.runId) as
        | { host_id: string | null; session_id: string | null }
        | undefined;
      if (run && isRemoteHostId(run.host_id) && run.session_id) watchRun(event.runId, run.session_id);
    } catch (err) {
      logger.warn('[merge-back] could not follow a run for checkpoints', { error: err instanceof Error ? err.name : 'unknown' });
    }
  };
  const seedWatchedRuns = (): void => {
    try {
      const rows = db.prepare(
        `SELECT id, session_id FROM workflow_runs
          WHERE host_id IS NOT NULL AND host_id != 'local' AND session_id IS NOT NULL
            AND status NOT IN (${TERMINAL_RUN_STATUSES.map(() => '?').join(', ')})`,
      ).all(...TERMINAL_RUN_STATUSES) as Array<{ id: string; session_id: string }>;
      for (const row of rows) watchRun(row.id, row.session_id);
    } catch (err) {
      logger.warn('[merge-back] could not list remote runs for checkpoints', { error: err instanceof Error ? err.name : 'unknown' });
    }
  };

  const onConfig = (): void => {
    // Turned off (or remote hosts kill-switched): no terminal may outlive the feature.
    const status = service.status();
    if (!status.running || status.killed) destroyTerminals('Environments turned off');
    emitHostsChanged({ kind: 'status' });
  };
  let started = false;

  // Phase D: orchestrator-side host access (lane probes, environment actions) and remote artifact pull-back.
  const hostResolver: ExecutionHostResolver = (hostId) => registry.get(hostId);
  const artifactFetcher = new RemoteArtifactFetcher({ logger });

  return {
    service,
    remoteRuntime,
    mergeBackStore,
    remoteCheckout,
    mergeBack,
    terminalShells: () => terminals.listOwnedShells(),
    start(): void {
      if (started) return;
      started = true;
      setRemoteRuntime(remoteRuntime);
      setRemoteCheckout(remoteCheckout);
      setExecutionHostResolver(hostResolver);
      setRemoteArtifactFetcher(artifactFetcher);
      setMergeBackService(mergeBack);
      seedWatchedRuns();
      runStatusEvents.on('changed', onRunStatus);
      scheduler.start();
      configManager.on('config-updated', onConfig);
    },
    stop(): void {
      started = false;
      if (getRemoteRuntime() === remoteRuntime) setRemoteRuntime(null);
      if (getRemoteCheckout() === remoteCheckout) setRemoteCheckout(null);
      if (getExecutionHostResolver() === hostResolver) setExecutionHostResolver(null);
      if (getRemoteArtifactFetcher() === artifactFetcher) setRemoteArtifactFetcher(null);
      if (getMergeBackService() === mergeBack) setMergeBackService(null);
      runStatusEvents.off('changed', onRunStatus);
      for (const runId of [...watchedRuns.keys()]) unwatchRun(runId);
      scheduler.stop();
      configManager.off('config-updated', onConfig);
      service.shutdown();
    },
    drain: () => service.drainRemoteProcesses(),
  };
}
