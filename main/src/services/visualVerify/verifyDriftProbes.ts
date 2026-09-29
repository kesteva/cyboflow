/**
 * verifyDriftProbes — the §5.3 drift probes behind the verification runbook's
 * proof expiry (docs/proposals/visual-verification-brittleness-fixes.md §5.3).
 *
 * MACHINE-LOCAL half of the runbook contract. `VerifyRunbookStore` is DB +
 * policy; these two probes are its IO, injected at the wiring site so the store
 * itself stays fs-free (its standalone-typecheck invariant). They also key the
 * bootstrap's §10 suppression, which is honored only while BOTH still match —
 * so a second implementation of either would produce a suppression that never
 * expires or one that never holds. One implementation, here, shared by both.
 *
 * §5.3's rule is "any component changing demotes", so both must be (a) stable
 * across calls on an unchanged host — they are compared for equality, not
 * merely stored — and (b) cheap, since `status()` recomputes them on every
 * gated request.
 *
 * No Electron import: the caller supplies the chromium probe and the app's
 * executable path, so both are exercisable with plain fakes.
 */
import { createHash } from 'node:crypto';
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';

const LOCKFILES = ['pnpm-lock.yaml', 'package-lock.json', 'yarn.lock', 'bun.lockb'];

/**
 * A0's fallback manifests (docs/proposals/runbook-optional-verification.md
 * §A0) — folded in, in this fixed order, when the tree carries no
 * `package.json` at all. Each is a lockfile-shaped signal for a toolchain the
 * npm path can't see: XcodeGen (`project.yml`), a root-level SwiftPM checkout
 * (`Package.resolved`), CocoaPods (`Podfile.lock`), Cargo (`Cargo.lock`), Go
 * modules (`go.sum`). The Xcode PROJECT's own `Package.resolved` (one per
 * `*.xcodeproj`) is handled separately below — finding it needs a directory
 * listing, not a fixed root path.
 *
 * Deliberately NOT `project.pbxproj`: it churns on every file Xcode adds to
 * the project, which would demote the runbook on every ordinary commit — the
 * same reason the npm path hashes `package.json`'s `scripts`/`packageManager`
 * fields rather than the whole file.
 */
const FALLBACK_MANIFESTS_BEFORE_XCODEPROJ = ['project.yml', 'Package.resolved'];
const FALLBACK_MANIFESTS_AFTER_XCODEPROJ = ['Podfile.lock', 'Cargo.lock', 'go.sum'];
const XCODEPROJ_PACKAGE_RESOLVED_SUFFIX = ['project.xcworkspace', 'xcshareddata', 'swiftpm', 'Package.resolved'];

/** The two fs codes that mean "nothing is there" — not "could not look". */
function isAbsenceCode(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | null)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

/**
 * Fold `<dirPath>/<relPath>` into `hash` when present, framed by its relative
 * path so the same bytes under two different manifest names (or an empty file
 * under either) can never hash alike. Answers what it saw:
 *   - `'folded'`     — present and read;
 *   - `'absent'`     — ENOENT/ENOTDIR, the ordinary "this toolchain is not in
 *                      use here" answer, skipped;
 *   - `'unreadable'` — any OTHER fs fault (EACCES, EISDIR, an IO error). The
 *                      caller turns this into `computeVerifyInputHash`'s
 *                      `null`: silently skipping a manifest that EXISTS would
 *                      make the hash flip with the file's readability, which is
 *                      exactly the "inability to look read as a change" the
 *                      `null` contract exists to prevent.
 */
async function foldManifest(
  hash: ReturnType<typeof createHash>,
  dirPath: string,
  relPath: string,
): Promise<'folded' | 'absent' | 'unreadable'> {
  let bytes: Buffer;
  try {
    bytes = await readFile(path.join(dirPath, ...relPath.split('/')));
  } catch (err) {
    return isAbsenceCode(err) ? 'absent' : 'unreadable';
  }
  hash.update(`${relPath}\0`);
  hash.update(bytes);
  hash.update('\0');
  return 'folded';
}

/**
 * The `*.xcodeproj` directories directly under `dirPath`, sorted — so the fold
 * order stays deterministic when a project carries more than one (an app target
 * and a widget/extension target as separate `.xcodeproj`s is a real shape).
 * `null` when the directory cannot be listed: the caller has already confirmed
 * it IS a directory, so a listing failure is a fault, not absence.
 */
async function listXcodeprojDirsSorted(dirPath: string): Promise<string[] | null> {
  try {
    const entries = await readdir(dirPath, { withFileTypes: true });
    return entries
      .filter((e) => e.isDirectory() && e.name.endsWith('.xcodeproj'))
      .map((e) => e.name)
      .sort();
  } catch {
    return null;
  }
}

/**
 * A0's fallback input hash, used when `computeVerifyInputHash` finds no
 * `package.json`: fold in whichever fixed-order fallback manifests exist, then
 * the same ABI facts the npm path ends on. None of them present ⇒ a constant
 * `'no-manifest'` tag stands in, so a project this probe cannot describe still
 * demotes when the HOST's ABI changes under it.
 *
 * `null` ("cannot observe") in two cases, both preserving the pre-A0 contract
 * for a tree nobody can look at:
 *   - `dirPath` is not an existing directory. ENOENT on `package.json` is
 *     "no npm manifest" only when there IS a tree to lack one; a probe path
 *     that has been cleaned up (a disposed run worktree — see
 *     `VerifyRunbookStore.markProven`'s `fresh` notes) must stay unobservable,
 *     or a promotion would stamp this constant over a real stored hash and the
 *     proof would read as drifted on its very next check.
 *   - a manifest or the root listing fails with anything but absence.
 */
