/**
 * Smoke test for build/afterSign.js (post-sign JAR tripwire + bundle hard checks).
 * Run as: node build/afterSign.test.js
 * Exits 0 on success, 1 on any failure.
 *
 * Cases A-D cover the warn-only JAR tripwire. Cases E onward cover the hard
 * checks that fail a release build: bundle architecture, the native-module ABI
 * probe, and the .app / app.asar size floors.
 *
 * Where a check can be exercised honestly without building an app, it is:
 * `lipo` really runs against a real Mach-O binary, and the ABI probe really
 * spawns the host `node` and really `require()`s a real native module. Only the
 * cases that need a binary nobody has on hand (a deliberately wrong-arch build)
 * stub command execution.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const afterSignModule = require('./afterSign');
const afterSign = afterSignModule.default;
const helpers = afterSignModule._helpers;

const repoRoot = path.join(__dirname, '..');

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (!condition) {
    console.error('FAIL:', message);
    failed++;
  } else {
    console.log('PASS:', message);
    passed++;
  }
}

/** Run afterSign while capturing console.warn output. */
async function runCapturingWarnings(ctx) {
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(' '));
  let threw = false;
  try {
    await afterSign(ctx);
  } catch (_err) {
    threw = true;
  } finally {
    console.warn = originalWarn;
  }
  return { threw, warnings };
}

function macContext(appOutDir, productName) {
  return {
    appOutDir,
    packager: {
      platform: { name: 'mac' },
      appInfo: { productName }
    }
  };
}

// ---------------------------------------------------------------------------
// Fixtures for the bundle hard checks
// ---------------------------------------------------------------------------

/** builder-util's Arch enum ordinals, as electron-builder passes them. */
const ARCH = { ia32: 0, x64: 1, armv7l: 2, arm64: 3, universal: 4 };

const PRODUCT_NAME = 'TestApp';

/** Run afterSign capturing warnings AND the thrown error. */
async function runCapturing(ctx) {
  const warnings = [];
  const logs = [];
  const originalWarn = console.warn;
  const originalLog = console.log;
  console.warn = (...args) => warnings.push(args.join(' '));
  console.log = (...args) => logs.push(args.join(' '));
  let error = null;
  try {
    await afterSign(ctx);
  } catch (err) {
    error = err;
  } finally {
    console.warn = originalWarn;
    console.log = originalLog;
  }
  return { error, message: error ? error.message : '', warnings, logs };
}

function macArchContext(appOutDir, arch) {
  return {
    appOutDir,
    arch,
    packager: {
      platform: { name: 'mac' },
      appInfo: { productName: PRODUCT_NAME }
    }
  };
}

/**
 * Create a file with a large apparent size without writing its bytes.
 * ftruncate leaves a sparse file on APFS, so a 160 MB fixture costs no disk —
 * and the size check under test reads st.size, which sees the full length.
 */
