/**
 * toolchainPusher — install a toolchain on an ssh host at `<remoteRoot>/toolchain/<hash>/` (spec A5).
 *
 * Steps (each a fixed POSIX sh program; paths/names are POSITIONAL args, never spliced into the program text):
 *  1. check    — `<hash>/manifest.json` exists and its text equals the local manifest → return early (idempotent).
 *  2. upload   — stream tar.gz (tarStream.ts) via `pushStream` into a program that extracts into
 *                `toolchain/.<hash>.tmp.$$` (umask 077), then prints `TMP\t<dir>` and one `rel\t<sha256>` line per
 *                file (`shasum -a 256`, `sha256sum` fallback). A failed extract removes the temp dir.
 *  3. verify   — LOCAL comparison of that listing against the manifest (same file set, same hashes). Mismatch →
 *                remove the temp dir, ToolchainPushError('verify'); nothing is renamed.
 *  4. install  — write manifest.json into the temp dir (stdin), then rename it to `<hash>` atomically (an existing
 *                `<hash>` without a matching manifest is moved aside first, then removed).
 *  5. gc       — keep the new hash + the newest other hash dir (by mtime); remove older hash dirs and abandoned
 *                `.<hash>.tmp|old.<pid>` dirs older than an hour. Only names of exactly those shapes are ever
 *                deleted (checked locally AND again remotely); anything else under `toolchain/` is left alone.
 *                GC failure never fails an install.
 *
 * `pushStream` runs `/bin/sh -c <script>` with no positional args, so the upload script starts with
 * `set -- <shQuote(root)> <shQuote(hash)>` before the fixed program.
 *
 * One push per host at a time: an in-module per-host promise chain serialises calls (a queued second push then
 * normally returns early at step 1). Progress is reported in SOURCE bytes (uncompressed file bytes consumed by the
 * archive), so `bytesTotal` is known up front: the sum of the manifest's file sizes.
 */
import { redactSecrets } from '../../../../../shared/types/hosts';
import type { ExecResult } from '../../../orchestrator/trpc/contracts/executionHost';
import type { LoggerLike } from '../../../orchestrator/types';
import { shQuote, type SshTransportLike } from '../sshTransport';
import { nodeToolchainHashFs, serializeToolchainManifest, type ToolchainHashFs } from './toolchainHash';
import { tarGzReadable, type TarEntry } from './tarStream';
import {
  CODEX_ENTRYPOINT_REL,
  CODEX_PATH_DIR_REL,
  TOOLCHAIN_CLAUDE_REL,
  TOOLCHAIN_CODEX_DIR,
  TOOLCHAIN_HASH_RE,
  TOOLCHAIN_MCP_REL,
  type ToolchainManifest,
  type ToolchainProgress,
  type ToolchainSourceFile,
} from './types';

export const TOOLCHAIN_CHECK_TIMEOUT_MS = 30_000;
export const TOOLCHAIN_UPLOAD_TIMEOUT_MS = 60 * 60_000;
export const TOOLCHAIN_INSTALL_TIMEOUT_MS = 60_000;
/** Abandoned temp dirs younger than this may belong to a concurrent push from another desktop. */
export const TOOLCHAIN_STALE_TMP_S = 60 * 60;
const MAX_MANIFEST_BYTES = 1024 * 1024;
const DEFAULT_PROGRESS_STEP_BYTES = 1024 * 1024;

export type ToolchainPushStep = 'check' | 'upload' | 'verify' | 'install' | 'aborted';

export class ToolchainPushError extends Error {
  readonly step: ToolchainPushStep;
  readonly hostId: string;
  constructor(step: ToolchainPushStep, hostId: string, detail: string) {
    super(`Installing cyboflow tools failed (${step})${detail ? `: ${detail}` : ''}`);
    this.name = 'ToolchainPushError';
    this.step = step;
    this.hostId = hostId;
  }
}

/** Upload-program exit codes. */
const PUSH_EXIT: Readonly<Record<number, string>> = {
  90: 'could not create the toolchain folder',
  91: 'could not create a temporary folder',
  92: 'could not unpack the upload',
  93: 'could not read the unpacked files',
};

function stderrTail(result: ExecResult): string {
  const lines = redactSecrets(result.stderr).split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
  const line = lines[lines.length - 1] ?? '';
  return line.length > 300 ? `${line.slice(0, 300)}…` : line;
}

