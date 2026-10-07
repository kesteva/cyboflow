import { MAX_MESSAGE_BYTES, type RelayTransport } from '../../../../../../shared/types/relayProtocol';
import type { ConnectorCapabilities, ConnectorDefinition } from '../../../../../../shared/types/persistentAgents';
import { BRIDGE_MAX_LINKS } from './constants';

export const BRIDGE_CONNECTOR_ID = 'bridge';
/** Bump on any descriptor or wire change (new capabilities then start unconfirmed). */
export const BRIDGE_CONNECTOR_VERSION = 1;

export const BRIDGE_CAPABILITIES: ConnectorCapabilities = {
  messaging: 'two-way',
  inbound: ['agent-initiated'],
  activityStream: false,
  usage: false,
  control: [],
  taskBriefs: 'message',
  deliveries: 'agent-reported',
  attachments: false,
};

export const BRIDGE_DEFINITION: ConnectorDefinition = {
  id: BRIDGE_CONNECTOR_ID,
  kind: 'bridge',
  version: BRIDGE_CONNECTOR_VERSION,
  vendors: ['openai-dots', 'meta-muse', 'other'],
  displayName: 'cyboflow Bridge',
  connectsVia: 'bridge',
  capabilities: BRIDGE_CAPABILITIES,
  credentialVendor: null,
  transports: ['relay-mcp', 'relay-http'],
  limits: { maxMessageBytes: MAX_MESSAGE_BYTES, maxLinks: BRIDGE_MAX_LINKS },
};

/** Default transport per vendor (the dialog may override). */
export const BRIDGE_DEFAULT_TRANSPORT: Record<'openai-dots' | 'meta-muse' | 'other', RelayTransport> = {
  'openai-dots': 'relay-mcp',
  'meta-muse': 'relay-http',
  other: 'relay-mcp',
};
