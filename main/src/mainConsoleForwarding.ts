/**
 * mainConsoleForwarding — the main-process console overrides, extracted from
 * index.ts's createWindow() (GitHub issue #19, the god-file split, step 24).
 * It replaces console.log / error / warn / info / debug so every line goes to
 * the file Logger (falling back to the saved original console methods when
 * there is none), to the dev-mode backend debug log, and — dev-only (F2) — to
 * the renderer over the 'main-log' channel. console.error keeps its
 * re-entrancy flag. The body is index.ts's verbatim, apart from its inputs
 * arriving as deps and two GETTERS, each read into a same-named local at the
 * exact point the original read the module binding:
 *
 *   getMainWindow → index.ts's `mainWindow`: MUST be lazy — the overrides
 *     outlive the call, and the window is nulled on 'closed' and reassigned by
 *     every later createWindow() (macOS 'activate').
 *   getLogger → index.ts's `logger`: assigned once in initializeServices()
 *     (which always precedes createWindow()), read lazily anyway to keep the
 *     original `if (logger)` fallback semantics exact.
 *
 * Passed by value: isDevelopment and the four saved console originals — module
 * consts in index.ts, captured at module load (before any override), so they
 * stay the true originals no matter how many times this re-installs.
 *
 * A SIBLING of index.ts on purpose (composition-root code; stays OUT of
 * main/src/orchestrator/**). No unit test, as there was none over
 * createWindow(); devDebugLog.ts carries its own suite.
 *
 * ORDER IS LOAD-BEARING at the call site: it is re-run by EVERY createWindow()
 * call, at the same point as before (after the renderer console-message
 * listener, before the render-process-gone listener).
 */

import type { BrowserWindow } from 'electron';
import { appendDevDebugLog, formatConsoleArgs } from './utils/devDebugLog';
import type { Logger } from './utils/logger';

export interface MainConsoleForwardingDeps {
  /** index.ts's live `mainWindow` binding. */
  getMainWindow: () => BrowserWindow | null;
  /** index.ts's live `logger` binding. */
  getLogger: () => Logger;
  isDevelopment: boolean;
  originalLog: typeof console.log;
  originalError: typeof console.error;
  originalWarn: typeof console.warn;
  originalInfo: typeof console.info;
}

export function installMainConsoleForwarding(deps: MainConsoleForwardingDeps): void {
  const { getMainWindow, getLogger, isDevelopment, originalLog, originalError, originalWarn, originalInfo } = deps;

  // Override console methods to forward to renderer and logger
  console.log = (...args: unknown[]) => {
    // Format the message
    const message = formatConsoleArgs(args);

    // Write to logger if available
    const logger = getLogger();
    if (logger) {
      logger.info(message);
    } else {
      originalLog.apply(console, args);
    }

    // In development, also write to backend debug log file
    if (isDevelopment) {
      appendDevDebugLog('backend', 'log', 'BACKEND', message, { error: originalError });
    }

    // Forward to renderer (dev-only). In production the renderer never mirrors
    // backend logs, so this IPC send + serialization would be pure overhead on
    // every log line — gate it on isDevelopment (F2).
    const mainWindow = getMainWindow();
    if (isDevelopment && mainWindow && !mainWindow.isDestroyed()) {
      try {
        mainWindow.webContents.send('main-log', 'log', message);
      } catch (e) {
        // If sending to renderer fails, use original console to avoid recursion
        originalLog('[Main] Failed to send log to renderer:', e);
      }
    }
  };

  console.error = (...args: unknown[]) => {
    // Prevent infinite recursion by checking if we're already in an error handler
    if ((console.error as typeof console.error & { __isHandlingError?: boolean }).__isHandlingError) {
      return originalError.apply(console, args);
    }
    
    (console.error as typeof console.error & { __isHandlingError?: boolean }).__isHandlingError = true;
    
    try {
      // If logger is not initialized or we're in the logger itself, use original console
      const logger = getLogger();
      if (!logger) {
        originalError.apply(console, args);
        return;
      }

      const message = formatConsoleArgs(args);

      // Extract Error object if present
      const errorObj = args.find(arg => arg instanceof Error) as Error | undefined;

      // Use logger but with recursion protection
      logger.error(message, errorObj);

      // In development, also write to backend debug log file
      if (isDevelopment) {
        appendDevDebugLog('backend', 'error', 'BACKEND', message, { error: originalError });
      }

      // Forward to renderer (dev-only, F2 — see console.log override above).
      const mainWindow = getMainWindow();
      if (isDevelopment && mainWindow && !mainWindow.isDestroyed()) {
        try {
          mainWindow.webContents.send('main-log', 'error', message);
        } catch (e) {
          // If sending to renderer fails, use original console to avoid recursion
          originalError('[Main] Failed to send error to renderer:', e);
        }
      }
    } catch (e) {
      // If anything fails in the error handler, fall back to original
      originalError.apply(console, args);
    } finally {
      (console.error as typeof console.error & { __isHandlingError?: boolean }).__isHandlingError = false;
    }
  };

  console.warn = (...args: unknown[]) => {
    const message = formatConsoleArgs(args);

    // Extract Error object if present for warnings too
    const errorObj = args.find(arg => arg instanceof Error) as Error | undefined;

    const logger = getLogger();
    if (logger) {
      logger.warn(message, errorObj);
    } else {
      originalWarn.apply(console, args);
    }

    // In development, also write to backend debug log file
    if (isDevelopment) {
      appendDevDebugLog('backend', 'warn', 'BACKEND', message, { error: originalError });
    }

    // Forward to renderer (dev-only, F2 — see console.log override above).
    const mainWindow = getMainWindow();
    if (isDevelopment && mainWindow && !mainWindow.isDestroyed()) {
      try {
        mainWindow.webContents.send('main-log', 'warn', message);
      } catch (e) {
        // If sending to renderer fails, use original console to avoid recursion
        originalWarn('[Main] Failed to send warning to renderer:', e);
      }
    }
  };

  console.info = (...args: unknown[]) => {
    const message = formatConsoleArgs(args);

    const logger = getLogger();
    if (logger) {
      logger.info(message);
    } else {
      originalInfo.apply(console, args);
    }

    // In development, also write to backend debug log file
    if (isDevelopment) {
      appendDevDebugLog('backend', 'info', 'BACKEND', message, { error: originalError });
    }

    // Forward to renderer (dev-only, F2 — see console.log override above).
    const mainWindow = getMainWindow();
    if (isDevelopment && mainWindow && !mainWindow.isDestroyed()) {
      try {
        mainWindow.webContents.send('main-log', 'info', message);
      } catch (e) {
        // If sending to renderer fails, use original console to avoid recursion
        originalInfo('[Main] Failed to send info to renderer:', e);
      }
    }
  };

  console.debug = (...args: unknown[]) => {
    const message = formatConsoleArgs(args);

    // In development, also write to backend debug log file
    if (isDevelopment) {
      appendDevDebugLog('backend', 'debug', 'BACKEND', message, { error: originalError });
    }

    // Forward to renderer (dev-only, F2 — see console.log override above).
    const mainWindow = getMainWindow();
    if (isDevelopment && mainWindow && !mainWindow.isDestroyed()) {
      try {
        mainWindow.webContents.send('main-log', 'debug', message);
      } catch (e) {
        // If sending to renderer fails, use original console to avoid recursion
        console.error('[Main] Failed to send debug to renderer:', e);
      }
    }
  };
}
