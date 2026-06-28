/**
 * verifyConfigLoader — the SOLE reader of a project's `.cyboflow/verify.json`
 * (see docs/visual-verification-design.md §"Config homes" + #6).
 *
 * `.cyboflow/verify.json` is the per-project, per-deliverable "how to run this"
 * product config that travels WITH the deliverable at the project root (sibling
 * to `.cyboflow/artifacts`) — deliberately NOT in `.claude/settings.json` or the
 * DB. This loader is SHARED INFRA: the createRun stamp reads its
 * `enabled` / `defaultType` for the project rungs of the resolver ladder; the
 * S2 dev-server runner reads each deliverable's `build` / `start` / `readyWhen`;
 * the S5 baselines read `baselineKey`. One reader, one fail-soft contract.
 *
 * Fail-soft contract (never throws, never fatal):
 *   - file absent (ENOENT)  → return null (an absent config is the common case).
 *   - malformed JSON        → logger?.warn + return null (a typo must not wedge a
 *                             run launch; the run simply resolves the disabled /
 *                             floor posture as if no config existed).
 *   - valid JSON            → return the parsed object typed as VerifyConfigFile.
 *
 * Standalone-typecheck invariant: imports ONLY node:fs/promises (readFile),
 * node:path (join), the shared verify types, and the orchestrator LoggerLike. NO
 * electron, NO better-sqlite3, NO services/* — fs/promises is explicitly allowed
 * for orchestrator modules (same as runFileExplorer / runLauncher).
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { VerifyConfigFile } from '../../../shared/types/visualVerification';
import type { LoggerLike } from './types';

/**
 * The project-root-relative path of the verify config. A single constant so the
 * loader, future writers, and tests reference one canonical location.
 */
export const VERIFY_CONFIG_RELATIVE_PATH = '.cyboflow/verify.json';

/**
 * Narrow type guard for the Node `ENOENT` error (file absent). Avoids an `any`
 * cast on the caught error while keeping the absent-file path distinct from a
 * genuine read failure.
 */
function isFileNotFound(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: unknown }).code === 'ENOENT'
  );
}

/**
 * Load + parse `<projectPath>/.cyboflow/verify.json`.
 *
 * @param projectPath absolute path to the project root.
 * @param logger      optional structured logger; a malformed-JSON warning is
 *                    emitted through it when supplied (omitted = silent fail-soft).
 * @returns the parsed VerifyConfigFile, or null when the file is absent or
 *          unparseable. NEVER throws.
 */
export async function loadVerifyConfig(
  projectPath: string,
  logger?: LoggerLike,
): Promise<VerifyConfigFile | null> {
  const configPath = join(projectPath, VERIFY_CONFIG_RELATIVE_PATH);

  let raw: string;
  try {
    raw = await readFile(configPath, 'utf-8');
  } catch (err) {
    // Absent config is not an error — it is the common, expected case.
    if (isFileNotFound(err)) {
      return null;
    }
    // Any OTHER read failure (permissions, a directory in the way, an I/O error)
    // is also fail-soft: the launch must never wedge on a config read. Surface it
    // through the logger so it is diagnosable, then resolve as if absent.
    logger?.warn('verifyConfigLoader: failed to read verify.json', {
      configPath,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }

  try {
    // The on-disk shape is trusted to match VerifyConfigFile (every member is
    // optional, so a partial / empty object is valid). Downstream consumers
    // (resolver, dev-server runner, baselines) defensively read each field.
    const parsed = JSON.parse(raw) as VerifyConfigFile;
    return parsed;
  } catch (err) {
    logger?.warn('verifyConfigLoader: failed to parse verify.json (malformed JSON)', {
      configPath,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}
