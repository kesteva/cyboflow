/**
 * mobileCommands unit tests — NO simulator, NO Xcode, NO Maestro JVM.
 *
 * The seam is split deliberately. Every SUBPROCESS is faked (`runTool`), but the
 * FILESYSTEM is real, in a per-test temp dir, and the deps come off
 * `createDefaultDriverDeps()` so the glob, the `lstat`-vs-`stat` symlink probe
 * and the realpath containment check are exercised as they actually ship. A
 * fake filesystem would have made the three confinement tests here assertions
 * about the fake: the escape cases are precisely the ones where node's real
 * `realpath` semantics are the thing under test.
 *
 * Everything is driven through `runDriverCommand`, not `runMobileCommand`, so
 * each case also proves the driverCore dispatcher routes the word and that the
 * modality guard let it through.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { deflateSync } from 'node:zlib';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDefaultDriverDeps, runDriverCommand, type DriverDeps } from '../driverCore';
import {
  DEFAULT_APP_PRODUCT_GLOB,
  isUniformPng,
  maestroFlowYaml,
  maestroTestArgs,
  MOBILE_EXIT_OK,
  MOBILE_EXIT_READINESS_TIMEOUT,
  MOBILE_EXIT_REFUSED,
  MOBILE_EXIT_USAGE,
  mobileDriveRefusal,
  parseGlobSegments,
  parseLaunchPid,
  parseMobileArgv,
  READY_POLL_INTERVAL_MS,
  resolveReadyTimeoutMs,
  sanitizeMobileScreenshotName,
  yamlScalar,
  type MobileInstallRecord,
} from '../mobileCommands';

const UDID = '11111111-2222-3333-4444-555555555555';
const BUNDLE_ID = 'com.example.Demo';
const EXECUTABLE = 'Demo';

// ---------------------------------------------------------------------------
// Tiny PNG encoder — the readiness loop's fixtures
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
}

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** An 8-bit RGBA non-interlaced PNG whose scanlines all use filter 0 (None). */
function encodeRgbaPng(
  width: number,
  height: number,
  pixel: (x: number, y: number) => [number, number, number, number],
): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: truecolour + alpha
  const raw = Buffer.alloc((width * 4 + 1) * height);
  let pos = 0;
  for (let y = 0; y < height; y++) {
    raw[pos++] = 0; // filter: None
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = pixel(x, y);
      raw[pos++] = r;
      raw[pos++] = g;
      raw[pos++] = b;
      raw[pos++] = a;
    }
  }
  return Buffer.concat([
    PNG_SIG,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * A SOLID RGBA image encoded with one of the delta filters. For a flat colour
 * every predictor (Sub/Up/Paeth) predicts exactly right after the first sample,
 * so the encoded scanlines are the colour once and then zeros — which is both
 * how a real encoder would emit a blank frame and the cheapest way to exercise
 * the unfilter path without a PNG library.
 */
function solidPngWithFilter(
  width: number,
  height: number,
  rgba: [number, number, number, number],
  filterType: 1 | 2 | 4,
): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  let pos = 0;
  for (let y = 0; y < height; y++) {
    // Row 0 has no row above it, so Up/Paeth would predict 0 there; emit it
    // unfiltered, exactly as a real encoder does.
    const filter = y === 0 && filterType !== 1 ? 0 : filterType;
    raw[pos++] = filter;
    for (let x = 0; x < width; x++) {
      const literal = filter === 0 || (filter === 1 && x === 0);
      for (let c = 0; c < 4; c++) raw[pos++] = literal ? rgba[c] : 0;
    }
  }
  return Buffer.concat([
    PNG_SIG,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

const WHITE = encodeRgbaPng(8, 8, () => [255, 255, 255, 255]);
const BLACK = encodeRgbaPng(8, 8, () => [0, 0, 0, 255]);
const TWO_TONE = encodeRgbaPng(8, 8, (x) => (x < 4 ? [255, 0, 0, 255] : [0, 0, 255, 255]));

// ---------------------------------------------------------------------------
// The deps seam: real filesystem, faked subprocesses and clock
// ---------------------------------------------------------------------------

interface ToolInvocation {
  bin: string;
  args: string[];
}

/** One faked subprocess outcome, matched against the argv the driver builds. */
interface ToolStub {
  match: (bin: string, args: string[]) => boolean;
  code?: number;
  stdout?: string;
  stderr?: string;
  /** Side effect (e.g. writing a fake screenshot frame) run before resolving. */
  effect?: (bin: string, args: string[]) => Promise<void>;
}

interface Harness {
  deps: DriverDeps;
  tools: ToolInvocation[];
  out: string[];
  err: string[];
  /** Virtual clock, advanced by every `sleep`. */
  clock: { t: number };
  alive: { value: boolean };
}

function makeHarness(
  root: string,
  stubs: ToolStub[],
  overrides: Partial<DriverDeps> = {},
): Harness {
  const tools: ToolInvocation[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const clock = { t: 1_000 };
  const alive = { value: true };
  const real = createDefaultDriverDeps();
  const deps: DriverDeps = {
    ...real,
    runTool: async (bin, args) => {
      tools.push({ bin, args });
      const stub = stubs.find((s) => s.match(bin, args));
      if (!stub) return { code: 127, stdout: '', stderr: `no stub for ${bin} ${args.join(' ')}` };
      if (stub.effect) await stub.effect(bin, args);
      return { code: stub.code ?? 0, stdout: stub.stdout ?? '', stderr: stub.stderr ?? '' };
    },
    isProcessAlive: () => alive.value,
    now: () => clock.t,
    sleep: async (ms) => {
      clock.t += ms;
    },
    cwd: () => root,
    stdout: (line) => out.push(line),
    stderr: (line) => err.push(line),
    ...overrides,
  };
  return { deps, tools, out, err, clock, alive };
}

function mobileEnv(root: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    VERIFY_MODALITY: 'mobile',
    VERIFY_ARTIFACTS_DIR: join(root, 'artifacts'),
    VERIFY_SIM_UDID: UDID,
    VERIFY_APP_BUNDLE_ID: BUNDLE_ID,
    VERIFY_DERIVED_DATA: join(root, 'dd'),
    VERIFY_MOBILE_DRIVE: 'none',
    ...extra,
  };
}

/** Build a plausible `.app` under `<dir>` with an executable of the given bytes. */
async function makeAppBundle(dir: string, executableBytes: string): Promise<string> {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'Info.plist'), '<binary plist stand-in>', 'utf8');
  await writeFile(join(dir, EXECUTABLE), executableBytes, 'utf8');
  return dir;
}

/** The `plutil` stub answering for a bundle's Info.plist. */
function plutilStub(bundleId = BUNDLE_ID, executable = EXECUTABLE): ToolStub {
  return {
    match: (bin, args) => bin === 'plutil' && args.includes('-convert'),
    stdout: JSON.stringify({
      CFBundleIdentifier: bundleId,
      CFBundleExecutable: executable,
      CFBundleVersion: '1',
    }),
  };
}

const installStub: ToolStub = {
  match: (bin, args) => bin === 'xcrun' && args[1] === 'install',
};

function containerStub(path: string): ToolStub {
  return {
    match: (bin, args) => bin === 'xcrun' && args[1] === 'get_app_container',
    stdout: `${path}\n`,
  };
}

let root = '';

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'cyboflow-mobile-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// argv parsing
// ---------------------------------------------------------------------------

describe('parseMobileArgv', () => {
  it('returns null for a word this family does not own, so driverCore keeps its own message', () => {
    expect(parseMobileArgv('goto', ['https://example.com'])).toBeNull();
    expect(parseMobileArgv('frobnicate', [])).toBeNull();
  });

  it('parses the two argument-free commands and rejects arguments on them', () => {
    expect(parseMobileArgv('mobile-install', [])).toEqual({
      ok: true,
      command: { kind: 'mobile', sub: 'install' },
    });
    expect(parseMobileArgv('mobile-launch', [])).toEqual({
      ok: true,
      command: { kind: 'mobile', sub: 'launch' },
    });
    expect(parseMobileArgv('mobile-install', ['x'])).toMatchObject({ ok: false });
    expect(parseMobileArgv('mobile-launch', ['x'])).toMatchObject({ ok: false });
  });

  it('parses the observe + drive commands', () => {
    expect(parseMobileArgv('mobile-screenshot', ['home'])).toEqual({
      ok: true,
      command: { kind: 'mobile', sub: 'screenshot', name: 'home.png' },
    });
    expect(parseMobileArgv('mobile-openurl', ['demo://x'])).toEqual({
      ok: true,
      command: { kind: 'mobile', sub: 'openurl', url: 'demo://x' },
    });
    expect(parseMobileArgv('mobile-tap', ['Log in'])).toEqual({
      ok: true,
      command: { kind: 'mobile', sub: 'tap', target: 'Log in' },
    });
    expect(parseMobileArgv('mobile-type', ['hello', 'world'])).toEqual({
      ok: true,
      command: { kind: 'mobile', sub: 'type', text: 'hello world' },
    });
    expect(parseMobileArgv('mobile-swipe', ['UP'])).toEqual({
      ok: true,
      command: { kind: 'mobile', sub: 'swipe', direction: 'up' },
    });
    expect(parseMobileArgv('mobile-press', ['Home'])).toEqual({
      ok: true,
      command: { kind: 'mobile', sub: 'press', key: 'home' },
    });
    expect(parseMobileArgv('mobile-flow', ['flows/login.yaml'])).toEqual({
      ok: true,
      command: { kind: 'mobile', sub: 'flow', flowPath: 'flows/login.yaml' },
    });
  });

  it('rejects an unknown swipe direction and an unknown key', () => {
    expect(parseMobileArgv('mobile-swipe', ['diagonally'])).toMatchObject({ ok: false });
    expect(parseMobileArgv('mobile-press', ['escape'])).toMatchObject({ ok: false });
    expect(parseMobileArgv('mobile-swipe', ['up', 'down'])).toMatchObject({ ok: false });
  });
});

describe('sanitizeMobileScreenshotName', () => {
  it('REFUSES a path-shaped name rather than silently basenaming it', () => {
    expect(sanitizeMobileScreenshotName('../x.png')).toBeNull();
    expect(sanitizeMobileScreenshotName('a/b.png')).toBeNull();
    expect(sanitizeMobileScreenshotName('a\\b.png')).toBeNull();
    expect(sanitizeMobileScreenshotName('..')).toBeNull();
    expect(sanitizeMobileScreenshotName('')).toBeNull();
    expect(sanitizeMobileScreenshotName('.hidden.png')).toBeNull();
  });

  it('appends .png when absent and keeps it when present', () => {
    expect(sanitizeMobileScreenshotName('home')).toBe('home.png');
    expect(sanitizeMobileScreenshotName('home.PNG')).toBe('home.PNG');
  });

  it('refuses the path-shaped names through parseMobileArgv too', () => {
    expect(parseMobileArgv('mobile-screenshot', ['../x.png'])).toMatchObject({ ok: false });
    expect(parseMobileArgv('mobile-screenshot', ['a/b.png'])).toMatchObject({ ok: false });
  });
});

describe('parseGlobSegments', () => {
  it('splits a normal product glob', () => {
    expect(parseGlobSegments(DEFAULT_APP_PRODUCT_GLOB)).toEqual({
      ok: true,
      value: ['Build', 'Products', '*-iphonesimulator', '*.app'],
    });
  });

  it('refuses "..", an absolute glob and an empty one', () => {
    expect(parseGlobSegments('Build/../../*.app')).toMatchObject({ ok: false });
    expect(parseGlobSegments('/Build/Products/*.app')).toMatchObject({ ok: false });
    expect(parseGlobSegments('   ')).toMatchObject({ ok: false });
  });
});

describe('parseLaunchPid', () => {
  it('reads the pid out of simctl launch stdout', () => {
    expect(parseLaunchPid('com.example.Demo: 51234\n')).toBe(51234);
  });

  it('prefers the last line, so a leading status line cannot be mistaken for it', () => {
    expect(parseLaunchPid('note: 1 device\ncom.example.Demo2: 77\n')).toBe(77);
  });

  it('returns null when there is no pid to read', () => {
    expect(parseLaunchPid('')).toBeNull();
    expect(parseLaunchPid('com.example.Demo\n')).toBeNull();
  });
});

describe('resolveReadyTimeoutMs', () => {
  it('defaults when unset or malformed, and honours a real value', () => {
    expect(resolveReadyTimeoutMs({})).toBe(90_000);
    expect(resolveReadyTimeoutMs({ VERIFY_MOBILE_READY_TIMEOUT_MS: 'soon' })).toBe(90_000);
    expect(resolveReadyTimeoutMs({ VERIFY_MOBILE_READY_TIMEOUT_MS: '0' })).toBe(90_000);
    expect(resolveReadyTimeoutMs({ VERIFY_MOBILE_READY_TIMEOUT_MS: '5000' })).toBe(5_000);
  });
});

// ---------------------------------------------------------------------------
// isUniformPng — the blank-frame check
// ---------------------------------------------------------------------------

describe('isUniformPng', () => {
  it('is true for a solid frame and false for a two-colour one', () => {
    expect(isUniformPng(WHITE)).toBe(true);
    expect(isUniformPng(BLACK)).toBe(true);
    expect(isUniformPng(TWO_TONE)).toBe(false);
  });

  it('sees through the Sub, Up and Paeth scanline filters', () => {
    for (const filter of [1, 2, 4] as const) {
      expect(isUniformPng(solidPngWithFilter(6, 5, [12, 34, 56, 255], filter)), `filter ${filter}`).toBe(
        true,
      );
    }
  });

  it('catches a single differing pixel in the bottom-right corner', () => {
    // The sampled sweep can stride past one pixel; the last one is always read.
    const nearlyBlank = encodeRgbaPng(40, 40, (x, y) =>
      x === 39 && y === 39 ? [0, 0, 0, 255] : [255, 255, 255, 255],
    );
    expect(isUniformPng(nearlyBlank)).toBe(false);
  });

  it('returns false — never throws — for anything it cannot read', () => {
    expect(isUniformPng(Buffer.alloc(0))).toBe(false);
    expect(isUniformPng(Buffer.from('not a png at all'))).toBe(false);
    expect(isUniformPng(Buffer.concat([PNG_SIG, Buffer.from('garbage')]))).toBe(false);
    // A valid header whose IDAT is truncated mid-chunk (the trailing 12 bytes
    // are IEND, whose absence alone is tolerated — cut past it, into IDAT's CRC).
    expect(isUniformPng(WHITE.subarray(0, WHITE.length - 16))).toBe(false);
    // A complete IDAT whose deflate stream is corrupt: inflateSync throws and
    // the catch answers "not uniform", which is the readiness-safe direction.
    const corrupt = Buffer.from(WHITE);
    corrupt[corrupt.length - 20] ^= 0xff;
    expect(isUniformPng(corrupt)).toBe(false);
  });

  it('declines a shape it does not support rather than guessing (16-bit, interlaced)', () => {
    const sixteenBit = Buffer.from(WHITE);
    sixteenBit[8 + 8 + 8] = 16; // IHDR bit depth
    expect(isUniformPng(sixteenBit)).toBe(false);
    const interlaced = Buffer.from(WHITE);
    interlaced[8 + 8 + 12] = 1; // IHDR interlace method
    expect(isUniformPng(interlaced)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// mobile-install
// ---------------------------------------------------------------------------

describe('mobile-install', () => {
  async function stageProduct(bytes = 'MACHO'): Promise<string> {
    return makeAppBundle(
      join(root, 'dd', 'Build', 'Products', 'Debug-iphonesimulator', 'Demo.app'),
      bytes,
    );
  }

  it('resolves, verifies, installs and records both hashes', async () => {
    const built = await stageProduct();
    const installed = await makeAppBundle(join(root, 'container', 'Demo.app'), 'MACHO');
    const h = makeHarness(root, [plutilStub(), installStub, containerStub(installed)]);

    const code = await runDriverCommand(['mobile-install'], mobileEnv(root), h.deps);

    expect(h.err).toEqual([]);
    expect(code).toBe(MOBILE_EXIT_OK);
    const record = JSON.parse(
      await readFile(join(root, 'artifacts', 'mobile-install.json'), 'utf8'),
    ) as MobileInstallRecord;
    expect(record.bundleId).toBe(BUNDLE_ID);
    expect(record.executable).toBe(EXECUTABLE);
    expect(record.builtSha256).toBe(record.installedSha256);
    expect(record.builtPath.endsWith(join('Debug-iphonesimulator', 'Demo.app'))).toBe(true);
    expect(record.installedPath).toBe(installed);
    expect(built).toContain('Demo.app');
    // The install argv names the leased device and the resolved realpath.
    const install = h.tools.find((t) => t.args[1] === 'install');
    expect(install?.args.slice(0, 3)).toEqual(['simctl', 'install', UDID]);
  });

  it('refuses when nothing was built into this request DerivedData', async () => {
    await mkdir(join(root, 'dd'), { recursive: true });
    const h = makeHarness(root, [plutilStub(), installStub]);

    const code = await runDriverCommand(['mobile-install'], mobileEnv(root), h.deps);

    expect(code).toBe(MOBILE_EXIT_REFUSED);
    expect(h.err[0]).toContain('no product matched');
    expect(h.err[0]).toContain("nothing was built into this request's DerivedData");
    expect(h.tools).toEqual([]); // refused before plutil, let alone simctl
  });

  it('refuses two matches and names them both', async () => {
    await stageProduct();
    await makeAppBundle(
      join(root, 'dd', 'Build', 'Products', 'Debug-iphonesimulator', 'Other.app'),
      'OTHER',
    );
    const h = makeHarness(root, [plutilStub(), installStub]);

    const code = await runDriverCommand(['mobile-install'], mobileEnv(root), h.deps);

    expect(code).toBe(MOBILE_EXIT_REFUSED);
    expect(h.err[0]).toContain('matched 2');
    expect(h.err[0]).toContain('Demo.app');
    expect(h.err[0]).toContain('Other.app');
    expect(h.tools).toEqual([]);
  });

  it('refuses a .app that is itself a symlink out of DerivedData', async () => {
    const outside = await makeAppBundle(join(root, 'elsewhere', 'Demo.app'), 'FOREIGN');
    const products = join(root, 'dd', 'Build', 'Products', 'Debug-iphonesimulator');
    await mkdir(products, { recursive: true });
    await symlink(outside, join(products, 'Demo.app'));
    const h = makeHarness(root, [plutilStub(), installStub]);

    const code = await runDriverCommand(['mobile-install'], mobileEnv(root), h.deps);

    expect(code).toBe(MOBILE_EXIT_REFUSED);
    expect(h.err[0]).toContain('product escapes DerivedData');
    expect(h.err[0]).toContain('is a symlink');
    expect(h.tools).toEqual([]);
  });

  it('refuses a product whose realpath escapes through a symlinked parent directory', async () => {
    // The .app itself is a genuine directory — only an intermediate path
    // component is a link, which is exactly what the lstat check alone misses.
    const outside = join(root, 'elsewhere', 'Products');
    await makeAppBundle(join(outside, 'Debug-iphonesimulator', 'Demo.app'), 'FOREIGN');
    await mkdir(join(root, 'dd', 'Build'), { recursive: true });
    await symlink(outside, join(root, 'dd', 'Build', 'Products'));
    const h = makeHarness(root, [plutilStub(), installStub]);

    const code = await runDriverCommand(['mobile-install'], mobileEnv(root), h.deps);

    expect(code).toBe(MOBILE_EXIT_REFUSED);
    expect(h.err[0]).toContain('product escapes DerivedData');
    expect(h.err[0]).toContain('which is outside');
    expect(h.tools).toEqual([]);
  });

  it('refuses a glob containing "..", before touching the filesystem', async () => {
    await stageProduct();
    const h = makeHarness(root, [plutilStub(), installStub]);

    const code = await runDriverCommand(
      ['mobile-install'],
      mobileEnv(root, { VERIFY_APP_PRODUCT_GLOB: '../elsewhere/*.app' }),
      h.deps,
    );

    expect(code).toBe(MOBILE_EXIT_REFUSED);
    expect(h.err[0]).toContain('may not contain ".."');
    expect(h.tools).toEqual([]);
  });

  it('refuses when the bundle declares a different id than this request expects', async () => {
    await stageProduct();
    const h = makeHarness(root, [plutilStub('com.someone.Else'), installStub]);

    const code = await runDriverCommand(['mobile-install'], mobileEnv(root), h.deps);

    expect(code).toBe(MOBILE_EXIT_REFUSED);
    expect(h.err[0]).toContain('bundle id mismatch');
    expect(h.err[0]).toContain('com.someone.Else');
    expect(h.err[0]).toContain(BUNDLE_ID);
    expect(h.tools.some((t) => t.args[1] === 'install')).toBe(false);
  });

  it('refuses when the installed bits differ from the staged product, but still writes the record', async () => {
    await stageProduct('MACHO');
    const installed = await makeAppBundle(join(root, 'container', 'Demo.app'), 'SOMETHING-ELSE');
    const h = makeHarness(root, [plutilStub(), installStub, containerStub(installed)]);

    const code = await runDriverCommand(['mobile-install'], mobileEnv(root), h.deps);

    expect(code).toBe(MOBILE_EXIT_REFUSED);
    expect(h.err[0]).toContain('installed bits differ from the staged product');
    const record = JSON.parse(
      await readFile(join(root, 'artifacts', 'mobile-install.json'), 'utf8'),
    ) as MobileInstallRecord;
    expect(record.builtSha256).not.toBe(record.installedSha256);
  });

  it('reports a failing simctl install with its own stderr', async () => {
    await stageProduct();
    const h = makeHarness(root, [
      plutilStub(),
      { ...installStub, code: 1, stderr: 'Unable to install: invalid bundle' },
    ]);

    const code = await runDriverCommand(['mobile-install'], mobileEnv(root), h.deps);

    expect(code).toBe(MOBILE_EXIT_REFUSED);
    expect(h.err[0]).toContain('Unable to install');
  });

  it('refuses a path-shaped CFBundleExecutable', async () => {
    await stageProduct();
    const h = makeHarness(root, [plutilStub(BUNDLE_ID, '../../etc/passwd'), installStub]);

    const code = await runDriverCommand(['mobile-install'], mobileEnv(root), h.deps);

    expect(code).toBe(MOBILE_EXIT_REFUSED);
    expect(h.err[0]).toContain('path-shaped CFBundleExecutable');
  });

  it('exits 1 (a harness bug, not a refusal) when a lever is missing', async () => {
    const h = makeHarness(root, []);
    const env = mobileEnv(root);
    delete env.VERIFY_DERIVED_DATA;

    expect(await runDriverCommand(['mobile-install'], env, h.deps)).toBe(MOBILE_EXIT_USAGE);
    expect(h.err[0]).toContain('VERIFY_DERIVED_DATA');
  });
});

// ---------------------------------------------------------------------------
// mobile-launch + readiness
// ---------------------------------------------------------------------------

/** A `simctl io … screenshot <path>` stub that writes `frames[n]` on the n-th call. */
function screenshotStub(frames: Buffer[]): ToolStub {
  let n = 0;
  return {
    match: (bin, args) => bin === 'xcrun' && args[1] === 'io' && args[3] === 'screenshot',
    effect: async (_bin, args) => {
      const frame = frames[Math.min(n, frames.length - 1)];
      n += 1;
      await mkdir(join(args[4], '..'), { recursive: true }).catch(() => {});
      await writeFile(args[4], frame);
    },
  };
}

const launchStub: ToolStub = {
  match: (bin, args) => bin === 'xcrun' && args[1] === 'launch',
  stdout: `${BUNDLE_ID}: 4242\n`,
};

describe('mobile-launch', () => {
  it('reports ready once two consecutive frames are identical and not blank', async () => {
    // Frame 1 differs from frame 2 (still painting); frames 2 and 3 match.
    const h = makeHarness(root, [launchStub, screenshotStub([WHITE, TWO_TONE, TWO_TONE])]);

    const code = await runDriverCommand(['mobile-launch'], mobileEnv(root), h.deps);

    expect(code).toBe(MOBILE_EXIT_OK);
    expect(h.out[0]).toMatch(/^ready pid=4242 after=\d+ms$/);
    expect(h.out[0]).toContain(`after=${2 * READY_POLL_INTERVAL_MS}ms`);
  });

  it('does NOT accept a stable BLANK frame — a solid screen is perfectly stable', async () => {
    const h = makeHarness(root, [launchStub, screenshotStub([WHITE])]);

    const code = await runDriverCommand(
      ['mobile-launch'],
      mobileEnv(root, { VERIFY_MOBILE_READY_TIMEOUT_MS: '3000' }),
      h.deps,
    );

    expect(code).toBe(MOBILE_EXIT_READINESS_TIMEOUT);
    expect(h.out[0]).toBe('readiness-timeout after=3000ms lastFrame=readiness-last-frame.png');
    // The frame is preserved so the agent can cite it in `not_testable`.
    const kept = await readFile(join(root, 'artifacts', 'readiness-last-frame.png'));
    expect(kept.equals(WHITE)).toBe(true);
  });

  it('exits 2 when the app dies during launch', async () => {
    const h = makeHarness(root, [launchStub, screenshotStub([TWO_TONE])]);
    h.alive.value = false;

    const code = await runDriverCommand(['mobile-launch'], mobileEnv(root), h.deps);

    expect(code).toBe(MOBILE_EXIT_REFUSED);
    expect(h.err[0]).toContain('app exited during launch');
    expect(h.err[0]).toContain('4242');
  });

  it('exits 2 when simctl launch reports no pid at all', async () => {
    const h = makeHarness(root, [{ ...launchStub, stdout: 'launched\n' }]);

    const code = await runDriverCommand(['mobile-launch'], mobileEnv(root), h.deps);

    expect(code).toBe(MOBILE_EXIT_REFUSED);
    expect(h.err[0]).toContain('no pid');
  });

  it('reports a failing simctl launch rather than waiting on nothing', async () => {
    const h = makeHarness(root, [{ ...launchStub, code: 3, stderr: 'No such app' }]);

    const code = await runDriverCommand(['mobile-launch'], mobileEnv(root), h.deps);

    expect(code).toBe(MOBILE_EXIT_REFUSED);
    expect(h.err[0]).toContain('No such app');
  });

  it('times out with lastFrame=(none) when no frame could ever be captured', async () => {
    const h = makeHarness(root, [
      launchStub,
      {
        match: (bin, args) => bin === 'xcrun' && args[1] === 'io',
        code: 1,
        stderr: 'device not booted',
      },
    ]);

    const code = await runDriverCommand(
      ['mobile-launch'],
      mobileEnv(root, { VERIFY_MOBILE_READY_TIMEOUT_MS: '1500' }),
      h.deps,
    );

    expect(code).toBe(MOBILE_EXIT_READINESS_TIMEOUT);
    expect(h.out[0]).toContain('lastFrame=(none)');
    expect(h.err.join('\n')).toContain('device not booted');
  });
});

// ---------------------------------------------------------------------------
// mobile-screenshot / mobile-openurl
// ---------------------------------------------------------------------------

describe('mobile-screenshot and mobile-openurl', () => {
  it('captures into the artifacts dir with the leased udid', async () => {
    const h = makeHarness(root, [screenshotStub([TWO_TONE])]);

    const code = await runDriverCommand(['mobile-screenshot', 'home'], mobileEnv(root), h.deps);

    expect(code).toBe(MOBILE_EXIT_OK);
    expect(h.tools[0]).toEqual({
      bin: 'xcrun',
      args: ['simctl', 'io', UDID, 'screenshot', join(root, 'artifacts', 'home.png')],
    });
  });

  it('refuses a path-shaped name at the dispatcher, with no subprocess at all', async () => {
    for (const name of ['../x.png', 'a/b.png']) {
      const h = makeHarness(root, [screenshotStub([TWO_TONE])]);
      const code = await runDriverCommand(['mobile-screenshot', name], mobileEnv(root), h.deps);
      expect(code, name).toBe(1);
      expect(h.tools, name).toEqual([]);
    }
  });

  it('opens a url through the OS handler on BOTH drive arms', async () => {
    for (const drive of ['none', 'maestro']) {
      const h = makeHarness(root, [
        { match: (bin, args) => bin === 'xcrun' && args[1] === 'openurl' },
      ]);
      const code = await runDriverCommand(
        ['mobile-openurl', 'demo://item/7'],
        mobileEnv(root, { VERIFY_MOBILE_DRIVE: drive, VERIFY_MAESTRO_BIN: '/opt/maestro' }),
        h.deps,
      );
      expect(code, drive).toBe(MOBILE_EXIT_OK);
      expect(h.tools[0].args, drive).toEqual(['simctl', 'openurl', UDID, 'demo://item/7']);
    }
  });
});

// ---------------------------------------------------------------------------
// The Maestro drive rung
// ---------------------------------------------------------------------------

const MAESTRO_BIN = '/opt/maestro/bin/maestro';

function maestroEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return mobileEnv(root, {
    VERIFY_MOBILE_DRIVE: 'maestro',
    VERIFY_MAESTRO_BIN: MAESTRO_BIN,
    ...extra,
  });
}

function helpStub(text: string): ToolStub {
  return {
    match: (bin, args) => bin === MAESTRO_BIN && args[1] === '--help',
    stdout: text,
  };
}

const runFlowStub: ToolStub = {
  match: (bin, args) => bin === MAESTRO_BIN && args[1] !== '--help',
};

const DRIVE_ARGVS: string[][] = [
  ['mobile-tap', 'Log in'],
  ['mobile-type', 'hello world'],
  ['mobile-swipe', 'up'],
  ['mobile-press', 'home'],
];

describe('the drive rung', () => {
  it('refuses every drive command when the host has no Maestro, naming what to report', async () => {
    const env = mobileEnv(root, { VERIFY_MOBILE_DRIVE: 'none' });
    for (const argv of [...DRIVE_ARGVS, ['mobile-flow', 'x.yaml']]) {
      const h = makeHarness(root, [runFlowStub]);
      const code = await runDriverCommand(argv, env, h.deps);
      expect(code, argv[0]).toBe(MOBILE_EXIT_REFUSED);
      expect(h.err[0], argv[0]).toBe(mobileDriveRefusal(env));
      expect(h.err[0], argv[0]).toContain('not_testable (drive-unsupported)');
      expect(h.tools, argv[0]).toEqual([]);
    }
  });

  it('refuses when VERIFY_MOBILE_DRIVE=maestro but no binary was resolved', async () => {
    const env = mobileEnv(root, { VERIFY_MOBILE_DRIVE: 'maestro' });
    const h = makeHarness(root, [runFlowStub]);

    expect(await runDriverCommand(['mobile-tap', 'x'], env, h.deps)).toBe(MOBILE_EXIT_REFUSED);
    expect(h.err[0]).toContain('VERIFY_MAESTRO_BIN is not set');
    expect(h.tools).toEqual([]);
  });

  it('pins every invocation with --udid when Maestro advertises it', async () => {
    for (const argv of DRIVE_ARGVS) {
      const h = makeHarness(root, [helpStub('  --udid <udid>   Device udid'), runFlowStub]);
      const code = await runDriverCommand(argv, maestroEnv(), h.deps);

      expect(code, argv[0]).toBe(MOBILE_EXIT_OK);
      const run = h.tools.find((t) => t.bin === MAESTRO_BIN && t.args[1] !== '--help');
      expect(run?.args.slice(0, 3), argv[0]).toEqual(['test', '--udid', UDID]);
      expect(run?.args[3]?.startsWith(join(root, 'artifacts', 'maestro')), argv[0]).toBe(true);
    }
  });

  it('falls back to --device when only that flag exists', async () => {
    const h = makeHarness(root, [helpStub('  --device <device>  Device name or id'), runFlowStub]);

    expect(await runDriverCommand(['mobile-tap', 'Log in'], maestroEnv(), h.deps)).toBe(
      MOBILE_EXIT_OK,
    );
    const run = h.tools.find((t) => t.bin === MAESTRO_BIN && t.args[1] !== '--help');
    expect(run?.args.slice(0, 3)).toEqual(['test', '--device', UDID]);
  });

  it('REFUSES to drive when neither pin flag exists, rather than running unpinned', async () => {
    const h = makeHarness(root, [helpStub('Usage: maestro test [flow]\n  --format <fmt>'), runFlowStub]);

    const code = await runDriverCommand(['mobile-tap', 'Log in'], maestroEnv(), h.deps);

    expect(code).toBe(MOBILE_EXIT_REFUSED);
    expect(h.err[0]).toContain('cannot pin Maestro to the leased simulator');
    // The help probe ran; the flow did not.
    expect(h.tools.filter((t) => t.bin === MAESTRO_BIN && t.args[1] !== '--help')).toEqual([]);
  });

  it('writes the generated flow into the artifacts dir as evidence of what was driven', async () => {
    const h = makeHarness(root, [helpStub('--udid'), runFlowStub]);

    await runDriverCommand(['mobile-tap', 'Log in'], maestroEnv(), h.deps);

    const run = h.tools.find((t) => t.bin === MAESTRO_BIN && t.args[1] !== '--help');
    const yaml = await readFile(run?.args[3] ?? '', 'utf8');
    expect(yaml).toContain(`appId: "${BUNDLE_ID}"`);
    expect(yaml).toContain('- tapOn: "Log in"');
  });

  it('runs an agent-authored flow under the artifacts dir', async () => {
    const flow = join(root, 'artifacts', 'login.yaml');
    await mkdir(join(root, 'artifacts'), { recursive: true });
    await writeFile(flow, 'appId: com.example.Demo\n---\n- tapOn: "Log in"\n', 'utf8');
    const h = makeHarness(root, [helpStub('--udid'), runFlowStub]);

    const code = await runDriverCommand(['mobile-flow', flow], maestroEnv(), h.deps);

    expect(code).toBe(MOBILE_EXIT_OK);
    const run = h.tools.find((t) => t.bin === MAESTRO_BIN && t.args[1] !== '--help');
    expect(run?.args).toEqual(maestroTestArgs('--udid', UDID, await realOf(flow)));
  });

  it('refuses a flow file outside both the artifacts dir and the snapshot worktree', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'cyboflow-outside-'));
    try {
      const flow = join(outside, 'evil.yaml');
      await writeFile(flow, 'appId: x\n---\n- tapOn: "x"\n', 'utf8');
      const h = makeHarness(root, [helpStub('--udid'), runFlowStub]);

      const code = await runDriverCommand(['mobile-flow', flow], maestroEnv(), h.deps);

      expect(code).toBe(MOBILE_EXIT_REFUSED);
      expect(h.err[0]).toContain('which is outside both');
      expect(h.tools.filter((t) => t.args[1] !== '--help')).toEqual([]);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('refuses a flow file that does not exist', async () => {
    const h = makeHarness(root, [helpStub('--udid'), runFlowStub]);

    expect(await runDriverCommand(['mobile-flow', 'nope.yaml'], maestroEnv(), h.deps)).toBe(
      MOBILE_EXIT_REFUSED,
    );
  });

  it('reports a failing maestro run with its own output', async () => {
    const h = makeHarness(root, [
      helpStub('--udid'),
      { ...runFlowStub, code: 1, stderr: 'Element not found: Log in' },
    ]);

    const code = await runDriverCommand(['mobile-tap', 'Log in'], maestroEnv(), h.deps);

    expect(code).toBe(MOBILE_EXIT_REFUSED);
    expect(h.err[0]).toContain('Element not found');
  });
});

/** `realpath` as the driver resolves it, so a macOS `/var` -> `/private/var` link does not fail a test. */
async function realOf(path: string): Promise<string> {
  return createDefaultDriverDeps().realpath(path);
}

describe('maestroFlowYaml', () => {
  it('renders one step per command word', () => {
    expect(maestroFlowYaml(BUNDLE_ID, { kind: 'mobile', sub: 'tap', target: 'Log in' })).toBe(
      `appId: "${BUNDLE_ID}"\n---\n- tapOn: "Log in"\n`,
    );
    expect(maestroFlowYaml(BUNDLE_ID, { kind: 'mobile', sub: 'type', text: 'hi' })).toContain(
      '- inputText: "hi"',
    );
    expect(maestroFlowYaml(BUNDLE_ID, { kind: 'mobile', sub: 'swipe', direction: 'left' })).toContain(
      'direction: LEFT',
    );
    expect(maestroFlowYaml(BUNDLE_ID, { kind: 'mobile', sub: 'press', key: 'enter' })).toContain(
      '- pressKey: Enter',
    );
  });

  it('quotes a target that would otherwise become extra YAML', () => {
    const yaml = maestroFlowYaml(BUNDLE_ID, {
      kind: 'mobile',
      sub: 'tap',
      target: 'x"\n- launchApp: com.attacker',
    });
    expect(yaml.split('\n').filter((l) => l.startsWith('- '))).toHaveLength(1);
    expect(yamlScalar('a"b')).toBe('"a\\"b"');
  });
});

// ---------------------------------------------------------------------------
// The load-bearing invariant: one simulator, and it is the leased one
// ---------------------------------------------------------------------------

describe('udid confinement', () => {
  it('never names a device other than VERIFY_SIM_UDID, across the whole family', async () => {
    const OTHER = '99999999-8888-7777-6666-555555555555';
    const built = join(root, 'dd', 'Build', 'Products', 'Debug-iphonesimulator', 'Demo.app');
    await makeAppBundle(built, 'MACHO');
    const installed = await makeAppBundle(join(root, 'container', 'Demo.app'), 'MACHO');
    const flow = join(root, 'artifacts', 'login.yaml');
    await mkdir(join(root, 'artifacts'), { recursive: true });
    await writeFile(flow, 'appId: com.example.Demo\n---\n- tapOn: "x"\n', 'utf8');

    const every: ToolInvocation[] = [];
    for (const argv of [
      ['mobile-install'],
      ['mobile-launch'],
      ['mobile-screenshot', 'home'],
      ['mobile-openurl', 'demo://x'],
      ...DRIVE_ARGVS,
      ['mobile-flow', flow],
    ]) {
      const h = makeHarness(root, [
        plutilStub(),
        installStub,
        containerStub(installed),
        launchStub,
        screenshotStub([TWO_TONE, TWO_TONE]),
        helpStub('--udid'),
        runFlowStub,
      ]);
      await runDriverCommand(
        argv,
        maestroEnv({ VERIFY_MOBILE_READY_TIMEOUT_MS: '3000' }),
        h.deps,
      );
      every.push(...h.tools);
    }

    expect(every.length).toBeGreaterThan(8);
    for (const call of every) {
      expect(call.args.join(' '), `${call.bin} ${call.args.join(' ')}`).not.toContain(OTHER);
      // Any argv that names a device at all names the leased one. `simctl` and
      // Maestro both take it positionally right after the verb / pin flag.
      const udidish = call.args.filter((a) => /^[0-9A-F]{8}-/i.test(a));
      for (const value of udidish) expect(value).toBe(UDID);
    }
    // And every subprocess that touches a device is one of the three we expect.
    for (const call of every) {
      expect(['xcrun', 'plutil', MAESTRO_BIN]).toContain(call.bin);
    }
  });
});
