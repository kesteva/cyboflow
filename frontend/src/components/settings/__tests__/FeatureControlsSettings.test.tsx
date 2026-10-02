/**
 * FeatureControlsSettings — the AI tab's "Feature controls" group (is the
 * capability available at all). Pins the six sections the user-approved
 * classification assigns to this group, and that every control is a pure
 * props-in/callback-out surface (no local state, no config round trip of its own
 * — `Settings.tsx` still owns the state and the save).
 */
import '@testing-library/jest-dom';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { FeatureControlsSettings } from '../FeatureControlsSettings';
import type { FeatureControlsSettingsProps } from '../FeatureControlsSettings';

vi.mock('../../../utils/telemetry', () => ({
  trackEvent: vi.fn(),
}));

function renderGroup(over: Partial<FeatureControlsSettingsProps> = {}) {
  const props: FeatureControlsSettingsProps = {
    interactivePtyOnly: false,
    onInteractivePtyOnlyChange: vi.fn(),
    computeCostFromRates: false,
    onComputeCostFromRatesChange: vi.fn(),
    artifactCommitDir: '',
    onArtifactCommitDirChange: vi.fn(),
    visualVerifyEnabled: false,
    onVisualVerifyEnabledChange: vi.fn(),
    autoBootstrapRunbook: false,
    onAutoBootstrapRunbookChange: vi.fn(),
    webViewerEnabled: true,
    onWebViewerEnabledChange: vi.fn(),
    webViewerAgentObserve: false,
    onWebViewerAgentObserveChange: vi.fn(),
    webViewerAgentDrive: false,
    onWebViewerAgentDriveChange: vi.fn(),
    webViewerPersistLogin: true,
    onWebViewerPersistLoginChange: vi.fn(),
    idleReviewEnabled: true,
    onIdleReviewEnabledChange: vi.fn(),
    idleReviewThresholdMinutes: 5,
    onIdleReviewThresholdMinutesChange: vi.fn(),
    ...over,
  };
  render(<FeatureControlsSettings {...props} />);
  return props;
}

/** The frozen membership list for this group (see TASK-158's classification). */
const FEATURE_CONTROL_SECTIONS = [
  'CLI Runtime',
  'Computed Run Cost',
  'Artifact Commit Location',
  'Visual Verification',
  'Web Viewer',
  'Idle Session Review',
] as const;

describe('FeatureControlsSettings', () => {
  it('renders exactly the six Feature-control sections', () => {
    renderGroup();

    for (const title of FEATURE_CONTROL_SECTIONS) {
      expect(screen.getByRole('heading', { name: title, level: 4 })).toBeInTheDocument();
    }
  });

  it('carries no Session-settings sections', () => {
    renderGroup();

    for (const title of [
      'Global Instructions',
      'Agent Permission Mode',
      'Workflow Orchestration',
      'Quick Sessions',
      'Quick Session Runtime',
      'Code Review Eval',
    ]) {
      expect(screen.queryByRole('heading', { name: title, level: 4 })).not.toBeInTheDocument();
    }
  });

  it('renders every control the sections own', () => {
    renderGroup();

    expect(screen.getByRole('button', { name: /Allow SDK/ })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: /Interactive CLI only/ })).toBeInTheDocument();
    expect(screen.getByTestId('computed-run-cost-off')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('computed-run-cost-on')).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByPlaceholderText('.cyboflow/artifacts')).toHaveValue('');
    expect(screen.getByLabelText('Enable visual verification')).not.toBeChecked();
    expect(screen.getByLabelText('Surface idle quick sessions for review')).toBeChecked();
    expect(screen.getByLabelText('Idle threshold (minutes)')).toHaveValue(5);
  });

  it('reports every change back through its callback (no local state)', () => {
    const props = renderGroup();

    fireEvent.click(screen.getByRole('button', { name: /Interactive CLI only/ }));
    expect(props.onInteractivePtyOnlyChange).toHaveBeenCalledWith(true);

    fireEvent.click(screen.getByTestId('computed-run-cost-on'));
    expect(props.onComputeCostFromRatesChange).toHaveBeenCalledWith(true);

    fireEvent.change(screen.getByPlaceholderText('.cyboflow/artifacts'), {
      target: { value: 'docs/artifacts' },
    });
    expect(props.onArtifactCommitDirChange).toHaveBeenCalledWith('docs/artifacts');

    fireEvent.click(screen.getByLabelText('Enable visual verification'));
    expect(props.onVisualVerifyEnabledChange).toHaveBeenCalledWith(true);

    fireEvent.click(screen.getByLabelText('Surface idle quick sessions for review'));
    expect(props.onIdleReviewEnabledChange).toHaveBeenCalledWith(false);

    fireEvent.change(screen.getByLabelText('Idle threshold (minutes)'), { target: { value: '12' } });
    expect(props.onIdleReviewThresholdMinutesChange).toHaveBeenCalledWith(12);
  });

  it("emits '' (never NaN) when the idle threshold is cleared", () => {
    const props = renderGroup();

    fireEvent.change(screen.getByLabelText('Idle threshold (minutes)'), { target: { value: '' } });
    expect(props.onIdleReviewThresholdMinutesChange).toHaveBeenCalledWith('');
  });

  it('disables the idle threshold field while idle review is off', () => {
    renderGroup({ idleReviewEnabled: false });

    expect(screen.getByLabelText('Idle threshold (minutes)')).toBeDisabled();
  });
});

describe('FeatureControlsSettings — web viewer', () => {
  it('gates every agent capability behind the master switch', () => {
    renderGroup({ webViewerEnabled: false });

    // The master switch itself stays operable; the three below do not, so a
    // disabled viewer cannot have an agent capability toggled on from the UI.
    expect(screen.getByLabelText('Enable the web viewer')).toBeEnabled();
    for (const label of [
      'Let agents read web tabs',
      'Let agents drive web tabs',
      'Stay signed in between launches',
    ]) {
      expect(screen.getByLabelText(label)).toBeDisabled();
    }
  });

  it('reports each web-viewer toggle through its own callback', () => {
    const props = renderGroup({ webViewerEnabled: true });

    fireEvent.click(screen.getByLabelText('Let agents read web tabs'));
    expect(props.onWebViewerAgentObserveChange).toHaveBeenCalledWith(true);

    fireEvent.click(screen.getByLabelText('Let agents drive web tabs'));
    expect(props.onWebViewerAgentDriveChange).toHaveBeenCalledWith(true);

    fireEvent.click(screen.getByLabelText('Stay signed in between launches'));
    expect(props.onWebViewerPersistLoginChange).toHaveBeenCalledWith(false);

    fireEvent.click(screen.getByLabelText('Enable the web viewer'));
    expect(props.onWebViewerEnabledChange).toHaveBeenCalledWith(false);
  });
});
