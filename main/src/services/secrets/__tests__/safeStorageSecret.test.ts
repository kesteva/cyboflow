import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const safeStorageMock = vi.hoisted(() => ({
  isEncryptionAvailable: vi.fn(() => true),
  getSelectedStorageBackend: vi.fn(() => 'keychain'),
  encryptString: vi.fn((plain: string) => Buffer.from(`enc:${plain}`, 'utf-8')),
  decryptString: vi.fn((cipher: Buffer) => {
    const text = cipher.toString('utf-8');
    if (!text.startsWith('enc:')) throw new Error('Error while decrypting the ciphertext provided');
    return text.slice(4);
  }),
}));

vi.mock('electron', () => ({ safeStorage: safeStorageMock }));

import {
  SecretsUnavailableError,
  decryptSecret,
  encryptSecret,
  isSecretStorageAvailable,
} from '../safeStorageSecret';

const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
}

describe('safeStorageSecret', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    safeStorageMock.isEncryptionAvailable.mockReturnValue(true);
    safeStorageMock.getSelectedStorageBackend.mockReturnValue('keychain');
  });

  afterEach(() => {
    if (originalPlatform) Object.defineProperty(process, 'platform', originalPlatform);
  });

  it('round-trips a secret through encrypt/decrypt', () => {
    const cipher = encryptSecret('sk-ant-secret');
    expect(cipher.toString('utf-8')).not.toBe('sk-ant-secret');
    expect(decryptSecret(cipher)).toBe('sk-ant-secret');
    expect(isSecretStorageAvailable()).toBe(true);
  });

  it('throws SecretsUnavailableError without touching encrypt/decrypt when encryption is unavailable', () => {
    safeStorageMock.isEncryptionAvailable.mockReturnValue(false);
    let thrown: unknown;
    try { encryptSecret('x'); } catch (err) { thrown = err; }
    expect(thrown).toBeInstanceOf(SecretsUnavailableError);
    expect((thrown as Error).name).toBe('SecretsUnavailableError');
    expect(() => decryptSecret(Buffer.from('enc:x'))).toThrow(SecretsUnavailableError);
    expect(safeStorageMock.encryptString).not.toHaveBeenCalled();
    expect(safeStorageMock.decryptString).not.toHaveBeenCalled();
    expect(isSecretStorageAvailable()).toBe(false);
  });

  it('rethrows a decrypt failure as a non-SecretsUnavailableError', () => {
    let thrown: unknown;
    try { decryptSecret(Buffer.from('garbage')); } catch (err) { thrown = err; }
    expect(thrown).toBeInstanceOf(Error);
    expect(thrown).not.toBeInstanceOf(SecretsUnavailableError);
    expect((thrown as Error).name).not.toBe('SecretsUnavailableError');
  });

  it("refuses Linux's basic_text backend", () => {
    setPlatform('linux');
    safeStorageMock.getSelectedStorageBackend.mockReturnValue('basic_text');
    expect(() => encryptSecret('x')).toThrow(SecretsUnavailableError);
    expect(() => decryptSecret(Buffer.from('enc:x'))).toThrow(SecretsUnavailableError);
    expect(isSecretStorageAvailable()).toBe(false);
    expect(safeStorageMock.encryptString).not.toHaveBeenCalled();
  });

  it('accepts a real Linux keyring backend', () => {
    setPlatform('linux');
    safeStorageMock.getSelectedStorageBackend.mockReturnValue('gnome_libsecret');
    expect(decryptSecret(encryptSecret('k'))).toBe('k');
  });

  it('does not consult the Linux backend on other platforms', () => {
    setPlatform('darwin');
    safeStorageMock.getSelectedStorageBackend.mockReturnValue('basic_text');
    expect(decryptSecret(encryptSecret('k'))).toBe('k');
    expect(safeStorageMock.getSelectedStorageBackend).not.toHaveBeenCalled();
  });
});
