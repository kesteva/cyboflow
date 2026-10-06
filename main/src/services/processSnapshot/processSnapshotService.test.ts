import { describe, it, expect, vi } from 'vitest';
import { ProcessSnapshotService } from './processSnapshotService';
import type { ProcessSnapshotRow } from '../processTable';

const BROKER_CMD = 'node /x/app-server-broker.mjs serve --cwd /wt/broker --endpoint unix:/tmp/s';

const row = (pid: number, command: string, ppid = 1): ProcessSnapshotRow => ({
  pid,
  ppid,
  pcpu: 1.5,
  pmem: 0.2,
  etimeSeconds: 60,
  command,
});

const FIXTURE: ProcessSnapshotRow[] = [
  row(10, 'claude --resume'),
  row(11, 'codex'),
  row(12, '-zsh'),
  row(13, BROKER_CMD),
  row(14, '/usr/bin/whatever'),
];

function build(over: { listProcesses?: () => Promise<ProcessSnapshotRow[]> } = {}) {
  const listProcesses = vi.fn(over.listProcesses ?? (async () => FIXTURE));
  const claude = {
    listOwnedProcesses: vi.fn(() => [
      { pid: 10, provider: 'claude' as const, panelId: 'p10', sessionId: 's10', worktreePath: '/wt/a' },
    ]),
  };
  const codex = {
    listOwnedProcesses: vi.fn(() => [
      { pid: 11, provider: 'codex' as const, panelId: 'p11', sessionId: 's11', worktreePath: '/wt/b' },
    ]),
  };
  const runShellManager = {
    listOwnedShells: vi.fn(() => [
      { pid: 12, runId: 'r1', terminalId: 't1', worktreePath: '/wt/c' },
    ]),
  };
  const service = new ProcessSnapshotService({
    listProcesses,
    cliManager: [claude, codex],
    runShellManager,
  });
  return { service, listProcesses, claude, codex, runShellManager };
}

describe('ProcessSnapshotService', () => {
  it('performs exactly one listProcesses() call per snapshot()', async () => {
    const { service, listProcesses } = build();
    await service.snapshot();
    expect(listProcesses).toHaveBeenCalledTimes(1);
    await service.snapshot();
    expect(listProcesses).toHaveBeenCalledTimes(2);
  });

  it('round-trips every fixture row with the right type, worktree, and owner', async () => {
    const { service } = build();
    const out = await service.snapshot();
    expect(out).toHaveLength(FIXTURE.length);

    const byPid = new Map(out.map((p) => [p.pid, p]));
    expect(byPid.get(10)).toMatchObject({
      processType: 'claude-cli',
      worktreePath: '/wt/a',
      owner: { kind: 'cli', panelId: 'p10', sessionId: 's10' },
      pcpu: 1.5,
      command: 'claude --resume',
    });
    expect(byPid.get(11)).toMatchObject({ processType: 'codex-cli', worktreePath: '/wt/b' });
    expect(byPid.get(12)).toMatchObject({
      processType: 'shell-pty',
      worktreePath: '/wt/c',
      owner: { kind: 'run-shell', runId: 'r1', terminalId: 't1' },
    });
    expect(byPid.get(13)).toMatchObject({
      processType: 'codex-broker',
      worktreePath: '/wt/broker',
      owner: null,
    });
    expect(byPid.get(14)).toMatchObject({ processType: 'unknown', worktreePath: null, owner: null });
  });

  it('accepts a single cliManager (non-array)', async () => {
    const service = new ProcessSnapshotService({
      listProcesses: async () => [row(10, 'claude')],
      cliManager: {
        listOwnedProcesses: () => [
          { pid: 10, provider: 'claude', panelId: 'p', sessionId: 's', worktreePath: '/wt/a' },
        ],
      },
      runShellManager: { listOwnedShells: () => [] },
    });
    const [only] = await service.snapshot();
    expect(only.processType).toBe('claude-cli');
  });

  it('uses only injected dependencies (no real ps) and rejects when the scan rejects', async () => {
    const { service } = build({
      listProcesses: async () => {
        throw new Error('ps failed');
      },
    });
    await expect(service.snapshot()).rejects.toThrow('ps failed');
  });

  it('an injected isBrokerProcess can add brokers but never demotes an owned handle', async () => {
    const service = new ProcessSnapshotService({
      listProcesses: async () => [row(10, 'claude'), row(20, 'custom-broker')],
      cliManager: {
        listOwnedProcesses: () => [
          { pid: 10, provider: 'claude', panelId: 'p', sessionId: 's', worktreePath: '/wt/a' },
        ],
      },
      runShellManager: { listOwnedShells: () => [] },
      isBrokerProcess: () => true,
    });
    const out = await service.snapshot();
    expect(out.find((p) => p.pid === 10)?.processType).toBe('claude-cli');
    expect(out.find((p) => p.pid === 20)?.processType).toBe('codex-broker');
  });
});
