/**
 * Persistent agents (Agents & Environments) — the orchestrator-side seam between the tRPC router and the
 * PersistentAgentsService that lives under main/src/services/persistentAgents/.
 *
 * Same shape as trackerSyncBridge.ts: a facade interface the service satisfies structurally, a module-level
 * injectable singleton set once at boot (persistentAgentsComposition), and a module-level EventEmitter the
 * store emits on after commit and the router subscriptions listen on. Living HERE (not in the router, not in
 * the service) keeps the router free of services/* imports (standalone-typecheck invariant) and avoids a
 * circular import between the service and the subscription.
 *
 * Imports only node:events and shared/types/*.
 */
import { EventEmitter } from 'node:events';
import type {
  ActivityView, AddCredentialInput, AgentView, ConnectInput, ConnectResultData, ConnectorView, ControlVerb,
  CredentialReference, CredentialView, GetThreadInput, PairingPayload, PersistentAgentsChangedEvent,
  PersistentAgentsStatus, PersistentAgentThreadEvent, RotateCredentialInput, SendInput, SwitchConnectionInput,
  ThreadPage, UsageView, VerifyView,
} from '../../../shared/types/persistentAgents';

export interface DisconnectOutcome {
  connectionId: string;
  remoteRevoke: 'done' | 'pending';
  offerForgetCredentialId: string | null;
}
export type ForgetCredentialOutcome = { forgotten: true } | { forgotten: false; referencedBy: CredentialReference[] };

/** Implemented by PersistentAgentsService. Methods THROW named errors; the router converts them. */
export interface PersistentAgentsFacade {
  status(): PersistentAgentsStatus;
  listConnectors(): ConnectorView[];
  /** Non-archived unless includeArchived; ordered by COALESCE(lastMessageAt, createdAt) DESC. */
  listAgents(input: { includeArchived: boolean }): AgentView[];
  getThread(input: GetThreadInput): ThreadPage;
  send(input: SendInput): Promise<{ messageId: string }>;
  connect(input: ConnectInput): Promise<ConnectResultData>;
  verify(input: { connectionId: string }): Promise<VerifyView>;
  switchConnection(input: SwitchConnectionInput): Promise<ConnectResultData>;
  cancelSwitch(input: { agentId: string }): Promise<void>;
  disconnect(input: { agentId: string }): Promise<DisconnectOutcome>;
  archiveAgent(input: { agentId: string }): Promise<void>;
  control(input: { agentId: string; verb: ControlVerb }): Promise<void>;
  markRead(input: { agentId: string; upTo?: string }): Promise<{ unread: number }>;
  listCredentials(): CredentialView[];
  addCredential(input: AddCredentialInput): Promise<CredentialView>;
  rotateCredential(input: RotateCredentialInput): Promise<CredentialView>;
  forgetCredential(input: { id: string; detach: boolean }): Promise<ForgetCredentialOutcome>;
  getActivity(input: { agentId: string; scope?: string; limit: number }): ActivityView[];
  getUsage(input: { agentId: string }): UsageView;
  repairPairing(input: { connectionId: string }): Promise<PairingPayload>;
  /** In-memory, token/brief always null; null when expired or unknown. */
  getPairing(input: { connectionId: string }): PairingPayload | null;
}

// ---------------------------------------------------------------------------
// Module-level injectable singleton (set once at boot via setPersistentAgentsFacade)
// ---------------------------------------------------------------------------

/** A persistent-agents procedure ran before the composition injected the live service. */
export class PersistentAgentsNotInitializedError extends Error {
  constructor() {
    super('Persistent agents are not initialized');
    this.name = 'PersistentAgentsNotInitializedError';
  }
}

let facade: PersistentAgentsFacade | null = null;

/** Inject the live service (composition root). Calling again replaces it; tests reset per case. */
export function setPersistentAgentsFacade(next: PersistentAgentsFacade): void {
  facade = next;
}

/** @throws {PersistentAgentsNotInitializedError} when boot has not injected one yet. */
export function getPersistentAgentsFacade(): PersistentAgentsFacade {
  if (facade === null) throw new PersistentAgentsNotInitializedError();
  return facade;
}

/** The wired facade, or null (the router answers "off" for an unset facade). */
export function peekPersistentAgentsFacade(): PersistentAgentsFacade | null {
  return facade;
}

/** Test-only: clear the wired facade so a case starts from the unset state. */
export function _resetPersistentAgentsFacadeForTesting(): void {
  facade = null;
}

// ---------------------------------------------------------------------------
// Change broadcast — the store emits after commit; router subscriptions listen.
// Payloads are NOTIFICATIONS: the renderer re-queries rather than patching from an event.
// ---------------------------------------------------------------------------

export const persistentAgentEvents = new EventEmitter();
persistentAgentEvents.setMaxListeners(50);

export const PERSISTENT_AGENTS_CHANNEL = 'persistent-agents';

export function persistentAgentThreadChannel(agentId: string): string {
  return `persistent-agent-thread-${agentId}`;
}

export function emitPersistentAgentsChanged(ev: PersistentAgentsChangedEvent): void {
  persistentAgentEvents.emit(PERSISTENT_AGENTS_CHANNEL, ev);
}

export function emitPersistentAgentThreadEvent(ev: PersistentAgentThreadEvent): void {
  persistentAgentEvents.emit(persistentAgentThreadChannel(ev.agentId), ev);
}
