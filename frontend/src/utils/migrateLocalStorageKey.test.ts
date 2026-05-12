import { describe, it, expect, vi, beforeEach } from 'vitest';
import { migrateLocalStorageKey } from './migrateLocalStorageKey';

// ---- localStorage fake ---------------------------------------------------
function makeFakeStorage(initial: Record<string, string> = {}): Storage {
  const store: Record<string, string> = { ...initial };
  return {
    getItem: vi.fn((key: string) => store[key] ?? null),
    setItem: vi.fn((key: string, value: string) => { store[key] = value; }),
    removeItem: vi.fn((key: string) => { delete store[key]; }),
    clear: vi.fn(() => { Object.keys(store).forEach(k => delete store[k]); }),
    key: vi.fn((_index: number) => null),
    get length() { return Object.keys(store).length; },
  } as unknown as Storage;
}

describe('migrateLocalStorageKey', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('Test 1: when newKey is already set, returns its value without reading legacyKey', () => {
    const fakeStorage = makeFakeStorage({ 'new-key': 'true', 'legacy-key': 'false' });
    vi.stubGlobal('localStorage', fakeStorage);

    const result = migrateLocalStorageKey('legacy-key', 'new-key');

    expect(result).toBe('true');
    // legacy key must NOT have been read
    expect(fakeStorage.getItem).not.toHaveBeenCalledWith('legacy-key');
    // nothing should be written or removed
    expect(fakeStorage.setItem).not.toHaveBeenCalled();
    expect(fakeStorage.removeItem).not.toHaveBeenCalled();
  });

  it('Test 2: when only legacyKey is set, copies value to newKey, removes legacyKey, returns value', () => {
    const fakeStorage = makeFakeStorage({ 'legacy-key': 'true' });
    vi.stubGlobal('localStorage', fakeStorage);

    const result = migrateLocalStorageKey('legacy-key', 'new-key');

    expect(result).toBe('true');
    expect(fakeStorage.setItem).toHaveBeenCalledWith('new-key', 'true');
    expect(fakeStorage.removeItem).toHaveBeenCalledWith('legacy-key');
  });

  it('Test 3: when neither key is set, returns null without any writes', () => {
    const fakeStorage = makeFakeStorage({});
    vi.stubGlobal('localStorage', fakeStorage);

    const result = migrateLocalStorageKey('legacy-key', 'new-key');

    expect(result).toBeNull();
    expect(fakeStorage.setItem).not.toHaveBeenCalled();
    expect(fakeStorage.removeItem).not.toHaveBeenCalled();
  });

  it('Test 4: when localStorage.getItem throws (e.g. Safari private mode), returns null gracefully', () => {
    const throwingStorage: Storage = {
      getItem: vi.fn(() => { throw new Error('SecurityError: access denied'); }),
      setItem: vi.fn(),
      removeItem: vi.fn(),
      clear: vi.fn(),
      key: vi.fn(),
      length: 0,
    } as unknown as Storage;
    vi.stubGlobal('localStorage', throwingStorage);

    expect(() => migrateLocalStorageKey('legacy-key', 'new-key')).not.toThrow();
    const result = migrateLocalStorageKey('legacy-key', 'new-key');
    expect(result).toBeNull();
  });
});
