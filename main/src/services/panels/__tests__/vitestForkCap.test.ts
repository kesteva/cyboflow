import { describe, it, expect, vi } from 'vitest';
import { availableParallelism } from 'node:os';

import {
  scanVitestProcesses,
  reapOrphans,
  forkPoolOptions,
} from '../../../../../vitestForkCap';

/**
 * A `ps -Ao pid=,ppid=,command=` style dump. Each row is [pid, ppid, command];
 * `ps` pads the numeric columns, which the parser has to tolerate.
 */
const psDump =
  (...rows: Array<[number, number, string]>) =>
  () =>
    rows.map(([pid, ppid, cmd]) => `${String(pid).padStart(6)} ${String(ppid).padStart(6)} ${cmd}`).join('\n') + '\n';

/** A healthy gate: one root plus `workers` forks parented to it. */
function healthyGate(rootPid: number, workers: number): Array<[number, number, string]> {
  const rows: Array<[number, number, string]> = [[rootPid, 500, 'node (vitest)']];
  for (let i = 1; i <= workers; i += 1) {
    rows.push([rootPid + i, rootPid, `node (vitest ${i})`]);
  }
  return rows;
}

describe('scanVitestProcesses', () => {
  it('counts vitest roots and ignores their live pool workers', () => {
    const scan = scanVitestProcesses(psDump(...healthyGate(1000, 2), ...healthyGate(2000, 3)));
    expect(scan.gates).toBe(2);
    expect(scan.orphanPids).toEqual([]);
  });

  it('spots workers whose root has died, by ppid 1', () => {
    const scan = scanVitestProcesses(
      psDump(
        ...healthyGate(1000, 2),
        [19550, 1, 'node (vitest 2)'],
        [19555, 1, 'node (vitest 7)'],
      ),
    );
    expect(scan.gates).toBe(1);
    expect(scan.orphanPids).toEqual([19550, 19555]);
  });

  it('never treats a detached ROOT as an orphan — nohup reparents it legitimately', () => {
    // `nohup pnpm test:unit &` leaves the root at ppid 1. Reaping it would kill a
    // healthy run; only indexed worker titles may ever be orphans.
    const scan = scanVitestProcesses(psDump([9000, 1, 'node (vitest)'], [9001, 9000, 'node (vitest 1)']));
    expect(scan.gates).toBe(1);
    expect(scan.orphanPids).toEqual([]);
  });

  it('ignores unrelated processes and unparseable lines', () => {
    const scan = scanVitestProcesses(
      () => '  1234   1 /usr/bin/node ./server.js\ngarbage line\n\n   77   1 launchd\n',
    );
    expect(scan.gates).toBe(1);
    expect(scan.orphanPids).toEqual([]);
  });

  it('never reaps pid 1 itself', () => {
    const scan = scanVitestProcesses(psDump([1, 1, 'node (vitest 1)']));
    expect(scan.orphanPids).toEqual([]);
  });

  it('fails soft when ps is unavailable', () => {
    const scan = scanVitestProcesses(() => {
      throw new Error('ps: command not found');
    });
    expect(scan).toEqual({ gates: 1, orphanPids: [] });
  });
});

describe('reapOrphans', () => {
  it('kills every pid and reports the count', () => {
    const kill = vi.fn();
    expect(reapOrphans([10, 11, 12], kill)).toBe(3);
    expect(kill).toHaveBeenCalledTimes(3);
  });

  it('keeps going when one kill throws, counting only the accepted ones', () => {
    const kill = vi.fn((pid: number) => {
      if (pid === 11) throw new Error('ESRCH');
    });
    expect(reapOrphans([10, 11, 12], kill)).toBe(2);
    expect(kill).toHaveBeenCalledTimes(3);
  });
});

