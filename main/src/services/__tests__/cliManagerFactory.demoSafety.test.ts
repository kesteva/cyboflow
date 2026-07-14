import { afterAll, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { CliManagerFactory } from '../cliManagerFactory';
import type { ConfigManager } from '../configManager';
import type { SessionManager } from '../sessionManager';
import { DemoCliManager } from '../demo/demoCliManager';
import { CodexPtyManager } from '../panels/codex/codexPtyManager';
import { CodexSdkManager } from '../panels/codex/codexSdkManager';

describe('CliManagerFactory demo safety', () => {
  let demoMode = true;
  const configManager = {
    isDemoMode: () => demoMode,
  } as unknown as ConfigManager;
  const sessionManager = {} as unknown as SessionManager;
  const db = {
    prepare: () => {
      throw new Error('not used by manager construction');
    },
    transaction: () => {
      throw new Error('not used by manager construction');
    },
  } as unknown as Database.Database;
  const factory = CliManagerFactory.getInstance(undefined, configManager);

  afterAll(async () => {
    await factory.shutdown();
  });

  it('uses demo-backed Codex adapters in demo mode and real managers in normal mode', async () => {
    const demoSdkManager = await factory.createManager('codex-sdk', {
      sessionManager,
      additionalOptions: { db },
      skipValidation: true,
    });
    // Mirrors boot: codex-pty omits db and reuses the handle captured above.
    const demoPtyManager = await factory.createManager('codex-pty', {
      sessionManager,
      skipValidation: true,
    });

    expect(demoSdkManager).toBeInstanceOf(CodexSdkManager);
    expect(demoPtyManager).toBeInstanceOf(CodexPtyManager);
    expect(demoSdkManager.spawnCliProcess).toBe(DemoCliManager.prototype.spawnCliProcess);
    expect(demoPtyManager.spawnCliProcess).toBe(DemoCliManager.prototype.spawnCliProcess);
    expect(typeof (demoSdkManager as CodexSdkManager).setCyboflowMcpRuntimeConfig).toBe('function');
    expect(typeof (demoSdkManager as CodexSdkManager).setApprovalRouterProvider).toBe('function');
    expect(typeof (demoPtyManager as CodexPtyManager).relayUserTurn).toBe('function');

    demoMode = false;
    const normalSdkManager = await factory.createManager('codex-sdk', {
      sessionManager,
      additionalOptions: { db },
      skipValidation: true,
    });
    const normalPtyManager = await factory.createManager('codex-pty', {
      sessionManager,
      skipValidation: true,
    });

    expect(normalSdkManager).toBeInstanceOf(CodexSdkManager);
    expect(normalPtyManager).toBeInstanceOf(CodexPtyManager);
    expect(normalSdkManager.spawnCliProcess).not.toBe(DemoCliManager.prototype.spawnCliProcess);
    expect(normalPtyManager.spawnCliProcess).not.toBe(DemoCliManager.prototype.spawnCliProcess);
  });
});
