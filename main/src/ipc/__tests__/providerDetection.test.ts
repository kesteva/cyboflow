/**
 * The provider-keyed onboarding/Settings detection channel.
 *
 * What is worth pinning is the DISPATCH, not the probes themselves (each
 * provider's probe has its own coverage): the generic channel must route to the
 * provider it was asked for, reject an unregistered one instead of silently
 * probing a default, and the two provider-named delegates must return exactly
 * what the generic channel returns so they cannot drift apart while both exist.
 */
import { describe, expect, it, vi } from 'vitest';
import { AGENT_PROVIDERS } from '../../../../shared/types/agentRuntime';

vi.mock('../../utils/claudeCredentials', () => ({
  detectClaudeCredentials: vi.fn(async () => ({
    found: true,
    source: 'keychain' as const,
    account: 'claude@example.com',
  })),
}));
vi.mock('../../utils/claudeCodeTest', () => ({
  detectClaudeBinary: vi.fn(async () => ({
    found: true,
    path: '/usr/local/bin/claude',
    version: '1.2.3',
  })),
}));
// The omp probe now really shells out to findExecutableInPath('omp') (see
// ompAvailability.ts) — pin it to "not found" so this suite is deterministic
// regardless of whether the machine running it happens to have omp on PATH.
// detectOmpAvailability's own found/missing/too-old/probe-failure behavior is
// covered by services/panels/omp/__tests__/ompAvailability.test.ts.
vi.mock('../../utils/shellPath', () => ({
  getShellPath: () => '/usr/bin:/bin',
  findExecutableInPath: () => null,
}));

import { PROVIDERS_DETECT_CHANNEL } from '../../../../shared/types/onboarding';
import type { AppServices } from '../types';
import { registerProviderDetectionHandlers } from '../providerDetection';

const CODEX_DETECTION = {
  runtime: { found: true, path: '/app/codex', version: '0.153.3' },
  account: { found: true, email: 'codex@example.com', planType: 'plus' },
  state: 'detected' as const,
};

function register() {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const ipcMain = {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      handlers.set(channel, handler);
    }),
  };
  const detectChatGptAccount = vi.fn(async () => CODEX_DETECTION);
  const services = {
    configManager: { getConfig: () => ({ claudeExecutablePath: undefined }) },
    codexSdkManager: { detectChatGptAccount },
  } as unknown as AppServices;
  registerProviderDetectionHandlers(ipcMain as never, services);
  return { handlers, detectChatGptAccount };
}

describe('registerProviderDetectionHandlers', () => {
  it('routes providers:detect to the requested provider probe', async () => {
    const { handlers, detectChatGptAccount } = register();

    await expect(handlers.get(PROVIDERS_DETECT_CHANNEL)?.({}, 'codex')).resolves.toEqual({
      success: true,
      data: CODEX_DETECTION,
    });
    await expect(handlers.get(PROVIDERS_DETECT_CHANNEL)?.({}, 'claude')).resolves.toEqual({
      success: true,
      data: {
        credentials: { found: true, source: 'keychain', account: 'claude@example.com' },
        binary: { found: true, path: '/usr/local/bin/claude', version: '1.2.3' },
        state: 'detected',
      },
    });
    expect(detectChatGptAccount).toHaveBeenCalledOnce();
  });

  it('reports omp unavailable when the binary is not on PATH', async () => {
    // findExecutableInPath is mocked to return null above, so the real
    // detectOmpAvailability probe short-circuits to 'unavailable' without
    // ever calling --version.
    const { handlers } = register();

    await expect(handlers.get(PROVIDERS_DETECT_CHANNEL)?.({}, 'omp')).resolves.toEqual({
      success: true,
      data: { state: 'unavailable', binaryPath: null, version: null },
    });
  });

  it('rejects an unregistered provider rather than falling back to a default', async () => {
    const { handlers, detectChatGptAccount } = register();

    await expect(handlers.get(PROVIDERS_DETECT_CHANNEL)?.({}, 'gemini')).resolves.toEqual({
      success: false,
      // Spelled from the registry, not frozen — see the models.test.ts twin.
      error: `Unknown agent provider "gemini" (expected one of ${AGENT_PROVIDERS.join(', ')}).`,
    });
    expect(detectChatGptAccount).not.toHaveBeenCalled();
  });

  it('keeps the provider-named channels as delegates of the same registry', async () => {
    const { handlers } = register();

    const generic = await handlers.get(PROVIDERS_DETECT_CHANNEL)?.({}, 'codex');
    await expect(handlers.get('codex:detect')?.({})).resolves.toEqual(generic);
    await expect(handlers.get('claude:detect')?.({})).resolves.toEqual(
      await handlers.get(PROVIDERS_DETECT_CHANNEL)?.({}, 'claude'),
    );
  });
});
