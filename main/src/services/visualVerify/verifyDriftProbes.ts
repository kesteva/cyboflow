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
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const LOCKFILES = ['pnpm-lock.yaml', 'package-lock.json', 'yarn.lock', 'bun.lockb'];

/**
 * The §5.3 project INPUT hash: the things that change what "build and serve
 * this project" MEANS — the package scripts the runbook's commands invoke, the
 * lockfile (a dependency bump can break a dev server), and the two ABI facts
 * §1's root cause (c) turned on. Deliberately NOT a hash of the whole tree:
 * every commit would then demote the runbook, which would make the proof
 * worthless by expiring it constantly.
 *
 * Returns null when the inputs could not be observed. The store treats null as
 * "cannot tell", which fails soft to 'absent' WITHOUT demoting — an inability
 * to look is not evidence that something changed.
 */
export async function computeVerifyInputHash(dirPath: string): Promise<string | null> {
  try {
    const raw = await readFile(path.join(dirPath, 'package.json'), 'utf8');
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
    return null;
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
