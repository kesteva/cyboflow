/**
 * The remote-sync dev-build gate: the whole feature must be unreachable in a
 * release build, whatever config.json says.
 *
 * Pinned here:
 *   - isDevBuildFor: unpackaged or the packaged 'dev' variant only;
 *   - isDevBuild fails closed without an Electron `app` (plain Node / vitest);
 *   - ConfigManager.isRemoteSyncEnabled = isDevBuild && remoteSync.enabled, so a
 *     flag left on in config.json stays inert in a release build;
 *   - the config boundary rejects a remoteSync write in a release build, and in
 *     a dev build validates strictly and deep-merges;
 *   - RemoteSyncService and the tRPC surface report `{ available: false }` in a
 *     release build (no facade wired, or the gate closed);
 *   - main AppConfig / UpdateConfigRequest / frontend AppConfig share the shape.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import type { AppServices } from '../../../ipc/types';
import { createConfigOps } from '../../../ipc/configOps';
import type { ConfigOpsLike } from '../../../orchestrator/trpc/contracts/configOps';
import { ConfigManager } from '../../configManager';
import { setCyboflowDirectory } from '../../../utils/cyboflowDirectory';
import { _setDevBuildForTesting, isDevBuild, isDevBuildFor } from '../../../utils/buildChannel';
import { RemoteSyncService } from '../remoteSyncService';
import {
  _resetRemoteSyncFacadeForTesting,
  setRemoteSyncFacade,
} from '../../../orchestrator/remoteSyncBridge';
import { appRouter } from '../../../orchestrator/trpc/router';
import { createContext } from '../../../orchestrator/trpc/context';
import { DatabaseService } from '../../../database/database';
import { TaskChangeRouter } from '../../../orchestrator/taskChangeRouter';
import { dbAdapter } from '../../../orchestrator/__test_fixtures__/dbAdapter';
import type { AppConfig as MainAppConfig, UpdateConfigRequest } from '../../../types/config';
import type { AppConfig as FrontendAppConfig } from '../../../../../frontend/src/types/config';

// --- compile-time type parity across every layer that declares the shape -----
type MainField = MainAppConfig['remoteSync'];
type FrontendField = FrontendAppConfig['remoteSync'];
type UpdateField = UpdateConfigRequest['remoteSync'];

const remoteSyncParity: [MainField] extends [FrontendField]
  ? [FrontendField] extends [MainField]
    ? [MainField] extends [UpdateField]
      ? [UpdateField] extends [MainField]
        ? true
        : never
      : never
    : never
  : never = true;

// Cold-importing the whole appRouter can be slow under full-suite load.
const ROUTER_TIMEOUT_MS = 30_000;

function configOpsFor(manager: ConfigManager): ConfigOpsLike {
  return createConfigOps({
    configManager: manager,
    claudeCodeManager: {} as unknown as AppServices['claudeCodeManager'],
  });
}

// Closed in afterEach: Windows refuses to unlink an open sessions.db (EBUSY).
const openDatabases: DatabaseService[] = [];

/** A service over a fresh database, with no cloud sign-in composed. */
function serviceFor(manager: ConfigManager, dir: string): RemoteSyncService {
  const svc = new DatabaseService(path.join(dir, 'sessions.db'));
  svc.initialize();
  openDatabases.push(svc);
  const db = dbAdapter(svc.getDb());
  return new RemoteSyncService({ db, router: new TaskChangeRouter(db), configManager: manager, cloud: null });
}

async function readPersisted(dir: string): Promise<{ remoteSync?: unknown }> {
  return JSON.parse(await fs.readFile(path.join(dir, 'config.json'), 'utf8')) as { remoteSync?: unknown };
}

describe('isDevBuildFor', () => {
  it('is true for an unpackaged run and the packaged dev variant only', () => {
    expect(isDevBuildFor(false, 'stable')).toBe(true);
    expect(isDevBuildFor(false, 'dev')).toBe(true);
    expect(isDevBuildFor(true, 'dev')).toBe(true);
    expect(isDevBuildFor(true, 'stable')).toBe(false);
  });
});

describe('isDevBuild', () => {
  afterEach(() => _setDevBuildForTesting(undefined));

  it('fails closed when Electron app is unavailable', () => {
    expect(remoteSyncParity).toBe(true);
    expect(isDevBuild()).toBe(false);
  });

  it('honors the test override', () => {
    _setDevBuildForTesting(true);
    expect(isDevBuild()).toBe(true);
  });
});

