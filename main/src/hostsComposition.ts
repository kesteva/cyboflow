/**
 * hostsComposition — the composition root of Environments (hosts): HostStore, HostRegistry (This Mac + SSH
 * machines), the interactive-terminal manager, the preflight scheduler and the HostsService facade the tRPC
 * router calls. A SIBLING of index.ts (like persistentAgentsComposition.ts), so it may import services and
 * the native PTY module that orchestrator/** may not.
 *
 * Constructing touches no network and spawns nothing. start() only starts the (self-gating) scheduler and
 * relays config changes to the renderer; the feature gates are read live per call by the service.
 * stop() is the synchronous quit-drain hook.
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
import { HostStore } from './orchestrator/hosts/hostStore';
import { captureSeamError } from './services/telemetry';
import { HostRegistry } from './services/hosts/hostRegistry';
import { HostsService, type HostTerminalsLike } from './services/hosts/hostsService';
import { HostTerminalManager, type OwnedHostShell } from './services/hosts/hostTerminalManager';
import { LocalHost } from './services/hosts/localHost';
import { PreflightScheduler } from './services/hosts/preflightScheduler';
import { SshTransport } from './services/hosts/sshTransport';

export interface HostsCompositionDeps {
  db: DatabaseLike;
  configManager: Pick<ConfigManager, 'isEnvironmentsAvailable' | 'isEnvironmentsEnabled' | 'on' | 'off'>;
  logger: LoggerLike;
  appVersion: string;
  getMainWindow: () => Pick<BrowserWindow, 'webContents'> | null | undefined;
}

export interface HostsComposition {
  service: HostsService;
  /** PTY shells owned by open host terminals (System view). */
  terminalShells: () => OwnedHostShell[];
  /** Idempotent. */
  start(): void;
  /** Synchronous and idempotent (quit drain): no timers, no listeners, no terminals, no ssh masters. */
  stop(): void;
}

export function composeHosts(deps: HostsCompositionDeps): HostsComposition {
  const { db, configManager, logger, appVersion, getMainWindow } = deps;

  const store = new HostStore(db, { logger });
  const transport = new SshTransport({ logger });
  const local = new LocalHost({ appVersion, captureError: captureSeamError, logger });
  const registry = new HostRegistry({ store, transport, local, appVersion, captureError: captureSeamError, logger });
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
  });
  const scheduler = new PreflightScheduler({
    listHosts: () => store.list({ includeArchived: false }),
    runPreflight: (hostId) => service.runPreflight(hostId),
    appVersion,
    isRunning: () => service.status().running,
    logger,
  });
  setHostsFacade(service);

  const onConfig = (): void => {
    // Turned off (or remote hosts kill-switched): no terminal may outlive the feature.
    const status = service.status();
    if (!status.running || status.killed) destroyTerminals('Environments turned off');
    emitHostsChanged({ kind: 'status' });
  };
  let started = false;

  return {
    service,
    terminalShells: () => terminals.listOwnedShells(),
    start(): void {
      if (started) return;
      started = true;
      scheduler.start();
      configManager.on('config-updated', onConfig);
    },
    stop(): void {
      started = false;
      scheduler.stop();
      configManager.off('config-updated', onConfig);
      service.shutdown();
    },
  };
}
