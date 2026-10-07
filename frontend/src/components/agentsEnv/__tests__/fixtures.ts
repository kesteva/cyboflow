/** Typed fixtures for the Agents & Environments tests (a contract drift fails tsc, not the runtime). */
import type { ConnectorCapabilities } from '../../../../../shared/types/persistentAgents';
import type {
  CloudDisplayState,
  CloudSignInFailure,
  CloudStatus,
} from '../../../../../shared/types/cloudAccountWire';
import type {
  AgentViewT,
  AgentsFeatureStatus,
  ConnectionViewT,
  ConnectorViewT,
  ThreadMessage,
} from '../types';

export const bridgeDescriptor: ConnectorCapabilities = {
  messaging: 'two-way',
  inbound: ['agent-initiated'],
  activityStream: false,
  usage: false,
  control: [],
  taskBriefs: 'message',
  deliveries: 'agent-reported',
  attachments: false,
};

export const cmaDescriptor: ConnectorCapabilities = {
  messaging: 'two-way',
  inbound: ['push'],
  activityStream: true,
  usage: true,
  control: ['interrupt'],
  taskBriefs: 'structured',
  deliveries: 'github-only',
  attachments: false,
};

export function makeStatus(over: Partial<AgentsFeatureStatus> = {}): AgentsFeatureStatus {
  return {
    devBuild: true,
    configEnabled: true,
    enabled: true,
    killed: false,
    running: true,
    bridgeDisabled: false,
    ...over,
  };
}

export function makeConnection(over: Partial<ConnectionViewT> = {}): ConnectionViewT {
  return {
    id: 'conn-1',
    kind: 'bridge',
    connectorId: 'bridge',
    connectorVersion: 1,
    connectorDisplayName: 'cyboflow Bridge',
    transport: 'relay-mcp',
    state: 'verified',
    isCurrent: true,
    lastSeenAt: new Date().toISOString(),
    verifiedAt: new Date().toISOString(),
    createdAt: '2026-10-07T09:00:00.000Z',
    remoteStatus: null,
    rateLimitedUntil: null,
    capabilities: { descriptor: bridgeDescriptor, descriptorVersion: 1, observed: {} },
    availability: { state: 'ok', message: null, retryAt: null },
    credential: null,
    endpoints: { mcpUrl: 'https://relay.example/mcp/c1', httpBase: 'https://relay.example/c/c1' },
    pairedClient: null,
    verifyFacts: [],
    remoteRevoke: null,
    lastError: null,
    ...over,
  };
}

export function makeAgent(over: Partial<AgentViewT> = {}): AgentViewT {
  return {
    id: 'a1',
    handle: 'my-dot',
    displayName: 'My dot',
    vendor: 'openai-dots',
    githubLogin: null,
    archivedAt: null,
    createdAt: '2026-10-07T09:00:00.000Z',
    unreadCount: 0,
    lastMessageAt: null,
    connection: makeConnection(),
    pendingSwitch: null,
    lastSwitchError: null,
    retiredConnections: [],
    ...over,
  };
}

export function makeMessage(over: Partial<ThreadMessage> = {}): ThreadMessage {
  return {
    id: 'm1',
    connectionId: 'conn-1',
    direction: 'in',
    author: 'agent',
    kind: 'text',
    body: 'hello',
    links: [],
    delivery: null,
    createdAt: '2026-10-07T10:00:00.000Z',
    remoteCreatedAt: null,
    isProbe: false,
    sendState: null,
    sendAttempts: 0,
    nextAttemptAt: null,
    lastError: null,
    sentAt: null,
    pickedUpAt: null,
    remoteAck: null,
    readAt: null,
    ...over,
  };
}

export function makeBridgeConnector(over: Partial<ConnectorViewT> = {}): ConnectorViewT {
  return {
    definition: {
      id: 'bridge',
      kind: 'bridge',
      version: 1,
      vendors: ['openai-dots', 'meta-muse', 'other'],
      displayName: 'cyboflow Bridge',
      connectsVia: 'bridge',
      capabilities: bridgeDescriptor,
      credentialVendor: null,
      transports: ['relay-mcp', 'relay-http'],
      limits: { maxMessageBytes: 65_536, maxLinks: 20 },
    },
    availability: { state: 'ok', message: null, retryAt: null },
    ...over,
  };
}

// ---- cyboflow cloud ---------------------------------------------------------------------

export interface CloudStatusOver {
  lastOkAt?: string | null;
  bridgeEntitled?: boolean;
  displayLogin?: string | null;
  signIn?: Extract<CloudStatus, { available: true }>['signIn'];
  lastSignInFailure?: CloudSignInFailure | null;
}

/** An available cloud status in the given display state (an account exists except when signed out). */
export function makeCloudStatus(display: CloudDisplayState = 'signed_in', over: CloudStatusOver = {}): CloudStatus {
  const hasAccount = display !== 'signed_out' && display !== 'signing_in';
  return {
    available: true,
    display,
    configuredOrigin: 'https://cloud.example',
    staging: false,
    originMismatch: false,
    signIn: over.signIn ?? { phase: 'idle' },
    lastSignInFailure: over.lastSignInFailure ?? null,
    lastError: null,
    defaultDeviceName: 'my-mac',
    account: hasAccount
      ? {
          state: 'ok',
          origin: 'https://cloud.example',
          displayLogin: over.displayLogin === undefined ? 'octo' : over.displayLogin,
          deviceName: 'my-mac',
          deviceCode: 'ABC',
          entitlements: ['bridge'],
          scopes: ['bridge'],
          bridgeEntitled: over.bridgeEntitled ?? true,
          signedInAt: '2026-10-07T10:00:00.000Z',
          lastOkAt: over.lastOkAt === undefined ? '2026-10-07T10:01:00.000Z' : over.lastOkAt,
        }
      : null,
  };
}
