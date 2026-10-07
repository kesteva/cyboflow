/**
 * Named errors of the persistent-agents core (Agents & Environments).
 *
 * They live in orchestrator/ (not services/) so the store — an orchestrator file — can throw them without a
 * runtime services/* import (main/eslint.config.js orchestrator rule; standaloneInvariant.test.ts).
 * main/src/services/persistentAgents/errors.ts re-exports every class for the services layer.
 *
 * The tRPC router recognises these BY NAME (PERSISTENT_AGENTS_ERROR_NAMES) plus a few structural fields
 * (`availability`, `reason`, `field`), so every class sets `this.name` to its class name. Messages are
 * fixed, user-presentable text: never a body, a label, a URL or a secret.
 */
import type {
  ConnectorAvailability,
  PersistentAgentsFailure,
} from '../../../../shared/types/persistentAgents';

/** Any mutation while the feature is not running (toggle off, kill switch, release build). */
export class PersistentAgentsDisabledError extends Error {
  constructor() {
    super('Agents & Environments is turned off.');
    this.name = 'PersistentAgentsDisabledError';
  }
}

export class AgentNotFoundError extends Error {
  readonly agentId: string;
  constructor(agentId: string) {
    super('Agent not found.');
    this.name = 'AgentNotFoundError';
    this.agentId = agentId;
  }
}

export class ConnectionNotFoundError extends Error {
  readonly connectionId: string;
  constructor(connectionId: string) {
    super('Connection not found.');
    this.name = 'ConnectionNotFoundError';
    this.connectionId = connectionId;
  }
}

export class CredentialNotFoundError extends Error {
  readonly credentialId: string;
  constructor(credentialId: string) {
    super('API key not found.');
    this.name = 'CredentialNotFoundError';
    this.credentialId = credentialId;
  }
}

export class ConnectorNotRegisteredError extends Error {
  readonly connectorId: string;
  constructor(connectorId: string) {
    super("This connector isn't available in this build.");
    this.name = 'ConnectorNotRegisteredError';
    this.connectorId = connectorId;
  }
}

/** A connector call was refused because the connector (or this connection) is not callable right now. */
export class ConnectorUnavailableError extends Error {
  readonly availability: ConnectorAvailability;
  constructor(availability: ConnectorAvailability) {
    super(availability.message ?? "This connector isn't available right now.");
    this.name = 'ConnectorUnavailableError';
    this.availability = availability;
  }
}

export class ControlNotSupportedError extends Error {
  readonly verb: string;
  constructor(verb: string) {
    super("This agent doesn't support that control.");
    this.name = 'ControlNotSupportedError';
    this.verb = verb;
  }
}

export type AgentNotSendableReason = 'archived' | 'no_connection' | 'revoked';

const NOT_SENDABLE_COPY: Record<AgentNotSendableReason, string> = {
  archived: 'This agent is archived.',
  no_connection: 'This agent has no connection.',
  revoked: "This agent's connection was revoked. Reconnect it first.",
};

export class AgentNotSendableError extends Error {
  readonly reason: AgentNotSendableReason;
  constructor(reason: AgentNotSendableReason) {
    super(NOT_SENDABLE_COPY[reason]);
    this.name = 'AgentNotSendableError';
    this.reason = reason;
  }
}

export class SwapInProgressError extends Error {
  readonly agentId: string;
  constructor(agentId: string) {
    super('A reconnect is already in progress.');
    this.name = 'SwapInProgressError';
    this.agentId = agentId;
  }
}

export class NoSwapInProgressError extends Error {
  readonly agentId: string;
  constructor(agentId: string, message = 'There is no reconnect to cancel.') {
    super(message);
    this.name = 'NoSwapInProgressError';
    this.agentId = agentId;
  }
}

export interface InvalidAgentInputOptions {
  reason?: 'too_large' | 'invalid';
  field?: PersistentAgentsFailure['field'];
}

export class InvalidAgentInputError extends Error {
  readonly reason: 'too_large' | 'invalid';
  readonly field: PersistentAgentsFailure['field'] | undefined;
  constructor(message: string, opts: InvalidAgentInputOptions = {}) {
    super(message);
    this.name = 'InvalidAgentInputError';
    this.reason = opts.reason ?? 'invalid';
    this.field = opts.field;
  }
}

export class HandleTakenError extends Error {
  readonly handle: string;
  constructor(handle: string) {
    super('Another agent already uses this handle.');
    this.name = 'HandleTakenError';
    this.handle = handle;
  }
}

export class PairingNotSupportedError extends Error {
  readonly connectorId: string;
  constructor(connectorId: string) {
    super("This connection doesn't use pairing.");
    this.name = 'PairingNotSupportedError';
    this.connectorId = connectorId;
  }
}

/** The stored vendor key cannot be decrypted on this computer (the row was marked undecryptable first). */
export class CredentialUndecryptableError extends Error {
  readonly credentialId: string;
  constructor(credentialId: string) {
    super("The stored key can't be read on this computer. Re-enter it.");
    this.name = 'CredentialUndecryptableError';
    this.credentialId = credentialId;
  }
}
