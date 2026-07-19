import { ipcMain } from 'electron';
import { SessionManager } from '../services/sessionManager';
import { mainWindow } from '../index';

interface LogEntry {
  timestamp: string;
  level: 'info' | 'warn' | 'error' | 'debug';
  message: string;
  source?: string;
}

// Store logs per session in memory
const sessionLogs = new Map<string, LogEntry[]>();

// Budgets bounding the per-session in-memory buffer for the life of a run — a
// long-lived run emitting output continuously must not grow this Map without
// bound. Both are enforced together (oldest-first trim) so a burst of many
// small lines and a handful of huge lines are each capped independently.
const MAX_LOG_ENTRIES = 2000;
const MAX_LOG_BYTES = 2 * 1024 * 1024; // 2 MiB, tracked over entry.message length

/**
 * Append an entry to a session's log buffer, trimming the oldest entries
 * whenever the entry-count cap or cumulative message-byte cap is exceeded.
 * Most-recent entries always survive; both budgets are enforced together.
 */
function appendLogEntry(logs: LogEntry[], entry: LogEntry): LogEntry[] {
  logs.push(entry);

  // Drop the oldest entries first for the count cap...
  let start = Math.max(0, logs.length - MAX_LOG_ENTRIES);

  // ...then keep dropping from the (already count-trimmed) front until the
  // cumulative message-byte budget is satisfied too.
  let totalBytes = 0;
  for (let i = start; i < logs.length; i++) totalBytes += logs[i].message.length;
  while (totalBytes > MAX_LOG_BYTES && start < logs.length) {
    totalBytes -= logs[start].message.length;
    start++;
  }

  return start > 0 ? logs.slice(start) : logs;
}

export function setupLogHandlers(sessionManager: SessionManager) {
  // Get logs for a session
  ipcMain.handle('sessions:get-logs', async (_event, sessionId: string) => {
    try {
      const logs = sessionLogs.get(sessionId) || [];
      return { success: true, data: logs };
    } catch (error) {
      console.error('Failed to get logs:', error);
      return { 
        success: false, 
        error: error instanceof Error ? error.message : 'Failed to get logs' 
      };
    }
  });

  // Clear logs for a session
  ipcMain.handle('sessions:clear-logs', async (_event, sessionId: string) => {
    try {
      sessionLogs.set(sessionId, []);
      return { success: true };
    } catch (error) {
      console.error('Failed to clear logs:', error);
      return { 
        success: false, 
        error: error instanceof Error ? error.message : 'Failed to clear logs' 
      };
    }
  });

  // Add a log entry
  ipcMain.handle('sessions:add-log', async (_event, sessionId: string, entry: LogEntry) => {
    try {
      const logs = sessionLogs.get(sessionId) || [];
      sessionLogs.set(sessionId, appendLogEntry(logs, entry));

      // Send the log entry to the renderer
      if (mainWindow) {
        mainWindow.webContents.send('session-log', {
          sessionId,
          entry
        });
      }
      
      return { success: true };
    } catch (error) {
      console.error('Failed to add log:', error);
      return { 
        success: false, 
        error: error instanceof Error ? error.message : 'Failed to add log' 
      };
    }
  });
}

// Helper function to add a log from internal sources
export function addSessionLog(sessionId: string, level: LogEntry['level'], message: string, source?: string) {
  const entry: LogEntry = {
    timestamp: new Date().toISOString(),
    level,
    message,
    source
  };
  
  const logs = sessionLogs.get(sessionId) || [];
  sessionLogs.set(sessionId, appendLogEntry(logs, entry));

  // Send the log entry to the renderer
  if (mainWindow) {
    mainWindow.webContents.send('session-log', {
      sessionId,
      entry
    });
  }
}

// Helper to clean up logs when a session is deleted or when starting a new run
export function cleanupSessionLogs(sessionId: string) {
  sessionLogs.delete(sessionId);
  
  // Notify the frontend to clear logs
  if (mainWindow) {
    mainWindow.webContents.send('session-logs-cleared', { sessionId });
  }
}