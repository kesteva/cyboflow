/**
 * SshHost — the ExecutionHost for a user-added SSH machine, over SshTransport.
 *
 * exec runs the argv remotely (quoted word by word by the transport). fs and git are tiny POSIX `sh -c`
 * programs whose PATH is a positional argument ($1), so a caller path is never spliced into shell text:
 *   exists -> `test -e`, readFile -> `head -c`, writeFile -> stdin into a 0600 temp file, chmod, rename,
 *   mkdirp -> `mkdir -p`, git -> `git -C <path> …`.
 * A leading `~/` is expanded against the REMOTE $HOME inside the program.
 *
 * Guards on every HostPath (spec "Remote-root guard"):
 *  - its hostId must be this host's id (HostPathMismatchError);
 *  - the path must be absolute or start with `~/`, and an absolute path that EXISTS on this Mac is refused
 *    (RemotePathIsLocalError): a local path must never be operated on remotely by mistake.
 */
import { existsSync } from 'node:fs';
import { redactSecrets, type PreflightCheckResult, type PreflightResult } from '../../../../shared/types/hosts';
import type {
  ExecOptions,
  ExecResult,
  ExecutionHost,
  ExecutionHostInfo,
  GitExecutor,
  HostPath,
  MachineExec,
  MachineFs,
} from '../../orchestrator/trpc/contracts/executionHost';
import type { LoggerLike } from '../../orchestrator/types';
import { runSshPreflight, type CaptureErrorFn } from './preflight/preflightEngine';
import type { SshTransportLike } from './sshTransport';

const DEFAULT_READ_MAX_BYTES = 1024 * 1024;

export class HostPathMismatchError extends Error {
  constructor() {
    super('That path belongs to a different environment.');
    this.name = 'HostPathMismatchError';
  }
}

export class RemotePathIsLocalError extends Error {
  constructor() {
    super('Refusing a remote operation on a path that exists on this Mac.');
    this.name = 'RemotePathIsLocalError';
  }
}

export class InvalidRemotePathError extends Error {
  constructor() {
    super('A remote path must be absolute or start with ~/.');
    this.name = 'InvalidRemotePathError';
  }
}

/** A remote fs/git operation failed (ssh error or non-zero exit); the message carries redacted stderr. */
export class RemoteOperationError extends Error {
  readonly result: ExecResult;
  constructor(op: string, result: ExecResult) {
    const tail = redactSecrets(result.stderr).trim().split(/\r?\n/).pop() ?? '';
    super(`Remote ${op} failed${result.timedOut ? ' (timed out)' : ''}${tail ? `: ${tail.slice(0, 300)}` : ''}`);
    this.name = 'RemoteOperationError';
    this.result = result;
  }
}

/** Shared prelude: `p` = $1 with a leading `~/` expanded against the remote $HOME. */
const PATH_PRELUDE = 'p=$1; case "$p" in "~/"*) p="$HOME/${p#??}" ;; esac; shift; ';

function remoteSh(program: string, path: string, ...rest: string[]): string[] {
  return ['/bin/sh', '-c', PATH_PRELUDE + program, 'sh', path, ...rest];
}

export interface SshHostDeps {
  id: string;
  label: string;
  sshTarget: string;
  remoteRoot: string;
  appVersion: string;
  transport: SshTransportLike;
  /** Local existence probe for the remote-root guard. Default node:fs existsSync. */
  localExists?: (absolutePath: string) => boolean;
  now?: () => Date;
  clock?: () => number;
  captureError?: CaptureErrorFn;
  logger?: LoggerLike;
}

export class SshHost implements ExecutionHost {
  readonly info: ExecutionHostInfo;
  readonly exec: MachineExec;
  readonly fs: MachineFs;
  readonly git: GitExecutor;

  constructor(private readonly deps: SshHostDeps) {
    this.info = { id: deps.id, kind: 'ssh', label: deps.label };
    const localExists = deps.localExists ?? existsSync;
    const target = deps.sshTarget;
    const t = deps.transport;

    const guard = (p: HostPath): string => {
      if (p.hostId !== deps.id) throw new HostPathMismatchError();
      const path = p.path;
      if (path.includes('\0') || !(path.startsWith('/') || path.startsWith('~/'))) throw new InvalidRemotePathError();
      if (path.startsWith('/') && localExists(path)) throw new RemotePathIsLocalError();
      return path;
    };

    this.exec = {
      exec: (argv: string[], opts: ExecOptions = {}): Promise<ExecResult> => t.exec(target, argv, opts),
    };

    this.fs = {
      exists: async (p: HostPath): Promise<boolean> => {
        const r = await t.exec(target, remoteSh('test -e "$p"', guard(p)));
        if (r.code === 0) return true;
        if (r.code === 1) return false;
        throw new RemoteOperationError('exists', r);
      },
      readFile: async (p: HostPath, maxBytes = DEFAULT_READ_MAX_BYTES): Promise<string> => {
        const n = Math.max(0, Math.floor(maxBytes));
        const r = await t.exec(target, remoteSh('exec head -c "$1" -- "$p"', guard(p), String(n)));
        if (r.code !== 0) throw new RemoteOperationError('read', r);
        return r.stdout;
      },
      writeFile: async (p: HostPath, data: string, mode: number): Promise<void> => {
        if (!Number.isInteger(mode) || mode < 0 || mode > 0o777) throw new Error('invalid file mode');
        // Data arrives on stdin. BSD `install` rejects a pipe as /dev/stdin, so: a 0600 temp file next to the
        // target (umask 077 before any byte lands), the requested mode, then an atomic rename.
        const r = await t.exec(
          target,
          remoteSh(
            'umask 077; t="$p.cf-tmp.$$"; if cat > "$t" && chmod "$1" "$t" && mv -f "$t" "$p"; then exit 0; fi; rm -f "$t"; exit 1',
            guard(p),
            mode.toString(8),
          ),
          { stdin: data },
        );
        if (r.code !== 0) throw new RemoteOperationError('write', r);
      },
      mkdirp: async (p: HostPath): Promise<void> => {
        const r = await t.exec(target, remoteSh('exec mkdir -p -- "$p"', guard(p)));
        if (r.code !== 0) throw new RemoteOperationError('mkdir', r);
      },
    };

    this.git = {
      run: async (cwd: HostPath, args: string[], opts: ExecOptions = {}): Promise<ExecResult> =>
        t.exec(target, remoteSh('exec git -C "$p" "$@"', guard(cwd), ...args), opts),
    };
  }

  preflight(
    mode: PreflightResult['mode'],
    onCheck?: (r: PreflightCheckResult) => void,
    signal?: AbortSignal,
  ): Promise<PreflightResult> {
    const d = this.deps;
    return runSshPreflight(
      {
        hostId: d.id,
        sshTarget: d.sshTarget,
        remoteRoot: d.remoteRoot,
        appVersion: d.appVersion,
        transport: d.transport,
        now: d.now,
        clock: d.clock,
        captureError: d.captureError,
        logger: d.logger,
      },
      mode,
      onCheck,
      signal,
    );
  }
}
