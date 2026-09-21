#!/usr/bin/env node

/**
 * make-ico.mjs — pack PNGs into a Windows .ico.
 *
 * macOS ships no .ico writer (sips/iconutil only speak PNG and icns) and the
 * repo deliberately carries no ImageMagick/rsvg dependency, so the container is
 * assembled here. Modern .ico is just a 6-byte header, one 16-byte directory
 * entry per image, and the raw PNG bytes appended — Windows Vista and later
 * read PNG-compressed entries directly, which is what the committed
 * main/assets/icon.ico already uses for all seven of its sizes.
 *
 * Usage:
 *   node scripts/make-ico.mjs <out.ico> <16.png> <24.png> ... <256.png>
 *
 * Each input must be a real PNG; its dimensions are read from the IHDR chunk
 * rather than trusted from the filename, because a wrong entry size makes
 * Windows silently pick the wrong image.
 */

import fs from 'node:fs';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const HEADER_BYTES = 6;
const ENTRY_BYTES = 16;

function readPngSize(bytes, file) {
  if (bytes.length < 24 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error(`${file} is not a PNG`);
  }
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  if (width < 1 || width > 256 || height < 1 || height > 256) {
    throw new Error(`${file} is ${width}x${height}; .ico entries must be 1..256px`);
  }
  return { width, height };
}

const [outPath, ...pngPaths] = process.argv.slice(2);
if (!outPath || pngPaths.length === 0) {
  console.error('usage: make-ico.mjs <out.ico> <png>...');
  process.exit(1);
}

const images = pngPaths.map((file) => {
  const bytes = fs.readFileSync(file);
  return { file, bytes, ...readPngSize(bytes, file) };
});

const header = Buffer.alloc(HEADER_BYTES);
header.writeUInt16LE(0, 0);               // reserved
header.writeUInt16LE(1, 2);               // type 1 = icon
header.writeUInt16LE(images.length, 4);

const directory = Buffer.alloc(ENTRY_BYTES * images.length);
let offset = HEADER_BYTES + directory.length;

images.forEach((image, index) => {
  const at = index * ENTRY_BYTES;
  // 256 is encoded as 0 — the width/height fields are a single byte each.
  directory[at] = image.width === 256 ? 0 : image.width;
  directory[at + 1] = image.height === 256 ? 0 : image.height;
  directory[at + 2] = 0;                              // palette entries (0 = truecolor)
  directory[at + 3] = 0;                              // reserved
  directory.writeUInt16LE(1, at + 4);                 // color planes
  directory.writeUInt16LE(32, at + 6);                // bits per pixel
  directory.writeUInt32LE(image.bytes.length, at + 8);
  directory.writeUInt32LE(offset, at + 12);
  offset += image.bytes.length;
});

fs.writeFileSync(outPath, Buffer.concat([header, directory, ...images.map((i) => i.bytes)]));
console.log(`${outPath} (${images.length} sizes: ${images.map((i) => i.width).join(', ')})`);
