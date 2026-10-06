import { afterAll, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import {
  CliManagerFactory,
  isCodexPtyManagerLike,
  isCodexSdkManagerLike,
  isOmpPtyManagerLike,
  isOmpSdkManagerLike,
} from '../cliManagerFactory';
import type { ConfigManager } from '../configManager';
import type { SessionManager } from '../sessionManager';
import { DemoCliManager } from '../demo/demoCliManager';
import { CodexPtyManager } from '../panels/codex/codexPtyManager';
import { CodexSdkManager } from '../panels/codex/codexSdkManager';
import { OmpPtyManager } from '../panels/omp/ompPtyManager';
import { OmpSdkManager } from '../panels/omp/ompSdkManager';

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

  it('satisfies the Codex seam contract in demo mode without becoming a Codex manager', async () => {
    const demoSdkManager = await factory.createManager('codex-sdk', {
      sessionManager,
      additionalOptions: { db },
    });
    // Mirrors boot: codex-pty omits db and reuses the handle captured above.
    const demoPtyManager = await factory.createManager('codex-pty', {
      sessionManager,
    });

    // Boot's narrowing is structural, so this — not `instanceof` — is what has to
    // hold. The demo manager stays an honest DemoCliManager rather than an object
    // grafted onto the real Codex prototype (which left every un-stubbed method
    // resolving to the REAL implementation).
    expect(isCodexSdkManagerLike(demoSdkManager)).toBe(true);
    expect(isCodexPtyManagerLike(demoPtyManager)).toBe(true);
    expect(demoSdkManager).toBeInstanceOf(DemoCliManager);
    expect(demoPtyManager).toBeInstanceOf(DemoCliManager);
    expect(demoSdkManager).not.toBeInstanceOf(CodexSdkManager);
    expect(demoPtyManager).not.toBeInstanceOf(CodexPtyManager);
    expect(demoSdkManager.spawnCliProcess).toBe(DemoCliManager.prototype.spawnCliProcess);
    expect(demoPtyManager.spawnCliProcess).toBe(DemoCliManager.prototype.spawnCliProcess);
  });

  it('accepts collaborator injection but REFUSES the seams that need a real Codex runtime', async () => {
    const demoSdkManager = await factory.createManager('codex-sdk', {
      sessionManager,
      additionalOptions: { db },
    });
    if (!isCodexSdkManagerLike(demoSdkManager)) throw new Error('demo manager lost its seams');

    // Boot injects these unconditionally; they must no-op, not throw.
    expect(() =>
      demoSdkManager.setCyboflowMcpRuntimeConfig({
        orchSocketPath: '/tmp/fake.sock',
        bridgeScriptPath: '/tmp/bridge.js',
        nodeExecutablePath: '/usr/bin/node',
      }),
    ).not.toThrow();
    expect(() => demoSdkManager.setApprovalRouterProvider(() => { throw new Error('unused'); })).not.toThrow();
    expect(() => demoSdkManager.setQuestionRouterProvider(() => { throw new Error('unused'); })).not.toThrow();

    // A probe or catalogue fetch can only be answered by the vendor binary, so
    // demo mode refuses loudly instead of reaching for it.
    await expect(demoSdkManager.getCodexModelCatalog()).rejects.toThrow(/unavailable in demo mode/);
    await expect(demoSdkManager.detectChatGptAccount()).rejects.toThrow(/unavailable in demo mode/);
  });

  it('satisfies the OMP seam contract in demo mode without becoming an OMP manager', async () => {
    const demoSdkManager = await factory.createManager('omp-sdk', {
      sessionManager,
      additionalOptions: { db },
    });
    // Mirrors boot: omp-pty omits db and reuses the handle captured above.
    const demoPtyManager = await factory.createManager('omp-pty', {
      sessionManager,
    });

    expect(isOmpSdkManagerLike(demoSdkManager)).toBe(true);
    expect(isOmpPtyManagerLike(demoPtyManager)).toBe(true);
    expect(demoSdkManager).toBeInstanceOf(DemoCliManager);
    expect(demoPtyManager).toBeInstanceOf(DemoCliManager);
    expect(demoSdkManager).not.toBeInstanceOf(OmpSdkManager);
    expect(demoPtyManager).not.toBeInstanceOf(OmpPtyManager);
    expect(demoSdkManager.spawnCliProcess).toBe(DemoCliManager.prototype.spawnCliProcess);
    expect(demoPtyManager.spawnCliProcess).toBe(DemoCliManager.prototype.spawnCliProcess);
  });

  it('accepts OMP collaborator injection but REFUSES the catalogue probe in demo mode', async () => {
    const demoSdkManager = await factory.createManager('omp-sdk', {
      sessionManager,
      additionalOptions: { db },
    });
    if (!isOmpSdkManagerLike(demoSdkManager)) throw new Error('demo manager lost its seams');

    expect(() =>
      demoSdkManager.setCyboflowMcpRuntimeConfig({
        orchSocketPath: '/tmp/fake.sock',
        bridgeScriptPath: '/tmp/bridge.js',
        nodeExecutablePath: '/usr/bin/node',
      }),
    ).not.toThrow();

    // The catalogue can only come from a real `omp` binary, so demo refuses
    // loudly rather than spawning the vendor CLI behind a canned session.
    await expect(demoSdkManager.getOmpModelCatalog()).rejects.toThrow(/unavailable in demo mode/);
  });

  it('returns the real Codex and OMP managers outside demo mode', async () => {
    demoMode = false;
    const normalSdkManager = await factory.createManager('codex-sdk', {
      sessionManager,
      additionalOptions: { db },
    });
    const normalPtyManager = await factory.createManager('codex-pty', {
      sessionManager,
    });
    const normalOmpSdkManager = await factory.createManager('omp-sdk', {
      sessionManager,
      additionalOptions: { db },
    });
    const normalOmpPtyManager = await factory.createManager('omp-pty', {
      sessionManager,
    });

    expect(normalSdkManager).toBeInstanceOf(CodexSdkManager);
    expect(normalPtyManager).toBeInstanceOf(CodexPtyManager);
    expect(normalOmpSdkManager).toBeInstanceOf(OmpSdkManager);
    expect(normalOmpPtyManager).toBeInstanceOf(OmpPtyManager);
    // The real managers satisfy the same contract boot narrows against.
    expect(isCodexSdkManagerLike(normalSdkManager)).toBe(true);
    expect(isCodexPtyManagerLike(normalPtyManager)).toBe(true);
    expect(isOmpSdkManagerLike(normalOmpSdkManager)).toBe(true);
    expect(isOmpPtyManagerLike(normalOmpPtyManager)).toBe(true);
    expect(normalSdkManager.spawnCliProcess).not.toBe(DemoCliManager.prototype.spawnCliProcess);
    expect(normalPtyManager.spawnCliProcess).not.toBe(DemoCliManager.prototype.spawnCliProcess);
    expect(normalOmpSdkManager.spawnCliProcess).not.toBe(DemoCliManager.prototype.spawnCliProcess);
    expect(normalOmpPtyManager.spawnCliProcess).not.toBe(DemoCliManager.prototype.spawnCliProcess);
  });
});
