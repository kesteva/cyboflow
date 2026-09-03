/**
 * Post-sign verification hook for electron-builder.
 *
 * Two responsibilities:
 *
 * 1. JAR TRIPWIRE (warn-only, historical). Scan the unpacked asar tree for
 *    `*.jar` files and warn loudly if any are found. JARs can carry unsigned
 *    native code that fails notarization or trips Gatekeeper, and none of the
 *    currently shipped dependencies contain any — so a JAR appearing here means
 *    a dependency changed and the packaging config needs a decision.
 *
 *    This hook deliberately does NOT delete anything: it runs after codesign,
 *    and removing a file from an already-signed .app invalidates the bundle's
 *    resource seal. The fix for a real JAR belongs BEFORE signing — exclude it
 *    via `build.files` / package exclusion, or sign its native contents.
 *
 *    (Historical: the Crystal-era version of this hook stripped JARs from
 *    `@anthropic-ai/claude-code/vendor/`; that package is no longer shipped —
 *    the SDK path uses `@anthropic-ai/claude-agent-sdk` — so the strip logic
 *    had been a silent no-op and was retired.)
 *
 * 2. BUNDLE HARD CHECKS (throw on failure). Three release failures have shipped
 *    from this repo, each of which a mechanical check would have caught:
 *      - DMGs that were 215K stubs (the packaging produced an empty artifact),
 *      - an x64 build handed to arm64 users (wrong-arch binaries in the bundle),
 *      - a better-sqlite3 NODE_MODULE_VERSION mismatch (the bundled Electron
 *        could not dlopen the native module it shipped with).
 *    Each was found by hand, after release. The checks below fail the BUILD
 *    instead: bundle architecture, a real runtime ABI probe of the packaged
 *    better_sqlite3.node, and size floors on the .app and its asar.
 *
 *    Every failure is collected and reported in ONE error, so a release
 *    engineer sees everything that is wrong in a single pass rather than
 *    peeling them off one rebuild at a time.
 *
 *    Escape hatch: CYBOFLOW_SKIP_BUNDLE_CHECKS=1 skips the hard checks (loudly).
 *    Missing signing credentials do NOT skip them — an unsigned dev build is
 *    still a build whose bundle can be wrong-arch or ABI-broken.
 *
 *    Windows gets the same three checks against the win-unpacked layout
 *    (`verifyWindowsBundle`): the PE machine type of `<productName>.exe`
 *    read from the COFF header (there is no `lipo` on Windows), the same
 *    ELECTRON_RUN_AS_NODE load probe of the packaged better_sqlite3.node, and
 *    a size floor on the unpacked directory. The JAR tripwire stays mac-only.
 *
 * Notarization is delegated to electron-builder's built-in hook (controlled
 * by build.mac.notarize in package.json). This script does NOT invoke the
 * notarization toolchain directly.
 *
 * READ-ONLY over the bundle. Nothing here writes into the .app — in particular
 * no `.node` file is ever rewritten in place. Rewriting a mapped native module
 * keeps the inode and breaks macOS lazy code-signature page validation
 * (KERN_CODESIGN_ERROR at dlopen; see Sentry CYBOFLOW-APP-6).
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFileSync } = require('child_process');

/** A real .app is ~300MB+; anything near this floor is a packaging failure. */
const DEFAULT_MIN_APP_BYTES = 150 * 1024 * 1024;
/** The asar carries main + frontend + node_modules; a stub is orders smaller. */
const DEFAULT_MIN_ASAR_BYTES = 10 * 1024 * 1024;
/** A real win-unpacked dir measures ~1.1 GB; near this floor is a stub. */
const DEFAULT_MIN_WIN_UNPACKED_BYTES = 300 * 1024 * 1024;

const SKIP_ENV_VAR = 'CYBOFLOW_SKIP_BUNDLE_CHECKS';

/**
 * builder-util's `Arch` enum is a NUMBER on the hook context
 * (`AfterPackContext.arch`), not a string — see
 * node_modules/builder-util/out/arch.d.ts. Index = ordinal.
 */
