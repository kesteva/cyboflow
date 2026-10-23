/**
 * RemoteArtifactFetcher — copies a remote run's reported artifact files (spec M2 §5 D4) from
 * `<remoteRoot>/artifacts/runs/<runKey>/<relPath>` on its environment into this Mac's run artifacts dir. Implements
 * the orchestrator's RemoteArtifactFetcherLike (orchestrator/hosts/remoteArtifactPull.ts).
 *
 * Binary-safe: MachineFs.readFile decodes the remote bytes as UTF-8 (lossy for a PNG), so the bytes travel base64
 * through ExecutionHost.exec instead, in chunks well under the transport's 4 MB output cap, with one fixed remote
 * program (REMOTE_ARTIFACT_READ_PROGRAM; every caller value is a positional argument, never shell text).
 *
 * Gates, read per call: Environments running and remote hosts not kill-switched (the published HostsFacade), the
 * host registry wired (executionHostBridge), the host's remote root known. Nothing here ever reads This Mac's own
 * filesystem as if it were the environment; the only local writes land inside the given local run artifacts dir.
 *
 * Not a security boundary against the agent: the remote program refuses symlinks and anything outside the run's
 * artifacts dir (a sanity guard), but the agent runs as the same remote user and could copy any file it can read
 * into that dir itself.
 */
import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { redactSecrets } from '../../../../shared/types/hosts';
import { peekHostsFacade, type HostsFacade } from '../../orchestrator/hostsBridge';
import {
  isSafeArtifactRelPath,
  RemoteArtifactFetchError,
  type RemoteArtifactFetcherLike,
  type RemoteArtifactFetchRequest,
} from '../../orchestrator/hosts/remoteArtifactPull';
import type { ExecResult, ExecutionHost } from '../../orchestrator/trpc/contracts/executionHost';
import type { LoggerLike } from '../../orchestrator/types';
import { getExecutionHostResolver, type ExecutionHostResolver } from './executionHostBridge';
import { remoteArtifactsDir } from './remoteRuntime';

/** Bytes per `dd` block, and blocks per exec: 2 MiB raw ≈ 2.8 MB base64 per round trip. */
export const ARTIFACT_READ_BLOCK_BYTES = 1024 * 1024;
export const ARTIFACT_READ_BLOCKS_PER_CHUNK = 2;
const CHUNK_BYTES = ARTIFACT_READ_BLOCK_BYTES * ARTIFACT_READ_BLOCKS_PER_CHUNK;
const EXEC_TIMEOUT_MS = 60_000;

/**
 * `$1` file, `$2` the run artifacts dir, `$3` `size` or a block offset. Exit 3 = refused (a symlink, or the file's
 * physical directory is not inside the run dir's); exit 4 = missing / not a regular file. `size` prints the byte
 * count; an offset prints that chunk base64-encoded (any line wrapping; the decoder ignores whitespace).
 */
export const REMOTE_ARTIFACT_READ_PROGRAM =
  'f=$1; r=$2; o=$3; ' +
  'if [ -L "$f" ]; then exit 3; fi; ' +
  'if [ ! -f "$f" ]; then exit 4; fi; ' +
  'd=$(cd -P -- "${f%/*}" && pwd -P) || exit 4; ' +
  'rr=$(cd -P -- "$r" && pwd -P) || exit 4; ' +
  'case "$d/" in "$rr"/*) ;; *) exit 3 ;; esac; ' +
  'if [ "$o" = size ]; then exec wc -c < "$f"; fi; ' +
  `dd if="$f" bs=${ARTIFACT_READ_BLOCK_BYTES} skip="$o" count=${ARTIFACT_READ_BLOCKS_PER_CHUNK} 2>/dev/null | base64`;

/** The argv that runs the program for one file (exported for the shell test). */
export function remoteArtifactReadArgv(file: string, runDir: string, mode: 'size' | number): string[] {
  return ['/bin/sh', '-c', REMOTE_ARTIFACT_READ_PROGRAM, 'sh', file, runDir, String(mode)];
}

const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

/** Strict base64 → bytes (whitespace ignored); null when the text is not base64. */
export function decodeBase64Chunk(text: string): Buffer | null {
  const compact = text.replace(/\s+/g, '');
  if (compact.length % 4 !== 0 || !BASE64_RE.test(compact)) return null;
  return Buffer.from(compact, 'base64');
}

export interface RemoteArtifactFetcherDeps {
  /** Default: the executionHostBridge resolver (HostRegistry.get). */
  getResolver?: () => ExecutionHostResolver | null;
  /** Default: the published HostsFacade (status gate). */
  getHosts?: () => Pick<HostsFacade, 'status'> | null;
  logger?: LoggerLike;
}

function detail(r: ExecResult): string {
  if (r.timedOut) return 'timed out';
  const tail = redactSecrets(r.stderr).trim().split(/\r?\n/).slice(-3).join(' ').slice(0, 300);
  return tail || `exit ${r.code ?? 'unknown'}`;
}

