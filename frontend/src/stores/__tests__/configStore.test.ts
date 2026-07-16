/**
 * configStore — `updateConfig` success/failure return-value contract. This is
 * the ONLY behavioral change on top of the pre-existing (non-throwing, `error`
 * state) contract: `updateConfig` now resolves `true` on success and `false`
 * on failure (API rejects `success`, or the call throws), so a caller like the
 * onboarding Telemetry step can get a definitive per-call signal without
 * racing the shared `error` field. Pre-existing behavior (setting `config` /
 * `error` state, refetching on success) is unchanged and re-asserted here.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useConfigStore } from '../configStore';
import type { AppConfig } from '../../types/config';

const configGet = vi.fn();
const configUpdate = vi.fn();

vi.mock('../../utils/api', () => ({
  API: {
    config: {
      get: (...a: unknown[]) => configGet(...a),
      update: (...a: unknown[]) => configUpdate(...a),
    },
  },
}));

function baseConfig(over: Partial<AppConfig> = {}): AppConfig {
  return { gitRepoPath: '/repo', ...over };
}

beforeEach(() => {
  configGet.mockReset();
  configUpdate.mockReset();
  useConfigStore.setState({ config: null, isLoading: false, error: null });
});

describe('configStore.updateConfig', () => {
  it('resolves true and refetches config on a successful update', async () => {
    configUpdate.mockResolvedValue({ success: true });
    configGet.mockResolvedValue({ success: true, data: baseConfig({ verbose: true }) });

    const ok = await useConfigStore.getState().updateConfig({ verbose: true });

    expect(ok).toBe(true);
    expect(configGet).toHaveBeenCalledTimes(1);
    expect(useConfigStore.getState().config).toEqual(baseConfig({ verbose: true }));
    expect(useConfigStore.getState().error).toBeNull();
  });

  it('resolves false and sets error state when the API reports failure', async () => {
    configUpdate.mockResolvedValue({ success: false, error: 'nope' });

    const ok = await useConfigStore.getState().updateConfig({ verbose: true });

    expect(ok).toBe(false);
    expect(configGet).not.toHaveBeenCalled();
    expect(useConfigStore.getState().error).toBe('nope');
  });

  it('resolves false and sets error state when the API call throws', async () => {
    configUpdate.mockRejectedValue(new Error('network down'));

    const ok = await useConfigStore.getState().updateConfig({ verbose: true });

    expect(ok).toBe(false);
    expect(useConfigStore.getState().error).toBe('Failed to update config');
  });
});
