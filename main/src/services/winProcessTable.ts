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
 *   pid-ppid-cpu-mem-etime-command → `123 456 1.5 0.3 mm:ss C:\...` (the six-column
 *     `ps -axo pid=,ppid=,pcpu=,pmem=,etime=,command=` shape; pcpu is lifetime CPU
 *     time over elapsed time, pmem is working set over total physical memory, `-`
 *     when not computable)
 *
 * A null CommandLine renders as an empty field — the parsers only need the
 * numeric columns.
 */
import { execFile } from 'node:child_process';
import { ShellDetector } from '../utils/shellDetector';

export type WinProcessLineFormat =
  | 'pid-ppid'
  | 'pid-command'
  | 'pid-ppid-command'
  | 'pid-ppid-etime-command'
  | 'pid-ppid-cpu-mem-etime-command';

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
        ETIME_EXPR,
        `'{0} {1} {2} {3}' -f $_.ProcessId, $_.ParentProcessId, $et, $_.CommandLine`,
      ].join(' ');
    case 'pid-ppid-cpu-mem-etime-command':
      return [
        ETIME_EXPR,
        // Lifetime CPU% = (kernel+user 100ns ticks) / elapsed; `-` when elapsed is 0.
        // `.ToString('F1', InvariantCulture)`, not `-f '{0:N1}'`: `-f` honours the host
        // locale (decimal commas, grouping separators) which the dot-decimal parser rejects.
        `$cpu = if ($e.TotalSeconds -gt 0) { (((([double]$_.KernelModeTime + [double]$_.UserModeTime) / 1e7) / $e.TotalSeconds * 100)).ToString('F1', [cultureinfo]::InvariantCulture) } else { '-' };`,
        `$mem = if ($totalMem -gt 0) { ([double]$_.WorkingSetSize / $totalMem * 100).ToString('F1', [cultureinfo]::InvariantCulture) } else { '-' };`,
        `'{0} {1} {2} {3} {4} {5}' -f $_.ProcessId, $_.ParentProcessId, $cpu, $mem, $et, $_.CommandLine`,
      ].join(' ');
  }
}

/** Shared PowerShell fragment: sets `$e` (elapsed) and `$et` (ps-style etime). */
const ETIME_EXPR = [
  `$e = $now - $_.CreationDate;`,
  `$et = if ($e.Days -gt 0) { '{0}-{1:d2}:{2:d2}:{3:d2}' -f $e.Days, $e.Hours, $e.Minutes, $e.Seconds }`,
  `elseif ($e.Hours -gt 0) { '{0}:{1:d2}:{2:d2}' -f $e.Hours, $e.Minutes, $e.Seconds }`,
  `else { '{0}:{1:d2}' -f $e.Minutes, $e.Seconds };`,
].join(' ');

/**
 * The PowerShell script that renders `format` — one `pid [ppid [etime]] command`
 * line per Win32_Process row. Exported so synchronous callers (the kill ladders
 * that cannot await inside `execSync`-shaped code) run the exact same query as
 * {@link execWindowsProcessTable} instead of carrying a second copy of it.
 */
export function buildWindowsProcessTableScript(format: WinProcessLineFormat): string {
  let body = '';
  if (format === 'pid-ppid-etime-command') body = `$now = Get-Date; `;
  else if (format === 'pid-ppid-cpu-mem-etime-command') {
    body = `$now = Get-Date; $totalMem = [double](Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory; `;
  }
  return `${body}Get-CimInstance Win32_Process | ForEach-Object { ${lineExpr(format)} }`;
}

/**
 * The `execFile` argv for {@link execWindowsProcessTable}, pulled out so a
 * test on any host can pin the exact executable + args without spawning a
 * real PowerShell. The executable is always the fixed System32 path (see
 * {@link ShellDetector.windowsPowerShellPath}), never a bare `'powershell'`
 * that PATH resolution could resolve to a Microsoft Store execution-alias
 * stub instead of the real interpreter.
 */
export function windowsProcessTableCommand(
  format: WinProcessLineFormat,
): { command: string; args: string[] } {
  return {
    command: ShellDetector.windowsPowerShellPath(),
    args: ['-NoProfile', '-NonInteractive', '-Command', buildWindowsProcessTableScript(format)],
  };
}

/**
 * Run the Windows process-table listing and return its stdout: one
 * ps-compatible line per process. Rejects on spawn/query failure exactly like
 * the `ps` call it stands in for — callers' existing error handling applies.
 */
export function execWindowsProcessTable(format: WinProcessLineFormat): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const { command, args } = windowsProcessTableCommand(format);
    execFile(
      command,
      args,
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
