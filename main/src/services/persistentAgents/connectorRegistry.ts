/**
 * ConnectorRegistry — the persistent-agent connectors available in this process (Bridge, later native
 * vendor connectors). Shape modelled on CliToolRegistry, but deliberately separate (never add entries to
 * CliToolRegistry or AGENT_PROVIDERS) and NOT a process singleton: the persistent-agents composition
 * constructs and owns one instance, so two compositions in one test process never share connectors.
 */
import {
  CONNECTOR_KINDS,
  CONTROL_VERBS,
  PERSISTENT_AGENT_MAX_LINKS,
  PERSISTENT_AGENT_MAX_MESSAGE_BYTES,
  PERSISTENT_AGENT_VENDORS,
  isOneOf,
  type ConnectorDefinition,
} from '../../../../shared/types/persistentAgents';
import type { AgentConnector, ConnectorDeps, ConnectorRegistration } from './connectorContract';

const CONNECTOR_ID_RE = /^[a-z][a-z0-9-]{1,40}$/;

/** Throws an Error naming the first rule the definition breaks. */
export function validateConnectorDefinition(def: ConnectorDefinition): void {
  const bad = (why: string): never => {
    throw new Error(`Invalid connector definition '${String(def.id)}': ${why}`);
  };
  if (typeof def.id !== 'string' || def.id === '') bad('empty id');
  if (!CONNECTOR_ID_RE.test(def.id)) bad('id must match /^[a-z][a-z0-9-]{1,40}$/');
  if (!isOneOf(CONNECTOR_KINDS, def.kind)) bad('unknown kind');
  if (!Number.isInteger(def.version) || def.version < 1) bad('version must be a positive integer');
  if (!Array.isArray(def.vendors) || def.vendors.length === 0) bad('no vendors');
  if (def.vendors.some((v) => !isOneOf(PERSISTENT_AGENT_VENDORS, v))) bad('unknown vendor');
  const maxBytes = def.limits?.maxMessageBytes;
  if (typeof maxBytes !== 'number' || maxBytes < 1 || maxBytes > PERSISTENT_AGENT_MAX_MESSAGE_BYTES) {
    bad('limits.maxMessageBytes out of range');
  }
  const maxLinks = def.limits?.maxLinks;
  if (typeof maxLinks !== 'number' || maxLinks < 0 || maxLinks > PERSISTENT_AGENT_MAX_LINKS) bad('limits.maxLinks out of range');
  if (def.capabilities.control.some((v) => !isOneOf(CONTROL_VERBS, v))) bad('unknown control verb');
  if (def.kind === 'bridge' && def.credentialVendor !== null) bad('a bridge connector takes no vendor credential');
  if (def.kind === 'native' && def.credentialVendor === null) bad('a native connector needs a vendor credential');
}

export class ConnectorRegistry {
  private readonly registrations = new Map<string, ConnectorRegistration>();
  private readonly instances = new Map<string, AgentConnector>();
  private deps: ConnectorDeps | null = null;

  /** Shared deps; must be called before the first get(). A second call replaces deps and drops cached instances. */
  configure(deps: ConnectorDeps): void {
    this.deps = deps;
    this.instances.clear();
  }

  register(reg: ConnectorRegistration, opts: { override?: boolean } = {}): void {
    validateConnectorDefinition(reg.definition);
    const id = reg.definition.id;
    if (this.registrations.has(id)) {
      if (!opts.override) throw new Error(`Connector '${id}' is already registered. Use override: true to replace.`);
      this.disposeInstance(id);
    }
    this.registrations.set(id, reg);
  }

  unregister(id: string): boolean {
    if (!this.registrations.has(id)) return false;
    this.disposeInstance(id);
    this.registrations.delete(id);
    return true;
  }

  getDefinition(id: string): ConnectorDefinition | undefined {
    return this.registrations.get(id)?.definition;
  }

  /** Lazily instantiates via factory(deps) once per id; undefined when unregistered. */
  get(id: string): AgentConnector | undefined {
    const reg = this.registrations.get(id);
    if (!reg) return undefined;
    const cached = this.instances.get(id);
    if (cached) return cached;
    if (this.deps === null) throw new Error('ConnectorRegistry.configure() must be called before get().');
    const instance = reg.factory(this.deps);
    this.instances.set(id, instance);
    return instance;
  }

  /** Registration order. */
  list(): ConnectorDefinition[] {
    return [...this.registrations.values()].map((r) => r.definition);
  }

  /** Sync: dispose every instantiated connector (quit drain). */
  disposeAll(): void {
    for (const id of [...this.instances.keys()]) this.disposeInstance(id);
  }

  private disposeInstance(id: string): void {
    const inst = this.instances.get(id);
    this.instances.delete(id);
    try {
      inst?.dispose?.();
    } catch {
      // Teardown is best-effort; a throwing dispose must not block the others.
    }
  }
}
