/**
 * safeStorageSecret — the generic app-owned secret seam (cyboflow cloud device token, persistent-agent
 * vendor keys). Wraps Electron's `safeStorage` (OS keychain on macOS/Windows; libsecret/kwallet on Linux):
 * plaintext never touches sqlite, only the ciphertext Buffer does, and decryption happens only in main.
 *
 * Never call any of these at module load or on the boot path: on some platforms even the availability
 * probe touches the keychain, and a dev build's keychain prompt freezes the main thread.
 *
 * The tracker keeps its own copy of this seam (services/trackerSync/secrets.ts); no refactor.
 */
import { safeStorage } from 'electron';

/** OS secret storage cannot encrypt/decrypt on this machine right now. Never fall back to plaintext. */
export class SecretsUnavailableError extends Error {
  constructor(message = 'OS-level secret encryption is not available on this machine') {
    super(message);
    this.name = 'SecretsUnavailableError';
  }
}

/**
 * Linux without a keyring backend falls back to a hard-coded password ('basic_text'), which is not real
 * encryption: refuse it rather than storing an effectively plaintext secret.
 */
function isInsecureLinuxBackend(): boolean {
  if (process.platform !== 'linux') return false;
  return safeStorage.getSelectedStorageBackend() === 'basic_text';
}

function assertAvailable(): void {
  if (!safeStorage.isEncryptionAvailable() || isInsecureLinuxBackend()) {
    throw new SecretsUnavailableError();
  }
}

/** Cheap probe; may itself touch the keychain on some platforms — never call on the boot path. */
export function isSecretStorageAvailable(): boolean {
  return safeStorage.isEncryptionAvailable() && !isInsecureLinuxBackend();
}

/** @throws SecretsUnavailableError when OS secret storage is unavailable (or Linux 'basic_text'). */
export function encryptSecret(plain: string): Buffer {
  assertAvailable();
  return safeStorage.encryptString(plain);
}

/**
 * @throws SecretsUnavailableError when OS secret storage is unavailable (or Linux 'basic_text').
 * @throws Error (anything else) when the ciphertext cannot be decrypted (another machine or user) —
 *   callers treat that as 'undecryptable'.
 */
export function decryptSecret(cipher: Buffer): string {
  assertAvailable();
  return safeStorage.decryptString(cipher);
}
