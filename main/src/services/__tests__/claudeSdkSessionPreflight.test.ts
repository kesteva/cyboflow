/**
 * runClaudeSdkSessionPreflights — the shared fail-closed ladder behind every
 * SDK-pinned session door (design branch of sessions:create-quick, the design-
 * mode fork in index.ts, the open-idea-session door).
 *
 * The ORDER of the three rungs is the behavioural contract this pins: the
 * provider switch is checked BEFORE the detection probe (otherwise a disabled
 * account gets reported as healthy), and the interactivePtyOnly lock last.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const detectClaudeCredentials = vi.fn(async () => ({ found: true }));
const detectClaudeBinary = vi.fn(async (_configuredPath?: string) => ({ found: true }));

vi.mock('../../utils/claudeCredentials', () => ({
  detectClaudeCredentials: () => detectClaudeCredentials(),
}));
vi.mock('../../utils/claudeBinaryDetection', () => ({
  detectClaudeBinary: (configuredPath?: string) => detectClaudeBinary(configuredPath),
}));

import {
  runClaudeSdkSessionPreflights,
  type ClaudeSdkPreflightConfig,
} from '../claudeSdkSessionPreflight';

function makeConfig(overrides: Partial<{ claudeEnabled: boolean; ptyOnly: boolean; execPath: string }> = {}): ClaudeSdkPreflightConfig {
  return {
    isAgentProviderEnabled: () => overrides.claudeEnabled ?? true,
    isInteractivePtyOnly: () => overrides.ptyOnly ?? false,
    getConfig: () => ({ claudeExecutablePath: overrides.execPath }),
  };
}

describe('runClaudeSdkSessionPreflights', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    detectClaudeCredentials.mockResolvedValue({ found: true });
    detectClaudeBinary.mockResolvedValue({ found: true });
  });

  it('passes when Claude is enabled, detected, and the PTY lock is off', async () => {
    await expect(runClaudeSdkSessionPreflights(makeConfig())).resolves.toEqual({ ok: true });
  });

  it("rejects 'provider_disabled' WITHOUT probing when Claude is switched off", async () => {
    const result = await runClaudeSdkSessionPreflights(makeConfig({ claudeEnabled: false }));

    expect(result).toEqual({ ok: false, reason: 'provider_disabled' });
    // The order is load-bearing: probing first would report a perfectly healthy
    // account the user deliberately disabled.
    expect(detectClaudeCredentials).not.toHaveBeenCalled();
    expect(detectClaudeBinary).not.toHaveBeenCalled();
  });

  it("rejects 'claude_not_detected' when credentials are missing (binary present => 'loggedOut')", async () => {
    detectClaudeCredentials.mockResolvedValue({ found: false });

    await expect(runClaudeSdkSessionPreflights(makeConfig())).resolves.toEqual({
      ok: false,
      reason: 'claude_not_detected',
    });
  });

  it("rejects 'claude_not_detected' when neither credentials nor binary are found", async () => {
    detectClaudeCredentials.mockResolvedValue({ found: false });
    detectClaudeBinary.mockResolvedValue({ found: false });

    await expect(runClaudeSdkSessionPreflights(makeConfig())).resolves.toEqual({
      ok: false,
      reason: 'claude_not_detected',
    });
  });

  it("rejects 'interactive_pty_only' LAST, only once detection has passed", async () => {
    const result = await runClaudeSdkSessionPreflights(makeConfig({ ptyOnly: true }));

    expect(result).toEqual({ ok: false, reason: 'interactive_pty_only' });
    expect(detectClaudeCredentials).toHaveBeenCalled();
  });

  it('threads the configured Claude executable path into the binary probe', async () => {
    await runClaudeSdkSessionPreflights(makeConfig({ execPath: '/opt/claude' }));

    expect(detectClaudeBinary).toHaveBeenCalledWith('/opt/claude');
  });
});
