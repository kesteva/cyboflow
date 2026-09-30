/**
 * winProcessTable unit tests — the PowerShell query-string builder, pinned on any
 * host (no real PowerShell is spawned).
 */
import { describe, it, expect } from 'vitest';
import { buildWindowsProcessTableScript } from './winProcessTable';
import { parsePsOutputWithCpuMem } from './processTable';

describe('buildWindowsProcessTableScript', () => {
  it('pid-ppid-cpu-mem-etime-command emits the six ps columns in order', () => {
    const script = buildWindowsProcessTableScript('pid-ppid-cpu-mem-etime-command');
    expect(script).toContain('$now = Get-Date;');
    expect(script).toContain('Win32_ComputerSystem');
    expect(script).toContain('Get-CimInstance Win32_Process | ForEach-Object {');
    expect(script).toContain(
      "'{0} {1} {2} {3} {4} {5}' -f $_.ProcessId, $_.ParentProcessId, $cpu, $mem, $et, $_.CommandLine",
    );
    // `-` (not 0) when a percentage cannot be computed.
    expect(script).toContain("else { '-' }");
  });

  it('formats pcpu/pmem with the invariant culture so the dot-decimal parser accepts them', () => {
    const script = buildWindowsProcessTableScript('pid-ppid-cpu-mem-etime-command');
    // Host-locale `-f '{0:N1}'` emits decimal commas / grouping separators; must be gone.
    expect(script).not.toContain('N1');
    expect(script.match(/\.ToString\('F1', \[cultureinfo\]::InvariantCulture\)/g)).toHaveLength(2);
    // Producer -> parser contract: the F1 invariant shape (incl. `-`) round-trips into a kept row.
    const rows = parsePsOutputWithCpuMem('321 4 1234.5 0.3 1-02:03:04 C:\\app\\node.exe x.js\n322 4 - - 0:05 C:\\b.exe\n');
    expect(rows.map((r) => [r.pid, r.pcpu, r.pmem])).toEqual([
      [321, 1234.5, 0.3],
      [322, null, null],
    ]);
  });

  it('leaves the existing etime format unchanged', () => {
    const script = buildWindowsProcessTableScript('pid-ppid-etime-command');
    expect(script).toContain("'{0} {1} {2} {3}' -f $_.ProcessId, $_.ParentProcessId, $et, $_.CommandLine");
    expect(script).not.toContain('Win32_ComputerSystem');
  });
});
