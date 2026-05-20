/**
 * Dev-mode debug log helpers. In `pnpm dev` the main process appends
 * console output to `cyboflow-{frontend,backend}-debug.log` files at the
 * project root so the AI assistant can read them without asking the user
 * to paste console output. Production builds do not call these helpers.
 *
 * Centralizing here keeps the filename literals in exactly one site —
 * future rebrand or path changes touch one file instead of nine.
 */
import * as fs from 'fs';
import * as path from 'path';

export type DevLogStream = 'frontend' | 'backend';
export type DevLogLevel = 'log' | 'error' | 'warn' | 'info' | 'debug' | 'verbose';

const FILENAMES: Record<DevLogStream, string> = {
  frontend: 'cyboflow-frontend-debug.log',
  backend: 'cyboflow-backend-debug.log',
};

/**
 * Returns the absolute path to the dev-mode debug log for the given stream.
 * Resolves against process.cwd() to match the existing convention (logs land
 * in the project root regardless of where the Electron binary was launched).
 */
export function getDevDebugLogPath(stream: DevLogStream): string {
  return path.join(process.cwd(), FILENAMES[stream]);
}

/**
 * Formats an array of console arguments into a single string, suitable for
 * writing to a debug log. Object values are JSON-stringified; Error instances
 * are rendered as `Error: {message}\nStack: {stack}`; circular structures are
 * represented by a descriptive placeholder; all other values use String().
 */
export function formatConsoleArgs(args: unknown[]): string {
  return args
    .map((arg) => {
      if (typeof arg === 'object' && arg !== null) {
        if (arg instanceof Error) {
          return `Error: ${arg.message}\nStack: ${arg.stack}`;
        }
        try {
          return JSON.stringify(arg, null, 2);
        } catch {
          return `[Object with circular structure: ${(arg as Record<string, unknown>).constructor?.name || 'Object'}]`;
        }
      }
      return String(arg);
    })
    .join(' ');
}

/**
 * Appends one formatted line to the appropriate dev-mode debug log.
 * Format: `[<ISO timestamp>] [<SOURCE> <LEVEL>] <message>\n`
 * (matches the format the AI assistant reads in `pnpm dev`).
 *
 * Failures are swallowed and logged via originalConsole to avoid the
 * console-override recursion that the index.ts wrapper guards against.
 */
export function appendDevDebugLog(
  stream: DevLogStream,
  level: DevLogLevel,
  source: string,
  message: string,
  originalConsole?: { error?: (...args: unknown[]) => void }
): void {
  const timestamp = new Date().toISOString();
  const line = `[${timestamp}] [${source.toUpperCase()} ${level.toUpperCase()}] ${message}\n`;
  try {
    fs.appendFileSync(getDevDebugLogPath(stream), line);
  } catch (error) {
    if (originalConsole?.error) {
      originalConsole.error(`[devDebugLog] Failed to write to ${stream} debug log:`, error);
    }
  }
}
