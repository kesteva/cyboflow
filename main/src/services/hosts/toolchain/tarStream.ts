/**
 * tarStream — a minimal streaming ustar writer + gzip, the upload body of a toolchain push.
 *
 * Why not the system `tar`: `tar -czf - -C <dir>` needs every file under ONE directory with its final relative
 * name, i.e. a staging dir of symlinks (and `-h`) assembled from three unrelated locations, cleaned up afterwards,
 * and its progress is opaque. Writing the archive in-process needs ~60 lines, streams each file from disk with
 * backpressure (nothing is buffered whole), reports exact progress in source bytes and leaves no temp files.
 *
 * Format: POSIX ustar, regular files only (no directory entries — both bsdtar and GNU tar create parents), uid/gid
 * 0, mtime 0, the manifest's normalised mode; names over 100 bytes use the ustar prefix field (≤ 155 + 100).
 * Compression: zlib gzip level 1 (the binaries barely compress; speed matters more).
 */
import { pipeline, Readable } from 'node:stream';
import { createGzip } from 'node:zlib';
import type { ToolchainHashFs } from './toolchainHash';

const BLOCK = 512;

export interface TarEntry {
  /** Archive path (POSIX, relative). */
  name: string;
  /** Local file to stream. */
  path: string;
  size: number;
  mode: number;
}

export class TarNameTooLongError extends Error {
  constructor(name: string) {
    super(`Toolchain file name too long for the archive: ${name}`);
    this.name = 'TarNameTooLongError';
  }
}

function writeOctal(buf: Buffer, offset: number, width: number, value: number): void {
  // width includes the terminating NUL
  const text = value.toString(8).padStart(width - 1, '0');
  if (text.length > width - 1) throw new Error('tar header field overflow');
  buf.write(text, offset, width - 1, 'ascii');
  buf[offset + width - 1] = 0;
}

function splitName(name: string): { prefix: string; base: string } {
  if (Buffer.byteLength(name) <= 100) return { prefix: '', base: name };
  for (let i = name.indexOf('/'); i !== -1; i = name.indexOf('/', i + 1)) {
    const prefix = name.slice(0, i);
    const base = name.slice(i + 1);
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(base) <= 100 && base.length > 0) return { prefix, base };
  }
  throw new TarNameTooLongError(name);
}

/** One 512-byte ustar header for a regular file. */
export function tarHeader(entry: Pick<TarEntry, 'name' | 'size' | 'mode'>): Buffer {
  const { prefix, base } = splitName(entry.name);
  const h = Buffer.alloc(BLOCK, 0);
  h.write(base, 0, 100, 'utf8');
  writeOctal(h, 100, 8, entry.mode & 0o7777);
  writeOctal(h, 108, 8, 0); // uid
  writeOctal(h, 116, 8, 0); // gid
  writeOctal(h, 124, 12, entry.size);
  writeOctal(h, 136, 12, 0); // mtime
  h.fill(0x20, 148, 156); // checksum placeholder: 8 spaces
  h.write('0', 156, 1, 'ascii'); // typeflag: regular file
  h.write('ustar\u000000', 257, 8, 'ascii'); // magic "ustar\0" + version "00"
  h.write(prefix, 345, 155, 'utf8');
  let sum = 0;
  for (const b of h) sum += b;
  h.write(`${sum.toString(8).padStart(6, '0')}\u0000 `, 148, 8, 'ascii');
  return h;
}

function padding(size: number): Buffer | null {
  const rem = size % BLOCK;
  return rem === 0 ? null : Buffer.alloc(BLOCK - rem, 0);
}

/**
 * The uncompressed archive as a Readable. `onSourceBytes` sees each file chunk's length as the archive consumes
 * it (the progress unit). A file whose size changed since the manifest was built fails the stream.
 */
export function tarReadable(entries: readonly TarEntry[], fsDeps: ToolchainHashFs, onSourceBytes?: (n: number) => void): Readable {
  async function* generate(): AsyncGenerator<Buffer> {
    for (const e of entries) {
      yield tarHeader(e);
      let seen = 0;
      for await (const chunk of fsDeps.openRead(e.path) as AsyncIterable<Buffer | string>) {
        const buf = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
        seen += buf.length;
        if (seen > e.size) throw new Error(`A toolchain file changed while uploading: ${e.name}`);
        yield buf;
        onSourceBytes?.(buf.length);
      }
      if (seen !== e.size) throw new Error(`A toolchain file changed while uploading: ${e.name}`);
      const pad = padding(e.size);
      if (pad) yield pad;
    }
    yield Buffer.alloc(BLOCK * 2, 0);
  }
  return Readable.from(generate(), { objectMode: false });
}

/** The gzip'd archive. An error anywhere (a file read, the gzip) destroys the returned stream with it. */
export function tarGzReadable(entries: readonly TarEntry[], fsDeps: ToolchainHashFs, onSourceBytes?: (n: number) => void): Readable {
  const gz = createGzip({ level: 1 });
  pipeline(tarReadable(entries, fsDeps, onSourceBytes), gz, () => {
    /* errors surface on `gz` (pipeline destroys it with the cause) */
  });
  return gz;
}
