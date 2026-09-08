/**
 * Safely escape shell arguments to prevent command injection.
 *
 * Prefer argv-based execution (main/src/utils/runGit.ts, execFile/spawn) for new
 * code — these string builders exist only for the remaining `/bin/sh` callers
 * (currently ShellDetector.buildCommandString's POSIX arm, on behalf of
 * runCommandManager and sessionManager). The git-command-string builders were
 * removed once every git call site migrated to runGit.
 */

/**
 * Escape a string for safe use in shell commands
 * @param arg The argument to escape
 * @returns The escaped argument
 */
export function escapeShellArg(arg: string): string {
  // If the argument is empty, return empty quotes
  if (!arg) return "''";

  // Use single quotes and handle internal single quotes
  // by ending the quote, adding an escaped single quote, and starting a new quote
  return "'" + arg.replace(/'/g, "'\\''") + "'";
}

/**
 * Escape an array of shell arguments
 * @param args The arguments to escape
 * @returns The escaped arguments joined with spaces
 */
export function escapeShellArgs(args: string[]): string {
  return args.map(escapeShellArg).join(' ');
}