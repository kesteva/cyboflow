/**
 * Settings — "Auto-grade variant & experiment runs" sub-toggle round-trip (A/B
 * testing slice C). Lives inside the existing "Code Review Eval" section, bound
 * to config.autoGradeVariantRuns (absent = ON default). Verifies the loaded
 * value renders checked, and that toggling it off carries `autoGradeVariantRuns:
 * false` into the batched `API.config.update` save alongside the sibling fields.
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
    codeReviewEvalEnabled: true,
    autoGradeVariantRuns: true,
    ...over,
  };
}

beforeEach(() => {
  configGet.mockReset().mockResolvedValue({ success: true, data: baseConfig() });
  configUpdate.mockReset().mockResolvedValue({ success: true });
  getVersionInfo.mockReset().mockResolvedValue({ success: true, data: { variant: 'dev' } });
});

describe('Settings — autoGradeVariantRuns toggle', () => {
  it('loads checked by default (absent ⇒ ON) and renders inside Code Review Eval', async () => {
    configGet.mockResolvedValue({ success: true, data: baseConfig({ autoGradeVariantRuns: undefined }) });
    render(<Settings isOpen onClose={vi.fn()} />);
    const checkbox = await screen.findByLabelText('Auto-grade variant & experiment runs');
    expect(checkbox).toBeChecked();
  });

  it('reflects a loaded false value as unchecked', async () => {
    configGet.mockResolvedValue({ success: true, data: baseConfig({ autoGradeVariantRuns: false }) });
    render(<Settings isOpen onClose={vi.fn()} />);
    const checkbox = await screen.findByLabelText('Auto-grade variant & experiment runs');
    expect(checkbox).not.toBeChecked();
  });

  it('toggling off and saving carries autoGradeVariantRuns: false into API.config.update', async () => {
    render(<Settings isOpen onClose={vi.fn()} />);
    const checkbox = await screen.findByLabelText('Auto-grade variant & experiment runs');
    expect(checkbox).toBeChecked();

    fireEvent.click(checkbox);
    expect(checkbox).not.toBeChecked();

    const saveButton = screen.getByRole('button', { name: /save/i });
    fireEvent.click(saveButton);

    await waitFor(() =>
      expect(configUpdate).toHaveBeenCalledWith(
        expect.objectContaining({ autoGradeVariantRuns: false, codeReviewEvalEnabled: true }),
      ),
    );
  });
});
