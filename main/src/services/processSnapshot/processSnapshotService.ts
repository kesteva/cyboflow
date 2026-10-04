/**
 * ProcessSnapshotService — ONE `ps` scan per snapshot, unioned with the
 * managers' owned-handle lists and tagged with a {@link ProcessType}.
 *
 * Cost rule (docs/design/process-worktree-monitor.md): a full `ps` scan is
 * ~2 ms but every spawn costs ~36 ms, so `snapshot()` scans the whole table
 * exactly once and indexes it in memory — never a per-pid `ps`. Every
 * dependency is injected (McpOrphanTripwire / CodexBrokerReaper seam style), so
 * a test fakes process listing and manager state with zero subprocesses.
 *
 * This service is deliberately NOT wired to boot or any timer: whoever polls it
 * (and gates that poll on view visibility) owns the cadence.
 */
import { execFile } from 'node:child_process';
import {
  parsePsOutputWithCpuMem,
  type ProcessSnapshotRow,
} from '../processTable';
import { execWindowsProcessTable } from '../winProcessTable';
import { parseBrokerCwd } from '../codexBrokerReaper';
import type { OwnedCliProcess } from '../panels/cli/AbstractCliManager';
import type { OwnedRunShell } from '../runShellManager';
import { classifyProcessType, type OwnedHandles, type ProcessType } from './processTypes';

/** Who owns a matched row. `null` on a {@link SnapshottedProcess} when unmatched. */
export type ProcessOwner =
  | { kind: 'cli'; panelId: string; sessionId: string }
  | { kind: 'run-shell'; runId: string; terminalId: string };

/** A `ps` row plus what cyboflow knows about it. */
export interface SnapshottedProcess extends ProcessSnapshotRow {
  processType: ProcessType;
  /** Owning worktree when the row matched a manager handle (or a broker's `--cwd`); else null. */
  worktreePath: string | null;
  owner: ProcessOwner | null;
}

/** Structural view of `AbstractCliManager` — only the read-only accessor. */
export interface CliOwnedSource {
  listOwnedProcesses(): OwnedCliProcess[];
}

/** Structural view of `RunShellManager` — only the read-only accessor. */
export interface ShellOwnedSource {
  listOwnedShells(): OwnedRunShell[];
}

export interface ProcessSnapshotServiceOptions {
  /** The single `ps` scan. Defaults to the real six-column scan ({@link defaultListProcesses}). */
  listProcesses?: () => Promise<ProcessSnapshotRow[]>;
  /** One CLI manager, or one per provider (Claude, Codex, pi, OMP). */
  cliManager: CliOwnedSource | readonly CliOwnedSource[];
  runShellManager: ShellOwnedSource;
  /**
   * Broker predicate override. Only consulted for rows the standard classifier
   * left `'unknown'`, so it can add brokers but never demote an owned handle.
   */
  isBrokerProcess?: (row: Pick<ProcessSnapshotRow, 'command'>) => boolean;
}

/** Real scan: `ps -axo pid=,ppid=,pcpu=,pmem=,etime=,command=` (PowerShell stand-in on win32). */
export function defaultListProcesses(
  platform: NodeJS.Platform = process.platform,
): Promise<ProcessSnapshotRow[]> {
  if (platform === 'win32') {
    return execWindowsProcessTable('pid-ppid-cpu-mem-etime-command').then(parsePsOutputWithCpuMem);
  }
  return new Promise<ProcessSnapshotRow[]>((resolve, reject) => {
    execFile(
      'ps',
      ['-axo', 'pid=,ppid=,pcpu=,pmem=,etime=,command='],
      // Command lines can be long; 16 MiB is above any realistic full table.
      { maxBuffer: 16 * 1024 * 1024, windowsHide: true },
      (err, stdout) => {
        if (err) {
          reject(err instanceof Error ? err : new Error(String(err)));
          return;
        }
        resolve(parsePsOutputWithCpuMem(stdout));
      },
    );
  });
}

export class ProcessSnapshotService {
  private readonly listProcesses: () => Promise<ProcessSnapshotRow[]>;
  private readonly cliManagers: readonly CliOwnedSource[];
  private readonly runShellManager: ShellOwnedSource;
  private readonly isBrokerOverride?: (row: Pick<ProcessSnapshotRow, 'command'>) => boolean;

  constructor(opts: ProcessSnapshotServiceOptions) {
    this.listProcesses = opts.listProcesses ?? (() => defaultListProcesses());
    this.cliManagers = Array.isArray(opts.cliManager)
      ? (opts.cliManager as readonly CliOwnedSource[])
      : [opts.cliManager as CliOwnedSource];
    this.runShellManager = opts.runShellManager;
    this.isBrokerOverride = opts.isBrokerProcess;
  }

  /** One scan → every row tagged with its process type and (when owned) worktree + owner ids. */
  async snapshot(): Promise<SnapshottedProcess[]> {
    const rows = await this.listProcesses();
    const cli = this.cliManagers.flatMap((m) => m.listOwnedProcesses());
    const shells = this.runShellManager.listOwnedShells();
    const owned: OwnedHandles = { cli, shells };

    const cliByPid = new Map(cli.map((h) => [h.pid, h] as const));
    const shellByPid = new Map(shells.map((h) => [h.pid, h] as const));

    return rows.map((row): SnapshottedProcess => {
      let processType = classifyProcessType(row, owned);
      if (processType === 'unknown' && this.isBrokerOverride?.(row)) processType = 'codex-broker';

      const cliHandle = cliByPid.get(row.pid);
      if (cliHandle) {
        return {
          ...row,
          processType,
          worktreePath: cliHandle.worktreePath,
          owner: { kind: 'cli', panelId: cliHandle.panelId, sessionId: cliHandle.sessionId },
        };
      }
      const shellHandle = shellByPid.get(row.pid);
      if (shellHandle) {
        return {
          ...row,
          processType,
          worktreePath: shellHandle.worktreePath,
          owner: { kind: 'run-shell', runId: shellHandle.runId, terminalId: shellHandle.terminalId },
        };
      }
      return {
        ...row,
        processType,
        // A broker isn't a manager handle but its `--cwd` names the worktree it serves.
        worktreePath: processType === 'codex-broker' ? parseBrokerCwd(row.command) : null,
        owner: null,
      };
    });
  }
}
