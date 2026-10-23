import { describe, it, expect, vi } from 'vitest';
import type { ChildProcess, ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import type { SpawnedProcess } from '@anthropic-ai/claude-agent-sdk';
import type { AppServerProcess } from '../../panels/codex/appServer/client';
import type { HostProcess } from '../../../orchestrator/trpc/contracts/executionHost';
import { RemoteHostProcess, type HostProcessTimers } from '../hostProcess';

// ---- compile-time shape assertions (type-only imports; nothing here runs the SDK or Codex) ----
const asSdkSpawned = (p: HostProcess): SpawnedProcess => p;
const asCodexProcess = (p: HostProcess): AppServerProcess => p;
const remoteIsHostProcess = (p: RemoteHostProcess): HostProcess => p;
const localChildIsHostProcess = (p: ChildProcessWithoutNullStreams): HostProcess => p;

class FakeChild extends EventEmitter {
  readonly written: string[] = [];
  readonly signals: NodeJS.Signals[] = [];
  readonly stdin = new Writable({
    write: (chunk: Buffer, _enc, cb) => {
      this.written.push(chunk.toString('utf8'));
      cb();
    },
  });
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;

  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    this.signals.push(signal);
    return true;
  }

  exit(code: number | null, signal: NodeJS.Signals | null = null): void {
    this.exitCode = code;
    this.signalCode = signal;
    this.emit('exit', code, signal);
    this.emit('close', code, signal);
  }
}

function manualTimers(): HostProcessTimers & { fire(): void; pending(): number } {
  const queue: Array<{ fn: () => void; cancelled: boolean }> = [];
  return {
    setTimeout: (fn) => {
      const entry = { fn, cancelled: false };
      queue.push(entry);
      return entry;
    },
    clearTimeout: (h) => {
      (h as { cancelled: boolean }).cancelled = true;
    },
    fire: () => {
      for (const e of queue.splice(0)) if (!e.cancelled) e.fn();
    },
    pending: () => queue.filter((e) => !e.cancelled).length,
  };
}

function make(over: { signal?: AbortSignal } = {}) {
  const child = new FakeChild();
  const timers = manualTimers();
  const remoteKill = vi.fn(async (_s: 'TERM' | 'KILL') => undefined);
  const proc = new RemoteHostProcess({
    child: child as unknown as ChildProcess,
    prelude: 'A=1\n\n',
    remoteKill,
    timers,
    signal: over.signal,
  });
  return { child, timers, remoteKill, proc };
}

const flush = () => new Promise<void>((r) => setImmediate(r));

describe('RemoteHostProcess', () => {
  it('satisfies the SDK SpawnedProcess and Codex AppServerProcess shapes (and pid is undefined)', () => {
    const { proc } = make();
    expect(asSdkSpawned(proc).killed).toBe(false);
    expect(asCodexProcess(proc).pid).toBeUndefined();
    expect(remoteIsHostProcess(proc)).toBe(proc);
    expect(typeof localChildIsHostProcess).toBe('function');
  });

  it('writes the env prelude before any caller byte', async () => {
    const { child, proc } = make();
    proc.stdin.write('{"type":"user"}\n');
    await flush();
    expect(child.written).toEqual(['A=1\n\n', '{"type":"user"}\n']);
  });

  it('kill: ends stdin, waits the grace, then remote TERM via the pidfile, then SIGTERMs the local ssh; idempotent', async () => {
    const { child, timers, remoteKill, proc } = make();
    const ended = new Promise<void>((r) => child.stdin.on('finish', () => r()));
    expect(proc.kill('SIGTERM')).toBe(true);
    await ended;
    expect(proc.killed).toBe(true);
    expect(remoteKill).not.toHaveBeenCalled();
    expect(child.signals).toEqual([]);
    expect(proc.kill('SIGTERM')).toBe(true);
    expect(timers.pending()).toBe(1);
    timers.fire();
    await flush();
    expect(remoteKill).toHaveBeenCalledTimes(1);
    expect(remoteKill).toHaveBeenCalledWith('TERM');
    expect(child.signals).toEqual(['SIGTERM']);
    const exits: Array<[number | null, NodeJS.Signals | null]> = [];
    proc.on('exit', (c: number | null, s: NodeJS.Signals | null) => exits.push([c, s]));
    child.exit(null, 'SIGTERM');
    expect(exits).toEqual([[null, 'SIGTERM']]);
    expect(proc.signalCode).toBe('SIGTERM');
    expect(proc.kill('SIGTERM')).toBe(false);
  });

  it('an exit inside the grace window cancels the remote kill', async () => {
    const { child, timers, remoteKill, proc } = make();
    proc.kill();
    child.exit(0);
    expect(timers.pending()).toBe(0);
    timers.fire();
    await flush();
    expect(remoteKill).not.toHaveBeenCalled();
    expect(child.signals).toEqual([]);
    expect(proc.exitCode).toBe(0);
  });

  it('SIGKILL escalates immediately (remote KILL + local SIGKILL), even after a graceful kill started', async () => {
    const { child, timers, remoteKill, proc } = make();
    proc.kill('SIGTERM');
    expect(proc.kill('SIGKILL')).toBe(true);
    expect(timers.pending()).toBe(0);
    await flush();
    expect(remoteKill).toHaveBeenCalledWith('KILL');
    expect(child.signals).toEqual(['SIGKILL']);
  });

  it('an aborted signal kills', async () => {
    const ac = new AbortController();
    const { child, proc } = make({ signal: ac.signal });
    const ended = new Promise<void>((r) => child.stdin.on('finish', () => r()));
    ac.abort();
    await ended;
    expect(proc.killed).toBe(true);
  });

  it('forwards error, passes stdout untouched and redacts stderr across chunk boundaries', async () => {
    const { child, proc } = make();
    const errors: Error[] = [];
    proc.on('error', (e: Error) => errors.push(e));
    child.emit('error', new Error('spawn ssh ENOENT'));
    expect(errors.map((e) => e.message)).toEqual(['spawn ssh ENOENT']);

    let out = '';
    let err = '';
    proc.stdout.on('data', (b: Buffer) => { out += b.toString('utf8'); });
    proc.stderr.on('data', (b: Buffer | string) => { err += b.toString(); });
    child.stdout.write('sk-ant-data-is-data\n');
    child.stderr.write('auth failed for sk-ant-oat01-AB');
    child.stderr.write('CD_ef\nnext line\n');
    child.stderr.end('tail sk-ant-zz');
    await flush();
    expect(out).toBe('sk-ant-data-is-data\n');
    expect(err).toBe('auth failed for sk-ant-[REDACTED]\nnext line\ntail sk-ant-[REDACTED]');
  });
});
