import '@testing-library/jest-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { PermissionModePill } from '../PermissionModePill';

describe('PermissionModePill', () => {
  let persist: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    persist = vi.fn().mockResolvedValue({ success: true });
  });

  it('renders the current mode label', () => {
    render(<PermissionModePill currentMode="default" persist={persist} onModeChange={vi.fn()} />);
    expect(screen.getByText('Ask before edits')).toBeInTheDocument();
  });

  it('persists a new mode via the pluggable persist fn and notifies the host on select', async () => {
    const onChange = vi.fn();
    render(<PermissionModePill currentMode="default" persist={persist} onModeChange={onChange} />);
    fireEvent.click(screen.getByText('Ask before edits')); // open the dropdown
    fireEvent.click(await screen.findByText('Auto'));
    await waitFor(() => expect(persist).toHaveBeenCalledWith('auto'));
    expect(onChange).toHaveBeenCalledWith('auto');
  });

  it('does not re-persist when selecting the already-active mode', async () => {
    const onChange = vi.fn();
    render(<PermissionModePill currentMode="auto" persist={persist} onModeChange={onChange} />);
    fireEvent.click(screen.getByText('Auto')); // open
    const items = await screen.findAllByText('Auto');
    fireEvent.click(items[items.length - 1]);
    await waitFor(() => expect(persist).not.toHaveBeenCalled());
    expect(onChange).not.toHaveBeenCalled();
  });

  it('fires onApplied with the host-supplied message after a confirmed persist', async () => {
    const onApplied = vi.fn();
    render(
      <PermissionModePill
        currentMode="default"
        persist={persist}
        onModeChange={vi.fn()}
        onApplied={onApplied}
        appliedMessage="applies when the terminal restarts"
      />,
    );
    fireEvent.click(screen.getByText('Ask before edits')); // open
    fireEvent.click(await screen.findByText('Auto'));
    await waitFor(() =>
      expect(onApplied).toHaveBeenCalledWith('auto', 'applies when the terminal restarts'),
    );
  });

  it('does not fire onApplied when the persist fails', async () => {
    persist.mockResolvedValueOnce({ success: false, error: 'nope' });
    const onApplied = vi.fn();
    render(
      <PermissionModePill
        currentMode="default"
        persist={persist}
        onModeChange={vi.fn()}
        onApplied={onApplied}
      />,
    );
    fireEvent.click(screen.getByText('Ask before edits')); // open
    fireEvent.click(await screen.findByText('Auto'));
    await waitFor(() => expect(persist).toHaveBeenCalledWith('auto'));
    expect(onApplied).not.toHaveBeenCalled();
  });

  it('reflects the selection optimistically even when the parent never updates currentMode (stale fetched-session prop)', async () => {
    // currentMode stays "auto" for the whole test — the quick composer feeds it
    // from a fetched session copy that usePanelSurface never re-syncs from the
    // store, so a controlled-only pill would stay stuck on "Auto".
    render(<PermissionModePill currentMode="auto" persist={persist} onModeChange={vi.fn()} />);
    fireEvent.click(screen.getByText('Auto')); // open
    fireEvent.click(await screen.findByText('Allow edits'));
    await waitFor(() => expect(persist).toHaveBeenCalledWith('acceptEdits'));
    // Dropdown closed → the only label in the DOM is the trigger, now showing the
    // optimistic selection rather than the stale "auto" prop.
    expect(screen.getByText('Allow edits')).toBeInTheDocument();
    expect(screen.queryByText('Auto')).not.toBeInTheDocument();
  });

  it('reverts the optimistic label when the persist fails', async () => {
    persist.mockResolvedValueOnce({ success: false, error: 'nope' });
    render(<PermissionModePill currentMode="auto" persist={persist} onModeChange={vi.fn()} />);
    fireEvent.click(screen.getByText('Auto')); // open
    fireEvent.click(await screen.findByText('Allow edits'));
    await waitFor(() => expect(persist).toHaveBeenCalledWith('acceptEdits'));
    // The failed write rolls the displayed mode back to the prior value.
    await waitFor(() => expect(screen.getByText('Auto')).toBeInTheDocument());
    expect(screen.queryByText('Allow edits')).not.toBeInTheDocument();
  });

  it('re-syncs to an externally changed currentMode (reload / session switch)', () => {
    const { rerender } = render(
      <PermissionModePill currentMode="auto" persist={persist} onModeChange={vi.fn()} />,
    );
    expect(screen.getByText('Auto')).toBeInTheDocument();
    rerender(<PermissionModePill currentMode="default" persist={persist} onModeChange={vi.fn()} />);
    expect(screen.getByText('Ask before edits')).toBeInTheDocument();
    expect(screen.queryByText('Auto')).not.toBeInTheDocument();
  });

  it('uses the supplied title on the trigger', () => {
    render(
      <PermissionModePill
        currentMode="default"
        persist={persist}
        onModeChange={vi.fn()}
        title="Agent permission — applies when the terminal restarts"
      />,
    );
    expect(
      screen.getByTitle('Agent permission — applies when the terminal restarts'),
    ).toBeInTheDocument();
  });
});
