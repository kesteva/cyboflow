/**
 * winProcessTable — the Windows stand-in for `ps` text listings.
 *
 * `ps` does not exist on Windows, so every `ps -axo …` sweep silently no-ops
 * there. This module runs ONE PowerShell query (Get-CimInstance Win32_Process)
 * and prints the same `pid [ppid [etime]] command` line shapes the POSIX
 * parsers already accept, so parsing code stays platform-blind.
 *
 * Line contract (leading fields space-separated, command last):
 *   pid-ppid               → `123 456`
 *   pid-command            → `123 C:\...\node.exe server.js`
 *   pid-ppid-command       → `123 456 C:\...`
 *   pid-ppid-etime-command → `123 456 mm:ss C:\...` (macOS etime shapes)
 *
 * A null CommandLine renders as an empty field — the parsers only need the
 * numeric columns.
 */
import { execFile } from 'node:child_process';

export type WinProcessLineFormat =
  | 'pid-ppid'
  | 'pid-command'
  | 'pid-ppid-command'
  | 'pid-ppid-etime-command';

/** The line-format expression for each shape (inside the ForEach-Object). */
function lineExpr(format: WinProcessLineFormat): string {
  switch (format) {
    case 'pid-ppid':
      return `'{0} {1}' -f $_.ProcessId, $_.ParentProcessId`;
    case 'pid-command':
      return `'{0} {1}' -f $_.ProcessId, $_.CommandLine`;
    case 'pid-ppid-command':
      return `'{0} {1} {2}' -f $_.ProcessId, $_.ParentProcessId, $_.CommandLine`;
    case 'pid-ppid-etime-command':
      return [
        `$e = $now - $_.CreationDate;`,
        `$et = if ($e.Days -gt 0) { '{0}-{1:d2}:{2:d2}:{3:d2}' -f $e.Days, $e.Hours, $e.Minutes, $e.Seconds }`,
        `elseif ($e.Hours -gt 0) { '{0}:{1:d2}:{2:d2}' -f $e.Hours, $e.Minutes, $e.Seconds }`,
        `else { '{0}:{1:d2}' -f $e.Minutes, $e.Seconds };`,
        `'{0} {1} {2} {3}' -f $_.ProcessId, $_.ParentProcessId, $et, $_.CommandLine`,
      ].join(' ');
  }
}

/**
 * The PowerShell script that renders `format` — one `pid [ppid [etime]] command`
 * line per Win32_Process row. Exported so synchronous callers (the kill ladders
 * that cannot await inside `execSync`-shaped code) run the exact same query as
 * {@link execWindowsProcessTable} instead of carrying a second copy of it.
 */
export function buildWindowsProcessTableScript(format: WinProcessLineFormat): string {
  const body = format === 'pid-ppid-etime-command' ? `$now = Get-Date; ` : '';
  return `${body}Get-CimInstance Win32_Process | ForEach-Object { ${lineExpr(format)} }`;
}

/**
 * Run the Windows process-table listing and return its stdout: one
 * ps-compatible line per process. Rejects on spawn/query failure exactly like
 * the `ps` call it stands in for — callers' existing error handling applies.
 */
export function execWindowsProcessTable(format: WinProcessLineFormat): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    execFile(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-Command', buildWindowsProcessTableScript(format)],
      // Full-table command lines can total multiple MB; 64 MiB is comfortably
      // above any realistic table.
      { maxBuffer: 64 * 1024 * 1024, timeout: 30_000, windowsHide: true },
      (err, stdout) => {
        if (err) {
          reject(err instanceof Error ? err : new Error(String(err)));
          return;
        }
        resolve(stdout);
      },
    );
  });
}
