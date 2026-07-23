/**
 * Settings — Privacy & Telemetry checkbox event semantics. `telemetry_opt_out_changed`
 * must fire ONLY after a successful save, and only for a channel whose value
 * actually changed — never on checkbox onChange (which would fire even if the
 * user then cancels without saving) and never for a save that fails or leaves
 * a channel unchanged. Mirrors the onboarding Telemetry step's post-success
 * diff-against-baseline semantics (TASK-066).
 */
import '@testing-library/jest-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { Settings } from '../Settings';
import type { AppConfig } from '../../types/config';

const configGet = vi.fn();
const configUpdate = vi.fn();
const getVersionInfo = vi.fn();
const trackEvent = vi.fn();
const projectsGetAll = vi.fn();

vi.mock('../../utils/api', () => ({
  API: {
    config: {
      get: (...a: unknown[]) => configGet(...a),
      update: (...a: unknown[]) => configUpdate(...a),
    },
    projects: {
      getAll: (...a: unknown[]) => projectsGetAll(...a),
    },
    getVersionInfo: (...a: unknown[]) => getVersionInfo(...a),
  },
}));

vi.mock('../../utils/telemetry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../utils/telemetry')>();
  return {
    ...actual,
    trackEvent: (...a: unknown[]) => trackEvent(...a),
    // Delegate to the REAL diff-and-emit helper with the spy injected, so the
    // shared logic stays single-source while assertions still see the events.
    emitTelemetryChangeEvents: (
      baseline: Parameters<typeof actual.emitTelemetryChangeEvents>[0],
      next: Parameters<typeof actual.emitTelemetryChangeEvents>[1],
    ) => actual.emitTelemetryChangeEvents(baseline, next, ((...a: unknown[]) => trackEvent(...a)) as typeof actual.trackEvent),
  };
});

vi.mock('../../contexts/ThemeContext', () => ({
  useTheme: () => ({ theme: 'paper', setTheme: vi.fn() }),
}));

vi.mock('../../stores/configStore', () => ({
  useConfigStore: () => ({ fetchConfig: vi.fn().mockResolvedValue(undefined) }),
}));

function baseConfig(over: Partial<AppConfig> = {}): AppConfig {
  return {
    gitRepoPath: '/repo',
    telemetry: { installId: 'inst-1', errorReportingEnabled: true, usageMetricsEnabled: true },
    ...over,
  };
}

beforeEach(() => {
  configGet.mockReset().mockResolvedValue({ success: true, data: baseConfig() });
  configUpdate.mockReset().mockResolvedValue({ success: true });
  getVersionInfo.mockReset().mockResolvedValue({ success: true, data: { variant: 'dev' } });
  projectsGetAll.mockReset().mockResolvedValue({ success: true, data: [] });
  trackEvent.mockReset();
});

/** The "Privacy & Telemetry" card starts collapsed (defaultExpanded=false) — expand it. */
async function expandTelemetryCard(): Promise<void> {
  const toggle = await screen.findByRole('button', { name: /Privacy & Telemetry/ });
  fireEvent.click(toggle);
  await screen.findByLabelText('Send anonymized crash & error reports');
}

describe('Settings — telemetry_opt_out_changed event semantics', () => {
  it('does not emit on checkbox toggle alone (no save yet)', async () => {
    render(<Settings isOpen onClose={vi.fn()} initialTab="general" />);
    await expandTelemetryCard();
    const checkbox = screen.getByLabelText('Send anonymized crash & error reports');
    fireEvent.click(checkbox);
    expect(checkbox).not.toBeChecked();
    expect(trackEvent).not.toHaveBeenCalledWith('telemetry_opt_out_changed', expect.anything());
  });

  it('emits only for the changed channel on a successful save', async () => {
    render(<Settings isOpen onClose={vi.fn()} initialTab="general" />);
    await expandTelemetryCard();
    const errorsCheckbox = screen.getByLabelText('Send anonymized crash & error reports');
    fireEvent.click(errorsCheckbox); // errors: true -> false; usage stays true

    const saveButton = screen.getByRole('button', { name: /save/i });
    fireEvent.click(saveButton);

    await waitFor(() => expect(configUpdate).toHaveBeenCalled());
    expect(trackEvent).toHaveBeenCalledWith('telemetry_opt_out_changed', { channel: 'errors', enabled: false });
    expect(trackEvent).not.toHaveBeenCalledWith('telemetry_opt_out_changed', { channel: 'usage', enabled: true });
  });

  it('emits nothing when neither telemetry channel changed', async () => {
    render(<Settings isOpen onClose={vi.fn()} initialTab="general" />);
    await expandTelemetryCard();

    const saveButton = screen.getByRole('button', { name: /save/i });
    fireEvent.click(saveButton);

    await waitFor(() => expect(configUpdate).toHaveBeenCalled());
    expect(trackEvent).not.toHaveBeenCalledWith('telemetry_opt_out_changed', expect.anything());
  });

  it('emits nothing when the save fails', async () => {
    configUpdate.mockResolvedValue({ success: false, error: 'nope' });
    render(<Settings isOpen onClose={vi.fn()} initialTab="general" />);
    await expandTelemetryCard();
    const errorsCheckbox = screen.getByLabelText('Send anonymized crash & error reports');
    fireEvent.click(errorsCheckbox);

    const saveButton = screen.getByRole('button', { name: /save/i });
    fireEvent.click(saveButton);

    await waitFor(() => expect(configUpdate).toHaveBeenCalled());
    expect(trackEvent).not.toHaveBeenCalledWith('telemetry_opt_out_changed', expect.anything());
  });

  it('emits nothing when the dialog is closed without saving (cancel)', async () => {
    const onClose = vi.fn();
    render(<Settings isOpen onClose={onClose} initialTab="general" />);
    await expandTelemetryCard();
    const errorsCheckbox = screen.getByLabelText('Send anonymized crash & error reports');
    fireEvent.click(errorsCheckbox);

    // Close without ever clicking Save.
    onClose();

    expect(configUpdate).not.toHaveBeenCalled();
    expect(trackEvent).not.toHaveBeenCalledWith('telemetry_opt_out_changed', expect.anything());
  });
});
