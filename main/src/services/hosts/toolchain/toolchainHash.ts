/**
 * toolchainHash — per-file sha256 and the toolchain manifest (spec A5).
 *
 *  - Files are hashed STREAMED (the claude binary is ~220 MB; it is never read into memory at once) and cached by
 *    (path, size, mtimeMs), so re-building a manifest for an unchanged build costs one stat per file.
 *  - The toolchain hash = sha256 over the files sorted by `rel`, one `rel\0sha256\0mode(octal)\n` line each,
 *    followed by `layout=<TOOLCHAIN_LAYOUT>`. Claude's version, the MCP bundle and Codex's version/target are
 *    all covered through the file contents and paths; the app version is deliberately NOT included (every dev
 *    build would otherwise re-push ~550 MB).
 *  - Modes are normalised to 0o755 (any execute bit) / 0o644 so a checkout's umask cannot change the hash.
 *  - The Codex vendor tree is walked without following symlinks; a symlink or special file inside it is refused
 *    (the tar writer only emits regular files).
 */
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Readable } from 'node:stream';
import type { ResolvedToolchainSources } from './toolchainResolver';
import {
  TOOLCHAIN_CLAUDE_REL,
  TOOLCHAIN_CODEX_DIR,
  TOOLCHAIN_LAYOUT,
  TOOLCHAIN_MANIFEST_NAME,
  TOOLCHAIN_MCP_REL,
  type ToolchainFile,
  type ToolchainManifest,
  type ToolchainSourceFile,
} from './types';

export interface ToolchainFileStat {
  size: number;
  mtimeMs: number;
  mode: number;
  isFile: boolean;
  isDirectory: boolean;
  isSymbolicLink: boolean;
}

/** The filesystem the hasher / walker use (tests inject spies; production is node:fs). */
export interface ToolchainHashFs {
  /** lstat semantics: a symlink reports isSymbolicLink. */
  lstat(p: string): Promise<ToolchainFileStat>;
  readdir(p: string): Promise<string[]>;
  openRead(p: string): Readable;
}

export const nodeToolchainHashFs: ToolchainHashFs = {
  lstat: async (p) => {
    const s = await fs.promises.lstat(p);
    return {
      size: s.size,
      mtimeMs: s.mtimeMs,
      mode: s.mode,
      isFile: s.isFile(),
      isDirectory: s.isDirectory(),
      isSymbolicLink: s.isSymbolicLink(),
    };
  },
  readdir: (p) => fs.promises.readdir(p),
  openRead: (p) => fs.createReadStream(p, { highWaterMark: 1024 * 1024 }),
};

export class InvalidToolchainFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidToolchainFileError';
  }
}

export function normalizeToolchainMode(mode: number): number {
  return (mode & 0o111) !== 0 ? 0o755 : 0o644;
}

/**
 * A safe manifest `rel`: relative POSIX segments, no `.`/`..`/empty segment, no control characters (a tab or
 * newline would break the remote verification listing), and not the manifest itself.
 */
export function isValidToolchainRel(rel: string): boolean {
  // eslint-disable-next-line no-control-regex
  if (rel.length === 0 || rel.startsWith('/') || /[\u0000-\u001F\u007F\\]/.test(rel)) return false;
  if (rel === TOOLCHAIN_MANIFEST_NAME) return false;
  return rel.split('/').every((seg) => seg.length > 0 && seg !== '.' && seg !== '..');
}

interface CacheEntry {
  size: number;
  mtimeMs: number;
  sha256: string;
}

export interface HashedFile {
  sha256: string;
  size: number;
  /** Normalised (0o755 / 0o644). */
  mode: number;
}

/** Streamed sha256 with a (path, size, mtimeMs) cache. One instance per process is the norm. */
export class ToolchainHasher {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly inflight = new Map<string, Promise<string>>();

  constructor(private readonly fsDeps: ToolchainHashFs = nodeToolchainHashFs) {}

  /** Hash one regular file. `onBytes` sees each chunk's length as it is hashed (cache hits report the size). */
  async hashFile(p: string, onBytes?: (n: number) => void): Promise<HashedFile> {
    const st = await this.fsDeps.lstat(p);
    if (!st.isFile || st.isSymbolicLink) throw new InvalidToolchainFileError(`Not a regular file: ${p}`);
    const mode = normalizeToolchainMode(st.mode);
    const hit = this.cache.get(p);
    if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs) {
      onBytes?.(st.size);
      return { sha256: hit.sha256, size: st.size, mode };
    }
    const key = `${p}\0${st.size}\0${st.mtimeMs}`;
    let pending = this.inflight.get(key);
    if (!pending) {
      pending = this.stream(p, onBytes).finally(() => this.inflight.delete(key));
      this.inflight.set(key, pending);
    }
    const sha256 = await pending;
    this.cache.set(p, { size: st.size, mtimeMs: st.mtimeMs, sha256 });
    return { sha256, size: st.size, mode };
  }

  private async stream(p: string, onBytes?: (n: number) => void): Promise<string> {
    const hash = createHash('sha256');
    for await (const chunk of this.fsDeps.openRead(p) as AsyncIterable<Buffer | string>) {
      const buf = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
      hash.update(buf);
      onBytes?.(buf.length);
    }
    return hash.digest('hex');
  }
}