function describeFailure(result: ExecResult, known: Readonly<Record<number, string>> = {}): string {
  if (result.timedOut) return 'timed out';
  const parts: string[] = [];
  if (result.code !== null && known[result.code]) parts.push(known[result.code]);
  const tail = stderrTail(result);
  if (tail) parts.push(tail);
  if (parts.length === 0) parts.push(result.code === null ? 'the connection failed' : `exit ${result.code}`);
  return parts.join(': ');
}

// --- remote programs (fixed text) ------------------------------------------------------------------------------

/** $1 root, $2 hash. Exit 1 = not installed; else the manifest text on stdout. */
export const CHECK_PROGRAM =
  `f="$1/toolchain/$2/manifest.json"; [ -f "$f" ] || exit 1; exec head -c ${MAX_MANIFEST_BYTES} -- "$f"`;

/** $1 root, $2 hash; stdin = tar.gz. Prints `TMP\t<dir>` then `rel\t<sha256>` per extracted file. */
export const PUSH_PROGRAM =
  'r=$1; h=$2; tc="$r/toolchain"; umask 077; ' +
  'mkdir -p -- "$tc" || exit 90; ' +
  't="$tc/.$h.tmp.$$"; rm -rf -- "$t"; mkdir -- "$t" || exit 91; ' +
  'if ! tar -xzf - -C "$t"; then rm -rf -- "$t"; exit 92; fi; ' +
  'if command -v shasum >/dev/null 2>&1; then H="shasum -a 256"; else H=sha256sum; fi; ' +
  'cd -- "$t" || exit 93; ' +
  'printf "TMP\\t%s\\n" "$t"; ' +
  'find . -type f | while IFS= read -r f; do s=$($H < "$f"); printf "%s\\t%s\\n" "${f#./}" "${s%% *}"; done';

/** $1 root, $2 hash, $3 temp dir; stdin = manifest.json. Exit 3 = refused temp path. */
export const INSTALL_PROGRAM =
  'r=$1; h=$2; t=$3; tc="$r/toolchain"; d="$tc/$h"; o=; umask 077; ' +
  'case "$t" in "$tc/.$h.tmp."*) ;; *) exit 3 ;; esac; ' +
  'cat > "$t/manifest.json" || exit 4; ' +
  'if [ -e "$d" ]; then o="$tc/.$h.old.$$"; mv -- "$d" "$o" || exit 5; fi; ' +
  'mv -- "$t" "$d" || exit 6; ' +
  'if [ -n "$o" ]; then rm -rf -- "$o"; fi; exit 0';

/** $1 root, $2 temp dir: remove an unverified upload. */
export const DISCARD_PROGRAM =
  'tc="$1/toolchain"; case "$2" in "$tc"/.*.tmp.*) exec rm -rf -- "$2" ;; *) exit 3 ;; esac';

/** $1 root. Prints `NOW\t<epoch>` then `<mtime epoch>\t<name>` for each directory in toolchain/. */
export const GC_LIST_PROGRAM =
  'cd -- "$1/toolchain" 2>/dev/null || exit 0; printf "NOW\\t%s\\n" "$(date +%s)"; ' +
  'for f in * .[!.]*; do if [ -d "$f" ] && [ ! -L "$f" ]; then ' +
  'm=$(stat -f %m -- "$f" 2>/dev/null || stat -c %Y -- "$f" 2>/dev/null) && printf "%s\\t%s\\n" "$m" "$f"; fi; done';

/** $1 root, then names. Each name is re-checked against the GC shapes before `rm -rf`. */
export const GC_REMOVE_PROGRAM =
  'tc="$1/toolchain"; shift; for n in "$@"; do ' +
  'printf "%s" "$n" | grep -Eq "^(\\.)?[0-9a-f]{64}(\\.(tmp|old)\\.[0-9]+)?$" || continue; ' +
  'rm -rf -- "$tc/$n"; done';

function sh(program: string, ...args: string[]): string[] {
  return ['/bin/sh', '-c', program, 'sh', ...args];
}

// --- pure helpers -----------------------------------------------------------------------------------------------

