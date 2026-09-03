/**
 * Windows shell-shim spawn planning.
 *
 * Node >= 18.20 refuses to spawn `.cmd`/`.bat` without a shell — execFile of a
 * batch shim throws EINVAL (CVE-2024-27980 hardening). npm-shim installs of the
 * CLIs this app probes leave exactly such shims, so a shell-less `--version`
 * probe dies with EINVAL and callers misread it as a broken install. Two escape
 * hatches, best first: a sibling native `<name>.exe`, then the shim through
 * cmd.exe (see utils/win32CmdLine for the quoting that requires).
 *
 * Inert on POSIX: every helper branches on an injected platform or is reached
 * only from a win32 arm.
 */
import * as fs from 'fs';

import { cmdExeInvocation, quoteForCmd } from './win32CmdLine';

export interface ShellShimProbeInvocation {
  /** Executable to spawn (argv[0]). */
  command: string;
  /** argv for the spawn, including the version flag. */
  args: string[];
  /** Set only on the cmd.exe plan; a plain `.exe` wants Node's own quoting. */
  windowsVerbatimArguments?: boolean;
}

const SHELL_SHIM_SUFFIX = /\.(cmd|bat)$/i;

/** True when `executablePath` is a Windows batch shim Node cannot spawn shell-less. Always false off win32. */
export function isWindowsShellShim(
  executablePath: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  return platform === 'win32' && SHELL_SHIM_SUFFIX.test(executablePath);
}

/**
 * The native `<name>.exe` sitting next to a `.cmd`/`.bat` shim, or null when
 * the path is not a shim. Presence on disk is the caller's check.
 */
export function siblingNativeExecutable(executablePath: string): string | null {
  if (!SHELL_SHIM_SUFFIX.test(executablePath)) return null;
  return executablePath.replace(SHELL_SHIM_SUFFIX, '.exe');
}

/**
 * The spawn plans for a `--version` probe of `executablePath`, best-first:
 * the sibling native `.exe` when it exists, then the shim itself through
 * cmd.exe. On a path that is not a Windows shell shim this returns the direct
 * single plan, byte-identical to a plain `execFile(path, ['--version'])`.
 * `fileExists` is a test seam (defaults to fs.existsSync).
 */
export function planWindowsShimVersionProbes(
  executablePath: string,
  fileExists: (path: string) => boolean = (p) => fs.existsSync(p),
  platform: NodeJS.Platform = process.platform,
): ShellShimProbeInvocation[] {
  if (!isWindowsShellShim(executablePath, platform)) {
    return [{ command: executablePath, args: ['--version'] }];
  }

  const plans: ShellShimProbeInvocation[] = [];

  const sibling = siblingNativeExecutable(executablePath);
  if (sibling && fileExists(sibling)) {
    plans.push({ command: sibling, args: ['--version'] });
  }

  plans.push(cmdExeInvocation(`${quoteForCmd(executablePath)} --version`));

  return plans;
}
