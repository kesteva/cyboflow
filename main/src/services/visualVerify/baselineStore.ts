/**
 * baselineStore — the FILESYSTEM home for git-tracked golden baselines (L5; see
 * docs/visual-verification-design.md §"Golden baselines"). Baselines are NOT
 * DB-tracked: they live as plain PNGs under
 *
 *   <projectRoot>/.cyboflow/artifacts/baselines/<key>/<viewport>.png
 *
 * (sibling to the run-artifacts subtree, durable at PROJECT ROOT so they survive a
 * worktree teardown). They are committed to git via the ArtifactRouter
 * accept-baseline op (this store does the fs-copy; the router-injected committer
 * does the `git add` + `git commit`). The SSIM pre-diff resolves a request's
 * baselineKey to these PNGs and gates the paid VLM on a near-pixel match.
 *
 * This file lives under main/src/services/* and is INJECTED into the (electron-/
 * service-free) scheduler + ArtifactRouter as a narrow interface — they never
 * import it. It uses node:fs/promises + node:path only (no electron needed: it
 * moves bytes, it does not decode images — pixelDiff.ts owns decoding).
 *
 * PATH-SAFETY INVARIANT: a `key` or `viewport` is a free-form caller string
 * (deliverable baselineKey / viewport label). Both are sanitized into a single safe
 * path STEM (mirrors CapturePageBackend.viewportFileStem) before being joined, so a
 * crafted value like '../../etc' can NEVER escape the baselines dir — the separators
 * are stripped, not interpreted.
 */
import { mkdir, copyFile, readdir, access } from 'node:fs/promises';
import { join } from 'node:path';
import type { BaselineMetadata } from '../../../../shared/types/visualVerification';

/** The baselines subtree under a project's `.cyboflow/artifacts` directory. */
export const BASELINES_SUBDIR = join('.cyboflow', 'artifacts', 'baselines');

/**
 * Sanitize a free-form key/viewport into a safe single path stem. Strips path
 * separators + odd characters (mirrors CapturePageBackend.viewportFileStem) so the
 * value can never traverse out of the baselines dir. Falls back to `fallback` when
 * the input sanitizes to empty.
 */
export function safeStem(value: string | undefined, fallback: string): string {
  const cleaned = (value ?? '').replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  return cleaned.length > 0 ? cleaned : fallback;
}

/**
 * The narrow interface the scheduler (SSIM pre-diff) + ArtifactRouter
 * (accept-baseline) depend on. Injected like CapturePageBackend / VlmJudge so both
 * consumers stay electron/service-free.
 */
export interface BaselineStore {
  /**
   * Absolute path the baseline PNG for (projectRoot, key, viewport) WOULD live at
   * (whether or not it exists). The viewport stem mirrors the captured-PNG stem so
   * a captured `<viewport>.png` maps to its baseline `<viewport>.png`.
   */
  baselinePath(projectRoot: string, key: string, viewport: string): string;
  /** The absolute baseline PNG path if it exists on disk, else null (no throw). */
  read(projectRoot: string, key: string, viewport: string): Promise<string | null>;
  /** The viewport stems that have an accepted baseline PNG under `key` (sorted). */
  list(projectRoot: string, key: string): Promise<string[]>;
  /**
   * Copy `sourcePath` into the baseline slot for (projectRoot, key, viewport),
   * creating the dir tree. Returns the destination absolute path. Does NOT commit —
   * the ArtifactRouter accept-baseline op invokes the injected committer for git.
   */
  write(
    projectRoot: string,
    key: string,
    viewport: string,
    sourcePath: string,
  ): Promise<string>;
  /** Build the BaselineMetadata for an accepted set (parity with S1's shape). */
  metadata(key: string, viewports: BaselineMetadata['viewports'], notes?: string): BaselineMetadata;
}

/** Concrete fs-backed BaselineStore. Stateless; safe to share as a singleton. */
export class FsBaselineStore implements BaselineStore {
  /** The directory all baselines for `key` live under (sanitized). */
  private keyDir(projectRoot: string, key: string): string {
    return join(projectRoot, BASELINES_SUBDIR, safeStem(key, 'default'));
  }

  baselinePath(projectRoot: string, key: string, viewport: string): string {
    return join(this.keyDir(projectRoot, key), `${safeStem(viewport, 'default')}.png`);
  }

  async read(projectRoot: string, key: string, viewport: string): Promise<string | null> {
    const p = this.baselinePath(projectRoot, key, viewport);
    try {
      await access(p);
      return p;
    } catch {
      return null;
    }
  }

  async list(projectRoot: string, key: string): Promise<string[]> {
    const dir = this.keyDir(projectRoot, key);
    try {
      const entries = await readdir(dir);
      return entries
        .filter((e) => e.toLowerCase().endsWith('.png'))
        .map((e) => e.slice(0, -'.png'.length))
        .sort();
    } catch {
      // Missing baseline dir — no accepted baselines yet (intent-only judging).
      return [];
    }
  }

  async write(
    projectRoot: string,
    key: string,
    viewport: string,
    sourcePath: string,
  ): Promise<string> {
    const dest = this.baselinePath(projectRoot, key, viewport);
    await mkdir(this.keyDir(projectRoot, key), { recursive: true });
    await copyFile(sourcePath, dest);
    return dest;
  }

  metadata(
    key: string,
    viewports: BaselineMetadata['viewports'],
    notes?: string,
  ): BaselineMetadata {
    return {
      key,
      viewports,
      acceptedAt: new Date().toISOString(),
      ...(notes !== undefined ? { notes } : {}),
    };
  }
}