describe('remote sync gate', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cyboflow-remote-sync-'));
    setCyboflowDirectory(tmpDir);
  });

  afterEach(async () => {
    _setDevBuildForTesting(undefined);
    _resetRemoteSyncFacadeForTesting();
    for (const svc of openDatabases.splice(0)) svc.close();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  async function managerWith(config: Record<string, unknown> | null): Promise<ConfigManager> {
    if (config) await fs.writeFile(path.join(tmpDir, 'config.json'), JSON.stringify(config));
    const manager = new ConfigManager();
    await manager.initialize();
    return manager;
  }

  describe('release build', () => {
    beforeEach(() => _setDevBuildForTesting(false));

    it('is unavailable and keeps a stored flag inert', async () => {
      const manager = await managerWith({ remoteSync: { enabled: true } });
      expect(manager.isRemoteSyncAvailable()).toBe(false);
      expect(manager.isRemoteSyncEnabled()).toBe(false);
    });

    it('rejects a remoteSync config write and persists nothing', async () => {
      const manager = await managerWith(null);
      const result = await configOpsFor(manager).updateConfig({ remoteSync: { enabled: true } });
      expect(result).toEqual({ success: false, error: 'Remote sync is not available in this build' });
      expect(manager.getConfig().remoteSync).toBeUndefined();
    });

    it('reports unavailable from the service even if a facade were wired', async () => {
      const manager = await managerWith({ remoteSync: { enabled: true } });
      expect(serviceFor(manager, tmpDir).getStatus()).toEqual({ available: false });
    });

    it('answers unavailable on the tRPC surface when no facade is wired', async () => {
      const caller = appRouter.createCaller(createContext());
      expect(await caller.cyboflow.remoteSync.getStatus()).toEqual({ available: false });
    }, ROUTER_TIMEOUT_MS);
  });

  describe('dev build', () => {
    beforeEach(() => _setDevBuildForTesting(true));

    it('is available, flag off by default, signed out', async () => {
      const manager = await managerWith(null);
      expect(manager.isRemoteSyncAvailable()).toBe(true);
      expect(manager.isRemoteSyncEnabled()).toBe(false);
      expect(serviceFor(manager, tmpDir).getStatus()).toEqual({
        available: true,
        enabled: false,
        cloudState: 'signed_out',
        device: null,
        serverOrigin: null,
        staging: false,
        signedIn: false,
        projects: [],
      });
    });

    it('turns on through the config boundary and persists sparsely', async () => {
      const manager = await managerWith(null);
      const ops = configOpsFor(manager);
      expect(await ops.updateConfig({ remoteSync: { enabled: true } })).toEqual({ success: true });
      expect(manager.isRemoteSyncEnabled()).toBe(true);
      expect((await readPersisted(tmpDir)).remoteSync).toEqual({ enabled: true });

      // null clears back to the floor, and an empty block is stored as absent.
      expect(await ops.updateConfig({ remoteSync: { enabled: null as unknown as boolean } })).toEqual({ success: true });
      expect(manager.isRemoteSyncEnabled()).toBe(false);
      expect((await readPersisted(tmpDir)).remoteSync).toBeUndefined();
    });

    it('rejects malformed payloads', async () => {
      const ops = configOpsFor(await managerWith(null));
      expect(await ops.updateConfig({ remoteSync: { enabled: 'true' as unknown as boolean } })).toEqual({
        success: false,
        error: 'Invalid remoteSync.enabled: expected a boolean',
      });
      expect(await ops.updateConfig({ remoteSync: { origin: 'x' } as unknown as { enabled: boolean } })).toEqual({
        success: false,
        error: 'Unknown remoteSync key: origin',
      });
    });

    it('serves the wired facade on the tRPC surface', async () => {
      const manager = await managerWith({ remoteSync: { enabled: true } });
      setRemoteSyncFacade(serviceFor(manager, tmpDir));
      const caller = appRouter.createCaller(createContext());
      expect(await caller.cyboflow.remoteSync.getStatus()).toMatchObject({ available: true, enabled: true });
    }, ROUTER_TIMEOUT_MS);

    it('validates the project-linking inputs and answers not ready while signed out', async () => {
      const manager = await managerWith({ remoteSync: { enabled: true } });
      setRemoteSyncFacade(serviceFor(manager, tmpDir));
      const caller = appRouter.createCaller(createContext());
      await expect(
        caller.cyboflow.remoteSync.enableProject({ projectId: 1, mode: 'join' } as unknown as { projectId: number; mode: 'create' }),
      ).rejects.toThrow();
      await expect(caller.cyboflow.remoteSync.enableProject({ projectId: 0, mode: 'create' })).rejects.toThrow();
      expect(await caller.cyboflow.remoteSync.enableProject({ projectId: 1, mode: 'create' })).toMatchObject({ ok: false, reason: 'not_ready' });
    }, ROUTER_TIMEOUT_MS);
  });
});
