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
 * `%NAME%` IS UNSAFE ON A `/c` COMMAND LINE, WITH NO ESCAPE. cmd.exe expands
 * `%NAME%` as an environment-variable reference even inside double quotes —
 * quoting a token does not suppress it — and the `%%` → `%` escape that works
 * inside a BATCH FILE body (cmd parses those line by line) does not apply
 * here at all: there is no way to pass a literal `%NAME%` through a `/c`
 * command line. `quoteForCmd`/`cmdCommandLine` therefore REJECT any token
 * containing one outright (a path like `C:\Users\%TEMP%\...` fails loudly)
 * rather than silently building a command line that expands to something the
 * caller never wrote. A caller building a `.cmd`/`.bat` SCRIPT BODY instead of
 * a `/c` command line wants {@link escapeForBatch}, the one place `%%`
 * actually works.
 *
 * Everything here is inert on POSIX — callers only reach it from win32 arms.
 */

/**
 * cmd.exe metacharacters that make a token unsafe to interpolate unquoted into
 * a `/c` command line. (`%` is absent: double-quoting does not suppress cmd's
 * %VAR% expansion, so quoting it would add nothing — {@link quoteForCmd}
 * rejects a `%NAME%` token instead, see the header comment above.)
 */
const CMD_METACHARS = /[ \t&()^<>|"]/;

/** A `%NAME%` reference — cmd.exe's environment-variable expansion, unescapable on a `/c` command line (see the header comment above). */
const CMD_PERCENT_VARIABLE = /%[^%\s]+%/;

/** Quote one token for a cmd.exe command line, when it needs quoting. Throws on a `%NAME%` token — see the header comment above. */
export function quoteForCmd(token: string): string {
  const percentMatch = CMD_PERCENT_VARIABLE.exec(token);
  if (percentMatch) {
    throw new Error(
      `cmd.exe token ${JSON.stringify(token)} contains ${percentMatch[0]}, which cmd.exe expands as an ` +
        'environment variable even inside double quotes and cannot be escaped on a /c command line — ' +
        'refusing rather than silently running a rewritten command',
    );
  }
  return CMD_METACHARS.test(token) ? `"${token}"` : token;
}

/**
 * Escape `%` for a BATCH FILE body — a `.cmd`/`.bat` script cmd.exe parses
 * line by line, where `%%` collapses to one literal `%`. This is the ONLY
 * place that escape is valid; see the header comment above for why a `/c`
 * command line (quoteForCmd / cmdCommandLine / cmdExeInvocation) rejects a
 * `%NAME%` token instead of trying to apply it there.
 */
export function escapeForBatch(value: string): string {
  return value.replace(/%/g, '%%');
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
