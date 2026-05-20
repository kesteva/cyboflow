/**
 * Shared LoggerLike spy fixture.
 *
 * Exports makeSpyLogger() — a single canonical factory for all orchestrator
 * and IPC test files that need a LoggerLike test double.  Replaces the six
 * independent makeLogger / makeSilentLogger / makeFakeLogger / nullLogger
 * declarations that were previously scattered across test files.
 *
 * Standalone-typecheck invariant: this file must NOT import from
 * 'electron', 'better-sqlite3', or any concrete service in
 * main/src/services/*. Only primitive types and vitest are allowed.
 *
 * Sibling fixture pattern matches dbAdapter.ts in this directory.
 */
import { vi } from 'vitest';
import type { LoggerLike } from '../types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface LogCall {
  level: 'info' | 'warn' | 'error' | 'debug';
  message: string;
  ctx?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Returns a LoggerLike where:
 *   - Each method (info/warn/error/debug) is an individually spy-able vi.fn().
 *   - Every invocation also pushes { level, message, ctx } onto a shared
 *     `calls` array accessible on the returned object.
 *
 * Both assertion surfaces are available simultaneously:
 *   expect(logger.info).toHaveBeenCalledWith('some message', { key: 'val' });
 *   expect(logger.calls[0]).toEqual({ level: 'info', message: 'some message', ctx: { key: 'val' } });
 *
 * Spy logger — calls array is unused by the harness itself but available to
 * harness-extending tests.
 */
export function makeSpyLogger(): LoggerLike & { calls: LogCall[] } {
  const calls: LogCall[] = [];

  const info = vi.fn((message: string, ctx?: Record<string, unknown>) => {
    calls.push({ level: 'info', message, ...(ctx !== undefined ? { ctx } : {}) });
  });

  const warn = vi.fn((message: string, ctx?: Record<string, unknown>) => {
    calls.push({ level: 'warn', message, ...(ctx !== undefined ? { ctx } : {}) });
  });

  const error = vi.fn((message: string, ctx?: Record<string, unknown>) => {
    calls.push({ level: 'error', message, ...(ctx !== undefined ? { ctx } : {}) });
  });

  const debug = vi.fn((message: string, ctx?: Record<string, unknown>) => {
    calls.push({ level: 'debug', message, ...(ctx !== undefined ? { ctx } : {}) });
  });

  return { info, warn, error, debug, calls };
}
