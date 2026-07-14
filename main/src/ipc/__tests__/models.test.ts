import { describe, expect, it, vi } from 'vitest';
import type { AppServices } from '../types';
import { registerModelHandlers } from '../models';

function captureHandlers() {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const ipcMain = {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      handlers.set(channel, handler);
    }),
  };
  return { handlers, ipcMain };
}

describe('registerModelHandlers', () => {
  it('returns the dynamically discovered Codex model catalog', async () => {
    const catalog = {
      models: [{
        id: 'gpt-5.6-sol',
        label: 'GPT-5.6 Sol',
        description: 'Frontier coding model',
        isDefault: true,
      }],
      defaultModel: 'gpt-5.6-sol',
    };
    const getCodexModelCatalog = vi.fn(async () => catalog);
    const { handlers, ipcMain } = captureHandlers();
    registerModelHandlers(
      ipcMain as never,
      { codexSdkManager: { getCodexModelCatalog } } as unknown as AppServices,
    );

    await expect(handlers.get('models:get-codex-catalog')?.({})).resolves.toEqual({
      success: true,
      data: catalog,
    });
    expect(getCodexModelCatalog).toHaveBeenCalledOnce();
  });

  it('returns a typed failure when Codex discovery fails', async () => {
    const { handlers, ipcMain } = captureHandlers();
    registerModelHandlers(
      ipcMain as never,
      {
        codexSdkManager: {
          getCodexModelCatalog: vi.fn(async () => { throw new Error('Codex unavailable'); }),
        },
      } as unknown as AppServices,
    );

    await expect(handlers.get('models:get-codex-catalog')?.({})).resolves.toEqual({
      success: false,
      error: 'Codex unavailable',
    });
  });
});