/** The process-wide hasher (its cache is what makes repeated manifest builds cheap). */
export const defaultToolchainHasher = new ToolchainHasher();

/** The toolchain hash over (rel, sha256, mode) of every file + the layout version. Order-independent. */
export function computeToolchainHash(files: readonly Pick<ToolchainFile, 'rel' | 'sha256' | 'mode'>[]): string {
  const sorted = [...files].sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  const hash = createHash('sha256');
  for (const f of sorted) hash.update(`${f.rel}\0${f.sha256}\0${f.mode.toString(8)}\n`);
  hash.update(`layout=${TOOLCHAIN_LAYOUT}`);
  return hash.digest('hex');
}

async function walkRegularFiles(fsDeps: ToolchainHashFs, root: string, relPrefix: string): Promise<ToolchainSourceFile[]> {
  const out: ToolchainSourceFile[] = [];
  const names = (await fsDeps.readdir(root)).sort();
  for (const name of names) {
    const abs = path.join(root, name);
    const rel = `${relPrefix}/${name}`;
    const st = await fsDeps.lstat(abs);
    if (st.isSymbolicLink) throw new InvalidToolchainFileError(`Symlinks are not supported in the toolchain: ${abs}`);
    if (st.isDirectory) out.push(...(await walkRegularFiles(fsDeps, abs, rel)));
    else if (st.isFile) out.push({ rel, path: abs });
    else throw new InvalidToolchainFileError(`Unsupported file type in the toolchain: ${abs}`);
  }
  return out;
}

/** Every file of the bundle with its local source, sorted by rel. */
export async function listToolchainSources(
  resolved: ResolvedToolchainSources,
  fsDeps: ToolchainHashFs = nodeToolchainHashFs,
): Promise<ToolchainSourceFile[]> {
  const files: ToolchainSourceFile[] = [
    { rel: TOOLCHAIN_CLAUDE_REL, path: resolved.claudePath },
    { rel: TOOLCHAIN_MCP_REL, path: resolved.mcpBundlePath },
  ];
  if (resolved.codex) {
    files.push(...(await walkRegularFiles(fsDeps, resolved.codex.vendorDir, `${TOOLCHAIN_CODEX_DIR}/${resolved.codex.target}`)));
  }
  for (const f of files) {
    if (!isValidToolchainRel(f.rel)) throw new InvalidToolchainFileError(`Unsupported toolchain file name: ${f.rel}`);
  }
  return files.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
}

export interface BuildToolchainManifestOptions {
  hasher?: ToolchainHasher;
  fsDeps?: ToolchainHashFs;
  /** Bytes hashed so far / total bytes of the bundle (the 'hashing' progress phase). */
  onHashProgress?: (bytesDone: number, bytesTotal: number) => void;
}

export interface BuiltToolchain {
  manifest: ToolchainManifest;
  sources: ToolchainSourceFile[];
}

/** Hash every file and assemble the manifest for one arch. */
export async function buildToolchainManifest(
  resolved: ResolvedToolchainSources,
  opts: BuildToolchainManifestOptions = {},
): Promise<BuiltToolchain> {
  const fsDeps = opts.fsDeps ?? nodeToolchainHashFs;
  const hasher = opts.hasher ?? defaultToolchainHasher;
  const sources = await listToolchainSources(resolved, fsDeps);
  let total = 0;
  for (const s of sources) total += (await fsDeps.lstat(s.path)).size;
  let done = 0;
  const files: ToolchainFile[] = [];
  for (const s of sources) {
    const h = await hasher.hashFile(s.path, (n) => {
      done += n;
      opts.onHashProgress?.(Math.min(done, total), total);
    });
    files.push({ rel: s.rel, sha256: h.sha256, size: h.size, mode: h.mode });
  }
  const manifest: ToolchainManifest = {
    layout: TOOLCHAIN_LAYOUT,
    hash: computeToolchainHash(files),
    arch: resolved.arch,
    claudeVersion: resolved.claudeVersion,
    codexVersion: resolved.codex?.version ?? null,
    codexTarget: resolved.codex?.target ?? null,
    files,
  };
  return { manifest, sources };
}

/** The exact bytes of `<hash>/manifest.json` (the installed check compares this text). */
export function serializeToolchainManifest(manifest: ToolchainManifest): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}
