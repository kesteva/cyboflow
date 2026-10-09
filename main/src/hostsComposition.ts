/**
 * hostsComposition — the composition root of Environments (hosts): HostStore, HostRegistry (This Mac + SSH
 * machines), the interactive-terminal manager, the preflight scheduler and the HostsService facade the tRPC
 * router calls. A SIBLING of index.ts (like persistentAgentsComposition.ts), so it may import services and
 * the native PTY module that orchestrator/** may not.
 *
 * Constructing touches no network and spawns nothing. start() only starts the (self-gating) scheduler and
 * relays config changes to the renderer; the feature gates are read live per call by the service.
 * stop() is the synchronous quit-drain hook.
 */
import * as pty from '@homebridge/node-pty-prebuilt-multiarch';
import type { BrowserWindow } from 'electron';
import type { ConfigManager } from './services/configManager';
import type { DatabaseLike, LoggerLike } from './orchestrator/types';
import { emitHostsChanged, setHostsFacade } from './orchestrator/hostsBridge';
import { HostStore } from './orchestrator/hosts/hostStore';
import { captureSeamError } from './services/telemetry';
import { HostRegistry } from './services/hosts/hostRegistry';
import { HostsService } from './services/hosts/hostsService';
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
  );
  const service = new HostsService({
    store,
    registry,
    terminals,
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
