/**
 * persistAttachments — a refused save (e.g. an attachment for a session on a remote environment, M2) rejects with
 * main's own message, not Electron's "Error invoking remote method …" wrapper.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { ipcErrorMessage, persistAttachments } from '../persistAttachments';

describe('persistAttachments', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('unwraps the Electron invoke prefix', () => {
    expect(
      ipcErrorMessage(new Error("Error invoking remote method 'sessions:save-images': Error: Attaching files is not available on remote environments.")),
    ).toBe('Attaching files is not available on remote environments.');
    expect(ipcErrorMessage(new Error('plain failure'))).toBe('plain failure');
  });

  it('rejects with the readable refusal', async () => {
    const saveLargeText = vi.fn(async () => {
      throw new Error("Error invoking remote method 'sessions:save-large-text': Error: Attaching files is not available on remote environments.");
    });
    vi.stubGlobal('window', { ...window, electronAPI: { sessions: { saveLargeText, saveImages: vi.fn() } } });
    await expect(
      persistAttachments('s-remote', { texts: [{ id: 't', content: 'big' }], images: [] } as never),
    ).rejects.toThrow(/^Attaching files is not available on remote environments\.$/);
  });
});
