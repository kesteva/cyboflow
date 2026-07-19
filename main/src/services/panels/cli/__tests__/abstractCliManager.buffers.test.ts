/**
 * F7 — Bounded PTY buffers in AbstractCliManager.setupProcessHandlers.
 *
 * Drives setupProcessHandlers against a fake IPty (fireData/fireExit driver,
 * mirroring the FakePty pattern used by interactiveClaudeManager.test.ts) so
 * these are pure unit tests with zero real process spawn.
 *
 * Coverage:
 *  - the `lastOutput` diagnostic tail keeps the most recent bytes across
 *    onData calls (regression guard for a truncation that dropped the tail
 *    instead of the head).
 *  - `substring(-500)` -> `slice(-500)`: a negative-index `substring` clamps
 *    to 0 and returns the WHOLE string; `slice` returns the true last-500
 *    tail. Both handleProcessStartupFailure's sibling message and
 *    handleProcessRuntimeFailure exercise this.
 *  - the incomplete-line `buffer` still splits + emits every complete line
 *    correctly during a burst that also contains a huge trailing partial
 *    line (cap must not corrupt already-split lines).
 *  - a pathological newline-free stream (or one giant unterminated line)
 *    exceeding the 1MB line-buffer cap is truncated to a bounded tail
 *    instead of growing without bound, and a verbose log fires once the cap
 *    trips.
 */

import { describe, it, expect, vi } from 'vitest';
import { AbstractCliManager } from '../AbstractCliManager';
import type { SessionManager } from '../../../sessionManager';
import type { Logger } from '../../../../utils/logger';
import type { ConversationMessage } from '../../../../database/models';
import type { IPty } from '@homebridge/node-pty-prebuilt-multiarch';

// ---------------------------------------------------------------------------
// Fake IPty — captures onData/onExit listeners; test drives them directly.
// ---------------------------------------------------------------------------

class FakePty {
  readonly pid = 0;
  private dataListeners: Array<(d: string) => void> = [];
  private exitListeners: Array<(e: { exitCode: number; signal?: number }) => void> = [];

  onData = (cb: (d: string) => void): { dispose(): void } => {
    this.dataListeners.push(cb);
    return { dispose: () => undefined };
  };

  onExit = (cb: (e: { exitCode: number; signal?: number }) => void): { dispose(): void } => {
    this.exitListeners.push(cb);
    return { dispose: () => undefined };
  };

  write(): void {
    /* no-op */
  }
  resize(): void {
    /* no-op */
  }
  kill(): void {
    /* no-op */
  }

  fireData(chunk: string): void {
    for (const cb of this.dataListeners) cb(chunk);
  }

  fireExit(exitCode: number): void {
    for (const cb of this.exitListeners) cb({ exitCode });
  }
}

// ---------------------------------------------------------------------------
// Minimal concrete subclass exposing setupProcessHandlers + recording every
// parseCliOutput call so tests can assert on exactly what reached parsing.
// ---------------------------------------------------------------------------

class TestCliManager extends AbstractCliManager {
  readonly parsedChunks: string[] = [];

  constructor(logger?: Logger) {
    super({} as unknown as SessionManager, logger, undefined);
  }

  protected getCliToolName(): string {
    return 'testcli';
  }
  protected async testCliAvailability(): Promise<{ available: boolean }> {
    return { available: true };
  }
  protected buildCommandArgs(): string[] {
    return [];
  }
  protected async getCliExecutablePath(): Promise<string> {
    return 'sh';
  }
  protected parseCliOutput(data: string): [] {
    this.parsedChunks.push(data);
    return [];
  }
  protected async initializeCliEnvironment(): Promise<{ [key: string]: string }> {
    return {};
  }
  protected async cleanupCliResources(): Promise<void> {
    return;
  }
  protected async getCliEnvironment(): Promise<{ [key: string]: string }> {
    return {};
  }
  async startPanel(): Promise<void> {
    return;
  }
  async continuePanel(
    _panelId: string,
    _sessionId: string,
    _worktreePath: string,
    _prompt: string,
    _conversationHistory: ConversationMessage[]
  ): Promise<void> {
    return;
  }
  async stopPanel(): Promise<void> {
    return;
  }
  async restartPanelWithHistory(): Promise<void> {
    return;
  }

  // ---- test-only bridge to the protected primitive under test ----
  driveHandlers(pty: FakePty, panelId = 'panel-1', sessionId = 'session-1'): void {
    this.setupProcessHandlers(pty as unknown as IPty, panelId, sessionId);
  }
}

function makeSpyLogger(): Logger {
  return {
    verbose: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } as unknown as Logger;
}

