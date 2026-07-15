/**
 * PrototypeServerReaper (TASK-057) unit tests.
 *
 * These drive the reaper through its injected `listProcesses`/`killPid` seams —
 * no real `ps`/`process.kill` — so they assert the substring-matching + fail-soft
 * loop deterministically. The critical regressions covered: the empty-target
 * match-all footgun, and a per-PID kill failure not aborting the loop.
 */
import { describe, it, expect, vi } from 'vitest';
import { PrototypeServerReaper, type ProcessInfo } from './prototypeServerReaper';

/** Build a lister that returns a fixed process table. */
function fixedLister(rows: ProcessInfo[]): () => Promise<ProcessInfo[]> {
  return () => Promise.resolve(rows);
}

const RUNS_ROOT = '/Users/me/.cyboflow/artifacts/runs';

/** The command line a prototype server for `runId` would show in `ps`. */
function serverCommand(runId: string, port = 8123): string {
  return `python3 -m http.server ${port} --directory ${RUNS_ROOT}/${runId}/prototype`;
}

describe('PrototypeServerReaper', () => {
  describe('reapForRun', () => {
    it('kills ONLY http.server processes serving this run\'s prototype dir', async () => {
      const killPid = vi.fn<(pid: number) => void>();
      const rows: ProcessInfo[] = [
        { pid: 101, command: serverCommand('run-A') }, // match
        { pid: 102, command: serverCommand('run-B') }, // different run — leave
        { pid: 103, command: 'python3 -m http.server 9000 --directory /tmp/other' }, // http.server, wrong dir — leave
        { pid: 104, command: `vim ${RUNS_ROOT}/run-A/prototype/index.html` }, // right dir, not http.server — leave
      ];
      const reaper = new PrototypeServerReaper({ listProcesses: fixedLister(rows), killPid });

      await reaper.reapForRun(`${RUNS_ROOT}/run-A`);

      expect(killPid).toHaveBeenCalledTimes(1);
      expect(killPid).toHaveBeenCalledWith(101);
    });

    it('tolerates a trailing slash on the run artifacts dir', async () => {
      const killPid = vi.fn<(pid: number) => void>();
      const reaper = new PrototypeServerReaper({
        listProcesses: fixedLister([{ pid: 201, command: serverCommand('run-A') }]),
        killPid,
      });

      await reaper.reapForRun(`${RUNS_ROOT}/run-A/`);

      expect(killPid).toHaveBeenCalledWith(201);
    });

    it('kills NOTHING when the target dir is empty (match-all footgun guard)', async () => {
      const killPid = vi.fn<(pid: number) => void>();
      const rows: ProcessInfo[] = [
        { pid: 301, command: serverCommand('run-A') },
        { pid: 302, command: serverCommand('run-B') },
      ];
      const reaper = new PrototypeServerReaper({ listProcesses: fixedLister(rows), killPid });

      await reaper.reapForRun('');
      await reaper.reapForRun('   ');
      // @ts-expect-error — exercising the undefined guard at runtime.
      await reaper.reapForRun(undefined);

      expect(killPid).not.toHaveBeenCalled();
    });
  });

  describe('sweepOrphans', () => {
    it('kills all prototype servers under the runs root and leaves others', async () => {
      const killPid = vi.fn<(pid: number) => void>();
      const rows: ProcessInfo[] = [
        { pid: 401, command: serverCommand('run-A') }, // match
        { pid: 402, command: serverCommand('run-B') }, // match
        { pid: 403, command: 'python3 -m http.server 9000 --directory /elsewhere/prototype' }, // outside root — leave
        { pid: 404, command: `python3 -m http.server 9001 --directory ${RUNS_ROOT}/run-C/docs` }, // under root, not /prototype — leave
        { pid: 405, command: 'node server.js' }, // unrelated — leave
      ];
      const reaper = new PrototypeServerReaper({ listProcesses: fixedLister(rows), killPid });

      await reaper.sweepOrphans(RUNS_ROOT);

      expect(killPid).toHaveBeenCalledTimes(2);
      expect(killPid.mock.calls.map((c) => c[0]).sort()).toEqual([401, 402]);
    });

    it('spares a live run\'s server and kills a sibling whose run is not live', async () => {
      const killPid = vi.fn<(pid: number) => void>();
      const rows: ProcessInfo[] = [
        { pid: 701, command: serverCommand('run-live') }, // live → spared
        { pid: 702, command: serverCommand('run-dead') }, // not live → killed
      ];
      const reaper = new PrototypeServerReaper({ listProcesses: fixedLister(rows), killPid });

      await reaper.sweepOrphans(RUNS_ROOT, (runId) => runId === 'run-live');

      expect(killPid).toHaveBeenCalledTimes(1);
      expect(killPid).toHaveBeenCalledWith(702);
    });

    it('kills an unparseable-runId match even when the predicate says live (still an orphan)', async () => {
      const killPid = vi.fn<(pid: number) => void>();
      // The segment between `<root>/` and `/prototype` contains a slash, so no
      // single runId can be extracted — the defensive path falls through to kill
      // even though the predicate would spare everything.
      const rows: ProcessInfo[] = [
        { pid: 711, command: `python3 -m http.server 8100 --directory ${RUNS_ROOT}/nested/dir/prototype` },
      ];
      const reaper = new PrototypeServerReaper({ listProcesses: fixedLister(rows), killPid });

      await reaper.sweepOrphans(RUNS_ROOT, () => true);

      expect(killPid).toHaveBeenCalledWith(711);
    });

    it('kills NOTHING when the runs root is empty (match-all footgun guard)', async () => {
      const killPid = vi.fn<(pid: number) => void>();
      const reaper = new PrototypeServerReaper({
        listProcesses: fixedLister([{ pid: 501, command: serverCommand('run-A') }]),
        killPid,
      });

      await reaper.sweepOrphans('');

      expect(killPid).not.toHaveBeenCalled();
    });
  });

  describe('fail-soft', () => {
    it('a killPid that throws for one PID does not prevent killing the others', async () => {
      const killed: number[] = [];
      const killPid = vi.fn((pid: number) => {
        if (pid === 601) throw new Error('No such process');
        killed.push(pid);
      });
      const rows: ProcessInfo[] = [
        { pid: 601, command: serverCommand('run-A') }, // throws
        { pid: 602, command: serverCommand('run-B') }, // still killed
        { pid: 603, command: serverCommand('run-C') }, // still killed
      ];
      const reaper = new PrototypeServerReaper({ listProcesses: fixedLister(rows), killPid });

      await expect(reaper.sweepOrphans(RUNS_ROOT)).resolves.toBeUndefined();

      expect(killPid).toHaveBeenCalledTimes(3);
      expect(killed.sort()).toEqual([602, 603]);
    });

    it('a listProcesses that rejects → no throw, no kills', async () => {
      const killPid = vi.fn<(pid: number) => void>();
      const reaper = new PrototypeServerReaper({
        listProcesses: () => Promise.reject(new Error('ps blew up')),
        killPid,
      });

      await expect(reaper.reapForRun(`${RUNS_ROOT}/run-A`)).resolves.toBeUndefined();
      await expect(reaper.sweepOrphans(RUNS_ROOT)).resolves.toBeUndefined();

      expect(killPid).not.toHaveBeenCalled();
    });
  });
});