export interface RemoteToolchainPaths {
  dir: string;
  claude: string;
  mcpBundle: string;
  codexBin: string | null;
  /** Prepend to the remote PATH (codex's helper binaries); null without codex. */
  codexPathDir: string | null;
}

export class InvalidToolchainRootError extends Error {
  constructor() {
    super('The remote folder must be an absolute path other than /.');
    this.name = 'InvalidToolchainRootError';
  }
}

function normaliseRoot(remoteRoot: string): string {
  // eslint-disable-next-line no-control-regex
  if (!remoteRoot.startsWith('/') || /[\u0000-\u001F\u007F]/.test(remoteRoot)) throw new InvalidToolchainRootError();
  const trimmed = remoteRoot.replace(/\/+$/, '');
  if (trimmed === '') throw new InvalidToolchainRootError();
  return trimmed;
}

/** Where the installed toolchain's pieces live on the host. */
export function remoteToolchainPaths(remoteRoot: string, manifest: Pick<ToolchainManifest, 'hash' | 'codexTarget'>): RemoteToolchainPaths {
  const dir = `${normaliseRoot(remoteRoot)}/toolchain/${manifest.hash}`;
  const codexDir = manifest.codexTarget ? `${dir}/${TOOLCHAIN_CODEX_DIR}/${manifest.codexTarget}` : null;
  return {
    dir,
    claude: `${dir}/${TOOLCHAIN_CLAUDE_REL}`,
    mcpBundle: `${dir}/${TOOLCHAIN_MCP_REL}`,
    codexBin: codexDir ? `${codexDir}/${CODEX_ENTRYPOINT_REL}` : null,
    codexPathDir: codexDir ? `${codexDir}/${CODEX_PATH_DIR_REL}` : null,
  };
}

export interface VerifyListing {
  tmpDir: string | null;
  hashes: Map<string, string>;
}

export function parseVerifyListing(stdout: string): VerifyListing {
  const hashes = new Map<string, string>();
  let tmpDir: string | null = null;
  for (const line of stdout.split('\n')) {
    if (line.length === 0) continue;
    const tab = line.indexOf('\t');
    if (tab < 0) continue;
    const key = line.slice(0, tab);
    const value = line.slice(tab + 1);
    if (key === 'TMP' && tmpDir === null) tmpDir = value;
    else hashes.set(key, value);
  }
  return { tmpDir, hashes };
}

/**
 * null when the remote listing matches the manifest exactly; else a short description of the first problem.
 * (The transport redacts stdout; were redaction ever to rewrite a name, this fails safe as a mismatch.)
 */
export function verifyAgainstManifest(manifest: ToolchainManifest, hashes: ReadonlyMap<string, string>): string | null {
  for (const f of manifest.files) {
    const got = hashes.get(f.rel);
    if (got === undefined) return `${f.rel} is missing on the host`;
    if (got !== f.sha256) return `${f.rel} does not match after upload`;
  }
  if (hashes.size !== manifest.files.length) {
    const extra = [...hashes.keys()].find((rel) => !manifest.files.some((f) => f.rel === rel));
    return `unexpected file on the host${extra ? `: ${extra}` : ''}`;
  }
  return null;
}

const GC_TMP_RE = /^\.([0-9a-f]{64})\.(tmp|old)\.[0-9]+$/;

export interface GcEntry {
  name: string;
  mtimeS: number;
}

/**
 * Names to delete: hash dirs beyond the current one + the newest other (by mtime, then name), and temp/old dirs
 * older than TOOLCHAIN_STALE_TMP_S. Anything not shaped like those is never selected.
 */
