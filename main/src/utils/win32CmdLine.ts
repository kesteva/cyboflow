/**
 * Building a `cmd.exe` command line that survives Node's argv quoting.
 *
 * Node quotes each argv entry for the Windows CreateProcess convention, which
 * backslash-escapes an inner `"` as `\"`. cmd.exe does not understand that
 * escape, so any command containing a quote is mangled before cmd ever sees
 * it. The fix is to hand cmd ONE argument and set `windowsVerbatimArguments`,
 * which turns Node's quoting off entirely, then wrap the whole line in an
 * extra quote pair that `/s` tells cmd to strip. Same shape cross-spawn uses;
 * it survives paths with spaces.
 *
 * Everything here is inert on POSIX — callers only reach it from win32 arms.
 */

/**
 * cmd.exe metacharacters that make a token unsafe to interpolate unquoted into
 * a `/c` command line. (`%` is absent: double-quoting does not suppress cmd's
 * %VAR% expansion, so quoting it would add nothing.)
 */
const CMD_METACHARS = /[ \t&()^<>|"]/;

/** Quote one token for a cmd.exe command line, when it needs quoting. */
export function quoteForCmd(token: string): string {
  return CMD_METACHARS.test(token) ? `"${token}"` : token;
}

/** Join tokens into one cmd.exe command line, quoting each as needed. */
export function cmdCommandLine(tokens: string[]): string {
  return tokens.map(quoteForCmd).join(' ');
}

/** What to spawn, and how, to run `commandLine` through cmd.exe. */
export interface CmdExeInvocation {
  command: string;
  args: string[];
  windowsVerbatimArguments: true;
}

/**
 * `cmd.exe /d /s /c "<commandLine>"`, ready for spawn or execFile. Pass the
 * returned `windowsVerbatimArguments` straight through in the options object —
 * without it the outer quotes are re-escaped and the call breaks.
 */
export function cmdExeInvocation(commandLine: string): CmdExeInvocation {
  return {
    command: process.env.comspec || 'cmd.exe',
    args: ['/d', '/s', '/c', `"${commandLine}"`],
    windowsVerbatimArguments: true,
  };
}
