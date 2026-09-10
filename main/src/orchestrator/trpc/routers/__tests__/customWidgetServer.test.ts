/**
 * Unit tests for the cyboflow.customWidgetServer router
 * (docs/proposals/CUSTOM-VIEWS.md §5.4, §9 row S3) — the tRPC mutation pair
 * that replaces the plan's original "preload + ipcMain.handle" sketch (see
 * routers/customWidgetServer.ts's header for why: the legacy ipcMain.handle
 * surface is ratchet-frozen).
 */
import { describe, it, expect } from 'vitest';
import { appRouter } from '../../router';
import { createContext } from '../../context';
import type { CustomWidgetServerLike } from '../../context';

class FakeCustomWidgetServer implements CustomWidgetServerLike {
  ensureResult = { baseUrl: 'http://127.0.0.1:9999/tok', origin: 'http://127.0.0.1:9999' };
  stopResult = true;
  ensureCalls = 0;
  stopCalls = 0;

  async ensure(): Promise<{ baseUrl: string; origin: string }> {
    this.ensureCalls += 1;
    return this.ensureResult;
  }

  async stop(): Promise<boolean> {
    this.stopCalls += 1;
    return this.stopResult;
  }
}

describe('cyboflow.customWidgetServer precondition guard', () => {
  it('throws PRECONDITION_FAILED when the manager is unwired', async () => {
    const caller = appRouter.createCaller(createContext({}));
    await expect(caller.cyboflow.customWidgetServer.ensure()).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    await expect(caller.cyboflow.customWidgetServer.stop()).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
  });
});

describe('cyboflow.customWidgetServer', () => {
  it('ensure delegates to the manager and returns its result', async () => {
    const manager = new FakeCustomWidgetServer();
    const caller = appRouter.createCaller(createContext({ customWidgetServer: manager }));

    const result = await caller.cyboflow.customWidgetServer.ensure();
    expect(result).toEqual(manager.ensureResult);
    expect(manager.ensureCalls).toBe(1);
  });

  it('stop delegates to the manager and wraps the boolean as { stopped }', async () => {
    const manager = new FakeCustomWidgetServer();
    manager.stopResult = false;
    const caller = appRouter.createCaller(createContext({ customWidgetServer: manager }));

    const result = await caller.cyboflow.customWidgetServer.stop();
    expect(result).toEqual({ stopped: false });
    expect(manager.stopCalls).toBe(1);
  });
});
