import { describe, it, expect, vi, afterEach } from 'vitest';
import { copyToClipboard } from '../clipboard';

function setClipboard(value: unknown): void {
  Object.defineProperty(navigator, 'clipboard', { value, configurable: true });
}

afterEach(() => {
  setClipboard(undefined);
});

describe('copyToClipboard', () => {
  it('returns true and writes the text on success', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    setClipboard({ writeText });
    await expect(copyToClipboard('hello')).resolves.toBe(true);
    expect(writeText).toHaveBeenCalledWith('hello');
  });

  it('returns false when writeText rejects', async () => {
    setClipboard({ writeText: vi.fn().mockRejectedValue(new Error('denied')) });
    await expect(copyToClipboard('x')).resolves.toBe(false);
  });

  it('returns false when the clipboard API is absent', async () => {
    setClipboard(undefined);
    await expect(copyToClipboard('x')).resolves.toBe(false);
  });
});
