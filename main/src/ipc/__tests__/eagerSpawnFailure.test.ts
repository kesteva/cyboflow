/**
 * Unit tests for reportEagerSpawnFailure — the pairing of the Sentry seam
 * report with the user-visible session error.
 *
 * The behaviour under test is the one the wild case (CYBOFLOW-APP-1E) exposed:
 * telemetry alone left the user with a blank terminal, so a report that does
 * not also reach the session is a half-fixed bug.
 */
import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';

const captureSeamError = vi.fn();
vi.mock('../../services/telemetry', () => ({
  captureSeamError: (...args: unknown[]) => captureSeamError(...args),
}));

import { reportEagerSpawnFailure, eagerSpawnFailureCopy } from '../eagerSpawnFailure';

function makeSurface(): { sessionManager: { addSessionError: Mock }; sessionId: string } {
  return { sessionManager: { addSessionError: vi.fn() }, sessionId: 'sess-001' };
}

describe('eagerSpawnFailureCopy', () => {
  it('names the fixable cause for a missing binary', () => {
    const { error, details } = eagerSpawnFailureCopy('binary-missing', 'claude', 'spawn claude ENOENT');
    expect(error).toBe('claude not found');
    expect(details).toContain('PATH');
    expect(details).toContain('Settings');
    // The raw message stays available locally — it is the only place it lands.
    expect(details).toContain('spawn claude ENOENT');
  });

  it('falls back to an honest generic for any other class', () => {
    const { error, details } = eagerSpawnFailureCopy('other', 'codex', 'something opaque');
    expect(error).toBe('codex failed to start');
    expect(details).toContain('try again');
    expect(details).toContain('something opaque');
  });
});

describe('reportEagerSpawnFailure', () => {
  beforeEach(() => {
    captureSeamError.mockClear();
  });

  it('reports the seam with a bounded message and classified tags', () => {
    const surface = makeSurface();
    reportEagerSpawnFailure(
      new Error('Claude Code (Interactive) not available: claude executable not found in PATH'),
      'interactive',
      'claude',
      surface,
    );

    expect(captureSeamError).toHaveBeenCalledTimes(1);
    const [seam, err, tags] = captureSeamError.mock.calls[0] as [string, Error, Record<string, string>];
    expect(seam).toBe('eager-pty-spawn-failed');
    // Fixed vocabulary only — the raw text must never become the exception message.
    expect(err.message).toBe('eager claude REPL spawn failed (binary-missing)');
    expect(err.message).not.toContain('executable not found');
    expect(tags).toEqual({ substrate: 'interactive', cliTool: 'claude', errorClass: 'binary-missing' });
  });

  it('adds the shape + digest fingerprint only when the class names no cause', () => {
    const surface = makeSurface();
    reportEagerSpawnFailure(new Error('the quick brown fox jumped'), 'interactive', 'claude', surface);

    const [, , tags] = captureSeamError.mock.calls[0] as [string, Error, Record<string, string>];
    expect(tags.errorClass).toBe('other');
    expect(tags.errorShape).toBe('one-line-short');
    expect(tags.errorDigest).toMatch(/^[0-9a-f]{8}$/);
  });

  it('tells the user, not just Sentry', () => {
    const surface = makeSurface();
    reportEagerSpawnFailure(new Error('spawn claude ENOENT'), 'interactive', 'claude', surface);

    expect(surface.sessionManager.addSessionError).toHaveBeenCalledWith(
      'sess-001',
      'claude not found',
      expect.stringContaining('spawn claude ENOENT'),
    );
  });

  it('accepts a non-Error rejection', () => {
    const surface = makeSurface();
    reportEagerSpawnFailure('spawn claude ENOENT', 'interactive', 'claude', surface);

    const [, err] = captureSeamError.mock.calls[0] as [string, Error];
    expect(err.message).toBe('eager claude REPL spawn failed (binary-missing)');
    expect(surface.sessionManager.addSessionError).toHaveBeenCalledTimes(1);
  });

  it('never lets a failing surface write replace the failure it is reporting', () => {
    // A workflow-run panel has no sessions row; the write can throw a FK error.
    const surface = makeSurface();
    surface.sessionManager.addSessionError.mockImplementation(() => {
      throw new Error('FOREIGN KEY constraint failed');
    });
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(() =>
      reportEagerSpawnFailure(new Error('spawn claude ENOENT'), 'interactive', 'claude', surface),
    ).not.toThrow();
    expect(captureSeamError).toHaveBeenCalledTimes(1);
    consoleError.mockRestore();
  });
});
