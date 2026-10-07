/**
 * PersistentAgentsService — implements the PersistentAgentsFacade the tRPC router calls. Thin: status,
 * guards, input checks and delegation to the store, the connection service and the credential service.
 *
 * Reads always answer (data is kept while the feature is off); every mutation refuses with
 * PersistentAgentsDisabledError unless status().running.
 */
import type { LoggerLike } from '../../orchestrator/types';
import type {
  DisconnectOutcome,
  ForgetCredentialOutcome,
  PersistentAgentsFacade,
} from '../../orchestrator/persistentAgentsBridge';
import type { PersistentAgentStore } from '../../orchestrator/persistentAgents/persistentAgentStore';
import { isValidLink } from '../../orchestrator/persistentAgents/persistentAgentStore';
import {
  DISABLED_AVAILABILITY,
  buildActivityView,
  buildAgentView,
  buildThreadMessageView,
  buildUsageView,
  sortAgentViews,
  type ConnectorLookup,
} from '../../orchestrator/persistentAgents/views';
import {
  PERSISTENT_AGENT_MAX_LINKS,
  PERSISTENT_AGENT_MAX_MESSAGE_BYTES,
  type ActivityView,
  type AddCredentialInput,
  type AgentView,
  type ConnectInput,
  type ConnectResultData,
  type ConnectorView,
  type ControlVerb,
  type CredentialView,
  type GetThreadInput,
  type PairingPayload,
  type PersistentAgentsStatus,
  type RotateCredentialInput,
  type SendInput,
  type SwitchConnectionInput,
  type ThreadPage,
  type UsageView,
  type VerifyView,
} from '../../../../shared/types/persistentAgents';
import type { ConnectionService } from './connectionService';
import type { ConnectorRegistry } from './connectorRegistry';
import type { CredentialService } from './credentialService';
import {
  AgentNotFoundError,
  AgentNotSendableError,
  InvalidAgentInputError,
  PersistentAgentsDisabledError,
} from './errors';
import type { InboundPump } from './inboundPump';
import type { OutboxWorker } from './outbox';

export interface PersistentAgentsServiceDeps {
  store: PersistentAgentStore;
  registry: ConnectorRegistry;
  connections: ConnectionService;
  credentials: CredentialService;
  pump: Pick<InboundPump, 'noteOutbound'>;
  outbox: Pick<OutboxWorker, 'kick'>;
  /** ConfigManager.isAgentsAvailable() (= dev build). */
  isAvailable: () => boolean;
  /** Raw config.agents?.enabled === true. */
  isConfigEnabled: () => boolean;
  /** ConfigManager.isAgentsEnabled(). */
  isEnabled: () => boolean;
  isKilled: () => boolean;
  isBridgeKilled: () => boolean;
  now: () => Date;
  logger: LoggerLike;
}

export class PersistentAgentsService implements PersistentAgentsFacade {
  constructor(private readonly deps: PersistentAgentsServiceDeps) {}

  status(): PersistentAgentsStatus {
    const enabled = this.deps.isEnabled();
    const killed = this.deps.isKilled();
    return {
      devBuild: this.deps.isAvailable(),
      configEnabled: this.deps.isConfigEnabled(),
      enabled,
      killed,
      running: enabled && !killed,
      bridgeDisabled: this.deps.isBridgeKilled(),
    };
  }

  private guard(): void {
    if (!this.status().running) throw new PersistentAgentsDisabledError();
  }

  private readonly lookup: ConnectorLookup = (connectorId) => {
    if (!this.deps.registry.getDefinition(connectorId)) return undefined;
    try {
      return this.deps.registry.get(connectorId);
    } catch {
      return undefined;
    }
  };

  listConnectors(): ConnectorView[] {
    return this.deps.registry.list().map((definition) => {
      const c = this.lookup(definition.id);
      let availability = DISABLED_AVAILABILITY;
      if (c) {
        try {
          availability = c.availability();
        } catch {
          availability = DISABLED_AVAILABILITY;
        }
      }
      return { definition, availability };
    });
  }

  listAgents(input: { includeArchived: boolean }): AgentView[] {
    const data = this.deps.store.listAgentsWithConnections(input.includeArchived);
    const views = data.agents.map((agent) => buildAgentView({
      agent,
      connections: data.connections.get(agent.id) ?? { current: null, swap: null, retired: [], lastSwitchError: null },
      unreadCount: data.unread.get(agent.id) ?? 0,
      lastMessageAt: data.lastMessageAt.get(agent.id) ?? null,
      credentials: data.credentials,
    }, this.lookup));
    return sortAgentViews(views);
  }