const ARCH_NAME_BY_ORDINAL = ['ia32', 'x64', 'armv7l', 'arm64', 'universal'];

/** Mach-O slice names (as `lipo -archs` prints them) that satisfy each arch. */
const SLICES_BY_ARCH = {
  ia32: ['i386'],
  x64: ['x86_64', 'x86_64h'],
  armv7l: ['armv7', 'armv7s'],
  arm64: ['arm64', 'arm64e'],
};

/** COFF machine types (PE header) that satisfy each arch on Windows. */
const PE_MACHINE_BY_ARCH = {
  ia32: 0x014c,
  x64: 0x8664,
  arm64: 0xaa64,
};

/** Default command runner; injectable so tests can stub command execution. */
function defaultExecFile(file, args, options) {
  return execFileSync(file, args, { encoding: 'utf8', ...options });
}

function collectJarsRecursively(dir, found) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectJarsRecursively(fullPath, found);
    } else if (entry.name.endsWith('.jar')) {
      found.push(fullPath);
    }
  }
}

/**
 * Normalize `context.arch` to an arch name.
 *
 * Accepts the Arch enum ordinal electron-builder actually passes, and a plain
 * string for callers that already resolved it. Returns null when the value
 * names no architecture we know how to verify — which is itself reported as a
 * failure rather than silently skipped.
 */
function resolveExpectedArch(arch) {
  if (typeof arch === 'number' && Number.isInteger(arch)) {
    return ARCH_NAME_BY_ORDINAL[arch] || null;
  }
  if (typeof arch === 'string') {
    const normalized = arch === 'x86_64' ? 'x64' : arch;
    if (normalized === 'universal' || SLICES_BY_ARCH[normalized]) return normalized;
  }
  return null;
}

/** Read the Mach-O slices in `file` via `lipo -archs`. Throws on unreadable input. */
function lipoArchs(file, execFile = defaultExecFile) {
  const output = execFile('lipo', ['-archs', file], { stdio: ['ignore', 'pipe', 'pipe'] });
  return String(output).trim().split(/\s+/).filter(Boolean);
}

/**
 * Does a binary carrying `slices` satisfy `expectedArch`?
 *
 * A universal build must carry BOTH slices in its main executable. Individual
 * native addons inside a universal bundle legitimately stay single-arch (that
 * is what build.mac.x64ArchFiles declares), so callers pass
 * `allowSingleSliceUniversal` for those.
 */
function archMatches(slices, expectedArch, allowSingleSliceUniversal = false) {
  if (expectedArch === 'universal') {
    const hasX64 = SLICES_BY_ARCH.x64.some((slice) => slices.includes(slice));
    const hasArm64 = SLICES_BY_ARCH.arm64.some((slice) => slices.includes(slice));
    return allowSingleSliceUniversal ? hasX64 || hasArm64 : hasX64 && hasArm64;
  }
  const accepted = SLICES_BY_ARCH[expectedArch] || [];
  return accepted.some((slice) => slices.includes(slice));
}

/**
 * Read the COFF machine type out of a PE image header (the Windows equivalent
 * of asking `lipo` for the Mach-O slices). `buffer` must start with the DOS
 * 'MZ' magic; the uint32 at 0x3C points at the 'PE\0\0' signature, whose
 * COFF header carries the machine type as its first uint16. Returns null when
 * the buffer is not a PE image or is truncated — never throws.
 */
function readPeMachineType(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 0x40) return null;
  if (buffer.readUInt16LE(0) !== 0x5a4d) return null; // 'MZ'
  const peOffset = buffer.readUInt32LE(0x3c);
  if (peOffset + 6 > buffer.length) return null;
  if (buffer.readUInt32LE(peOffset) !== 0x00004550) return null; // 'PE\0\0'
  return buffer.readUInt16LE(peOffset + 4);
}

/**
 * Resolve the bundle's main executable from Contents/Info.plist.
 *
 * The product name varies by variant ("Cyboflow" vs "Cyboflow Dev"), so the
 * plist is the only honest source. electron-builder writes XML, but a binary
 * plist is converted through `plutil` to stdout — never rewritten on disk.
 * Returns { name } or { error }.
 */
