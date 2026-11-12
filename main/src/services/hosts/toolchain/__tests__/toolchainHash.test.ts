import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  InvalidToolchainFileError,
  ToolchainHasher,
  buildToolchainManifest,
  computeToolchainHash,
  isValidToolchainRel,
  listToolchainSources,
  nodeToolchainHashFs,
  normalizeToolchainMode,
  serializeToolchainManifest,
  type ToolchainHashFs,
} from '../toolchainHash';
import { TOOLCHAIN_HASH_RE } from '../types';
import { makeFakeToolchain, writeFile } from './fixtures';

/** node fs with a counter on openRead (each call = one streamed hash). */
function countingFs(): { fsDeps: ToolchainHashFs; opened: string[] } {
  const opened: string[] = [];
  return {
    opened,
    fsDeps: {
      ...nodeToolchainHashFs,
      openRead: (p) => {
        opened.push(p);
        return fs.createReadStream(p, { highWaterMark: 1024 });
      },
    },
  };
}

function sha(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

describe('computeToolchainHash', () => {
  const files = [
    { rel: 'claude', sha256: 'a'.repeat(64), mode: 0o755 },
    { rel: 'cyboflowMcpServer.js', sha256: 'b'.repeat(64), mode: 0o755 },
    { rel: 'codex/t/bin/codex', sha256: 'c'.repeat(64), mode: 0o755 },
  ];

  it('is sha256 over sorted rel\\0sha\\0mode lines + layout=1', () => {
    const expected = sha(
      `claude\u0000${'a'.repeat(64)}\u0000755\n` +
      `codex/t/bin/codex\u0000${'c'.repeat(64)}\u0000755\n` +
      `cyboflowMcpServer.js\u0000${'b'.repeat(64)}\u0000755\n` +
      'layout=1',
    );
    expect(computeToolchainHash(files)).toBe(expected);
    expect(TOOLCHAIN_HASH_RE.test(expected)).toBe(true);
  });

  it('does not depend on input order', () => {
    expect(computeToolchainHash([...files].reverse())).toBe(computeToolchainHash(files));
  });

  it('changes with content, mode or path', () => {
    const base = computeToolchainHash(files);
    expect(computeToolchainHash([{ ...files[0], sha256: 'd'.repeat(64) }, files[1], files[2]])).not.toBe(base);
    expect(computeToolchainHash([{ ...files[0], mode: 0o644 }, files[1], files[2]])).not.toBe(base);
    expect(computeToolchainHash([{ ...files[0], rel: 'claude2' }, files[1], files[2]])).not.toBe(base);
  });
});

describe('normalizeToolchainMode / isValidToolchainRel', () => {
  it('collapses modes to 0755 / 0644', () => {
    expect(normalizeToolchainMode(0o100700)).toBe(0o755);
    expect(normalizeToolchainMode(0o100744)).toBe(0o755);
    expect(normalizeToolchainMode(0o100600)).toBe(0o644);
    expect(normalizeToolchainMode(0o100664)).toBe(0o644);
  });

  it('accepts plain relative paths only', () => {
    expect(isValidToolchainRel('codex/aarch64-apple-darwin/bin/codex')).toBe(true);
    for (const bad of ['', '/abs', 'a/../b', './a', 'a//b', 'a\tb', 'a\nb', 'manifest.json', 'a\\b']) {
      expect(isValidToolchainRel(bad)).toBe(false);
    }
  });
});

describe('buildToolchainManifest', () => {
  // The manifest records the local file mode; Windows has no executable bit, so claude reads back 0644.
  it.skipIf(process.platform === 'win32')('lists claude, the MCP bundle and every codex vendor file with their hashes', async () => {
    const { resolved } = makeFakeToolchain();
    const { manifest, sources } = await buildToolchainManifest(resolved, { hasher: new ToolchainHasher() });
    expect(manifest.files.map((f) => f.rel)).toEqual([
      'claude',
      'codex/aarch64-apple-darwin/bin/codex',
      'codex/aarch64-apple-darwin/codex-package.json',
      'codex/aarch64-apple-darwin/codex-path/rg',
      'codex/aarch64-apple-darwin/codex-resources/voice/manifest.json',
      'cyboflowMcpServer.js',
    ]);
    expect(sources.map((s) => s.rel)).toEqual(manifest.files.map((f) => f.rel));
    const claude = manifest.files.find((f) => f.rel === 'claude');
    expect(claude).toEqual({ rel: 'claude', sha256: sha(Buffer.alloc(3000, 7)), size: 3000, mode: 0o755 });
    expect(manifest.files.find((f) => f.rel.endsWith('voice/manifest.json'))?.mode).toBe(0o644);
    expect(manifest).toMatchObject({
      layout: 1,
      arch: 'arm64',
      claudeVersion: '0.3.284',
      codexVersion: '0.159.2',
      codexTarget: 'aarch64-apple-darwin',
    });
    expect(manifest.hash).toBe(computeToolchainHash(manifest.files));
  });

  it('is deterministic across builds and hashers', async () => {
    const { resolved } = makeFakeToolchain();
    const a = await buildToolchainManifest(resolved, { hasher: new ToolchainHasher() });
    const b = await buildToolchainManifest(resolved, { hasher: new ToolchainHasher() });
    expect(serializeToolchainManifest(a.manifest)).toBe(serializeToolchainManifest(b.manifest));
  });

  it('a claude-only toolchain has null codex fields', async () => {
    const { resolved } = makeFakeToolchain({ withCodex: false });
    const { manifest } = await buildToolchainManifest(resolved, { hasher: new ToolchainHasher() });
    expect(manifest.files.map((f) => f.rel)).toEqual(['claude', 'cyboflowMcpServer.js']);
    expect(manifest.codexTarget).toBeNull();
    expect(manifest.codexVersion).toBeNull();
  });

  it('reuses cached hashes by (path, size, mtime) and re-hashes a changed file', async () => {
    const { resolved } = makeFakeToolchain();
    const { fsDeps, opened } = countingFs();
    const hasher = new ToolchainHasher(fsDeps);
    const first = await buildToolchainManifest(resolved, { hasher, fsDeps });
    expect(opened).toHaveLength(6);

    opened.length = 0;
    const second = await buildToolchainManifest(resolved, { hasher, fsDeps });
    expect(opened).toHaveLength(0);
    expect(second.manifest.hash).toBe(first.manifest.hash);

    // Same size, new content and mtime: only that file is re-read.
    writeFile(resolved.claudePath, Buffer.alloc(3000, 9), 0o755);
    const future = new Date(Date.now() + 60_000);
    fs.utimesSync(resolved.claudePath, future, future);
    const third = await buildToolchainManifest(resolved, { hasher, fsDeps });
    expect(opened).toEqual([resolved.claudePath]);
    expect(third.manifest.hash).not.toBe(first.manifest.hash);
  });

  it('streams files in chunks (never one whole-file read) and reports hashing progress', async () => {
    const { resolved } = makeFakeToolchain({ claudeBytes: 10_000 });
    const { fsDeps } = countingFs();
    const seen: Array<[number, number]> = [];
    const { manifest } = await buildToolchainManifest(resolved, {
      hasher: new ToolchainHasher(fsDeps),
      fsDeps,
      onHashProgress: (done, total) => seen.push([done, total]),
    });
    const total = manifest.files.reduce((n, f) => n + f.size, 0);
    expect(seen.length).toBeGreaterThan(10); // 1 KiB chunks
    expect(seen[seen.length - 1]).toEqual([total, total]);
    expect(seen.every(([d], i) => i === 0 || d >= seen[i - 1][0])).toBe(true);
  });

  it('refuses a symlink inside the codex vendor tree', async () => {
    const { resolved } = makeFakeToolchain();
    const vendor = resolved.codex?.vendorDir ?? '';
    fs.symlinkSync(path.join(vendor, 'bin', 'codex'), path.join(vendor, 'bin', 'codex-link'));
    await expect(listToolchainSources(resolved)).rejects.toBeInstanceOf(InvalidToolchainFileError);
  });
});