  getThread(input: GetThreadInput): ThreadPage {
    if (!this.deps.store.getAgentRow(input.agentId)) throw new AgentNotFoundError(input.agentId);
    const limit = Math.max(1, Math.min(200, Math.floor(input.limit)));
    const page = this.deps.store.getThreadPage(input.agentId, input.before ?? null, limit);
    return { agentId: input.agentId, messages: page.rows.map(buildThreadMessageView), hasMore: page.hasMore };
  }

  async send(input: SendInput): Promise<{ messageId: string }> {
    this.guard();
    const agent = this.deps.store.getAgentRow(input.agentId);
    if (!agent) throw new AgentNotFoundError(input.agentId);
    if (agent.archived_at !== null) throw new AgentNotSendableError('archived');
    const current = this.deps.store.getCurrentConnection(input.agentId);
    const limits = (current && this.deps.registry.getDefinition(current.connector_id)?.limits)
      ?? { maxMessageBytes: PERSISTENT_AGENT_MAX_MESSAGE_BYTES, maxLinks: PERSISTENT_AGENT_MAX_LINKS };
    const bytes = Buffer.byteLength(input.text, 'utf8');
    if (bytes < 1) {
      throw new InvalidAgentInputError('Write a message first.', { reason: 'invalid', field: 'text' });
    }
    if (bytes > limits.maxMessageBytes) {
      throw new InvalidAgentInputError('This message is too long for this agent.', { reason: 'too_large', field: 'text' });
    }
    const links = input.links ?? [];
    if (links.length > limits.maxLinks || !links.every(isValidLink)) {
      throw new InvalidAgentInputError('Links must be http(s) addresses (at most 20).', { reason: 'invalid', field: 'text' });
    }
    const res = await this.deps.store.enqueueOutbound(input.agentId, { kind: 'text', body: input.text, links, author: 'user' });
    this.deps.pump.noteOutbound(input.agentId, this.deps.now().getTime());
    this.deps.outbox.kick(input.agentId);
    return res;
  }

  async connect(input: ConnectInput): Promise<ConnectResultData> {
    this.guard();
    return this.deps.connections.connect(input);
  }

  async verify(input: { connectionId: string }): Promise<VerifyView> {
    this.guard();
    return this.deps.connections.verify(input.connectionId);
  }

  async switchConnection(input: SwitchConnectionInput): Promise<ConnectResultData> {
    this.guard();
    return this.deps.connections.switchConnection(input);
  }

  async cancelSwitch(input: { agentId: string }): Promise<void> {
    this.guard();
    await this.deps.connections.cancelSwitch(input.agentId);
  }

  async disconnect(input: { agentId: string }): Promise<DisconnectOutcome> {
    this.guard();
    return this.deps.connections.disconnect(input.agentId);
  }

  async archiveAgent(input: { agentId: string }): Promise<void> {
    this.guard();
    await this.deps.connections.archive(input.agentId);
  }

  async control(input: { agentId: string; verb: ControlVerb }): Promise<void> {
    this.guard();
    await this.deps.connections.control(input.agentId, input.verb);
  }

  async markRead(input: { agentId: string; upTo?: string }): Promise<{ unread: number }> {
    this.guard();
    if (!this.deps.store.getAgentRow(input.agentId)) throw new AgentNotFoundError(input.agentId);
    return this.deps.store.markThreadRead(input.agentId, input.upTo);
  }

  listCredentials(): CredentialView[] {
    return this.deps.credentials.list();
  }

  async addCredential(input: AddCredentialInput): Promise<CredentialView> {
    this.guard();
    return this.deps.credentials.add(input);
  }

  async rotateCredential(input: RotateCredentialInput): Promise<CredentialView> {
    this.guard();
    return this.deps.credentials.rotate(input);
  }

  async forgetCredential(input: { id: string; detach: boolean }): Promise<ForgetCredentialOutcome> {
    this.guard();
    return this.deps.credentials.forget(input.id, input.detach);
  }

  getActivity(input: { agentId: string; scope?: string; limit: number }): ActivityView[] {
    if (!this.deps.store.getAgentRow(input.agentId)) throw new AgentNotFoundError(input.agentId);
    const limit = Math.max(1, Math.min(500, Math.floor(input.limit)));
    return this.deps.store.listActivity(input.agentId, input.scope ?? null, limit).map(buildActivityView);
  }

  getUsage(input: { agentId: string }): UsageView {
    if (!this.deps.store.getAgentRow(input.agentId)) throw new AgentNotFoundError(input.agentId);
    return buildUsageView(input.agentId, this.deps.store.listUsage(input.agentId));
  }

  async repairPairing(input: { connectionId: string }): Promise<PairingPayload> {
    this.guard();
    return this.deps.connections.repairPairing(input.connectionId);
  }

  getPairing(input: { connectionId: string }): PairingPayload | null {
    return this.deps.connections.getPairing(input.connectionId);
  }
}
