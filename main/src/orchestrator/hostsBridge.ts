/**
 * Environments (hosts) — the orchestrator-side seam between the tRPC router and the HostsService that
 * lives under main/src/services/hosts/. Same shape as persistentAgentsBridge.ts: a facade interface the
 * service satisfies structurally, a module-level injectable singleton set once at boot, and a module-level
 * EventEmitter the store emits on after commit and the router subscriptions listen on.
 *
 * Imports only node:events and shared/types/* (standalone-typecheck invariant).
 */
import { EventEmitter } from 'node:events';
import type {
  CapabilityTier,
  HostsChangedEvent,
  HostsFeatureStatus,
  HostView,
  PreflightProgressEvent,
  PreflightResult,
} from '../../../shared/types/hosts';

/** Implemented by HostsService. Methods THROW named errors; the router converts them. */
export interface HostsFacade {
  status(): HostsFeatureStatus;
  list(opts: { includeArchived: boolean }): HostView[];
  /** @throws HostNotFoundError */
  get(id: string): HostView;
  /** Then kicks a full preflight (not awaited). */
  addSsh(input: { label: string; sshTarget: string }): Promise<{ id: string }>;
  update(id: string, patch: { label?: string; sshTarget?: string }): Promise<void>;
  setUserCap(id: string, cap: CapabilityTier | null): Promise<void>;
  /** Coalesces with an in-flight run. */
  runPreflight(id: string): Promise<PreflightResult>;
  archive(id: string): Promise<void>;
  setProjectDefault(projectId: number, hostId: string | null): Promise<void>;
  /** A new terminal on every call. */
  terminalOpen(hostId: string): Promise<{ terminalId: string }>;
  terminalInput(terminalId: string, text: string): void;
  terminalResize(terminalId: string, cols: number, rows: number): void;
  terminalBacklog(terminalId: string): { backlog: string; exited: boolean; exitCode: number | null };
  terminalClose(terminalId: string): void;
}

/** A hosts procedure ran before the composition injected the live service. */
export class HostsNotInitializedError extends Error {
  constructor() {
    super('Environments are not initialized');
    this.name = 'HostsNotInitializedError';
  }
}

let facade: HostsFacade | null = null;

/** Inject the live service (composition root). Calling again replaces it; tests reset per case. */
export function setHostsFacade(next: HostsFacade): void {
  facade = next;
}

/** @throws {HostsNotInitializedError} when boot has not injected one yet. */
export function getHostsFacade(): HostsFacade {
  if (facade === null) throw new HostsNotInitializedError();
  return facade;
}

/** The wired facade, or null (the router answers "off" for an unset facade). */
export function peekHostsFacade(): HostsFacade | null {
  return facade;
}

/** Test-only: clear the wired facade so a case starts from the unset state. */
export function _resetHostsFacadeForTesting(): void {
  facade = null;
}

// Change broadcast — payloads are NOTIFICATIONS: the renderer re-queries rather than patching from an event.
export const hostEvents = new EventEmitter();
hostEvents.setMaxListeners(50);

export const HOSTS_CHANNEL = 'hosts';

export function hostPreflightChannel(id: string): string {
  return `host-preflight-${id}`;
}

export function emitHostsChanged(ev: HostsChangedEvent): void {
  hostEvents.emit(HOSTS_CHANNEL, ev);
}

export function emitPreflightProgress(ev: PreflightProgressEvent): void {
  hostEvents.emit(hostPreflightChannel(ev.hostId), ev);
}