async function computeFallbackInputHash(dirPath: string): Promise<string | null> {
  try {
    if (!(await stat(dirPath)).isDirectory()) return null;
  } catch {
    return null;
  }

  const xcodeprojDirs = await listXcodeprojDirsSorted(dirPath);
  if (xcodeprojDirs === null) return null;
  const manifests = [
    ...FALLBACK_MANIFESTS_BEFORE_XCODEPROJ,
    ...xcodeprojDirs.map((dir) => [dir, ...XCODEPROJ_PACKAGE_RESOLVED_SUFFIX].join('/')),
    ...FALLBACK_MANIFESTS_AFTER_XCODEPROJ,
  ];

  const hash = createHash('sha256');
  let foundAny = false;
  for (const relPath of manifests) {
    const outcome = await foldManifest(hash, dirPath, relPath);
    if (outcome === 'unreadable') return null;
    if (outcome === 'folded') foundAny = true;
  }

  if (!foundAny) hash.update('no-manifest');
  hash.update(process.versions.node.split('.')[0]);
  hash.update(process.versions.modules);
  return hash.digest('hex');
}

/**
 * The §5.3 project INPUT hash: the things that change what "build and serve
 * this project" MEANS — the package scripts the runbook's commands invoke, the
 * lockfile (a dependency bump can break a dev server), and the two ABI facts
 * §1's root cause (c) turned on. Deliberately NOT a hash of the whole tree:
 * every commit would then demote the runbook, which would make the proof
 * worthless by expiring it constantly.
 *
 * A0 (docs/proposals/runbook-optional-verification.md): a missing
 * `package.json` is no longer treated as unobservable. `ENOENT`/`ENOTDIR` on
 * it means "no npm manifest", and folds in the fixed-order fallback manifests
 * (or the `'no-manifest'` constant) instead — see
 * {@link computeFallbackInputHash}, which also keeps a probe path that is not
 * an existing directory at `null`. Any other fs fault (EACCES, EISDIR, an IO
 * error) on `package.json` or a fallback manifest, and an unparseable
 * `package.json`, still return `null`. The npm path itself — every project
 * that DOES carry a `package.json` — is byte-for-byte unchanged, so no
 * existing proof drifts just because this function shipped.
 *
 * Returns null when the inputs could not be observed. The store treats null as
 * "cannot tell", which fails soft to 'absent' WITHOUT demoting — an inability
 * to look is not evidence that something changed.
 */
export async function computeVerifyInputHash(dirPath: string): Promise<string | null> {
  let raw: string;
  try {
    raw = await readFile(path.join(dirPath, 'package.json'), 'utf8');
  } catch (err) {
    if (isAbsenceCode(err)) return computeFallbackInputHash(dirPath);
    // A genuine fs fault, not "no manifest" — cannot observe this tree at all.
    return null;
  }

  try {
    const parsed: unknown = JSON.parse(raw);
    const pkg = typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
    const hash = createHash('sha256');
    hash.update(JSON.stringify(pkg.scripts ?? null));
    hash.update(String(pkg.packageManager ?? ''));
    for (const lockfile of LOCKFILES) {
      try {
        hash.update(await readFile(path.join(dirPath, lockfile)));
      } catch {
        // absent lockfile — nothing to fold in.
      }
    }
    hash.update(process.versions.node.split('.')[0]);
    hash.update(process.versions.modules);
    return hash.digest('hex');
  } catch {
    // Unparseable package.json.
    return null;
  }
}

/**
 * A0 legacy-NULL compat's cheap existence check (docs/proposals/
 * runbook-optional-verification.md §A0) — whether `<dirPath>/package.json`
 * exists, without reading or hashing it. `VerifyRunbookStore` uses this (via
 * its optional `hasPackageJson` dep) to interpret a stored `input_hash IS NULL`
 * row: a record proven back when {@link computeVerifyInputHash} still returned
 * `null` for a package.json-less tree. That NULL counts as matching only when
 * this answers `false`, so `false` is reserved for the two codes that mean
 * "nothing is there"; any other `stat` failure answers `true` — the store's
 * conservative direction (refuse, never a proof it could not confirm).
 */
export async function probeHasPackageJson(dirPath: string): Promise<boolean> {
  try {
    await stat(path.join(dirPath, 'package.json'));
    return true;
  } catch (err) {
    return !isAbsenceCode(err);
  }
}

/**
 * The §5.3 host fingerprint. The chromium path is the driver's OWN resolution
 * (the same probe preflight uses), so a chromium that moved or vanished demotes
 * the proof rather than surfacing ten minutes into a deploy. The TCC grant
 * state is deliberately excluded: probing it shells the peekaboo binary on
 * EVERY gated request, and the per-modality capability ledger (§3.3) already
 * owns grant regressions.
 */
export async function computeVerifyHostFingerprint(deps: {
  probeChromium: () => Promise<string | null>;
  appExePath: string;
}): Promise<string> {
  let chromium: string | null = null;
  try {
    chromium = await deps.probeChromium();
  } catch {
    chromium = null;
  }
  return JSON.stringify({
    chromium,
    node: process.versions.node.split('.')[0],
    electronAbi: process.versions.modules,
    platform: process.platform,
    arch: process.arch,
    appPath: deps.appExePath,
  });
}