function readBundleExecutableName(appPath, execFile = defaultExecFile) {
  const plistPath = path.join(appPath, 'Contents', 'Info.plist');
  if (!fs.existsSync(plistPath)) {
    return { error: `Contents/Info.plist is missing from ${appPath}` };
  }

  let xml;
  const raw = fs.readFileSync(plistPath);
  if (raw.slice(0, 8).toString('latin1') === 'bplist00') {
    try {
      xml = String(execFile('plutil', ['-convert', 'xml1', '-o', '-', plistPath], {
        stdio: ['ignore', 'pipe', 'pipe'],
      }));
    } catch (err) {
      return { error: `could not read the binary Info.plist at ${plistPath}: ${err.message}` };
    }
  } else {
    xml = raw.toString('utf8');
  }

  const match = xml.match(/<key>CFBundleExecutable<\/key>\s*<string>([^<]*)<\/string>/);
  if (!match || !match[1].trim()) {
    return { error: `Info.plist at ${plistPath} declares no CFBundleExecutable` };
  }
  return { name: match[1].trim() };
}

/**
 * Is this `.node` a prebuilt binary for a non-macOS platform?
 *
 * node-pty-prebuilt-multiarch ships prebuilds for every platform it supports
 * under `prebuilds/<platform>-<arch>/` (linux, win32, android, …), and they all
 * ride along in the asar even on a macOS build. Those are ELF/PE, not Mach-O, so
 * `lipo -archs` cannot read them — feeding them to the arch check produces dozens
 * of spurious "could not read the architecture" failures. Only `darwin`
 * prebuilds are Mach-O and worth verifying; the rest are dead weight on macOS and
 * must be skipped, not judged.
 */
function isForeignPrebuild(file) {
  const segments = file.split(path.sep);
  const idx = segments.lastIndexOf('prebuilds');
  if (idx === -1 || idx + 1 >= segments.length) return false;
  const platform = segments[idx + 1].split('-')[0];
  return platform !== 'darwin';
}

/**
 * Collect every macOS `*.node` under `dir`, ignoring symlinks and the bundled
 * foreign-platform prebuilds (see `isForeignPrebuild`).
 */
function collectNodeAddons(dir, found = []) {
  if (!fs.existsSync(dir)) return found;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectNodeAddons(fullPath, found);
    } else if (entry.isFile() && entry.name.endsWith('.node')) {
      if (isForeignPrebuild(fullPath)) continue;
      found.push(fullPath);
    }
  }
  return found;
}

/**
 * Collect every `*.node` under `dir` for a WINDOWS bundle. Same walk as the
 * mac arm, but `prebuilds/` directories are skipped entirely instead of
 * filtered per-file: node-pty-prebuilt-multiarch ships every platform's
 * prebuild under `prebuilds/<platform>-<arch>/`, and on Windows none of them
 * is the loadable addon (that lives in `build/Release`), so they are dead
 * weight that must not reach the probe.
 */
function collectNodeAddonsForWindows(dir, found = []) {
  if (!fs.existsSync(dir)) return found;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'prebuilds') continue;
      collectNodeAddonsForWindows(fullPath, found);
    } else if (entry.isFile() && entry.name.endsWith('.node')) {
      found.push(fullPath);
    }
  }
  return found;
}

/**
 * Sum the logical size of every regular file under `dir`.
 *
 * Symlinks are skipped rather than followed: a .app's Frameworks directory is
 * full of version symlinks, and following them double-counts every framework.
 */
function computeDirectorySize(dir) {
  let total = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      total += computeDirectorySize(fullPath);
    } else if (entry.isFile()) {
      total += fs.statSync(fullPath).size;
    }
  }
  return total;
}