export function selectToolchainGc(entries: readonly GcEntry[], currentHash: string, nowS: number): string[] {
  const others = entries
    .filter((e) => TOOLCHAIN_HASH_RE.test(e.name) && e.name !== currentHash)
    .sort((a, b) => b.mtimeS - a.mtimeS || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const remove = others.slice(1).map((e) => e.name);
  for (const e of entries) {
    if (GC_TMP_RE.test(e.name) && nowS - e.mtimeS > TOOLCHAIN_STALE_TMP_S) remove.push(e.name);
  }
  return remove.sort();
}

export function parseGcListing(stdout: string): { nowS: number | null; entries: GcEntry[] } {
  let nowS: number | null = null;
  const entries: GcEntry[] = [];
  for (const line of stdout.split('\n')) {
    const tab = line.indexOf('\t');
    if (tab < 0) continue;
    const head = line.slice(0, tab);
    const name = line.slice(tab + 1);
    if (head === 'NOW') {
      const n = Number(name);
      if (Number.isFinite(n)) nowS = n;
      continue;
    }
    const m = Number(head);
    if (/^[0-9]+$/.test(head) && Number.isFinite(m) && name.length > 0) entries.push({ name, mtimeS: m });
  }
  return { nowS, entries };
}

// --- per-host mutex ---------------------------------------------------------------------------------------------

const hostChains = new Map<string, Promise<void>>();

async function withHostLock<T>(hostId: string, fn: () => Promise<T>): Promise<T> {
  const previous = hostChains.get(hostId) ?? Promise.resolve();
  let release!: () => void;
  const mine = new Promise<void>((resolve) => {
    release = resolve;
  });
  const chain = previous.then(() => mine);
  hostChains.set(hostId, chain);
  await previous;
  try {
    return await fn();
  } finally {
    release();
    if (hostChains.get(hostId) === chain) hostChains.delete(hostId);
  }
}

// --- push -------------------------------------------------------------------------------------------------------

export interface PushToolchainInput {
  hostId: string;
  transport: Pick<SshTransportLike, 'pushStream' | 'exec'>;
  /** Validated ssh destination. */
  target: string;
  /** Absolute, expanded remote root (from the probe), e.g. `/Users/me/cf-remote/<hostId>`. */
  remoteRoot: string;
  manifest: ToolchainManifest;
  /** Local source of every manifest file (buildToolchainManifest's `sources`). */
  sources: readonly ToolchainSourceFile[];
  onProgress?: (p: ToolchainProgress) => void;
  signal?: AbortSignal;
  /** Test seams. */
  fsDeps?: ToolchainHashFs;
  uploadTimeoutMs?: number;
  progressStepBytes?: number;
  logger?: LoggerLike;
}

export interface PushToolchainResult {
  hash: string;
  dir: string;
  /** True when a matching install was already there (nothing uploaded). */
  alreadyInstalled: boolean;
  /** Names GC removed under `toolchain/`. */
  removed: string[];
}

function tarEntries(manifest: ToolchainManifest, sources: readonly ToolchainSourceFile[], hostId: string): TarEntry[] {
  const byRel = new Map(sources.map((s) => [s.rel, s.path]));
  return manifest.files.map((f) => {
    const p = byRel.get(f.rel);
    if (!p) throw new ToolchainPushError('upload', hostId, `no local source for ${f.rel}`);
    return { name: f.rel, path: p, size: f.size, mode: f.mode };
  });
}

/** Install `manifest` on the host (idempotent). Serialised per host. */
export function pushToolchain(input: PushToolchainInput): Promise<PushToolchainResult> {
  return withHostLock(input.hostId, () => pushLocked(input));
}

async function pushLocked(input: PushToolchainInput): Promise<PushToolchainResult> {
  const { hostId, transport, target, manifest, signal } = input;
  if (!TOOLCHAIN_HASH_RE.test(manifest.hash)) throw new ToolchainPushError('check', hostId, 'invalid toolchain hash');
  let root: string;
  try {
    root = normaliseRoot(input.remoteRoot);
  } catch (e) {
    throw new ToolchainPushError('check', hostId, e instanceof Error ? e.message : String(e));
  }
  const paths = remoteToolchainPaths(root, manifest);
  const bytesTotal = manifest.files.reduce((n, f) => n + f.size, 0);
  const emit = (phase: ToolchainProgress['phase'], bytesSent: number): void => {
    try {
      input.onProgress?.({ hostId, phase, bytesSent, bytesTotal });
    } catch {
      /* a progress listener never breaks a push */
    }
  };
  const assertNotAborted = (): void => {
    if (signal?.aborted) throw new ToolchainPushError('aborted', hostId, 'cancelled');
  };
  const manifestText = serializeToolchainManifest(manifest);

  // 1. check
  assertNotAborted();
  const check = await transport.exec(target, sh(CHECK_PROGRAM, root, manifest.hash), { timeoutMs: TOOLCHAIN_CHECK_TIMEOUT_MS, signal });
  assertNotAborted();
  if (check.code === 0 && check.stdout === manifestText) {
    emit('done', bytesTotal);
    return { hash: manifest.hash, dir: paths.dir, alreadyInstalled: true, removed: [] };
  }
  if (check.code !== 0 && check.code !== 1) throw new ToolchainPushError('check', hostId, describeFailure(check));

  // 2. upload
  const entries = tarEntries(manifest, input.sources, hostId);
  const step = input.progressStepBytes ?? DEFAULT_PROGRESS_STEP_BYTES;
  let sent = 0;
  let lastEmitted = 0;
  emit('uploading', 0);
  const body = tarGzReadable(entries, input.fsDeps ?? nodeToolchainHashFs, (n) => {
    sent += n;
    if (sent - lastEmitted >= step || sent === bytesTotal) {
      lastEmitted = sent;
      emit('uploading', sent);
    }
  });
  const script = `set -- ${shQuote(root)} ${shQuote(manifest.hash)}; ${PUSH_PROGRAM}`;
  const upload = await transport.pushStream(target, script, body, {
    timeoutMs: input.uploadTimeoutMs ?? TOOLCHAIN_UPLOAD_TIMEOUT_MS,
    signal,
  });
  body.destroy();
  const listing = parseVerifyListing(upload.code === 0 ? upload.stdout : '');
  const discard = async (): Promise<void> => {
    if (!listing.tmpDir) return;
    try {
      await transport.exec(target, sh(DISCARD_PROGRAM, root, listing.tmpDir), { timeoutMs: TOOLCHAIN_INSTALL_TIMEOUT_MS });
    } catch {
      /* best effort; GC removes abandoned temp dirs later */
    }
  };
  if (signal?.aborted) {
    await discard();
    throw new ToolchainPushError('aborted', hostId, 'cancelled');
  }
  if (upload.code !== 0) throw new ToolchainPushError('upload', hostId, describeFailure(upload, PUSH_EXIT));

  // 3. verify
  emit('verifying', sent);
  const expectedTmpPrefix = `${root}/toolchain/.${manifest.hash}.tmp.`;
  const tmpDir = listing.tmpDir;
  if (!tmpDir || !tmpDir.startsWith(expectedTmpPrefix) || !/^[0-9]+$/.test(tmpDir.slice(expectedTmpPrefix.length))) {
    throw new ToolchainPushError('verify', hostId, 'the host did not report the unpacked folder');
  }
  const mismatch = verifyAgainstManifest(manifest, listing.hashes);
  if (mismatch) {
    await discard();
    throw new ToolchainPushError('verify', hostId, mismatch);
  }

  // 4. install
  const install = await transport.exec(target, sh(INSTALL_PROGRAM, root, manifest.hash, tmpDir), {
    stdin: manifestText,
    timeoutMs: TOOLCHAIN_INSTALL_TIMEOUT_MS,
    signal,
  });
  if (install.code !== 0) {
    await discard();
    throw new ToolchainPushError('install', hostId, describeFailure(install));
  }

  // 5. gc (best effort)
  let removed: string[] = [];
  try {
    removed = await collectGarbage(transport, target, root, manifest.hash);
  } catch (e) {
    input.logger?.warn('[hosts] toolchain gc failed', { hostId, error: redactSecrets(e instanceof Error ? e.message : String(e)) });
  }
  emit('done', bytesTotal);
  return { hash: manifest.hash, dir: paths.dir, alreadyInstalled: false, removed };
}

async function collectGarbage(
  transport: Pick<SshTransportLike, 'exec'>,
  target: string,
  root: string,
  currentHash: string,
): Promise<string[]> {
  const list = await transport.exec(target, sh(GC_LIST_PROGRAM, root), { timeoutMs: TOOLCHAIN_INSTALL_TIMEOUT_MS });
  if (list.code !== 0) throw new Error(describeFailure(list));
  const { nowS, entries } = parseGcListing(list.stdout);
  if (nowS === null) return [];
  const names = selectToolchainGc(entries, currentHash, nowS);
  if (names.length === 0) return [];
  const rm = await transport.exec(target, sh(GC_REMOVE_PROGRAM, root, ...names), { timeoutMs: TOOLCHAIN_INSTALL_TIMEOUT_MS });
  if (rm.code !== 0) throw new Error(describeFailure(rm));
  return names;
}
