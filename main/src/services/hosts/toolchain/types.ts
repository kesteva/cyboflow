/**
 * Toolchain types (spec A5) — the content-addressed bundle of binaries a remote host needs to run agents:
 * the native `claude` binary, the self-contained cyboflow MCP server bundle and (when this build has it for the
 * host's arch) the whole Codex vendor tree. It is pushed once per toolchain hash to
 * `<remoteRoot>/toolchain/<hash>/`.
 */

/** The remote architecture, in node's `process.arch` spelling (also the claude / codex package suffix). */
export type ToolchainArch = 'arm64' | 'x64';

/** Remote layout version; part of the toolchain hash, so a layout change re-pushes every host. */
export const TOOLCHAIN_LAYOUT = 1;

/** One file of the bundle. `rel` is a POSIX path under the hash dir; `mode` is normalised to 0o755 / 0o644. */
export interface ToolchainFile {
  rel: string;
  sha256: string;
  size: number;
  mode: number;
}

/** Written to `<hash>/manifest.json` last, after every file verified; its presence means "installed". */
export interface ToolchainManifest {
  layout: typeof TOOLCHAIN_LAYOUT;
  hash: string;
  arch: ToolchainArch;
  claudeVersion: string | null;
  codexVersion: string | null;
  codexTarget: string | null;
  files: ToolchainFile[];
}

/** A manifest entry's local source file. */
export interface ToolchainSourceFile {
  rel: string;
  /** Absolute local path. */
  path: string;
}

export interface ToolchainProgress {
  hostId: string;
  phase: 'hashing' | 'uploading' | 'verifying' | 'done';
  bytesSent: number;
  bytesTotal: number;
}

export type ToolchainUnavailableReason = 'arch-missing' | 'mcp-unbundled';

/** This build cannot produce a toolchain for that arch (preflight FAIL for the host). */
export class ToolchainUnavailableError extends Error {
  readonly reason: ToolchainUnavailableReason;
  readonly arch: ToolchainArch;
  constructor(reason: ToolchainUnavailableReason, arch: ToolchainArch) {
    super(
      reason === 'arch-missing'
        ? `This build of cyboflow has no ${arch} tools`
        : 'The MCP server bundle is not built; run pnpm build:main',
    );
    this.name = 'ToolchainUnavailableError';
    this.reason = reason;
    this.arch = arch;
  }
}

/** Map the probe's `uname -m` to a ToolchainArch; null for anything this build cannot serve. */
export function toolchainArchFromUname(unameM: string): ToolchainArch | null {
  switch (unameM.trim()) {
    case 'arm64':
    case 'aarch64':
      return 'arm64';
    case 'x86_64':
      return 'x64';
    default:
      return null;
  }
}

/** A toolchain hash (lowercase sha256 hex) — also the only directory-name shape the GC ever deletes. */
export const TOOLCHAIN_HASH_RE = /^[0-9a-f]{64}$/;

/** Fixed names inside a hash dir. */
export const TOOLCHAIN_CLAUDE_REL = 'claude';
export const TOOLCHAIN_MCP_REL = 'cyboflowMcpServer.js';
export const TOOLCHAIN_CODEX_DIR = 'codex';
export const TOOLCHAIN_MANIFEST_NAME = 'manifest.json';
/** Mirrors the darwin manifest checks in codexExecutablePath.ts (entrypoint `bin/codex`, pathDir `codex-path`). */
export const CODEX_ENTRYPOINT_REL = 'bin/codex';
export const CODEX_PATH_DIR_REL = 'codex-path';
