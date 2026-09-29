/**
 * preToolUseShellHook — the live-mode deferral. The hook is installed at spawn
 * for a gated mode, but a shift+tab in the TUI changes the mode without a
 * re-spawn; the hook must then stand aside rather than queue an approval.
 */
import { describe, expect, it } from 'vitest';
import { deferToLiveMode } from '../preToolUseShellHook';

describe('deferToLiveMode', () => {
  it.each(['auto', 'dontAsk', 'bypassPermissions'])('stands aside when the live mode is %s', (mode) => {
    expect(deferToLiveMode({ tool_name: 'Bash', permission_mode: mode })).toBe(true);
  });

  it.each(['default', 'acceptEdits', 'plan'])('keeps gating when the live mode is %s', (mode) => {
    expect(deferToLiveMode({ tool_name: 'Bash', permission_mode: mode })).toBe(false);
  });

  it('keeps gating when claude reports no mode (an older CLI) or a malformed one', () => {
    expect(deferToLiveMode({ tool_name: 'Bash' })).toBe(false);
    expect(deferToLiveMode({ tool_name: 'Bash', permission_mode: 42 })).toBe(false);
  });
});
