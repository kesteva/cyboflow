/**
 * Unit tests for the per-session log buffer bounds (main/src/ipc/logs.ts).
 *
 * Covered (F19):
 *  - Entry-count cap: pushing more than MAX_LOG_ENTRIES entries trims the
 *    oldest first; the most recent MAX_LOG_ENTRIES survive.
 *  - Byte cap: pushing entries whose cumulative message length exceeds
 *    MAX_LOG_BYTES trims the oldest first, even while well under the entry
 *    count cap.
 *  - Read/get API semantics are unchanged: 'sessions:get-logs' returns
 *    whatever survived trimming, most-recent last.
 *
 * electron and '../../index' (mainWindow) are stubbed per the established
 * pattern in ipc/__tests__/gitDestructiveHandlers.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
}));

vi.mock('../../index', () => ({ mainWindow: null }));

import { ipcMain } from 'electron';
import { setupLogHandlers, addSessionLog } from '../logs';
import type { SessionManager } from '../../services/sessionManager';

interface LogEntry {
  timestamp: string;
  level: 'info' | 'warn' | 'error' | 'debug';
  message: string;
  source?: string;
}

type Handler = (...args: unknown[]) => unknown;

function getHandler(channel: string): Handler {
  const calls = (ipcMain.handle as unknown as ReturnType<typeof vi.fn>).mock.calls as Array<
    [string, Handler]
  >;
  const entry = calls.find(([c]) => c === channel);
  if (!entry) throw new Error(`No handler registered for channel: ${channel}`);
  return entry[1];
}

async function getLogs(sessionId: string): Promise<LogEntry[]> {
  const result = (await getHandler('sessions:get-logs')({}, sessionId)) as {
    success: boolean;
    data: LogEntry[];
  };
  return result.data;
}

beforeEach(() => {
  (ipcMain.handle as unknown as ReturnType<typeof vi.fn>).mockClear();
  setupLogHandlers({} as unknown as SessionManager);
});

describe('session log buffer bounds', () => {
  it('trims oldest-first once the entry-count cap (2000) is exceeded, keeping the most recent', async () => {
    const sessionId = 'sess-count-cap';
    const MAX_LOG_ENTRIES = 2000;
    const overflow = 50;

    for (let i = 0; i < MAX_LOG_ENTRIES + overflow; i++) {
      addSessionLog(sessionId, 'info', `line-${i}`);
    }

    const logs = await getLogs(sessionId);
    expect(logs.length).toBe(MAX_LOG_ENTRIES);
    // The oldest `overflow` entries were dropped; the buffer starts at line-50...
    expect(logs[0].message).toBe(`line-${overflow}`);
    // ...and ends at the very last line pushed.
    expect(logs[logs.length - 1].message).toBe(`line-${MAX_LOG_ENTRIES + overflow - 1}`);
  });

  it('trims oldest-first once the cumulative byte budget (2 MiB) is exceeded, well under the entry-count cap', async () => {
    const sessionId = 'sess-byte-cap';
    const MAX_LOG_BYTES = 2 * 1024 * 1024;
    const chunkSize = 100 * 1024; // 100 KiB per entry — far fewer than 2000 entries needed to trip the byte cap
    const chunk = 'x'.repeat(chunkSize);

    // 30 entries * 100 KiB = ~3 MiB, comfortably over the 2 MiB budget while
    // staying at 30 entries — nowhere near the 2000-entry cap.
    const entryCount = 30;
    for (let i = 0; i < entryCount; i++) {
      addSessionLog(sessionId, 'info', `${chunk}-${i}`);
    }

    const logs = await getLogs(sessionId);
    expect(logs.length).toBeLessThan(entryCount);

    const totalBytes = logs.reduce((sum, e) => sum + e.message.length, 0);
    expect(totalBytes).toBeLessThanOrEqual(MAX_LOG_BYTES);

    // Most recent entry always survives.
    expect(logs[logs.length - 1].message.endsWith(`-${entryCount - 1}`)).toBe(true);
  });

  it('keeps everything when under both budgets (no spurious trimming)', async () => {
    const sessionId = 'sess-under-budget';
    for (let i = 0; i < 10; i++) {
      addSessionLog(sessionId, 'info', `small-${i}`);
    }

    const logs = await getLogs(sessionId);
    expect(logs.length).toBe(10);
    expect(logs.map((e) => e.message)).toEqual(
      Array.from({ length: 10 }, (_, i) => `small-${i}`),
    );
  });

  it('sessions:add-log IPC handler is also bounded by the same budgets', async () => {
    const sessionId = 'sess-ipc-add-log';
    const MAX_LOG_ENTRIES = 2000;
    const addLog = getHandler('sessions:add-log');

    for (let i = 0; i < MAX_LOG_ENTRIES + 10; i++) {
      const entry: LogEntry = { timestamp: new Date().toISOString(), level: 'info', message: `m-${i}` };
      await addLog({}, sessionId, entry);
    }

    const logs = await getLogs(sessionId);
    expect(logs.length).toBe(MAX_LOG_ENTRIES);
    expect(logs[0].message).toBe('m-10');
  });
});
