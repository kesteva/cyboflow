/**
 * CredentialService — vendor API keys for native persistent-agent connectors (add / rotate / forget) and
 * the connectors' on-demand `secret(id)`.
 *
 * Plaintext exists only transiently in this file: it is encrypted through the injected safeStorage seam
 * before the store sees it, decrypted on demand for one connector call, and never cached, logged or
 * returned in a view. A key that cannot be decrypted on this computer (restored backup, reset keychain)
 * marks the row 'undecryptable' and its connections auth_failed; rotating the key is the recovery path.
 */
import { createHash } from 'node:crypto';
import type { LoggerLike } from '../../orchestrator/types';
import type { PersistentAgentStore } from '../../orchestrator/persistentAgents/persistentAgentStore';
import { buildCredentialView } from '../../orchestrator/persistentAgents/views';
import {
  VENDOR_CREDENTIAL_VENDORS,
  isOneOf,
  type AddCredentialInput,
  type CredentialReference,
  type CredentialView,
  type RotateCredentialInput,
} from '../../../../shared/types/persistentAgents';
import type { ForgetCredentialOutcome } from '../../orchestrator/persistentAgentsBridge';
import {
  CredentialNotFoundError,
  CredentialUndecryptableError,
  InvalidAgentInputError,
} from './errors';

export const UNDECRYPTABLE_COPY = 'Stored key cannot be decrypted on this machine';

export interface CredentialServiceDeps {
  store: PersistentAgentStore;
  /** safeStorageSecret.encryptSecret (throws SecretsUnavailableError). */
  encrypt: (plain: string) => Buffer;
  /** safeStorageSecret.decryptSecret (throws SecretsUnavailableError, or anything else when undecryptable). */
  decrypt: (cipher: Buffer) => string;
  /** Connections reopened by a rotate (pulled once at auth_retry_at). */
  onCredentialReopened: (connectionIds: string[]) => void;
  logger: LoggerLike;
}

/** '…' + last 4 + ' · ' + first 8 hex of sha256 — identifies a key without revealing it. */
export function credentialFingerprint(secret: string): string {
  return `…${secret.slice(-4)} · ${createHash('sha256').update(secret).digest('hex').slice(0, 8)}`;
}

function validLabel(raw: unknown): string {
  const label = typeof raw === 'string' ? raw.trim() : '';
  // eslint-disable-next-line no-control-regex
  if (label.length < 1 || label.length > 80 || /[\u0000-\u001f\u007f]/.test(label)) {
    throw new InvalidAgentInputError('Give the key a name of 1–80 characters.', { field: 'label' });
  }
  return label;
}

function validSecret(raw: unknown): string {
  const secret = typeof raw === 'string' ? raw.trim() : '';
  if (secret.length < 8 || secret.length > 4_096) {
    throw new InvalidAgentInputError("That doesn't look like an API key.", { field: 'secret' });
  }
  return secret;
}

function isSecretsUnavailable(err: unknown): boolean {
  return err instanceof Error && err.name === 'SecretsUnavailableError';
}

export class CredentialService {
  constructor(private readonly deps: CredentialServiceDeps) {}

  list(): CredentialView[] {
    const refs = new Map<string, CredentialReference[]>();
    for (const r of this.deps.store.listCredentialReferenceRows()) {
      const list = refs.get(r.credential_id) ?? [];
      list.push({ agentId: r.agent_id, displayName: r.display_name, connectionId: r.connection_id });
      refs.set(r.credential_id, list);
    }
    return this.deps.store.listCredentialRows().map((row) => buildCredentialView(row, refs.get(row.id) ?? []));
  }

  private view(id: string): CredentialView {
    const row = this.deps.store.getCredentialRow(id);
    if (!row) throw new CredentialNotFoundError(id);
    const refs = this.deps.store.listCredentialReferenceRows(id)
      .map((r) => ({ agentId: r.agent_id, displayName: r.display_name, connectionId: r.connection_id }));
    return buildCredentialView(row, refs);
  }

  async add(input: AddCredentialInput): Promise<CredentialView> {
    if (!isOneOf(VENDOR_CREDENTIAL_VENDORS, input.vendor)) {
      throw new InvalidAgentInputError('Unknown key type.');
    }
    const label = validLabel(input.label);
    const secret = validSecret(input.secret);
    const cipher = this.deps.encrypt(secret); // SecretsUnavailableError → nothing stored
    const { id } = await this.deps.store.insertCredential({
      vendor: input.vendor, label, cipher, fingerprint: credentialFingerprint(secret),
    });
    this.deps.logger.info('[persistent-agents] credential added', { credentialId: id });
    return this.view(id);
  }

  async rotate(input: RotateCredentialInput): Promise<CredentialView> {
    if (!this.deps.store.getCredentialRow(input.id)) throw new CredentialNotFoundError(input.id);
    const secret = validSecret(input.secret);
    const cipher = this.deps.encrypt(secret);
    const { reopenedConnectionIds } = await this.deps.store.rotateCredential(input.id, cipher, credentialFingerprint(secret));
    this.deps.logger.info('[persistent-agents] credential rotated', { credentialId: input.id, reopened: reopenedConnectionIds.length });
    if (reopenedConnectionIds.length > 0) this.deps.onCredentialReopened(reopenedConnectionIds);
    return this.view(input.id);
  }

  async forget(id: string, detach: boolean): Promise<ForgetCredentialOutcome> {
    const res = await this.deps.store.forgetCredential(id, detach);
    if (res.forgotten) this.deps.logger.info('[persistent-agents] credential forgotten', { credentialId: id });
    return res;
  }

  /** ConnectorDeps.secret: decrypt on demand, never cached. */
  async secret(credentialId: string): Promise<string> {
    const row = this.deps.store.getCredentialCiphertext(credentialId);
    if (!row) throw new CredentialNotFoundError(credentialId);
    try {
      return this.deps.decrypt(row.cipher);
    } catch (err) {
      if (isSecretsUnavailable(err)) throw err;
      this.deps.logger.warn('[persistent-agents] stored credential cannot be decrypted', { credentialId });
      await this.deps.store.setCredentialState(credentialId, 'undecryptable', UNDECRYPTABLE_COPY);
      for (const connectionId of this.deps.store.listConnectionIdsForCredential(credentialId)) {
        await this.deps.store.setConnectionState(connectionId, {
          state: 'auth_failed', errorKind: 'undecryptable', lastError: UNDECRYPTABLE_COPY, authRetryAt: null,
        });
      }
      throw new CredentialUndecryptableError(credentialId);
    }
  }

  version(credentialId: string): number | null {
    return this.deps.store.getCredentialRow(credentialId)?.version ?? null;
  }
}