/**
 * Ask the packaged Electron binary, running as Node, to `require()` the
 * packaged native module. This is the only honest ABI check: a matching
 * NODE_MODULE_VERSION is not something you can infer from file names or build
 * metadata — you find out by dlopen'ing it under the host that will ship.
 *
 * ELECTRON_RUN_AS_NODE is MANDATORY. Spawning an Electron app binary without
 * it launches the app, which in this codebase has historically fork-bombed
 * (see docs: execPath fork-bomb). With it, the same binary behaves as Node.
 *
 * Cross-arch note: probing an x64 bundle on an arm64 host runs under Rosetta.
 * That is expected and still measures the right ABI.
 */
function probeNativeModule(executable, modulePath, execFile = defaultExecFile) {
  // Capture stderr through a FILE rather than a pipe. spawnSync truncates piped
  // output at 8 KB regardless of maxBuffer, and Electron's uncaught-exception
  // dump opens with a ~20 KB minified bootstrap line — so a pipe keeps only the
  // noise and drops the NODE_MODULE_VERSION diagnosis that follows it.
  const stderrFile = path.join(
    os.tmpdir(),
    `cyboflow-abi-probe-${process.pid}-${Date.now()}.log`
  );
  let fd;
  try {
    fd = fs.openSync(stderrFile, 'w');
  } catch (_err) {
    fd = 'pipe';
  }

  try {
    execFile(executable, ['-e', 'require(process.argv[1])', modulePath], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['ignore', 'ignore', fd],
    });
    return { ok: true };
  } catch (err) {
    let captured = '';
    try {
      captured = fs.readFileSync(stderrFile, 'utf8');
    } catch (_readErr) {
      captured = err.stderr ? String(err.stderr) : '';
    }
    const detail = summarizeProbeStderr(captured) || String(err.message || 'unknown failure');
    return { ok: false, detail };
  } finally {
    if (typeof fd === 'number') {
      try {
        fs.closeSync(fd);
      } catch (_err) {
        // Already closed by the spawn; nothing to do.
      }
    }
    fs.rmSync(stderrFile, { force: true });
  }
}

/** Longer than this and a line is a minified bundle, not a message for a human. */
const MAX_STDERR_LINE_LENGTH = 500;
const MAX_STDERR_CHARS = 4000;

/**
 * Reduce a failed probe's stderr to the part a release engineer needs.
 *
 * Electron prints the offending source line before the error, and for its own
 * bootstrap that line is the whole minified bundle. Dropping over-long lines
 * leaves exactly the Error text, the NODE_MODULE_VERSION numbers and the stack.
 */
function summarizeProbeStderr(text) {
  const kept = String(text)
    .split('\n')
    .filter((line) => line.length <= MAX_STDERR_LINE_LENGTH)
    .join('\n')
    .trim();
  return kept.length > MAX_STDERR_CHARS ? kept.slice(-MAX_STDERR_CHARS) : kept;
}

