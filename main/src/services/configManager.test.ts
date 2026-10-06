import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as path from 'node:path';

// Mock electron before importing modules that depend on it
vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getPath: vi.fn(() => '/mock/path'),
    getName: vi.fn(() => 'Cyboflow'),
    getVersion: vi.fn(() => '0.1.0'),
  },
}));

// Mock the cyboflow directory utility to avoid real fs reads
vi.mock('../utils/cyboflowDirectory', () => ({
  getCyboflowDirectory: vi.fn(() => '/mock/cyboflow'),
}));

// Mock shellPath to avoid subprocess calls
vi.mock('../utils/shellPath', () => ({
  clearShellPathCache: vi.fn(),
}));

// Mock fs/promises with an in-memory file store
const mockFiles: Record<string, string> = {};
vi.mock('fs/promises', () => ({
  default: {
    mkdir: vi.fn().mockResolvedValue(undefined),
    readFile: vi.fn(async (filePath: string) => {
      if (filePath in mockFiles) return mockFiles[filePath];
      const err = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      throw err;
    }),
    writeFile: vi.fn(async (filePath: string, data: string) => {
      mockFiles[filePath] = data;
    }),
  },
}));

// Defer the import so the mocks above are in place first
let ConfigManager: typeof import('./configManager').ConfigManager;

describe('ConfigManager.initialize: telemetry installId', () => {
  // Built with path.join: ConfigManager joins the mocked cyboflow dir with the
  // host separator, so on win32 the key is '\mock\cyboflow\config.json'.
  const CONFIG_PATH = path.join('/mock/cyboflow', 'config.json');

  beforeEach(async () => {
    vi.resetModules();
    // Reset the in-memory store between tests
    for (const key of Object.keys(mockFiles)) delete mockFiles[key];
    // Re-import after resetModules so module-level state is fresh
    ({ ConfigManager } = await import('./configManager'));
  });

  it('mints and persists an installId exactly once when the loaded config has none', async () => {
    mockFiles[CONFIG_PATH] = JSON.stringify({ gitRepoPath: '/some/repo' });

    const mgr = new ConfigManager();

    // Spy on saveConfig via writeFile call count before initialize
    const { default: fsMock } = await import('fs/promises');
    const writeFileSpy = vi.mocked(fsMock.writeFile);
    const callCountBefore = writeFileSpy.mock.calls.length;

    await mgr.initialize();

    const config = mgr.getConfig();

    // The loaded config had no telemetry.installId, so initialize() generates one and saves once.
    const callCountAfter = writeFileSpy.mock.calls.length;
    expect(callCountAfter).toBe(callCountBefore + 1);
    expect(config.telemetry?.installId).toMatch(/^[0-9a-f-]{36}$/);
  });
});
