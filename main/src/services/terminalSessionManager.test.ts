/**
 * TerminalSessionManager.killProcessTree unit tests.
 *
 * Exercises the SIGTERM -> poll -> SIGKILL flow and the cross-platform descendant
 * enumeration through the constructor-injected process-control seams (mirroring
 * codexBrokerReaper.ts's DI pattern) — no real `ps`/`process.kill`/`exec`, no real
 * subprocess ever spawned. Covers: the poll returns as soon as the process and its
 * group are dead (does NOT wait out the full grace window — regression guard for
 * the old unconditional 10s sleep), SIGKILL still fires once the grace window is
 * exhausted without the process dying, and `ps -axo pid=,ppid=` output is parsed +
 * walked into the correct descendant set (replacing the Linux-only `ps --ppid`
 * flag that silently found nothing on macOS).
 */
import { describe, it, expect, vi } from 'vitest';
import {
  TerminalSessionManager,
  parseProcessTable,
  collectDescendantPids,
  type ProcessTableRow,
  type TerminalSessionManagerOptions,
} from './terminalSessionManager';

/** Expose killProcessTree (private) for direct testing, as sibling tests in this repo do. */
interface TerminalSessionManagerPrivate {
  killProcessTree(pid: number): Promise<boolean>;
}

function makeManager(options: TerminalSessionManagerOptions): TerminalSessionManagerPrivate {
  return new TerminalSessionManager(options) as unknown as TerminalSessionManagerPrivate;
}

describe('parseProcessTable', () => {
  it('parses "pid ppid" rows, skipping blanks and malformed lines', () => {
    const out = ['  1   0', ' 320   1', '', 'garbage', '0 5', '  99   1  '].join('\n');
    expect(parseProcessTable(out)).toEqual([
      { pid: 1, ppid: 0 },
      { pid: 320, ppid: 1 },
      { pid: 99, ppid: 1 },
    ]);
  });
});

describe('collectDescendantPids', () => {
  const procs: ProcessTableRow[] = [
    { pid: 500, ppid: 1 },   // the session's shell (root)
    { pid: 501, ppid: 500 }, // direct child (e.g. a dev-server wrapper)
    { pid: 502, ppid: 501 }, // grandchild (e.g. the actual node process)
    { pid: 503, ppid: 502 }, // great-grandchild
    { pid: 999, ppid: 1 },   // unrelated process — must not be swept
  ];

  it('walks the ppid tree and collects every descendant, excluding the root and unrelated pids', () => {
    expect(collectDescendantPids(500, procs).sort((a, b) => a - b)).toEqual([501, 502, 503]);
  });

  it('never traverses or includes pid<=1', () => {
    const withInit: ProcessTableRow[] = [
      { pid: 1, ppid: 0 },
      { pid: 10, ppid: 1 },
    ];
    expect(collectDescendantPids(1, withInit)).toEqual([]);
  });

  it('is cycle-safe (a malformed ppid loop terminates)', () => {
    const cyclic: ProcessTableRow[] = [
      { pid: 10, ppid: 11 },
      { pid: 11, ppid: 10 },
    ];
    expect(collectDescendantPids(10, cyclic).sort((a, b) => a - b)).toEqual([11]);
  });

  it('returns an empty list for a root with no rows in the table', () => {
    expect(collectDescendantPids(999, [])).toEqual([]);
  });
});

describe('TerminalSessionManager killProcessTree — poll-until-dead', () => {
  it('returns early once the process and its group are dead, without waiting out the full grace window', async () => {
    let probeCalls = 0;
    // Alive for the first two probe calls, dead from the third on — models a
    // process that exits shortly after SIGTERM rather than lingering.
    const isPidAlive = vi.fn<(pid: number) => boolean>(() => {
      probeCalls += 1;
      return probeCalls <= 2;
    });
    const sendSignal = vi.fn<(pid: number, signal: NodeJS.Signals) => void>();

    const manager = makeManager({
      listProcessTable: () => Promise.resolve([]),
      isPidAlive,
      sendSignal,
      execCommand: () => Promise.resolve({ stdout: '' }),
      pollIntervalMs: 5,
      // A large grace window — if the poll regressed to waiting it out
      // unconditionally, this test would time out (vitest's default test
      // timeout is far below 60s) instead of completing quickly.
      graceMs: 60_000,
    });

    await manager.killProcessTree(4242);

    // Death was detected within the first couple of poll iterations, not by
    // exhausting the 60s grace bound.
    expect(probeCalls).toBeLessThanOrEqual(4);
    // SIGKILL still fires unconditionally afterward (fail-soft belt-and-braces).
    expect(sendSignal).toHaveBeenCalledWith(4242, 'SIGKILL');
  });

  it('sends SIGKILL to the pid and process group once the grace window is exhausted without exit', async () => {
    const isPidAlive = vi.fn<(pid: number) => boolean>(() => true); // never dies on its own
    const sendSignal = vi.fn<(pid: number, signal: NodeJS.Signals) => void>();
    const execCommand = vi.fn<(command: string) => Promise<{ stdout: string }>>(() =>
      Promise.resolve({ stdout: '' }),
    );
    const start = Date.now();

    const manager = makeManager({
      listProcessTable: () => Promise.resolve([]),
      isPidAlive,
      sendSignal,
      execCommand,
      pollIntervalMs: 10,
      graceMs: 50,
    });

    await manager.killProcessTree(4242);
    const elapsed = Date.now() - start;

    // The (short, test-scoped) grace window was genuinely waited out — the
    // while-loop's Date.now()-based deadline check guarantees this regardless
    // of poll-interval timer jitter, since isPidAlive never reports death.
    expect(elapsed).toBeGreaterThanOrEqual(50);
    expect(sendSignal).toHaveBeenCalledWith(4242, 'SIGTERM');
    expect(sendSignal).toHaveBeenCalledWith(4242, 'SIGKILL');
    expect(execCommand).toHaveBeenCalledWith(expect.stringContaining('kill -9 -4242'));
  });

  it('kills enumerated descendants individually via the injected process table', async () => {
    const execCommand = vi.fn<(command: string) => Promise<{ stdout: string }>>(() =>
      Promise.resolve({ stdout: '' }),
    );
    const procs: ProcessTableRow[] = [
      { pid: 4242, ppid: 1 },
      { pid: 4243, ppid: 4242 }, // descendant — must be individually SIGKILLed
    ];

    const manager = makeManager({
      listProcessTable: () => Promise.resolve(procs),
      isPidAlive: () => false, // dies immediately — no grace wait
      sendSignal: vi.fn(),
      execCommand,
      pollIntervalMs: 5,
      graceMs: 1000,
    });

    await manager.killProcessTree(4242);

    expect(execCommand).toHaveBeenCalledWith('kill -9 4243');
  });
});
