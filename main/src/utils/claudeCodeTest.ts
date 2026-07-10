import { execFile } from 'child_process';
import { promisify } from 'util';
import { getShellPath, findExecutableInPath } from './shellPath';
import type { ClaudeBinaryDetection } from '../../../shared/types/onboarding';

const execFileAsync = promisify(execFile);

const VERSION_TIMEOUT_MS = 5_000;

const notFound: ClaudeBinaryDetection = { found: false, path: null, version: null };

/**
 * Probe for an installed `claude` binary (onboarding step 1's "installed · not
 * logged in" annotation and the opt-in interactive PTY substrate). This is the
 * BINARY probe — login state is claudeCredentials.ts.
 *
 * Resolution order mirrors interactiveClaudeManager.testCliAvailability:
 *   configured path (config.claudeExecutablePath / caller override) → shell
 *   PATH via findExecutableInPath('claude'). An empty/whitespace configured
 *   value is treated as "not configured" (`||` fallthrough) so a default-blank
 *   config setting never short-circuits the PATH probe. The binary is validated
 *   with `claude --version`; a resolvable-but-unrunnable binary reports
 *   found:false. Never throws.
 *
 * `configuredPath` is threaded from the IPC layer (services.configManager)
 * rather than reached for here — this module has no singleton config handle.
 */
export async function detectClaudeBinary(configuredPath?: string): Promise<ClaudeBinaryDetection> {
  try {
    // Ensure the enhanced shell PATH is loaded before probing (packaged apps
    // start with a restricted PATH; findExecutableInPath depends on this).
    getShellPath();

    const resolvedPath = configuredPath?.trim() || findExecutableInPath('claude');
    if (!resolvedPath) return { ...notFound };

    try {
      const { stdout } = await execFileAsync(resolvedPath, ['--version'], { timeout: VERSION_TIMEOUT_MS });
      return { found: true, path: resolvedPath, version: stdout.trim() || null };
    } catch {
      // Found on disk but `--version` failed (not executable, wrong binary,
      // timeout) — report not-found so the onboarding gate does not claim an
      // unusable install.
      return { ...notFound };
    }
  } catch {
    return { ...notFound };
  }
}
