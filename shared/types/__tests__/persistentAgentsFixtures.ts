/**
 * Shared descriptor fixtures for persistent-agents tests (shared derivations, the core's fake connector,
 * renderer chip tests). Capabilities only describe what a connector DECLARES; nothing here is observed.
 */
import type {
  ConnectionCapabilitiesSnapshot,
  ConnectorCapabilities,
  ConnectorDefinition,
  VerifiedFlag,
} from '../persistentAgents';

/** A native API connector (Claude Managed Agents shape): push inbound, activity, usage, one control verb. */
export const CMA_DESCRIPTOR: ConnectorCapabilities = {
  messaging: 'two-way',
  inbound: ['push'],
  activityStream: true,
  usage: true,
  control: ['interrupt'],
  taskBriefs: 'structured',
  deliveries: 'github-only',
  attachments: false,
};

/** The cyboflow Bridge descriptor: messages only when the agent checks in, no telemetry, no control. */
export const BRIDGE_DESCRIPTOR: ConnectorCapabilities = {
  messaging: 'two-way',
  inbound: ['agent-initiated'],
  activityStream: false,
  usage: false,
  control: [],
  taskBriefs: 'message',
  deliveries: 'agent-reported',
  attachments: false,
};

/** Synthetic inbound-only connector (e.g. an agent that only opens PRs on GitHub). */
export const GITHUB_ONLY_DESCRIPTOR: ConnectorCapabilities = {
  messaging: 'inbound-only',
  inbound: ['poll'],
  activityStream: false,
  usage: false,
  control: [],
  taskBriefs: 'message',
  deliveries: 'github-only',
  attachments: false,
};

export const CMA_DEFINITION: ConnectorDefinition = {
  id: 'claude-managed-agents',
  kind: 'native',
  version: 1,
  vendors: ['anthropic-cma'],
  displayName: 'Claude Managed Agents',
  connectsVia: 'api',
  capabilities: CMA_DESCRIPTOR,
  credentialVendor: 'anthropic',
  transports: ['stream'],
  limits: { maxMessageBytes: 65_536, maxLinks: 20 },
};

export const BRIDGE_FIXTURE_DEFINITION: ConnectorDefinition = {
  id: 'bridge',
  kind: 'bridge',
  version: 1,
  vendors: ['openai-dots', 'meta-muse', 'other'],
  displayName: 'cyboflow Bridge',
  connectsVia: 'bridge',
  capabilities: BRIDGE_DESCRIPTOR,
  credentialVendor: null,
  transports: ['relay-mcp', 'relay-http'],
  limits: { maxMessageBytes: 65_536, maxLinks: 20 },
};

/** Build a snapshot; every flag in `observed` is stamped with the same first-seen time. */
export function snapshotOf(
  descriptor: ConnectorCapabilities,
  observed: readonly VerifiedFlag[] = [],
  at = '2026-10-07T12:00:00.000Z',
): ConnectionCapabilitiesSnapshot {
  const flags: Partial<Record<VerifiedFlag, string>> = {};
  for (const f of observed) flags[f] = at;
  return { descriptor, descriptorVersion: 1, observed: flags };
}
