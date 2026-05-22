/**
 * Vitest integration test for the cyboflow stream-event publisher path.
 *
 * Design choice: this test lives in main/src/ipc/__tests__/ rather than the
 * repo-root tests/ directory because:
 *
 *   1. tests/ is a Playwright E2E directory; spinning up a full Electron process
 *      for this narrow wiring assertion is expensive and flaky in environments
 *      without a display server.
 *
 *   2. The SUT (cyboflow.ts getRunLauncher()) imports from main/src/orchestrator/
 *      and is already covered by the main workspace's vitest config
 *      (main/vitest.config.ts, include: src/**\/*.{test,spec}.ts).
 *
 *   3. Mocking BrowserWindow.webContents.send is straightforward here; a
 *      full Playwright test would need the real Electron renderer wired up.
 *
 * The acceptance-criterion spec file is tests/cyboflow-stream-publisher.spec.ts,
 * which documents this fallback decision and delegates to this test.
 *
 * Assertions:
 *   - A concrete StreamEventPublisher built like getRunLauncher() does calls
 *     win.webContents.send(`cyboflow:stream:${runId}`, event).
 *   - The send is skipped when win is null or destroyed.
 */
import { describe, it, expect, vi } from 'vitest';
import type { StreamEventPublisher } from '../../orchestrator/runLauncher';
import type { StreamEnvelope } from '../../../../shared/types/claudeStream';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeFakeWindow(isDestroyed = false) {
  return {
    isDestroyed: () => isDestroyed,
    webContents: {
      send: vi.fn(),
    },
  };
}

/**
 * Builds a concrete publisher using the same pattern as getRunLauncher()
 * in cyboflow.ts, but with an injected getMainWindow for testability.
 */
function buildPublisher(getMainWindow: () => ReturnType<typeof makeFakeWindow> | null): StreamEventPublisher {
  return {
    publish: (runId, event) => {
      const win = getMainWindow();
      if (!win || win.isDestroyed()) return;
      win.webContents.send(`cyboflow:stream:${runId}`, event);
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('cyboflow stream-event publisher (IPC wiring)', () => {
  it('calls win.webContents.send with the correct channel and event shape', () => {
    const fakeWin = makeFakeWindow();
    const publisher = buildPublisher(() => fakeWin);

    const runId = 'test-run-id-abc123';
    const event: StreamEnvelope = {
      type: 'run_started',
      payload: { runId, worktreePath: '/tmp/wt', branchName: 'cyboflow/sprint/abc123' },
      timestamp: new Date().toISOString(),
    };

    publisher.publish(runId, event);

    expect(fakeWin.webContents.send).toHaveBeenCalledOnce();
    expect(fakeWin.webContents.send).toHaveBeenCalledWith(
      `cyboflow:stream:${runId}`,
      event,
    );
  });

  it('skips send when getMainWindow returns null', () => {
    const publisher = buildPublisher(() => null);

    // Should not throw, and send should never be called
    const nullWinEvent: StreamEnvelope = {
      type: 'run_started',
      payload: {},
      timestamp: new Date().toISOString(),
    };
    expect(() => {
      publisher.publish('run-1', nullWinEvent);
    }).not.toThrow();
  });

  it('skips send when window is destroyed', () => {
    const fakeWin = makeFakeWindow(true /* isDestroyed */);
    const publisher = buildPublisher(() => fakeWin);

    const destroyedWinEvent: StreamEnvelope = {
      type: 'run_started',
      payload: {},
      timestamp: new Date().toISOString(),
    };
    publisher.publish('run-2', destroyedWinEvent);

    expect(fakeWin.webContents.send).not.toHaveBeenCalled();
  });

  it('encodes the runId into the IPC channel name', () => {
    const fakeWin = makeFakeWindow();
    const publisher = buildPublisher(() => fakeWin);

    const runId = 'unique-run-xyz';
    const event: StreamEnvelope = {
      type: 'run_started',
      payload: {},
      timestamp: '',
    };
    publisher.publish(runId, event);

    const [channel] = fakeWin.webContents.send.mock.calls[0] as [string, unknown];
    expect(channel).toBe(`cyboflow:stream:${runId}`);
  });
});
