/**
 * WorkflowScriptWatcher tests — filesystem launch detection (claude 2.1.177+
 * transcript-layout fallback). Uses fake timers + a real tmp dir, mirroring
 * journalTailer.test.ts.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkflowScriptWatcher, type WorkflowScriptLaunch } from '../workflowScriptWatcher';

const POLL_MS = 1000;

describe('WorkflowScriptWatcher', () => {
  let keyDir: string;

  beforeEach(() => {
    vi.useFakeTimers();
    keyDir = mkdtempSync(join(tmpdir(), 'cyboflow-wfwatch-'));
  });

  afterEach(() => {
    vi.useRealTimers();
    rmSync(keyDir, { recursive: true, force: true });
  });

  /** Write a persisted workflow script at <keyDir>/<uuid>/workflows/scripts/<file>. */
  function writeScript(uuid: string, fileName: string): string {
    const scriptsDir = join(keyDir, uuid, 'workflows', 'scripts');
    mkdirSync(scriptsDir, { recursive: true });
    const p = join(scriptsDir, fileName);
    writeFileSync(p, 'export const meta = {};\n', 'utf8');
    return p;
  }

  it('detects a new *-wf_*.js script and derives wfRunId / scriptPath / transcriptDir', async () => {
    const launches: WorkflowScriptLaunch[] = [];
    const watcher = new WorkflowScriptWatcher(keyDir, (l) => launches.push(l));
    watcher.start();

    const uuid = '701a975d-865b-4c30-a458-34917574f8dc';
    const scriptPath = writeScript(uuid, 'haiku-codebase-review-wf_64b2709a-111.js');

    await vi.advanceTimersByTimeAsync(POLL_MS);

    expect(launches).toHaveLength(1);
    expect(launches[0].wfRunId).toBe('wf_64b2709a-111');
    expect(launches[0].scriptPath).toBe(scriptPath);
    expect(launches[0].transcriptDir).toBe(
      join(keyDir, uuid, 'subagents', 'workflows', 'wf_64b2709a-111'),
    );
    watcher.stop();
  });

  it('fires onLaunch at most once per workflow across polls', async () => {
    const launches: WorkflowScriptLaunch[] = [];
    const watcher = new WorkflowScriptWatcher(keyDir, (l) => launches.push(l));
    watcher.start();

    writeScript('uuid-1', 'flow-wf_abc123.js');
    await vi.advanceTimersByTimeAsync(POLL_MS * 3);

    expect(launches).toHaveLength(1);
    watcher.stop();
  });

  it('detects multiple distinct workflows (including under different session dirs)', async () => {
    const launches: WorkflowScriptLaunch[] = [];
    const watcher = new WorkflowScriptWatcher(keyDir, (l) => launches.push(l));
    watcher.start();

    writeScript('uuid-1', 'first-wf_111.js');
    await vi.advanceTimersByTimeAsync(POLL_MS);
    writeScript('uuid-2', 'second-wf_222.js');
    await vi.advanceTimersByTimeAsync(POLL_MS);

    expect(launches.map((l) => l.wfRunId).sort()).toEqual(['wf_111', 'wf_222']);
    watcher.stop();
  });

  it('ignores non-matching files and is fail-soft on a missing key dir', async () => {
    const launches: WorkflowScriptLaunch[] = [];
    // Point at a key dir that does not exist yet — start() must not throw.
    const missing = join(keyDir, 'does-not-exist-yet');
    const watcher = new WorkflowScriptWatcher(missing, (l) => launches.push(l));
    expect(() => watcher.start()).not.toThrow();
    await vi.advanceTimersByTimeAsync(POLL_MS);

    // A script-shaped file WITHOUT the -wf_ marker is ignored.
    mkdirSync(join(keyDir, 'does-not-exist-yet', 'u', 'workflows', 'scripts'), { recursive: true });
    writeFileSync(
      join(keyDir, 'does-not-exist-yet', 'u', 'workflows', 'scripts', 'helper.js'),
      'x',
      'utf8',
    );
    await vi.advanceTimersByTimeAsync(POLL_MS);

    expect(launches).toHaveLength(0);
    watcher.stop();
  });

  it('stops polling after stop()', async () => {
    const launches: WorkflowScriptLaunch[] = [];
    const watcher = new WorkflowScriptWatcher(keyDir, (l) => launches.push(l));
    watcher.start();
    watcher.stop();

    writeScript('uuid-1', 'late-wf_999.js');
    await vi.advanceTimersByTimeAsync(POLL_MS * 3);

    expect(launches).toHaveLength(0);
  });
});