function formatBytes(bytes) {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Run every hard check against a packaged .app and return the list of failures
 * (empty when the bundle is good). Returning rather than throwing is what lets
 * the caller report all of them at once.
 */
function verifyBundle(options) {
  const {
    appPath,
    expectedArch,
    minAppBytes = DEFAULT_MIN_APP_BYTES,
    minAsarBytes = DEFAULT_MIN_ASAR_BYTES,
    execFile = defaultExecFile,
  } = options;

  const failures = [];

  if (!fs.existsSync(appPath)) {
    return [`the packaged app is missing entirely: ${appPath}`];
  }
  if (!expectedArch) {
    failures.push(
      'could not determine the expected architecture from the electron-builder ' +
        'context, so the bundle cannot be verified'
    );
  }

  // --- Check 1: architecture of the main executable and every native addon ---
  const executable = readBundleExecutableName(appPath, execFile);
  let executablePath = null;
  if (executable.error) {
    failures.push(executable.error);
  } else {
    executablePath = path.join(appPath, 'Contents', 'MacOS', executable.name);
    if (!fs.existsSync(executablePath)) {
      failures.push(
        `Info.plist names "${executable.name}" as CFBundleExecutable but ` +
          `${executablePath} does not exist`
      );
      executablePath = null;
    }
  }

  const unpackedRoot = path.join(appPath, 'Contents', 'Resources', 'app.asar.unpacked');
  const addons = collectNodeAddons(unpackedRoot);
  if (addons.length === 0) {
    failures.push(
      `no *.node native addons found under ${unpackedRoot} — the app ships ` +
        'better-sqlite3, node-pty and others, so an empty set means native ' +
        'modules were not unpacked and the app cannot boot'
    );
  }

  if (expectedArch) {
    const targets = [];
    if (executablePath) targets.push({ file: executablePath, allowSingleSliceUniversal: false });
    for (const addon of addons) targets.push({ file: addon, allowSingleSliceUniversal: true });

    const wrongArch = [];
    for (const target of targets) {
      let slices;
      try {
        slices = lipoArchs(target.file, execFile);
      } catch (err) {
        failures.push(`could not read the architecture of ${target.file}: ${err.message}`);
        continue;
      }
      if (!archMatches(slices, expectedArch, target.allowSingleSliceUniversal)) {
        wrongArch.push(`${target.file} (has: ${slices.join(', ') || 'none'})`);
      }
    }
    if (wrongArch.length > 0) {
      failures.push(
        `${wrongArch.length} binary/binaries do not contain the expected ` +
          `${expectedArch} architecture:\n    ` +
          wrongArch.join('\n    ')
      );
    }
  }

  // --- Check 2: runtime ABI probe of the packaged better_sqlite3.node ---
  const betterSqlite = addons.find((file) => path.basename(file) === 'better_sqlite3.node');
  if (!betterSqlite) {
    failures.push(
      `better_sqlite3.node was not found under ${unpackedRoot} — the app stores ` +
        'all of its state in SQLite and cannot start without it'
    );
  } else if (executablePath) {
    const probe = probeNativeModule(executablePath, betterSqlite, execFile);
    if (!probe.ok) {
      failures.push(
        `the packaged Electron binary cannot load the packaged ` +
          `better_sqlite3.node (ABI mismatch or broken addon):\n    ` +
          `${betterSqlite}\n    ${probe.detail.split('\n').join('\n    ')}`
      );
    }
  }

  // --- Check 3: size floors on the .app and its asar ---
  const appBytes = computeDirectorySize(appPath);
  if (appBytes < minAppBytes) {
    failures.push(
      `the packaged app is only ${formatBytes(appBytes)} (floor is ` +
        `${formatBytes(minAppBytes)}) — a real build is ~300 MB, so this is a stub`
    );
  }

  const asarPath = path.join(appPath, 'Contents', 'Resources', 'app.asar');
  if (!fs.existsSync(asarPath)) {
    failures.push(`app.asar is missing: ${asarPath}`);
  } else {
    const asarBytes = fs.statSync(asarPath).size;
    if (asarBytes < minAsarBytes) {
      failures.push(
        `app.asar is only ${formatBytes(asarBytes)} (floor is ` +
          `${formatBytes(minAsarBytes)}) — the application code did not make it in`
      );
    }
  }

  return failures;
}

/**
 * The Windows counterpart of `verifyBundle`, sized for the win-unpacked
 * layout electron-builder produces (`<appOutDir>/win-unpacked/`):
 *   1. architecture — the PE machine type of the packaged `<productName>.exe`
 *      (there is no `lipo` on Windows, so the COFF header is read directly),
 *   2. a real runtime ABI probe of the packaged better_sqlite3.node, spawned
 *      under the packaged executable with ELECTRON_RUN_AS_NODE=1 — the same
 *      honest-load pattern as the mac arm,
 *   3. a size floor on the unpacked directory (asar + unpacked natives ride
 *      inside it, so one floor covers the stub cases).
 * Returning the failures (rather than throwing) lets the caller report them
 * all in ONE error, like the mac arm.
 */
function verifyWindowsBundle(options) {
  const {
    appOutDir,
    productName,
    expectedArch,
    minDirBytes = DEFAULT_MIN_WIN_UNPACKED_BYTES,
  } = options;

  const failures = [];

  // electron-builder's Windows appOutDir IS the win-unpacked directory
  // (dist-electron/win-unpacked) — unlike the mac layout, there is no nested
  // step. Accept a legacy/doubled nesting in case a caller passes the parent.
  const nested = path.join(appOutDir, 'win-unpacked');
  const appDir = fs.existsSync(nested) ? nested : appOutDir;
  if (!fs.existsSync(appDir) || !fs.existsSync(path.join(appDir, `${productName}.exe`))) {
    return [`the packaged app directory is missing entirely (expected ${productName}.exe under): ${appDir}`];
  }

  const executablePath = path.join(appDir, `${productName}.exe`);

  // --- Check 1: architecture of the main executable (PE machine type) ---
  if (!expectedArch) {
    failures.push(
      'could not determine the expected architecture from the electron-builder ' +
        'context, so the bundle cannot be verified'
    );
  } else if (!PE_MACHINE_BY_ARCH[expectedArch]) {
    failures.push(
      `cannot verify a ${expectedArch} Windows bundle — no known PE machine ` +
        `type for it (expected one of: ${Object.keys(PE_MACHINE_BY_ARCH).join(', ')})`
    );
  } else if (!fs.existsSync(executablePath)) {
    failures.push(`the packaged executable is missing: ${executablePath}`);
  } else {
    let machine = null;
    let readFailed = false;
    try {
      machine = readPeMachineType(fs.readFileSync(executablePath));
    } catch (err) {
      readFailed = true;
      failures.push(`could not read the PE header of ${executablePath}: ${err.message}`);
    }
    if (!readFailed && machine === null) {
      failures.push(
        `${executablePath} has no readable PE header — it is not a Windows executable`
      );
    } else if (!readFailed && machine !== PE_MACHINE_BY_ARCH[expectedArch]) {
      failures.push(
        `${executablePath} is a PE machine 0x${machine.toString(16)} binary, ` +
          `expected 0x${PE_MACHINE_BY_ARCH[expectedArch].toString(16)} (${expectedArch})`
      );
    }
  }

  // --- Check 2: runtime ABI probe of the packaged better_sqlite3.node ---
  const unpackedRoot = path.join(appDir, 'resources', 'app.asar.unpacked');
  const addons = collectNodeAddonsForWindows(unpackedRoot);
  if (addons.length === 0) {
    failures.push(
      `no *.node native addons found under ${unpackedRoot} — the app ships ` +
        'better-sqlite3, node-pty and others, so an empty set means native ' +
        'modules were not unpacked and the app cannot boot'
    );
  }
  const betterSqlite = addons.find((file) => path.basename(file) === 'better_sqlite3.node');
  if (!betterSqlite) {
    failures.push(
      `better_sqlite3.node was not found under ${unpackedRoot} — the app stores ` +
        'all of its state in SQLite and cannot start without it'
    );
  } else if (fs.existsSync(executablePath)) {
    const probe = probeNativeModule(executablePath, betterSqlite);
    if (!probe.ok) {
      failures.push(
        `the packaged Electron binary cannot load the packaged ` +
          `better_sqlite3.node (ABI mismatch or broken addon):\n    ` +
          `${betterSqlite}\n    ${probe.detail.split('\n').join('\n    ')}`
      );
    }
  }

  // --- Check 3: size floor on the unpacked directory ---
  const dirBytes = computeDirectorySize(appDir);
  if (dirBytes < minDirBytes) {
    failures.push(
      `the unpacked app is only ${formatBytes(dirBytes)} (floor is ` +
        `${formatBytes(minDirBytes)}) — a real win-unpacked build is ~1.1 GB, so this is a stub`
    );
  }

  return failures;
}

/** The warn-only JAR tripwire, unchanged in behavior. */
function scanForJars(appPath) {
  const unpackedRoot = path.join(appPath, 'Contents/Resources/app.asar.unpacked');
  console.log('AfterSign: scanning', unpackedRoot);

  if (!fs.existsSync(unpackedRoot)) {
    console.log('AfterSign: no app.asar.unpacked directory found — nothing to scan');
    return;
  }

  const jars = [];
  collectJarsRecursively(unpackedRoot, jars);

  if (jars.length === 0) {
    console.log('AfterSign: no JAR files found under app.asar.unpacked (expected)');
    return;
  }

  console.warn('AfterSign: ============================================================');
  console.warn(`AfterSign: WARNING — ${jars.length} JAR file(s) found in the signed app bundle:`);
  for (const jar of jars) {
    console.warn('AfterSign:   ' + jar);
  }
  console.warn('AfterSign: JARs can contain unsigned native code that fails notarization');
  console.warn('AfterSign: or trips Gatekeeper. Do NOT delete them here (the app is already');
  console.warn('AfterSign: signed — removing sealed resources invalidates the signature).');
  console.warn('AfterSign: Exclude them from packaging via build.files BEFORE signing, or');
  console.warn('AfterSign: sign their native contents. See docs/signing/APPLE_DEVELOPER_SETUP.md.');
  console.warn('AfterSign: ============================================================');
}

exports.default = async function(context) {
  const { appOutDir, packager, arch } = context;

  const platformName = packager.platform.name;
  const isMac = platformName === 'mac';
  // app-builder-lib's Platform.WINDOWS carries name "windows" (nodeName
  // "win32", buildConfigurationKey "win"); accept both spellings so this does
  // not depend on the electron-builder version.
  const isWindows = platformName === 'windows' || platformName === 'win';
  if (!isMac && !isWindows) {
    return;
  }

  // Check if we have signing certificates (useful for debugging dev builds).
  // Deliberately does NOT gate the hard checks below — unsigned dev builds get
  // verified too.
  const hasSigningCredentials = process.env.CSC_LINK || process.env.CSC_KEY_PASSWORD;
  if (!hasSigningCredentials) {
    console.log('AfterSign: No signing credentials found');
  }

  if (isMac) {
    console.log('AfterSign: notarization is handled by electron-builder built-in hook; this script only scans for JAR files');
    const appPath = path.join(appOutDir, `${packager.appInfo.productName}.app`);
    scanForJars(appPath);
  }

  if (process.env[SKIP_ENV_VAR] === '1') {
    console.warn('AfterSign: ============================================================');
    console.warn(`AfterSign: ${SKIP_ENV_VAR}=1 — SKIPPING bundle verification.`);
    console.warn('AfterSign: Architecture, native-module ABI and size floors are NOT checked.');
    console.warn('AfterSign: Do not ship an artifact produced with this set.');
    console.warn('AfterSign: ============================================================');
    return;
  }

  // electron-builder always supplies `arch` on the afterSign context. Its
  // absence means a synthetic/legacy caller, which carries no bundle to verify.
  if (arch === undefined || arch === null) {
    console.log('AfterSign: context supplies no arch — skipping bundle verification');
    return;
  }

  console.log('AfterSign: verifying the packaged bundle (arch, native-module ABI, size floors)');
  const expectedArch = resolveExpectedArch(arch);
  const failures = isMac
    ? verifyBundle({
        appPath: path.join(appOutDir, `${packager.appInfo.productName}.app`),
        expectedArch,
      })
    : verifyWindowsBundle({
        appOutDir,
        productName: packager.appInfo.productName,
        expectedArch,
      });

  if (failures.length > 0) {
    throw new Error(
      `AfterSign: the packaged bundle failed ${failures.length} verification ` +
        `check(s) and must not be shipped:\n` +
        failures.map((failure, index) => `  ${index + 1}. ${failure}`).join('\n')
    );
  }

  console.log('AfterSign: bundle verification passed');
};

exports._helpers = {
  DEFAULT_MIN_APP_BYTES,
  DEFAULT_MIN_ASAR_BYTES,
  DEFAULT_MIN_WIN_UNPACKED_BYTES,
  SKIP_ENV_VAR,
  ARCH_NAME_BY_ORDINAL,
  PE_MACHINE_BY_ARCH,
  archMatches,
  collectNodeAddons,
  collectNodeAddonsForWindows,
  isForeignPrebuild,
  computeDirectorySize,
  lipoArchs,
  probeNativeModule,
  readBundleExecutableName,
  readPeMachineType,
  resolveExpectedArch,
  summarizeProbeStderr,
  verifyBundle,
  verifyWindowsBundle,
};
