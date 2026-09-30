import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

let dataDir = '';
vi.mock('./cyboflowDirectory', () => ({
  getCyboflowSubdirectory: (...sub: string[]) => path.join(dataDir, ...sub),
}));

import {
  getInstanceId,
  stampSpawnMarker,
  _resetInstanceIdForTesting,
} from './spawnMarker';

describe('spawnMarker', () => {
  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spawn-marker-'));
    _resetInstanceIdForTesting();
  });
  afterEach(() => {
    fs.rmSync(dataDir, { recursive: true, force: true });
    delete process.env.CYBOFLOW_INSTANCE;
  });

  it('getInstanceId is stable across calls', () => {
    const a = getInstanceId();
    expect(a).toMatch(/^[0-9a-f-]{36}$/);
    expect(getInstanceId()).toBe(a);
  });

  it('never adopts an inherited CYBOFLOW_INSTANCE', () => {
    process.env.CYBOFLOW_INSTANCE = 'hosting-instance';
    expect(getInstanceId()).not.toBe('hosting-instance');
  });

  it('stampSpawnMarker returns a new env and does not mutate the input', () => {
    const input = { PATH: '/bin', CYBOFLOW_INSTANCE: 'stale', DROP: undefined };
    const snapshot = { ...input };
    const out = stampSpawnMarker(input, '/wt/a');
    expect(input).toEqual(snapshot);
    expect(out).not.toBe(input);
    expect(out.CYBOFLOW_INSTANCE).toBe(getInstanceId());
    expect(out.CYBOFLOW_WORKTREE).toBe('/wt/a');
    expect(out.PATH).toBe('/bin');
    expect('DROP' in out).toBe(false);
    expect(typeof out.CYBOFLOW_INSTANCE).toBe('string');
  });

  it('writes a liveness record on first getInstanceId call', () => {
    const id = getInstanceId();
    const file = path.join(dataDir, 'instances', `${id}.json`);
    const record = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(record.instanceId).toBe(id);
    expect(record.pid).toBe(process.pid);
    expect(Number.isNaN(Date.parse(record.startedAt))).toBe(false);
  });

  it('removes the record on exit', () => {
    const listeners: Array<() => void> = [];
    const spy = vi.spyOn(process, 'once').mockImplementation(((ev: string, fn: () => void) => {
      if (ev === 'exit') listeners.push(fn);
      return process;
    }) as unknown as typeof process.once);
    const id = getInstanceId();
    spy.mockRestore();
    const file = path.join(dataDir, 'instances', `${id}.json`);
    expect(fs.existsSync(file)).toBe(true);
    listeners.forEach((fn) => fn());
    expect(fs.existsSync(file)).toBe(false);
  });

  it('never throws when the data dir is unwritable', () => {
    // A regular file where the `instances` dir should be → mkdir/write fail.
    fs.writeFileSync(path.join(dataDir, 'instances'), 'x');
    expect(() => getInstanceId()).not.toThrow();
    expect(() => stampSpawnMarker({}, '/wt')).not.toThrow();
  });

  it("index.ts's boot env strip list includes CYBOFLOW_INSTANCE", () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'index.ts'), 'utf8');
    const block = src.match(/for \(const key of \[([\s\S]*?)\]\) \{\s*delete process\.env\[key\];/);
    expect(block).not.toBeNull();
    expect(block![1]).toContain("'CYBOFLOW_INSTANCE'");
  });
});
