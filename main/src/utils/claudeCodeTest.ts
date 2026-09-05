import { execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import { getShellPath, findExecutableInPath } from './shellPath';
import {
  isWindowsShellShim,
  planWindowsShimVersionProbes,
} from './win32ShimProbe';
import type { ClaudeBinaryDetection } from '../../../shared/types/onboarding';

const execFileAsync = promisify(execFile);

const VERSION_TIMEOUT_MS = 5_000;

const notFound: ClaudeBinaryDetection = { found: false, path: null, version: null };

export interface ClaudeBinaryProbeDependencies {
  /** Host platform override (tests); defaults to process.platform. */
  platform?: NodeJS.Platform;
  /** fs.existsSync seam (tests) for the sibling-.exe preference. */
  fileExists?: (path: string) => boolean;
}

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
 * On Windows an npm-shim `.cmd` resolution is probed through the win32 shim
 * plans (sibling `.exe` first, then cmd.exe /d /s /c) — Node refuses to spawn a
 * batch file shell-less, so the plain probe would report a working install as
 * missing. Same failure semantics as before: any probe failure reports
 * found:false.
 *
 * `configuredPath` is threaded from the IPC layer (services.configManager)
 * rather than reached for here — this module has no singleton config handle.
 */
export async function detectClaudeBinary(
  configuredPath?: string,
  dependencies: ClaudeBinaryProbeDependencies = {},
): Promise<ClaudeBinaryDetection> {
  try {
    // Load the enhanced shell PATH before probing (packaged apps start with a
    // restricted PATH; findExecutableInPath depends on this).
    const shellPath = getShellPath();

    const resolvedPath = configuredPath?.trim() || findExecutableInPath('claude');
    if (!resolvedPath) return { ...notFound };

    // The version probe must run under the same enhanced PATH used for
    // resolution — a node-shebang `claude` that findExecutableInPath can see
    // still fails to EXEC under the packaged app's restricted PATH, which
    // would misreport an installed CLI as missing.
    const env = { ...process.env, PATH: shellPath };

    const probeOnce = async (
      command: string,
      args: string[],
      verbatim?: boolean,
    ): Promise<string> => {
      const { stdout } = await execFileAsync(command, args, {
        timeout: VERSION_TIMEOUT_MS,
        env,
        windowsHide: true,
        ...(verbatim ? { windowsVerbatimArguments: true } : {}),
      });
      return stdout;
    };

    try {
      let version: string | null = null;
      if (isWindowsShellShim(resolvedPath, dependencies.platform ?? process.platform)) {
        for (const plan of planWindowsShimVersionProbes(
          resolvedPath,
          dependencies.fileExists ?? ((p: string) => fs.existsSync(p)),
          dependencies.platform ?? process.platform,
        )) {
          try {
            version = (await probeOnce(plan.command, plan.args, plan.windowsVerbatimArguments)).trim() || null;
            break;
          } catch {
            // This plan failed — try the next one (then report not-found).
          }
        }
      } else {
        version = (await probeOnce(resolvedPath, ['--version'])).trim() || null;
      }
      if (version !== null) {
        return { found: true, path: resolvedPath, version };
      }
      // Found on disk but `--version` failed (not executable, wrong binary,
      // timeout) — report not-found so the onboarding gate does not claim an
      // unusable install.
      return { ...notFound };
    } catch {
      return { ...notFound };
    }
  } catch {
    return { ...notFound };
  }
}
