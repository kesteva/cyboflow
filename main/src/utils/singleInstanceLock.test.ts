import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { acquireInstanceLock } from './singleInstanceLock';

describe('acquireInstanceLock', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cyboflow-lock-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('acquires when no lock exists and writes the pid', () => {
    const res = acquireInstanceLock(dir, { pid: 111 });
    expect(res.acquired).toBe(true);
    expect(fs.readFileSync(path.join(dir, 'instance.lock'), 'utf8')).toBe('111');
  });

  it('creates the data dir if missing', () => {
    const nested = path.join(dir, 'does', 'not', 'exist');
    const res = acquireInstanceLock(nested, { pid: 1 });
    expect(res.acquired).toBe(true);
    expect(fs.existsSync(path.join(nested, 'instance.lock'))).toBe(true);
  });

  it('blocks a second instance when the holder is alive, reporting the holder pid', () => {
    const first = acquireInstanceLock(dir, { pid: 111, isProcessAlive: () => true });
    expect(first.acquired).toBe(true);

    const second = acquireInstanceLock(dir, { pid: 222, isProcessAlive: () => true });
    expect(second.acquired).toBe(false);
    if (!second.acquired) expect(second.holderPid).toBe(111);
  });

  it('reclaims a stale lock when the holder is dead', () => {
    fs.writeFileSync(path.join(dir, 'instance.lock'), '999');
    const res = acquireInstanceLock(dir, { pid: 222, isProcessAlive: () => false });
    expect(res.acquired).toBe(true);
    expect(fs.readFileSync(path.join(dir, 'instance.lock'), 'utf8')).toBe('222');
  });

  it('reclaims an unparseable/empty lock file', () => {
    fs.writeFileSync(path.join(dir, 'instance.lock'), '   ');
    const res = acquireInstanceLock(dir, { pid: 333, isProcessAlive: () => true });
    expect(res.acquired).toBe(true);
    expect(fs.readFileSync(path.join(dir, 'instance.lock'), 'utf8')).toBe('333');
  });

  it('release() removes the lock only when it still records our pid', () => {
    const res = acquireInstanceLock(dir, { pid: 111 });
    expect(res.acquired).toBe(true);
    if (!res.acquired) return;

    // A successor reclaimed the lock (file now records a different pid).
    fs.writeFileSync(path.join(dir, 'instance.lock'), '222');
    res.release();
    // Our late release must NOT delete the successor's lock.
    expect(fs.readFileSync(path.join(dir, 'instance.lock'), 'utf8')).toBe('222');
  });

  it('release() removes our own lock', () => {
    const res = acquireInstanceLock(dir, { pid: 111 });
    if (!res.acquired) throw new Error('expected acquire');
    res.release();
    expect(fs.existsSync(path.join(dir, 'instance.lock'))).toBe(false);
  });
});
