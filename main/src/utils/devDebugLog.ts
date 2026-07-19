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

// ---------------------------------------------------------------------------
// Buffered async writer (F16)
//
// appendDevDebugLog previously did a synchronous `fs.appendFileSync` per console
// call — on a busy backend that blocks the main thread on disk I/O for EVERY log
// line. Mirror the pattern in utils/logger.ts: one lazily opened fs.WriteStream
// per log file with an ordered in-memory queue, so writes are async and never
// block the main thread while strict line order is preserved. The
// truncate-on-launch reset stays in index.ts (it runs at module load, before any
// write here), and the stream opens in append mode so it never clobbers it.
// ---------------------------------------------------------------------------

interface DevLogWriter {
  stream: fs.WriteStream | null;
  queue: string[];
  processing: boolean;
  /** Resolvers waiting for this writer's queue + stream buffer to fully drain. */
  flushWaiters: Array<() => void>;
}

const writers: Record<DevLogStream, DevLogWriter> = {
  frontend: { stream: null, queue: [], processing: false, flushWaiters: [] },
  backend: { stream: null, queue: [], processing: false, flushWaiters: [] },
};

// The ORIGINAL console.error, captured from the first call that supplies it.
// Async stream errors (which can arrive after appendDevDebugLog has returned)
// are reported through this — never through the live `console.error`, which the
// index.ts wrapper has overridden to call back into appendDevDebugLog (recursion).
let errorReporter: ((...args: unknown[]) => void) | null = null;

function reportError(message: string, error: unknown): void {
  if (!errorReporter) return;
  try {
    errorReporter(message, error);
  } catch {
    // console itself is broken — nothing safe to do
  }
}

function ensureStream(streamKey: DevLogStream): fs.WriteStream | null {
  const w = writers[streamKey];
  if (w.stream) return w.stream;
  try {
    const s = fs.createWriteStream(getDevDebugLogPath(streamKey), { flags: 'a' });
    // An async stream error (e.g. EPIPE / ENOSPC) with no listener is re-thrown
    // as an uncaughtException. Attach one: drop the stream so the next write
    // lazily reopens, and report once via the original console.
    s.on('error', (err) => {
      w.stream = null;
      reportError(`[devDebugLog] ${streamKey} debug log write error:`, err);
    });
    w.stream = s;
    return s;
  } catch (err) {
    reportError(`[devDebugLog] failed to open ${streamKey} debug log:`, err);
    return null;
  }
}

function resolveFlushWaiters(w: DevLogWriter): void {
  if (w.flushWaiters.length === 0) return;
  const waiters = w.flushWaiters;
  w.flushWaiters = [];
  for (const resolve of waiters) resolve();
}

function processQueue(streamKey: DevLogStream): void {
  const w = writers[streamKey];
  if (w.processing) return;
  w.processing = true;

  const processNext = (): void => {
    if (w.queue.length === 0) {
      w.processing = false;
      // Reached only after the last line's write callback fired, so all queued
      // lines have been handed to the OS — safe to release flush waiters.
      resolveFlushWaiters(w);
      return;
    }

    const stream = ensureStream(streamKey);
    if (!stream) {
      // Could not open the log file — drop the backlog rather than grow it
      // unbounded or hang a pending flush.
      w.queue.length = 0;
      w.processing = false;
      resolveFlushWaiters(w);
      return;
    }

    const line = w.queue.shift() as string;
    stream.write(line, (err) => {
      if (err) {
        reportError(`[devDebugLog] ${streamKey} debug log write failed:`, err);
      }
      processNext();
    });
  };

  processNext();
}

/**
 * Appends one formatted line to the appropriate dev-mode debug log.
 * Format: `[<ISO timestamp>] [<SOURCE> <LEVEL>] <message>\n`
 * (matches the format the AI assistant reads in `pnpm dev`).
 *
 * The write is buffered onto a per-file ordered queue and flushed asynchronously
 * via an fs.WriteStream, so it never blocks the main thread. Failures are
 * swallowed (dev-only debug output) and reported via the passed originalConsole
 * to avoid the console-override recursion the index.ts wrapper guards against.
 */
export function appendDevDebugLog(
  stream: DevLogStream,
  level: DevLogLevel,
  source: string,
  message: string,
  originalConsole?: { error?: (...args: unknown[]) => void }
): void {
  if (originalConsole?.error) {
    errorReporter = originalConsole.error;
  }
  const timestamp = new Date().toISOString();
  const line = `[${timestamp}] [${source.toUpperCase()} ${level.toUpperCase()}] ${message}\n`;
  writers[stream].queue.push(line);
  processQueue(stream);
}

/**
 * Resolves once every buffered dev-log line has been flushed to disk. Await this
 * in the app quit path so pending lines land before exit. A no-op (resolves
 * immediately) when nothing is buffered — i.e. always in production, where these
 * helpers are never called.
 */
export function flushDevDebugLogs(): Promise<void> {
  const flushOne = (streamKey: DevLogStream): Promise<void> => {
    const w = writers[streamKey];
    if (!w.processing && w.queue.length === 0) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      w.flushWaiters.push(resolve);
    });
  };
  return Promise.all([flushOne('frontend'), flushOne('backend')]).then(() => undefined);
}

/**
 * Test-only: reset all writer state (streams, queues, captured error reporter)
 * so each vitest case starts from a clean slate. Not used in production.
 */
export function __resetDevDebugWritersForTests(): void {
  for (const key of Object.keys(writers) as DevLogStream[]) {
    const w = writers[key];
    w.stream = null;
    w.queue = [];
    w.processing = false;
    w.flushWaiters = [];
  }
  errorReporter = null;
}