// Collects the 'json' 'output' events a TestCliManager emits (the shape
// handleProcessStartupFailure/handleProcessRuntimeFailure emit their error
// message through).
function collectJsonOutputs(mgr: TestCliManager): Array<{ status: string; message: string; details?: string }> {
  const collected: Array<{ status: string; message: string; details?: string }> = [];
  mgr.on('output', (evt: { type: string; data: unknown }) => {
    if (evt.type !== 'json') return;
    const payload = evt.data as { data?: { status: string; message: string; details?: string } };
    if (payload.data) collected.push(payload.data);
  });
  return collected;
}

describe('AbstractCliManager.setupProcessHandlers — lastOutput diagnostic tail', () => {
  it('keeps the trailing bytes (not the leading ones) across multiple onData chunks', () => {
    const logger = makeSpyLogger();
    const mgr = new TestCliManager(logger);
    const outputs = collectJsonOutputs(mgr);
    const pty = new FakePty();
    mgr.driveHandlers(pty);

    // Feed well past the 500-char tail the failure handler reads, across
    // several chunks, ending with a unique marker.
    pty.fireData('x'.repeat(9000));
    pty.fireData('END-MARKER');
    pty.fireExit(1); // hasReceivedOutput is true -> handleProcessRuntimeFailure

    expect(outputs).toHaveLength(1);
    const details = outputs[0].details ?? '';
    // The marker (fed last) must survive: proves the tail-keeping direction
    // of the bound is correct, not just that *some* 500 chars came through.
    expect(details.endsWith('END-MARKER')).toBe(true);
    expect(details).toContain('Last output:\n');
  });

  it('substring(-500) regression: the tail is the true last 500 chars, not the whole string', () => {
    const mgr = new TestCliManager();
    const outputs = collectJsonOutputs(mgr);
    const pty = new FakePty();
    mgr.driveHandlers(pty);

    const body = 'a'.repeat(700) + 'TAIL500'.padEnd(500, 'z');
    pty.fireData(body);
    pty.fireExit(1);

    const details = outputs[0].details ?? '';
    const expectedTail = body.slice(-500);
    expect(details).toBe(`Last output:\n${expectedTail}`);
    // Sanity: the old `substring(-500)` bug would have returned the FULL
    // ~1200-char body here instead of a 500-char tail.
    expect(expectedTail.length).toBe(500);
    expect(details.length).toBeLessThan(body.length);
  });
});

describe('AbstractCliManager.setupProcessHandlers — incomplete-line buffer', () => {
  it('still splits and emits every complete line correctly around a large trailing partial line', () => {
    const mgr = new TestCliManager();
    const pty = new FakePty();
    mgr.driveHandlers(pty);

    const bigPartial = 'y'.repeat(2000); // no trailing newline
    pty.fireData(`line-one\nline-two\n${bigPartial}`);

    // Both complete lines parsed immediately; the partial tail is not yet
    // flushed (no newline seen for it).
    expect(mgr.parsedChunks).toEqual(['line-one\n', 'line-two\n']);

    // Terminating the partial line flushes it as-is (under cap, so untouched).
    pty.fireData('\n');
    pty.fireExit(0);
    expect(mgr.parsedChunks).toContain(`${bigPartial}\n`);
  });

  it('caps a pathological newline-free stream to a bounded tail and logs once the cap trips', () => {
    const logger = makeSpyLogger();
    const mgr = new TestCliManager(logger);
    const pty = new FakePty();
    mgr.driveHandlers(pty);

    const CAP = 1024 * 1024; // mirrors AbstractCliManager's LINE_BUFFER_CAP_BYTES
    // Feed well past the cap with zero newlines, in chunks (as a real PTY
    // would deliver), ending with a unique marker.
    pty.fireData('q'.repeat(CAP));
    pty.fireData('q'.repeat(50_000));
    pty.fireData('TAIL-MARKER');
    pty.fireExit(0); // flushes the remaining buffer via parseCliOutput

    expect(logger.verbose).toHaveBeenCalled();
    const flushed = mgr.parsedChunks[mgr.parsedChunks.length - 1];
    // Bounded, not the ~1.05MB+ that was actually fed.
    expect(flushed.length).toBeLessThanOrEqual(CAP);
    // Kept the newest bytes (the marker), not the oldest.
    expect(flushed.endsWith('TAIL-MARKER')).toBe(true);
  });

  it('does not trip the cap or log for ordinary bounded traffic', () => {
    const logger = makeSpyLogger();
    const mgr = new TestCliManager(logger);
    const pty = new FakePty();
    mgr.driveHandlers(pty);

    pty.fireData('hello\nworld\n');
    pty.fireExit(0);

    expect(logger.verbose).not.toHaveBeenCalled();
    expect(mgr.parsedChunks).toEqual(['hello\n', 'world\n']);
  });
});