export class RemoteArtifactFetcher implements RemoteArtifactFetcherLike {
  constructor(private readonly deps: RemoteArtifactFetcherDeps = {}) {}

  async fetch(req: RemoteArtifactFetchRequest): Promise<void> {
    const host = this.resolveHost(req.hostId);
    const root = host.info.remoteRoot;
    if (root === null || !root.startsWith('/')) {
      throw new RemoteArtifactFetchError('this environment has no completed check yet, so its folders are unknown');
    }
    let runDir: string;
    try {
      runDir = remoteArtifactsDir(root, req.runKey);
    } catch (err) {
      throw new RemoteArtifactFetchError('this run id cannot name a folder on the environment', { cause: err });
    }
    const localRoot = path.resolve(req.localDir);
    for (const rel of req.relPaths) {
      if (!isSafeArtifactRelPath(rel)) throw new RemoteArtifactFetchError(`${JSON.stringify(rel)} is not a file name inside the run artifacts folder`);
      const target = path.resolve(localRoot, ...rel.split('/'));
      if (!target.startsWith(localRoot + path.sep)) {
        throw new RemoteArtifactFetchError(`${rel} is not inside the run artifacts folder`);
      }
      const bytes = await this.readRemoteFile(host, `${runDir}/${rel}`, runDir, rel, req.maxBytes);
      await fs.mkdir(path.dirname(target), { recursive: true });
      const tmp = `${target}.cf-pull-${randomBytes(4).toString('hex')}`;
      try {
        await fs.writeFile(tmp, bytes);
        await fs.rename(tmp, target);
      } catch (err) {
        await fs.rm(tmp, { force: true }).catch(() => undefined);
        throw new RemoteArtifactFetchError(`could not save ${rel} on this Mac`, { cause: err });
      }
    }
    this.deps.logger?.info('[hosts] pulled remote run artifacts', { hostId: req.hostId, files: req.relPaths.length });
  }

  private resolveHost(hostId: string): ExecutionHost {
    const hosts = (this.deps.getHosts ?? peekHostsFacade)();
    const status = hosts?.status();
    if (!status?.running) throw new RemoteArtifactFetchError('Environments are turned off');
    if (status.killed) throw new RemoteArtifactFetchError('remote environments are turned off');
    const resolver = (this.deps.getResolver ?? getExecutionHostResolver)();
    if (resolver === null) throw new RemoteArtifactFetchError('remote environments are not available right now');
    try {
      return resolver(hostId);
    } catch (err) {
      throw new RemoteArtifactFetchError('this run\'s environment no longer exists', { cause: err });
    }
  }

  private async exec(host: ExecutionHost, argv: string[], rel: string): Promise<ExecResult> {
    try {
      return await host.exec.exec(argv, { timeoutMs: EXEC_TIMEOUT_MS });
    } catch (err) {
      const msg = redactSecrets(err instanceof Error ? err.message : String(err)).slice(0, 300);
      throw new RemoteArtifactFetchError(`could not read ${rel} from the environment (${msg})`, { cause: err });
    }
  }

  private failed(r: ExecResult, rel: string): RemoteArtifactFetchError {
    if (r.code === 4) return new RemoteArtifactFetchError(`${rel} was not found in this run's artifacts folder on the environment`);
    if (r.code === 3) {
      return new RemoteArtifactFetchError(`${rel} is a link or lies outside this run's artifacts folder on the environment`);
    }
    return new RemoteArtifactFetchError(`could not read ${rel} from the environment (${detail(r)})`);
  }

  private async readRemoteFile(host: ExecutionHost, file: string, runDir: string, rel: string, maxBytes: number): Promise<Buffer> {
    const sized = await this.exec(host, remoteArtifactReadArgv(file, runDir, 'size'), rel);
    if (sized.code !== 0) throw this.failed(sized, rel);
    const size = Number(sized.stdout.trim());
    if (!Number.isSafeInteger(size) || size < 0) throw new RemoteArtifactFetchError(`could not read the size of ${rel} on the environment`);
    if (size > maxBytes) {
      throw new RemoteArtifactFetchError(`${rel} is ${size} bytes, over the ${maxBytes}-byte limit for bringing a file back`);
    }
    const chunks: Buffer[] = [];
    let read = 0;
    for (let block = 0; read < size; block += ARTIFACT_READ_BLOCKS_PER_CHUNK) {
      const r = await this.exec(host, remoteArtifactReadArgv(file, runDir, block), rel);
      if (r.code !== 0) throw this.failed(r, rel);
      const chunk = decodeBase64Chunk(r.stdout);
      const expected = Math.min(CHUNK_BYTES, size - read);
      if (chunk === null || chunk.length !== expected) {
        throw new RemoteArtifactFetchError(`${rel} changed on the environment while it was being copied; report it again`);
      }
      chunks.push(chunk);
      read += chunk.length;
    }
    return Buffer.concat(chunks, size);
  }
}