describe('forkPoolOptions', () => {
  const oneGate = psDump(...healthyGate(1000, 2));

  it('is empty for an unmanaged run, leaving vitest pool defaults untouched', () => {
    expect(forkPoolOptions({}, oneGate)).toEqual({});
  });

  it('pins the fork pool when an explicit cap is set', () => {
    expect(forkPoolOptions({ CYBOFLOW_TEST_MAX_FORKS: '4' }, oneGate)).toEqual({
      pool: 'forks',
      maxWorkers: 4,
    });
  });

  it('divides the box across concurrent gates when managed', () => {
    const cores = availableParallelism();
    const result = forkPoolOptions(
      { CYBOFLOW_MANAGED_TEST_CONCURRENCY: '1' },
      psDump(...[0, 1, 2, 3, 4].flatMap((i) => healthyGate(1000 + i * 100, 1))),
    );
    expect(result).toMatchObject({ pool: 'forks' });
    const { maxWorkers: maxForks } = result as { maxWorkers: number };
    expect(maxForks).toBe(Math.max(2, Math.min(cores - 1, Math.floor(cores / 5))));
    // The whole point: five concurrent gates must not each take the full box.
    expect(maxForks).toBeLessThanOrEqual(Math.max(2, cores - 1));
  });

  it('gives a lone managed gate the same width as an unmanaged one', () => {
    const cores = availableParallelism();
    const result = forkPoolOptions({ CYBOFLOW_MANAGED_TEST_CONCURRENCY: '1' }, oneGate);
    const { maxWorkers: maxForks } = result as { maxWorkers: number };
    expect(maxForks).toBe(Math.max(2, cores - 1));
  });

  it('reaps orphans under managed mode', () => {
    const kill = vi.fn();
    forkPoolOptions(
      { CYBOFLOW_MANAGED_TEST_CONCURRENCY: '1' },
      psDump(...healthyGate(1000, 1), [19550, 1, 'node (vitest 2)'], [19555, 1, 'node (vitest 7)']),
      kill,
    );
    expect(kill).toHaveBeenCalledTimes(2);
    expect(kill).toHaveBeenCalledWith(19550);
    expect(kill).toHaveBeenCalledWith(19555);
  });

  it('does NOT reap for a human terminal run', () => {
    const kill = vi.fn();
    forkPoolOptions({}, psDump([19550, 1, 'node (vitest 2)']), kill);
    expect(kill).not.toHaveBeenCalled();
  });

  it('reaps for a terminal run when explicitly asked', () => {
    const kill = vi.fn();
    forkPoolOptions({ CYBOFLOW_TEST_REAP_ORPHANS: '1' }, psDump([19550, 1, 'node (vitest 2)']), kill);
    expect(kill).toHaveBeenCalledWith(19550);
  });

  it('honours an explicit opt-out even under managed mode', () => {
    const kill = vi.fn();
    forkPoolOptions(
      { CYBOFLOW_MANAGED_TEST_CONCURRENCY: '1', CYBOFLOW_TEST_REAP_ORPHANS: '0' },
      psDump(...healthyGate(1000, 1), [19550, 1, 'node (vitest 2)']),
      kill,
    );
    expect(kill).not.toHaveBeenCalled();
  });

  it('counts UNREAPABLE orphans against the cap — the blind spot that caused this', () => {
    const cores = availableParallelism();
    const orphans = 2;
    const rows: Array<[number, number, string]> = [
      ...healthyGate(1000, 1),
      [19550, 1, 'node (vitest 2)'],
      [19555, 1, 'node (vitest 7)'],
    ];
    // Every kill fails, so both orphans survive and must be treated as cores gone.
    const result = forkPoolOptions(
      { CYBOFLOW_MANAGED_TEST_CONCURRENCY: '1' },
      psDump(...rows),
      () => {
        throw new Error('EPERM');
      },
    );
    const { maxWorkers: maxForks } = result as { maxWorkers: number };
    const effective = Math.max(1, cores - orphans);
    expect(maxForks).toBe(Math.max(2, Math.min(Math.max(1, effective - 1), Math.floor(effective / 1))));
    // And it must be strictly tighter than the same gate on an orphan-free box,
    // whenever the box is big enough for the floor not to swallow the difference.
    const clean = forkPoolOptions({ CYBOFLOW_MANAGED_TEST_CONCURRENCY: '1' }, psDump(...healthyGate(1000, 1)));
    const cleanForks = (clean as { maxWorkers: number }).maxWorkers;
    if (cleanForks > 2) expect(maxForks).toBeLessThan(cleanForks);
  });

  it('successfully reaped orphans do NOT also shrink the cap', () => {
    const result = forkPoolOptions(
      { CYBOFLOW_MANAGED_TEST_CONCURRENCY: '1' },
      psDump(...healthyGate(1000, 1), [19550, 1, 'node (vitest 2)']),
      vi.fn(),
    );
    const clean = forkPoolOptions({ CYBOFLOW_MANAGED_TEST_CONCURRENCY: '1' }, psDump(...healthyGate(1000, 1)));
    expect(result).toEqual(clean);
  });
});
