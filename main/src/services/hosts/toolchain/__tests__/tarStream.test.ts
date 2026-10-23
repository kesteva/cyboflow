import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { nodeToolchainHashFs } from '../toolchainHash';
import { TarNameTooLongError, tarGzReadable, tarHeader, tarReadable, type TarEntry } from '../tarStream';
import { makeTempDir, writeFile } from './fixtures';

async function collect(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const c of stream as AsyncIterable<Buffer>) parts.push(c);
  return Buffer.concat(parts);
}

interface ParsedEntry {
  name: string;
  mode: number;
  size: number;
  data: Buffer;
}

/** Minimal ustar reader (regular files) that also validates each header checksum. */
function parseTar(buf: Buffer): ParsedEntry[] {
  const out: ParsedEntry[] = [];
  let off = 0;
  const cstr = (b: Buffer): string => b.toString('utf8').replace(/\0.*$/s, '');
  while (off + 512 <= buf.length) {
    const h = buf.subarray(off, off + 512);
    if (h.every((b) => b === 0)) break;
    const stored = parseInt(cstr(h.subarray(148, 156)).trim(), 8);
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 0x20 : h[i];
    expect(sum).toBe(stored);
    expect(h.subarray(257, 263).toString('latin1')).toBe('ustar\0');
    const prefix = cstr(h.subarray(345, 500));
    const base = cstr(h.subarray(0, 100));
    const size = parseInt(cstr(h.subarray(124, 136)), 8);
    const mode = parseInt(cstr(h.subarray(100, 108)), 8);
    off += 512;
    out.push({ name: prefix ? `${prefix}/${base}` : base, mode, size, data: buf.subarray(off, off + size) });
    off += Math.ceil(size / 512) * 512;
  }
  return out;
}

function fixture(): { dir: string; entries: TarEntry[] } {
  const dir = makeTempDir();
  const files: Array<[string, Buffer, number]> = [
    ['claude', Buffer.alloc(1300, 1), 0o755],
    ['codex/t/bin/codex', Buffer.from('codex'), 0o755],
    ['codex/t/empty', Buffer.alloc(0), 0o644],
    ['codex/t/aligned', Buffer.alloc(512, 3), 0o644],
  ];
  const entries: TarEntry[] = [];
  for (const [name, data, mode] of files) {
    const p = path.join(dir, 'src', name.replace(/\//g, '_'));
    writeFile(p, data, mode);
    entries.push({ name, path: p, size: data.length, mode });
  }
  return { dir, entries };
}

describe('tarStream', () => {
  it('writes a valid ustar archive with names, modes, sizes and contents', async () => {
    const { entries } = fixture();
    const raw = await collect(tarReadable(entries, nodeToolchainHashFs));
    expect(raw.length % 512).toBe(0);
    const parsed = parseTar(raw);
    expect(parsed.map((e) => [e.name, e.mode, e.size])).toEqual(entries.map((e) => [e.name, e.mode, e.size]));
    for (const e of entries) {
      expect(parsed.find((p) => p.name === e.name)?.data.equals(fs.readFileSync(e.path))).toBe(true);
    }
  });

  it('reports every source byte through onSourceBytes', async () => {
    const { entries } = fixture();
    let n = 0;
    await collect(tarReadable(entries, nodeToolchainHashFs, (b) => (n += b)));
    expect(n).toBe(entries.reduce((s, e) => s + e.size, 0));
  });

  it('gzip output round-trips', async () => {
    const { entries } = fixture();
    const gz = await collect(tarGzReadable(entries, nodeToolchainHashFs));
    expect(parseTar(gunzipSync(gz)).map((e) => e.name)).toEqual(entries.map((e) => e.name));
  });

  it('splits long names into the ustar prefix field and refuses ones that cannot fit', () => {
    const long = `codex/${'d'.repeat(80)}/${'f'.repeat(60)}`;
    const h = tarHeader({ name: long, size: 0, mode: 0o644 });
    expect(h.subarray(0, 100).toString('utf8').replace(/\0+$/, '')).toBe('f'.repeat(60));
    expect(h.subarray(345, 500).toString('utf8').replace(/\0+$/, '')).toBe(`codex/${'d'.repeat(80)}`);
    expect(() => tarHeader({ name: 'x'.repeat(101), size: 0, mode: 0o644 })).toThrow(TarNameTooLongError);
  });

  it('fails the stream when a file changed size after the manifest was built', async () => {
    const { entries } = fixture();
    fs.appendFileSync(entries[1].path, 'more');
    await expect(collect(tarGzReadable(entries, nodeToolchainHashFs))).rejects.toThrow(/changed while uploading/);
  });

  it.skipIf(process.platform === 'win32')('extracts with the system tar', async () => {
    const { dir, entries } = fixture();
    const gz = await collect(tarGzReadable(entries, nodeToolchainHashFs));
    const out = path.join(dir, 'out');
    fs.mkdirSync(out);
    const r = spawnSync('tar', ['-xzf', '-', '-C', out], { input: gz });
    expect(r.status).toBe(0);
    for (const e of entries) {
      const p = path.join(out, ...e.name.split('/'));
      expect(fs.readFileSync(p).equals(fs.readFileSync(e.path))).toBe(true);
      expect(fs.statSync(p).mode & 0o100).toBe(e.mode & 0o100);
    }
  });
});