function writeSparseFile(file, bytes) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const fd = fs.openSync(file, 'w');
  try {
    fs.ftruncateSync(fd, bytes);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * A real Mach-O binary that is NOT a loadable node addon — the honest fixture
 * for "the arch is right but the module will not load".
 */
function machOButNotAnAddon() {
  return fs.existsSync('/bin/ls') ? '/bin/ls' : process.execPath;
}

/** Does this .node load in THIS process? The independent oracle for the probe. */
function loadsInProcess(file) {
  try {
    require(file);
    return true;
  } catch (_err) {
    return false;
  }
}

const HOST_ARCH = process.arch === 'x64' ? 'x64' : 'arm64';
const OTHER_ARCH = HOST_ARCH === 'x64' ? 'arm64' : 'x64';

/** Bundle-relative layouts (under app.asar.unpacked/node_modules) for a fixture addon. */
const COMPILED_SQLITE_REL = path.join('better-sqlite3', 'build', 'Release', 'better_sqlite3.node');
const prebuiltSqliteRel = (arch) => path.join('better-sqlite3', 'prebuilds', `darwin-${arch}.node`);

function betterSqliteModuleDir() {
  try {
    return path.dirname(require.resolve('better-sqlite3/package.json', { paths: [repoRoot] }));
  } catch (_err) {
    return null; // Not installed in (or above) this checkout.
  }
}

/**
 * A better-sqlite3 addon that the host `node` can actually load, if this
 * checkout has one, with the bundle layout it belongs at. Preference order:
 * the installed v13 N-API prebuild (`prebuilds/darwin-<arch>.node` — the shape
 * every real build ships since the Electron 44 upgrade), then a compiled
 * `build/Release` artifact carrying the host ABI, then a host-keyed entry banked
 * in .abi-cache by scripts/ensure-sqlite-abi.mjs.
 */
function resolveHostLoadableAddon() {
  const candidates = [];
  const moduleDir = betterSqliteModuleDir();
  if (moduleDir) {
    candidates.push({
      file: path.join(moduleDir, 'prebuilds', `darwin-${HOST_ARCH}.node`),
      rel: prebuiltSqliteRel(HOST_ARCH),
    });
    candidates.push({
      file: path.join(moduleDir, 'build', 'Release', 'better_sqlite3.node'),
      rel: COMPILED_SQLITE_REL,
    });
  }
  for (const dir of abiCacheEntries('host-')) {
    candidates.push({ file: path.join(dir, 'better_sqlite3.node'), rel: COMPILED_SQLITE_REL });
  }
  return candidates.find((c) => fs.existsSync(c.file) && loadsInProcess(c.file)) || null;
}

/** The installed v13 prebuild for `arch`, or null (pre-v13 checkout). */
function resolveInstalledPrebuild(arch) {
  const moduleDir = betterSqliteModuleDir();
  if (!moduleDir) return null;
  const file = path.join(moduleDir, 'prebuilds', `darwin-${arch}.node`);
  return fs.existsSync(file) ? file : null;
}

/**
 * A native addon compiled for ONE specific NODE_MODULE_VERSION, if this checkout
 * has one, and whether that ABI is the host's. Needed to reproduce the third
 * historical release failure (a bundled addon the bundled Electron cannot
 * dlopen). Every addon this app ships today is N-API (better-sqlite3 >= 13 and
 * node-pty alike load under BOTH hosts), so none of them can exhibit the
 * mismatch — only a classic per-ABI addon can, and the only ones left are the
 * pre-v13 better_sqlite3.node builds banked in .abi-cache by
 * scripts/ensure-sqlite-abi.mjs. Each candidate is PROVEN per-ABI by probing:
 * it must load under exactly one of the two hosts and fail the other with a
 * NODE_MODULE_VERSION error. A fresh checkout has none, hence opportunistic.
 */
function resolveAbiSpecificAddon() {
  const { probeNativeModule } = helpers;
  const electronBinary = resolveElectronBinary();
  const candidates = [];
  for (const dir of abiCacheEntries('host-')) candidates.push(path.join(dir, 'better_sqlite3.node'));
  for (const dir of abiCacheEntries('electron-')) candidates.push(path.join(dir, 'better_sqlite3.node'));

  const isAbiMismatch = (probe) => !probe.ok && probe.detail.includes('NODE_MODULE_VERSION');
  for (const file of candidates.filter((f) => fs.existsSync(f))) {
    const underHost = probeNativeModule(process.execPath, file);
    if (!underHost.ok) {
      if (isAbiMismatch(underHost)) return { file, loadsOnHost: false };
      continue; // broken for some other reason (arch, corruption) — not a per-ABI proof
    }
    if (!electronBinary) continue; // cannot prove it is not N-API without the other host
    if (isAbiMismatch(probeNativeModule(electronBinary, file))) return { file, loadsOnHost: true };
  }
  return null;
}

/**
 * The installed Electron binary, or null. Electron and host Node have
 * different NODE_MODULE_VERSIONs, so pointing the probe at Electron with a
 * HOST-ABI module reproduces the third historical release failure exactly —
 * no packaged app required.
 */
function resolveElectronBinary() {
  try {
    const entry = require(require.resolve('electron', { paths: [repoRoot] }));
    return typeof entry === 'string' && fs.existsSync(entry) ? entry : null;
  } catch (_err) {
    return null;
  }
}

function abiCacheEntries(prefix) {
  const cacheDir = process.env.SQLITE_ABI_CACHE_DIR || path.join(repoRoot, '.abi-cache');
  if (!fs.existsSync(cacheDir)) return [];
  return fs
    .readdirSync(cacheDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith(prefix))
    .map((entry) => path.join(cacheDir, entry.name));
}

/**
 * Build a fake .app tree under `tmpDir`.
 *
 * Defaults produce a bundle that passes every check on this host: an Info.plist
 * naming a main executable that is a symlink to the running `node` (a real
 * host-arch Mach-O that really behaves as Node when spawned), a
 * better_sqlite3.node, a fat-enough app.asar and enough padding to clear the
 * .app floor. Each option turns exactly one of those off.
 */
function buildAppFixture(tmpDir, options = {}) {
  const opts = {
    executableName: PRODUCT_NAME,
    withInfoPlist: true,
    withExecutable: true,
    addons: undefined,
    asarBytes: 20 * 1024 * 1024,
    padBytes: 160 * 1024 * 1024,
    ...options
  };

  const appPath = path.join(tmpDir, `${PRODUCT_NAME}.app`);
  const contents = path.join(appPath, 'Contents');
  const resources = path.join(contents, 'Resources');
  fs.mkdirSync(path.join(contents, 'MacOS'), { recursive: true });
  fs.mkdirSync(resources, { recursive: true });

  if (opts.withInfoPlist) {
    fs.writeFileSync(
      path.join(contents, 'Info.plist'),
      '<?xml version="1.0" encoding="UTF-8"?>\n' +
        '<plist version="1.0">\n<dict>\n' +
        '\t<key>CFBundleExecutable</key>\n' +
        `\t<string>${opts.executableName}</string>\n` +
        '</dict>\n</plist>\n'
    );
  }

  if (opts.withExecutable) {
    // A symlink, not a copy: `lipo` and the spawned probe both follow it, and
    // it avoids duplicating a ~100 MB binary per fixture.
    fs.symlinkSync(process.execPath, path.join(contents, 'MacOS', opts.executableName));
  }

  // An addon is placed by explicit `rel` (bundle layout under node_modules) or,
  // classically, at <dep>/build/Release/<name>.
  const addons = opts.addons === undefined ? [defaultSqliteAddon()] : opts.addons;
  for (const addon of addons) {
    const rel = addon.rel || path.join(addon.dep || 'some-dep', 'build', 'Release', addon.name);
    const dest = path.join(resources, 'app.asar.unpacked', 'node_modules', rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(addon.source, dest);
  }

  if (opts.asarBytes !== false) {
    writeSparseFile(path.join(resources, 'app.asar'), opts.asarBytes);
  }
  if (opts.padBytes > 0) {
    writeSparseFile(path.join(resources, 'padding.bin'), opts.padBytes);
  }

  return appPath;
}

/** The healthy default better-sqlite3 addon for a fixture, at its real layout. */
function defaultSqliteAddon() {
  const loadable = resolveHostLoadableAddon();
  return loadable
    ? { source: loadable.file, rel: loadable.rel }
    : { name: 'better_sqlite3.node', source: machOButNotAnAddon() };
}

/** The file name the default fixture's better-sqlite3 addon lands under. */
function defaultSqliteBasename() {
  const addon = defaultSqliteAddon();
  return path.basename(addon.rel || addon.name);
}

async function withTmpDir(fn) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aftersign-test-'));
  try {
    return await fn(tmpDir);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

/** The Arch ordinal matching the host, so a healthy fixture is expected to pass. */
function hostArchOrdinal() {
  return ARCH[HOST_ARCH];
}

// ---------------------------------------------------------------------------
// Case A: non-mac context resolves without throwing or warning
// ---------------------------------------------------------------------------
async function caseA() {
  const { threw, warnings } = await runCapturingWarnings({
    appOutDir: '/tmp',
    packager: {
      platform: { name: 'linux' },
      appInfo: { productName: 'X' }
    }
  });
  assert(!threw, 'Case A: non-mac returns without throwing');
  assert(warnings.length === 0, 'Case A: non-mac emits no warnings');
}

// ---------------------------------------------------------------------------
// Case B: mac tree WITH JARs — warns, does NOT delete (post-sign bundle is sealed)
// ---------------------------------------------------------------------------
async function caseB() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aftersign-test-'));
  try {
    const productName = 'TestApp';
    const unpackedBase = path.join(
      tmpDir,
      `${productName}.app`,
      'Contents',
      'Resources',
      'app.asar.unpacked',
      'node_modules',
      'some-dep'
    );
    const subDir = path.join(unpackedBase, 'sub');
    fs.mkdirSync(subDir, { recursive: true });

    const jar1 = path.join(unpackedBase, 'foo.jar');
    const jar2 = path.join(subDir, 'bar.jar');
    fs.writeFileSync(jar1, 'fake-jar-content');
    fs.writeFileSync(jar2, 'fake-jar-content');

    const { threw, warnings } = await runCapturingWarnings(macContext(tmpDir, productName));
    const warnText = warnings.join('\n');

    assert(!threw, 'Case B: mac context does not throw');
    assert(fs.existsSync(jar1), 'Case B: top-level jar NOT deleted (foo.jar)');
    assert(fs.existsSync(jar2), 'Case B: nested jar NOT deleted (sub/bar.jar)');
    assert(warnText.includes('foo.jar'), 'Case B: warning names foo.jar');
    assert(warnText.includes('bar.jar'), 'Case B: warning names nested bar.jar');
    assert(warnText.includes('2 JAR file(s)'), 'Case B: warning reports the count');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Case C: mac tree with no JARs — resolves quietly
// ---------------------------------------------------------------------------
async function caseC() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aftersign-test-'));
  try {
    const productName = 'TestApp';
    const unpackedBase = path.join(
      tmpDir,
      `${productName}.app`,
      'Contents',
      'Resources',
      'app.asar.unpacked',
      'node_modules',
      'some-dep'
    );
    fs.mkdirSync(unpackedBase, { recursive: true });
    fs.writeFileSync(path.join(unpackedBase, 'index.js'), 'module.exports = {};');

    const { threw, warnings } = await runCapturingWarnings(macContext(tmpDir, productName));
    assert(!threw, 'Case C: mac context without JARs does not throw');
    assert(warnings.length === 0, 'Case C: no warnings when no JARs present');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Case D: mac context with no app.asar.unpacked directory at all — no throw
// ---------------------------------------------------------------------------
async function caseD() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aftersign-test-'));
  try {
    const productName = 'TestApp';
    fs.mkdirSync(path.join(tmpDir, `${productName}.app`, 'Contents', 'Resources'), {
      recursive: true
    });
    const { threw, warnings } = await runCapturingWarnings(macContext(tmpDir, productName));
    assert(!threw, 'Case D: missing app.asar.unpacked does not throw');
    assert(warnings.length === 0, 'Case D: missing app.asar.unpacked emits no warnings');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Case E: arch resolution — the enum ordinals electron-builder actually passes
// ---------------------------------------------------------------------------
async function caseE() {
  const { resolveExpectedArch, archMatches } = helpers;
  assert(resolveExpectedArch(ARCH.x64) === 'x64', 'Case E: ordinal 1 resolves to x64');
  assert(resolveExpectedArch(ARCH.arm64) === 'arm64', 'Case E: ordinal 3 resolves to arm64');
  assert(resolveExpectedArch(ARCH.universal) === 'universal', 'Case E: ordinal 4 resolves to universal');
  assert(resolveExpectedArch(99) === null, 'Case E: an unknown ordinal resolves to null');
  assert(resolveExpectedArch('arm64') === 'arm64', 'Case E: a string arch is accepted');
  assert(resolveExpectedArch('x86_64') === 'x64', 'Case E: the Mach-O slice name normalizes to x64');

  assert(archMatches(['x86_64'], 'x64'), 'Case E: x86_64 satisfies x64');
  assert(!archMatches(['x86_64'], 'arm64'), 'Case E: x86_64 does NOT satisfy arm64');
  assert(archMatches(['arm64e'], 'arm64'), 'Case E: arm64e satisfies arm64');
  assert(
    !archMatches(['arm64'], 'universal'),
    'Case E: a single slice does NOT satisfy a universal main executable'
  );
  assert(
    archMatches(['arm64'], 'universal', true),
    'Case E: a single-slice addon is allowed inside a universal bundle'
  );
}

// ---------------------------------------------------------------------------
// Case F: wrong architecture hard-fails — REAL `lipo` against a real Mach-O.
// No mac binary carries an i386 slice any more, so demanding ia32 of the host
// `node` is a genuine mismatch rather than a stubbed one.
// ---------------------------------------------------------------------------
async function caseF() {
  await withTmpDir(async (tmpDir) => {
    // Compiled layout on purpose: a prebuild for another arch is skipped by
    // design (Case W), whereas a compiled addon of the wrong arch is a defect.
    buildAppFixture(tmpDir, {
      addons: [{ source: defaultSqliteAddon().source, rel: COMPILED_SQLITE_REL }]
    });
    const { message } = await runCapturing(macArchContext(tmpDir, ARCH.ia32));

    assert(message !== '', 'Case F: a wrong-arch bundle throws');
    assert(
      message.includes('do not contain the expected ia32 architecture'),
      'Case F: the error names the expected architecture'
    );
    assert(
      message.includes(`${PRODUCT_NAME}.app/Contents/MacOS/${PRODUCT_NAME}`),
      'Case F: the error lists the offending main executable'
    );
    assert(
      message.includes('better_sqlite3.node'),
      'Case F: the error also lists the offending native addon'
    );
  });
}

// ---------------------------------------------------------------------------
// Case G: a healthy bundle passes every check — REAL lipo, REAL ABI probe.
// ---------------------------------------------------------------------------
async function caseG() {
  const addon = resolveHostLoadableAddon();
  if (!addon) {
    console.log(
      'SKIP: Case G needs a host-loadable better-sqlite3 addon ' +
        '(a v13 prebuild, or `node scripts/ensure-sqlite-abi.mjs host`)'
    );
    return;
  }
  await withTmpDir(async (tmpDir) => {
    buildAppFixture(tmpDir, { addons: [{ source: addon.file, rel: addon.rel }] });
    const { message, warnings } = await runCapturing(macArchContext(tmpDir, hostArchOrdinal()));
    assert(message === '', `Case G: a healthy bundle does not throw (got: ${message})`);
    assert(warnings.length === 0, 'Case G: a healthy bundle emits no warnings');
  });
}

// ---------------------------------------------------------------------------
// Case H: the native module does not load — REAL spawn, REAL require failure.
// The fixture is a real host-arch Mach-O that simply is not a node addon, so
// the architecture check passes and only the ABI probe fails.
// ---------------------------------------------------------------------------
async function caseH() {
  await withTmpDir(async (tmpDir) => {
    buildAppFixture(tmpDir, {
      addons: [{ name: 'better_sqlite3.node', source: machOButNotAnAddon() }]
    });
    const { message } = await runCapturing(macArchContext(tmpDir, hostArchOrdinal()));

    assert(message !== '', 'Case H: an unloadable native module throws');
    assert(
      message.includes('cannot load the packaged better-sqlite3 addon'),
      'Case H: the error identifies the ABI/load failure'
    );
    assert(
      !message.includes('do not contain the expected'),
      'Case H: the architecture check passes — only the load fails'
    );
  });
}

// ---------------------------------------------------------------------------
// Case I: the ABI probe helper, exercised directly against real binaries.
// The verdict is cross-checked against an independent oracle: whether THIS
// process can require the same file.
// ---------------------------------------------------------------------------
async function caseI() {
  const { probeNativeModule } = helpers;

  const notAnAddon = machOButNotAnAddon();
  const badProbe = probeNativeModule(process.execPath, notAnAddon);
  assert(badProbe.ok === false, 'Case I: probing a non-addon Mach-O reports failure');
  assert(
    typeof badProbe.detail === 'string' && badProbe.detail.length > 0,
    'Case I: the failed probe carries the child stderr'
  );

  const addon = resolveHostLoadableAddon();
  if (addon) {
    const goodProbe = probeNativeModule(process.execPath, addon.file);
    assert(
      goodProbe.ok === loadsInProcess(addon.file),
      'Case I: the probe agrees with an in-process require of the same module'
    );
    assert(goodProbe.ok === true, 'Case I: a loadable native module probes clean');
  } else {
    console.log('SKIP: Case I positive probe needs a host-loadable better-sqlite3 addon');
  }

  // The v13 N-API prebuild is the addon every real build ships, and its whole
  // point is that ONE binary loads under both hosts. Pin that under the real
  // Electron: a regression here (a compiled per-ABI artifact sneaking back in)
  // is exactly what would resurrect the third historical release failure.
  const electronBinary = resolveElectronBinary();
  const prebuild = resolveInstalledPrebuild(HOST_ARCH);
  if (electronBinary && prebuild) {
    const underElectron = probeNativeModule(electronBinary, prebuild);
    assert(
      underElectron.ok === true,
      `Case I: the N-API prebuild loads under Electron (got: ${underElectron.detail || 'ok'})`
    );
    assert(
      probeNativeModule(process.execPath, prebuild).ok === true,
      'Case I: the same N-API prebuild loads under host node'
    );
  } else {
    console.log('SKIP: Case I N-API check needs Electron plus the installed v13 prebuild');
  }

  // A REAL NODE_MODULE_VERSION mismatch, reproduced without building anything:
  // a classic per-ABI addon probed under the host it was NOT compiled for.
  // Electron loading a host-ABI module is precisely the failure that shipped;
  // host node loading an Electron-ABI module is the same defect mirrored.
  const abiSpecific = resolveAbiSpecificAddon();
  if (abiSpecific && (abiSpecific.loadsOnHost ? electronBinary : true)) {
    const wrongHost = abiSpecific.loadsOnHost ? electronBinary : process.execPath;
    const mismatch = probeNativeModule(wrongHost, abiSpecific.file);
    assert(
      mismatch.ok === false,
      'Case I: a per-ABI native module is refused by the other host (real ABI mismatch)'
    );
    assert(
      mismatch.detail.includes('NODE_MODULE_VERSION'),
      `Case I: the failure reports the NODE_MODULE_VERSION mismatch verbatim (got: ${mismatch.detail})`
    );
  } else {
    console.log('SKIP: Case I NODE_MODULE_VERSION check needs a per-ABI addon (plus Electron if it is host-ABI)');
  }
}

// ---------------------------------------------------------------------------
// Case J: better_sqlite3.node missing from an otherwise populated bundle
// ---------------------------------------------------------------------------
async function caseJ() {
  await withTmpDir(async (tmpDir) => {
    buildAppFixture(tmpDir, {
      addons: [{ name: 'pty.node', dep: 'node-pty', source: machOButNotAnAddon() }]
    });
    const { message } = await runCapturing(macArchContext(tmpDir, hostArchOrdinal()));

    assert(message !== '', 'Case J: a bundle without a better-sqlite3 addon throws');
    assert(
      message.includes('no better-sqlite3 native addon was found'),
      'Case J: the error names the missing module'
    );
    assert(
      !message.includes('no *.node native addons found'),
      'Case J: other addons are present, so the empty-addons check does not fire'
    );
  });
}

// ---------------------------------------------------------------------------
// Case K: zero native addons at all
// ---------------------------------------------------------------------------
async function caseK() {
  await withTmpDir(async (tmpDir) => {
    buildAppFixture(tmpDir, { addons: [] });
    const { message } = await runCapturing(macArchContext(tmpDir, hostArchOrdinal()));

    assert(message !== '', 'Case K: a bundle with no native addons throws');
    assert(
      message.includes('no *.node native addons found'),
      'Case K: the error explains that native modules were not unpacked'
    );
  });
}

// ---------------------------------------------------------------------------
// Case L: size floors — a stub .app and a stub asar, reported together
// ---------------------------------------------------------------------------
async function caseL() {
  await withTmpDir(async (tmpDir) => {
    buildAppFixture(tmpDir, { padBytes: 0, asarBytes: 4096 });
    const { message } = await runCapturing(macArchContext(tmpDir, hostArchOrdinal()));

    assert(message !== '', 'Case L: an undersized bundle throws');
    assert(
      message.includes('the packaged app is only'),
      'Case L: the error reports the .app size floor'
    );
    assert(
      message.includes('app.asar is only'),
      'Case L: the error reports the app.asar size floor'
    );
    assert(
      /failed \d+ verification check\(s\)/.test(message),
      'Case L: both floors are reported in ONE error'
    );
  });
}

// ---------------------------------------------------------------------------
// Case M: app.asar missing entirely
// ---------------------------------------------------------------------------
async function caseM() {
  await withTmpDir(async (tmpDir) => {
    buildAppFixture(tmpDir, { asarBytes: false });
    const { message } = await runCapturing(macArchContext(tmpDir, hostArchOrdinal()));
    assert(message.includes('app.asar is missing'), 'Case M: a missing app.asar throws');
  });
}

// ---------------------------------------------------------------------------
// Case N: every failure is collected and reported at once
// ---------------------------------------------------------------------------
async function caseN() {
  await withTmpDir(async (tmpDir) => {
    // No Info.plist, no addons, no asar, no padding: four independent failures.
    buildAppFixture(tmpDir, {
      withInfoPlist: false,
      withExecutable: false,
      addons: [],
      asarBytes: false,
      padBytes: 0
    });
    const { message } = await runCapturing(macArchContext(tmpDir, hostArchOrdinal()));

    assert(message.includes('Info.plist is missing'), 'Case N: reports the missing Info.plist');
    assert(message.includes('no *.node native addons'), 'Case N: reports the missing addons');
    assert(message.includes('no better-sqlite3 native addon was found'), 'Case N: reports the missing DB module');
    assert(message.includes('the packaged app is only'), 'Case N: reports the size floor');
    assert(message.includes('app.asar is missing'), 'Case N: reports the missing asar');
    assert(
      /failed 5 verification check\(s\)/.test(message),
      'Case N: all five failures arrive in a single error'
    );
    assert(
      message.includes('  1. ') && message.includes('  5. '),
      'Case N: the failures are enumerated for the release engineer'
    );
  });
}

// ---------------------------------------------------------------------------
// Case O: CYBOFLOW_SKIP_BUNDLE_CHECKS=1 skips the hard checks, loudly
// ---------------------------------------------------------------------------
async function caseO() {
  await withTmpDir(async (tmpDir) => {
    // A bundle that would fail every single check.
    buildAppFixture(tmpDir, {
      withInfoPlist: false,
      withExecutable: false,
      addons: [],
      asarBytes: false,
      padBytes: 0
    });

    const previous = process.env.CYBOFLOW_SKIP_BUNDLE_CHECKS;
    process.env.CYBOFLOW_SKIP_BUNDLE_CHECKS = '1';
    let result;
    try {
      result = await runCapturing(macArchContext(tmpDir, hostArchOrdinal()));
    } finally {
      if (previous === undefined) delete process.env.CYBOFLOW_SKIP_BUNDLE_CHECKS;
      else process.env.CYBOFLOW_SKIP_BUNDLE_CHECKS = previous;
    }

    assert(result.error === null, 'Case O: the skip switch suppresses the hard failure');
    const warnText = result.warnings.join('\n');
    assert(
      warnText.includes('CYBOFLOW_SKIP_BUNDLE_CHECKS=1'),
      'Case O: the skip is announced loudly on stderr'
    );
    assert(
      warnText.includes('Do not ship an artifact produced with this set.'),
      'Case O: the warning says the artifact must not ship'
    );
  });
}

// ---------------------------------------------------------------------------
// Case P: missing signing credentials do NOT skip the hard checks
// ---------------------------------------------------------------------------
async function caseP() {
  await withTmpDir(async (tmpDir) => {
    buildAppFixture(tmpDir, { addons: [] });

    const savedLink = process.env.CSC_LINK;
    const savedPassword = process.env.CSC_KEY_PASSWORD;
    delete process.env.CSC_LINK;
    delete process.env.CSC_KEY_PASSWORD;
    let result;
    try {
      result = await runCapturing(macArchContext(tmpDir, hostArchOrdinal()));
    } finally {
      if (savedLink !== undefined) process.env.CSC_LINK = savedLink;
      if (savedPassword !== undefined) process.env.CSC_KEY_PASSWORD = savedPassword;
    }

    assert(
      result.message.includes('no *.node native addons found'),
      'Case P: an unsigned dev build is still verified'
    );
  });
}

// ---------------------------------------------------------------------------
// Case Q: a bundle whose Info.plist points at a nonexistent executable
// ---------------------------------------------------------------------------
async function caseQ() {
  await withTmpDir(async (tmpDir) => {
    buildAppFixture(tmpDir, { withExecutable: false });
    const { message } = await runCapturing(macArchContext(tmpDir, hostArchOrdinal()));
    assert(
      message.includes('as CFBundleExecutable but'),
      'Case Q: a dangling CFBundleExecutable is reported'
    );
  });
}

// ---------------------------------------------------------------------------
// Case R: helper-level checks that do not need a bundle
// ---------------------------------------------------------------------------
async function caseR() {
  const { computeDirectorySize, collectNodeAddons, readBundleExecutableName, verifyBundle } = helpers;

  await withTmpDir(async (tmpDir) => {
    // Symlinks are skipped, so a link to a huge file cannot inflate the total.
    fs.writeFileSync(path.join(tmpDir, 'a.bin'), Buffer.alloc(1024));
    fs.symlinkSync(process.execPath, path.join(tmpDir, 'link-to-node'));
    assert(
      computeDirectorySize(tmpDir) === 1024,
      'Case R: directory size counts real files and skips symlinks'
    );

    fs.mkdirSync(path.join(tmpDir, 'nested', 'deeper'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'nested', 'deeper', 'x.node'), 'x');
    fs.writeFileSync(path.join(tmpDir, 'nested', 'notes.txt'), 'x');
    const addons = collectNodeAddons(path.join(tmpDir, 'nested'));
    assert(addons.length === 1 && addons[0].endsWith('x.node'), 'Case R: only *.node files are collected');

    assert(
      collectNodeAddons(path.join(tmpDir, 'does-not-exist')).length === 0,
      'Case R: a missing directory yields no addons rather than throwing'
    );

    const appPath = buildAppFixture(tmpDir);
    assert(
      readBundleExecutableName(appPath).name === PRODUCT_NAME,
      'Case R: CFBundleExecutable is read out of Info.plist'
    );

    // electron-builder writes XML today, but a binary plist must still resolve.
    const plistPath = path.join(appPath, 'Contents', 'Info.plist');
    try {
      require('child_process').execFileSync('plutil', ['-convert', 'binary1', plistPath]);
      assert(
        fs.readFileSync(plistPath).slice(0, 8).toString('latin1') === 'bplist00',
        'Case R: the fixture Info.plist really is a binary plist now'
      );
      assert(
        readBundleExecutableName(appPath).name === PRODUCT_NAME,
        'Case R: a binary Info.plist is converted (to stdout) and read'
      );
    } catch (err) {
      if (err && err.code === 'ENOENT') {
        console.log('SKIP: Case R binary-plist check needs plutil');
      } else {
        throw err;
      }
    }

    assert(
      verifyBundle({ appPath: path.join(tmpDir, 'Nope.app'), expectedArch: 'arm64' })[0]
        .includes('missing entirely'),
      'Case R: a missing .app is a single, self-explanatory failure'
    );

    const unresolved = verifyBundle({ appPath, expectedArch: null });
    assert(
      unresolved.some((failure) => failure.includes('could not determine the expected architecture')),
      'Case R: an unresolvable arch fails rather than silently skipping'
    );
  });
}

// ---------------------------------------------------------------------------
// Case S: the third historical release failure, end to end.
// The bundle's better_sqlite3.node is a real per-ABI addon compiled for a
// DIFFERENT host than the bundle's "Electron" — the exact shape of the mismatch
// that shipped. Direction depends on which per-ABI addon this checkout has
// banked: a host-ABI addon under the real Electron binary, or an Electron-ABI
// addon under host node. Nothing is stubbed. Skips (honestly) on a checkout
// with no pre-v13 artifact banked — every shipped addon is N-API now.
// ---------------------------------------------------------------------------
async function caseS() {
  const electronBinary = resolveElectronBinary();
  const abiSpecific = resolveAbiSpecificAddon();
  if (!abiSpecific || (abiSpecific.loadsOnHost && !electronBinary)) {
    console.log('SKIP: Case S needs a per-ABI native addon (plus Electron if it is host-ABI)');
    return;
  }
  await withTmpDir(async (tmpDir) => {
    const appPath = buildAppFixture(tmpDir, {
      withExecutable: !abiSpecific.loadsOnHost,
      addons: [{ source: abiSpecific.file, rel: COMPILED_SQLITE_REL }]
    });
    if (abiSpecific.loadsOnHost) {
      fs.symlinkSync(electronBinary, path.join(appPath, 'Contents', 'MacOS', PRODUCT_NAME));
    }

    const { message } = await runCapturing(macArchContext(tmpDir, hostArchOrdinal()));
    assert(message !== '', 'Case S: an ABI-mismatched bundle fails the build');
    assert(
      message.includes('NODE_MODULE_VERSION'),
      'Case S: the build error carries the NODE_MODULE_VERSION diagnosis'
    );
    assert(
      message.includes('cannot load the packaged better-sqlite3 addon'),
      'Case S: the build error explains which module is at fault'
    );
    assert(
      !message.includes('asar-fs-wrapper'),
      "Case S: Electron's minified bootstrap dump is stripped from the message"
    );
  });
}

// ---------------------------------------------------------------------------
// Case T: stderr summarization keeps the message, drops the bundle
// ---------------------------------------------------------------------------
async function caseT() {
  const { summarizeProbeStderr } = helpers;
  const minified = `(()=>{${'x'.repeat(9000)}})()`;
  const summarized = summarizeProbeStderr(
    `node:electron/js2c/node_init:2\n${minified}\n\nError: NODE_MODULE_VERSION 127 vs 136\n`
  );
  assert(!summarized.includes('xxxx'), 'Case T: the minified bootstrap line is dropped');
  assert(
    summarized.includes('NODE_MODULE_VERSION 127 vs 136'),
    'Case T: the human-readable error survives'
  );
  assert(
    summarizeProbeStderr(`${'short line\n'.repeat(2000)}TAIL MARKER`).includes('TAIL MARKER'),
    'Case T: when truncation is needed the TAIL is kept, not the head'
  );
}

// ---------------------------------------------------------------------------
// Case U: the universal-bundle rules, via the injectable command runner.
// A half-universal main executable cannot be produced on a single-arch host,
// so this is the one place command execution is stubbed.
// ---------------------------------------------------------------------------
async function caseU() {
  const { verifyBundle } = helpers;

  /** Stub `lipo` per file suffix; let the ABI probe succeed. */
  function stubExecFile(slicesBySuffix) {
    return (file, args) => {
      if (file !== 'lipo') return '';
      const target = args[args.length - 1];
      const suffix = Object.keys(slicesBySuffix).find((key) => target.endsWith(key));
      return `${slicesBySuffix[suffix] || 'arm64'}\n`;
    };
  }

  await withTmpDir(async (tmpDir) => {
    const appPath = buildAppFixture(tmpDir);
    const sqliteName = defaultSqliteBasename();

    const halfUniversal = verifyBundle({
      appPath,
      expectedArch: 'universal',
      execFile: stubExecFile({ [PRODUCT_NAME]: 'x86_64', [sqliteName]: 'arm64' })
    });
    assert(
      halfUniversal.length === 1 && halfUniversal[0].includes(`MacOS/${PRODUCT_NAME}`),
      'Case U: a universal bundle whose main executable has one slice is rejected'
    );
    assert(
      !halfUniversal[0].includes(sqliteName),
      'Case U: a single-slice addon inside a universal bundle is allowed (x64ArchFiles)'
    );

    const fullyUniversal = verifyBundle({
      appPath,
      expectedArch: 'universal',
      execFile: stubExecFile({ [PRODUCT_NAME]: 'x86_64 arm64', [sqliteName]: 'arm64' })
    });
    assert(fullyUniversal.length === 0, 'Case U: a genuinely universal bundle passes');

    const lipoBroken = verifyBundle({
      appPath,
      expectedArch: 'arm64',
      execFile: (file) => {
        if (file === 'lipo') throw new Error('fat file has no architectures');
        return '';
      }
    });
    assert(
      lipoBroken.some((failure) => failure.includes('could not read the architecture')),
      'Case U: an unreadable binary is a failure, not a silent pass'
    );
  });
}

// Case V: foreign-platform prebuilds are skipped, not fed to lipo.
// node-pty-prebuilt-multiarch bundles linux/win32/etc prebuilds that are ELF/PE,
// not Mach-O. They must be excluded from the arch check (they crashed lipo and
// produced 48 spurious failures on the 0.2.6 build).
async function caseV() {
  const { isForeignPrebuild, collectNodeAddons } = helpers;

  assert(isForeignPrebuild(`root/node-pty/prebuilds/linux-arm/node.abi127.node`),
    'Case V: linux-arm prebuild is foreign');
  assert(isForeignPrebuild(`root/node-pty/prebuilds/linux-x64/node.abi127.musl.node`),
    'Case V: linux-x64 musl prebuild is foreign');
  assert(isForeignPrebuild(`root/node-pty/prebuilds/win32-x64/node.abi127.node`),
    'Case V: win32-x64 prebuild is foreign');
  assert(!isForeignPrebuild(`root/node-pty/prebuilds/darwin-arm64/node.abi127.node`),
    'Case V: darwin-arm64 prebuild is NOT foreign');
  assert(!isForeignPrebuild(`root/node-pty/prebuilds/darwin-x64/node.abi127.node`),
    'Case V: darwin-x64 prebuild is NOT foreign');
  assert(!isForeignPrebuild(`root/better-sqlite3/build/Release/better_sqlite3.node`),
    'Case V: a non-prebuild addon is NOT foreign');

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aftersign-test-'));
  try {
    const root = path.join(tmpDir, 'app.asar.unpacked');
    const layout = {
      'better-sqlite3/build/Release/better_sqlite3.node': 'x',
      'node-pty/prebuilds/darwin-arm64/node.abi127.node': 'x',
      'node-pty/prebuilds/darwin-x64/node.abi127.node': 'x',
      'node-pty/prebuilds/linux-arm/node.abi127.node': 'x',
      'node-pty/prebuilds/linux-x64/node.abi127.musl.node': 'x',
      'node-pty/prebuilds/win32-x64/node.abi127.node': 'x',
    };
    for (const [rel, body] of Object.entries(layout)) {
      const full = path.join(root, rel);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, body);
    }

    const collected = collectNodeAddons(root).map((f) => path.basename(path.dirname(f)));
    assert(collected.length === 3,
      `Case V: only the 3 macOS addons are collected (got ${collected.length}: ${collected.join(', ')})`);
    assert(!collected.includes('linux-arm') && !collected.includes('linux-x64') && !collected.includes('win32-x64'),
      'Case V: no foreign prebuild survives collection');
    assert(collected.includes('darwin-arm64') && collected.includes('darwin-x64'),
      'Case V: both darwin prebuilds survive collection when no arch is expected');

    const perArch = collectNodeAddons(root, 'arm64').map((f) => path.basename(path.dirname(f)));
    assert(perArch.length === 2 && perArch.includes('darwin-arm64') && !perArch.includes('darwin-x64'),
      `Case V: an arm64 build drops the darwin-x64 prebuild (got: ${perArch.join(', ')})`);
    const universal = collectNodeAddons(root, 'universal');
    assert(universal.length === 3, 'Case V: a universal build keeps both darwin prebuilds');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Case W: better-sqlite3 v13's N-API prebuild layout.
// Since v13 there is no build/Release/better_sqlite3.node at all — the addon is
// `prebuilds/darwin-<arch>.node`, and a per-arch build carries BOTH darwin
// prebuilds. The verifier must (a) recognise the prebuild as better-sqlite3,
// (b) skip the other arch's prebuild instead of failing it, and (c) still probe
// the right one. Pure layout assertions first; then the real thing end to end
// against the installed prebuilds when this checkout has them.
// ---------------------------------------------------------------------------
async function caseW() {
  const { isForeignPrebuild, isBetterSqliteAddon, findBetterSqliteAddon, parsePrebuildTarget } = helpers;
  const p = (...segments) => path.join('root', ...segments);

  const flat = parsePrebuildTarget(p('better-sqlite3', 'prebuilds', 'darwin-x64.node'));
  assert(flat && flat.platform === 'darwin' && flat.arch === 'x64',
    'Case W: the flat v13 prebuild layout parses to darwin/x64');
  const nested = parsePrebuildTarget(p('node-pty', 'prebuilds', 'darwin-arm64', 'pty.node'));
  assert(nested && nested.platform === 'darwin' && nested.arch === 'arm64',
    'Case W: the nested node-pty prebuild layout parses to darwin/arm64');
  assert(parsePrebuildTarget(p('better-sqlite3', 'build', 'Release', 'better_sqlite3.node')) === null,
    'Case W: a compiled addon is not a prebuild');

  assert(isForeignPrebuild(p('better-sqlite3', 'prebuilds', 'darwin-x64.node'), 'arm64'),
    'Case W: the darwin-x64 prebuild is foreign to an arm64 build');
  assert(!isForeignPrebuild(p('better-sqlite3', 'prebuilds', 'darwin-arm64.node'), 'arm64'),
    'Case W: the darwin-arm64 prebuild is native to an arm64 build');
  assert(isForeignPrebuild(p('node-pty', 'prebuilds', 'darwin-arm64', 'pty.node'), 'x64'),
    'Case W: the nested darwin-arm64 prebuild is foreign to an x64 build');
  assert(!isForeignPrebuild(p('better-sqlite3', 'prebuilds', 'darwin-x64.node'), 'universal'),
    'Case W: a universal build keeps both darwin prebuilds');
  assert(isForeignPrebuild(p('better-sqlite3', 'prebuilds', 'linuxmusl-x64.node'), 'x64'),
    'Case W: a non-darwin prebuild is foreign regardless of arch');
  assert(!isForeignPrebuild(p('better-sqlite3', 'build', 'Release', 'better_sqlite3.node'), 'arm64'),
    'Case W: a compiled addon is never foreign');

  assert(isBetterSqliteAddon(p('better-sqlite3', 'prebuilds', 'darwin-arm64.node')),
    'Case W: the v13 prebuild is recognised as better-sqlite3');
  assert(isBetterSqliteAddon(p('some-dep', 'build', 'Release', 'better_sqlite3.node')),
    'Case W: the compiled better_sqlite3.node is still recognised');
  assert(!isBetterSqliteAddon(p('node-pty', 'prebuilds', 'darwin-arm64', 'pty.node')),
    'Case W: another package\'s darwin prebuild is not better-sqlite3');
  assert(!isBetterSqliteAddon(p('better-sqlite3', 'prebuilds', 'linux-x64.node')),
    'Case W: a non-darwin better-sqlite3 prebuild is not the addon this build loads');

  const both = [
    p('better-sqlite3', 'prebuilds', `darwin-${OTHER_ARCH}.node`),
    p('better-sqlite3', 'prebuilds', `darwin-${HOST_ARCH}.node`),
  ];
  assert(findBetterSqliteAddon(both) === both[1],
    'Case W: with both darwin prebuilds present, the host-arch one is probed');
  assert(findBetterSqliteAddon([p('node-pty', 'build', 'Release', 'pty.node')]) === null,
    'Case W: no better-sqlite3 addon among other addons resolves to null');

  if (process.platform !== 'darwin') {
    console.log('SKIP: Case W end-to-end is darwin-only (real lipo + probe)');
    return;
  }
  const hostPrebuild = resolveInstalledPrebuild(HOST_ARCH);
  const otherPrebuild = resolveInstalledPrebuild(OTHER_ARCH);
  if (!hostPrebuild || !otherPrebuild) {
    console.log('SKIP: Case W end-to-end needs the installed better-sqlite3 v13 prebuilds');
    return;
  }
  await withTmpDir(async (tmpDir) => {
    // Exactly what a per-arch build carries: both darwin prebuilds, no
    // build/Release artifact anywhere.
    buildAppFixture(tmpDir, {
      addons: [
        { source: hostPrebuild, rel: prebuiltSqliteRel(HOST_ARCH) },
        { source: otherPrebuild, rel: prebuiltSqliteRel(OTHER_ARCH) },
      ]
    });
    const { message, warnings } = await runCapturing(macArchContext(tmpDir, hostArchOrdinal()));
    assert(message === '', `Case W: a v13-layout bundle passes every check (got: ${message})`);
    assert(warnings.length === 0, 'Case W: a v13-layout bundle emits no warnings');
  });
  await withTmpDir(async (tmpDir) => {
    // The same bundle judged for the OTHER arch: the other-arch prebuild is now
    // the native one and must be probed; it cannot load on this host (a real
    // cross-arch dlopen failure, or Rosetta-less arm64-on-x64), and the
    // host-arch prebuild must be skipped rather than reported as wrong-arch.
    buildAppFixture(tmpDir, {
      addons: [
        { source: hostPrebuild, rel: prebuiltSqliteRel(HOST_ARCH) },
        { source: otherPrebuild, rel: prebuiltSqliteRel(OTHER_ARCH) },
      ]
    });
    const { message } = await runCapturing(macArchContext(tmpDir, ARCH[OTHER_ARCH]));
    assert(
      !message.includes(`darwin-${HOST_ARCH}.node`),
      `Case W: the host-arch prebuild is skipped on an ${OTHER_ARCH} build, not judged (got: ${message})`
    );
  });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
(async () => {
  console.log('--- afterSign smoke test ---');
  await caseA();
  await caseB();
  await caseC();
  await caseD();
  await caseE();
  if (process.platform === 'darwin') {
    // Cases F–K exercise REAL macOS `codesign`/`lipo` against Mach-O
    // fixtures (and dlopen a host-ABI addon); on Linux CI they can only fail
    // for platform reasons, which proves nothing about the verification
    // logic they exist to pin.
    await caseF();
    await caseG();
    await caseH();
    await caseI();
    await caseJ();
    await caseK();
  } else {
    console.log(
      `SKIP: cases F-K are darwin-only (host is ${process.platform}); codesign/lipo/Mach-O probes cannot run here.`,
    );
  }
  await caseL();
  await caseM();
  await caseN();
  await caseO();
  await caseP();
  await caseQ();
  await caseR();
  await caseS();
  await caseT();
  await caseU();
  await caseV();
  await caseW();

  console.log(`\nResults: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})();
