import '@testing-library/jest-dom';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { TelemetryStep, type TelemetryDraft } from './TelemetryStep';

const BOTH_ON: TelemetryDraft = { errorReportingEnabled: true, usageMetricsEnabled: true };

describe('TelemetryStep', () => {
  it('renders a loading state and disables nothing to guess at while value is null', () => {
    render(<TelemetryStep value={null} onChange={vi.fn()} submitting={false} error={null} />);
    expect(screen.queryByRole('switch', { name: /crash & error reports/ })).not.toBeInTheDocument();
    expect(screen.getByText(/Loading your current settings/)).toBeInTheDocument();
  });

  it('reflects the resolved draft on each toggle independently', () => {
    render(
      <TelemetryStep
        value={{ errorReportingEnabled: true, usageMetricsEnabled: false }}
        onChange={vi.fn()}
        submitting={false}
        error={null}
      />,
    );
    expect(screen.getByRole('switch', { name: 'Send anonymized crash & error reports' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    expect(screen.getByRole('switch', { name: 'Send anonymized feature usage metrics' })).toHaveAttribute(
      'aria-checked',
      'false',
    );
  });

  it('calls onChange with only the toggled field flipped', () => {
    const onChange = vi.fn();
    render(<TelemetryStep value={BOTH_ON} onChange={onChange} submitting={false} error={null} />);

    fireEvent.click(screen.getByRole('switch', { name: 'Send anonymized crash & error reports' }));

    expect(onChange).toHaveBeenCalledWith({ errorReportingEnabled: false, usageMetricsEnabled: true });
  });

  it('disables both toggles while submitting', () => {
    render(<TelemetryStep value={BOTH_ON} onChange={vi.fn()} submitting error={null} />);
    expect(screen.getByRole('switch', { name: 'Send anonymized crash & error reports' })).toBeDisabled();
    expect(screen.getByRole('switch', { name: 'Send anonymized feature usage metrics' })).toBeDisabled();
  });

  it('renders an inline retryable error without swallowing it', () => {
    render(<TelemetryStep value={BOTH_ON} onChange={vi.fn()} submitting={false} error="Could not save." />);
    expect(screen.getByRole('alert')).toHaveTextContent('Could not save.');
  });

  it('states that source, prompts, project/repo names, and file paths are never sent', () => {
    render(<TelemetryStep value={BOTH_ON} onChange={vi.fn()} submitting={false} error={null} />);
    expect(
      screen.getByText(/no source code, prompts, project or repository names, or file paths are ever sent/),
    ).toBeInTheDocument();
    expect(screen.getByText(/Changes take effect after restarting the app/)).toBeInTheDocument();
  });
});
