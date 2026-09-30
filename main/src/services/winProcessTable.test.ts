/**
 * winProcessTable unit tests — the PowerShell query-string builder, pinned on any
 * host (no real PowerShell is spawned).
 */
import { describe, it, expect } from 'vitest';
import { buildWindowsProcessTableScript } from './winProcessTable';

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

  it('leaves the existing etime format unchanged', () => {
    const script = buildWindowsProcessTableScript('pid-ppid-etime-command');
    expect(script).toContain("'{0} {1} {2} {3}' -f $_.ProcessId, $_.ParentProcessId, $et, $_.CommandLine");
    expect(script).not.toContain('Win32_ComputerSystem');
  });
});
