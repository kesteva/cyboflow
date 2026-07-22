/**
 * Settings — dedicated Assistant tab. The assistant controls (enable toggle,
 * model, folder access) live in their own top-level tab, plus the
 * context-retention strategy picker (assistantContextRetention:
 * 'clear-daily' default | 'compact-daily' | 'auto-compact'). Verifies the tab
 * renders its controls, the retention default, that a selection carries the
 * EXPLICIT value into the batched `API.config.update` save (updateConfig
 * merges partials — undefined would fail to overwrite a stored override), and
 * that a stored override loads pressed.
 */
import '@testing-library/jest-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { Settings } from '../Settings';
import type { AppConfig } from '../../types/config';

const configGet = vi.fn();
const configUpdate = vi.fn();
const getVersionInfo = vi.fn();

vi.mock('../../utils/api', () => ({
  API: {
    config: {
      get: (...a: unknown[]) => configGet(...a),
      update: (...a: unknown[]) => configUpdate(...a),
    },
    getVersionInfo: (...a: unknown[]) => getVersionInfo(...a),
  },
}));

vi.mock('../../contexts/ThemeContext', () => ({
  useTheme: () => ({ theme: 'paper', setTheme: vi.fn() }),
}));

vi.mock('../../stores/configStore', () => ({
  useConfigStore: () => ({ fetchConfig: vi.fn().mockResolvedValue(undefined) }),
}));

function baseConfig(over: Partial<AppConfig> = {}): AppConfig {
  return {
    gitRepoPath: '/repo',
    assistantEnabled: true,
    ...over,
  };
}

beforeEach(() => {
  configGet.mockReset().mockResolvedValue({ success: true, data: baseConfig() });
  configUpdate.mockReset().mockResolvedValue({ success: true });
  getVersionInfo.mockReset().mockResolvedValue({ success: true, data: { variant: 'dev' } });
});

describe('Settings — Assistant tab', () => {
  it('renders the assistant controls in their own top-level tab', async () => {
    render(<Settings isOpen onClose={vi.fn()} initialTab="assistant" />);

    expect(await screen.findByLabelText('Enable assistant')).toBeChecked();
    // The three retention options render as a picker.
    expect(screen.getByRole('button', { name: /Clear daily/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Compact daily/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Auto-compact/ })).toBeInTheDocument();
  });

  it("defaults context retention to 'clear-daily' when the key is absent", async () => {
    render(<Settings isOpen onClose={vi.fn()} initialTab="assistant" />);

    const clearDaily = await screen.findByRole('button', { name: /Clear daily/ });
    expect(clearDaily).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: /Compact daily/ })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByRole('button', { name: /Auto-compact/ })).toHaveAttribute('aria-pressed', 'false');
  });

  it('loads a stored override pressed', async () => {
    configGet.mockResolvedValue({
      success: true,
      data: baseConfig({ assistantContextRetention: 'auto-compact' }),
    });
    render(<Settings isOpen onClose={vi.fn()} initialTab="assistant" />);

    const autoCompact = await screen.findByRole('button', { name: /Auto-compact/ });
    expect(autoCompact).toHaveAttribute('aria-pressed', 'true');
  });

  it('selecting a mode and saving carries the explicit value into API.config.update', async () => {
    render(<Settings isOpen onClose={vi.fn()} initialTab="assistant" />);

    const compactDaily = await screen.findByRole('button', { name: /Compact daily/ });
    fireEvent.click(compactDaily);
    expect(compactDaily).toHaveAttribute('aria-pressed', 'true');

    fireEvent.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() =>
      expect(configUpdate).toHaveBeenCalledWith(
        expect.objectContaining({ assistantContextRetention: 'compact-daily' }),
      ),
    );
  });

  it("saving without touching the picker still sends the explicit default (merge-partial guard)", async () => {
    render(<Settings isOpen onClose={vi.fn()} initialTab="assistant" />);
    await screen.findByLabelText('Enable assistant');

    fireEvent.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() =>
      expect(configUpdate).toHaveBeenCalledWith(
        expect.objectContaining({ assistantContextRetention: 'clear-daily' }),
      ),
    );
  });
});
