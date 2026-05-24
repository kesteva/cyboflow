/**
 * Unit tests for registerCyboflowHandlers (main/src/ipc/cyboflow.ts).
 *
 * Behaviors covered:
 *
 * AC for approveRun stub:
 *   - cyboflow:approveRun always returns { success: false, error: /NOT_IMPLEMENTED/ }
 *
 * The four channels that were previously tested here have been migrated to the
 * tRPC transport; their raw-IPC tests were deleted in TASK-716:
 *   cyboflow:listWorkflows, cyboflow:listRuns, cyboflow:startRun, cyboflow:mcp-health
 */
import { describe, it, expect } from 'vitest';
import type { AppServices } from '../types';
import { registerCyboflowHandlers } from '../cyboflow';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Capture handlers registered via ipcMain.handle so they can be invoked
 * directly in tests, bypassing the real Electron IPC stack.
 */
function makeHandlerCapture() {
  const handlers = new Map<string, (...args: unknown[]) => Promise<unknown>>();
  const ipcMain = {
    handle: (channel: string, fn: (...args: unknown[]) => Promise<unknown>) => {
      handlers.set(channel, fn);
    },
  };
  return { ipcMain, handlers };
}

/** Invoke a captured handler with a fake IpcMainInvokeEvent + args. */
async function invoke(
  handlers: Map<string, (...args: unknown[]) => Promise<unknown>>,
  channel: string,
  args: unknown,
): Promise<unknown> {
  const fn = handlers.get(channel);
  if (!fn) throw new Error(`No handler registered for channel: ${channel}`);
  // ipcMain.handle callbacks receive (event, ...args) — we pass a stub event.
  return fn({} as unknown, args);
}

/** Minimal AppServices stub — approveRun handler uses none of the services. */
function makeServices(): AppServices {
  return {} as unknown as AppServices;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('registerCyboflowHandlers — cyboflow:approveRun', () => {
  it('registers a handler for the channel', () => {
    const { ipcMain, handlers } = makeHandlerCapture();
    registerCyboflowHandlers(
      ipcMain as unknown as Parameters<typeof registerCyboflowHandlers>[0],
      makeServices(),
    );
    expect(handlers.has('cyboflow:approveRun')).toBe(true);
  });

  it('returns success: false with a NOT_IMPLEMENTED error message', async () => {
    const { ipcMain, handlers } = makeHandlerCapture();
    registerCyboflowHandlers(
      ipcMain as unknown as Parameters<typeof registerCyboflowHandlers>[0],
      makeServices(),
    );

    const result = await invoke(handlers, 'cyboflow:approveRun', {
      runId: 'any-run',
      approvalId: 'any-approval',
      decision: 'allow',
    }) as { success: boolean; error?: string };

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/NOT_IMPLEMENTED/i);
  });

  it('returns NOT_IMPLEMENTED for deny decision as well', async () => {
    const { ipcMain, handlers } = makeHandlerCapture();
    registerCyboflowHandlers(
      ipcMain as unknown as Parameters<typeof registerCyboflowHandlers>[0],
      makeServices(),
    );

    const result = await invoke(handlers, 'cyboflow:approveRun', {
      runId: 'any-run',
      approvalId: 'any-approval',
      decision: 'deny',
    }) as { success: boolean; error?: string };

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/NOT_IMPLEMENTED/i);
  });
});
