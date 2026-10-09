/**
 * ExecutionHost — the structural contract every machine (This Mac, an SSH host) satisfies.
 *
 * Standalone: no imports besides shared types. M1 ships the machine surface (exec / fs / git / preflight);
 * the agent spawner and forwardOrchSocket arrive in M2 with remote flows.
 *
 * Every method on an SshHost asserts the HostPath's hostId matches the host and (fs / git) that the path
 * is not an existing LOCAL path (remote-root guard), so a local path can never be operated on remotely.
 */
import type { HostKind, PreflightCheckResult, PreflightResult } from '../../../../../shared/types/hosts';

export interface HostPath {
  hostId: string;
  path: string;
}

export function localHostPath(path: string): HostPath {
  return { hostId: 'local', path };
}

export interface ExecOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  stdin?: string;
}

export interface ExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/** argv run on the machine; for ssh the argv is shell-quoted remotely by the transport. */
export interface MachineExec {
  exec(argv: string[], opts?: ExecOptions): Promise<ExecResult>;
}

export interface MachineFs {
  exists(p: HostPath): Promise<boolean>;
  readFile(p: HostPath, maxBytes?: number): Promise<string>;
  writeFile(p: HostPath, data: string, mode: number): Promise<void>;
  mkdirp(p: HostPath): Promise<void>;
}

export interface GitExecutor {
  run(cwd: HostPath, args: string[], opts?: ExecOptions): Promise<ExecResult>;
}

export interface ExecutionHostInfo {
  id: string;
  kind: HostKind;
  label: string;
}

export interface ExecutionHost {
  info: ExecutionHostInfo;
  exec: MachineExec;
  fs: MachineFs;
  git: GitExecutor;
  preflight(
    mode: PreflightResult['mode'],
    onCheck?: (r: PreflightCheckResult) => void,
    signal?: AbortSignal,
  ): Promise<PreflightResult>;
}
