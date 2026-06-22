import '@testing-library/jest-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { PermissionModePill } from '../PermissionModePill';

const mockUpdate = vi.fn();
vi.mock('../../../../utils/api', () => ({
  API: { sessions: { updateAgentPermissionMode: (...args: unknown[]) => mockUpdate(...args) } },
}));

describe('PermissionModePill', () => {
  beforeEach(() => {
    mockUpdate.mockReset();
    mockUpdate.mockResolvedValue({ success: true });
  });

  it('renders the current mode label', () => {
    render(<PermissionModePill sessionId="s1" currentMode="default" onModeChange={vi.fn()} />);
    expect(screen.getByText('Ask before edits')).toBeInTheDocument();
  });

  it('persists a new mode via the IPC and notifies the host on select', async () => {
    const onChange = vi.fn();
    render(<PermissionModePill sessionId="s1" currentMode="default" onModeChange={onChange} />);
    fireEvent.click(screen.getByText('Ask before edits')); // open the dropdown
    fireEvent.click(await screen.findByText('Auto'));
    await waitFor(() => expect(mockUpdate).toHaveBeenCalledWith('s1', 'auto'));
    expect(onChange).toHaveBeenCalledWith('auto');
  });

  it('does not re-persist when selecting the already-active mode', async () => {
    const onChange = vi.fn();
    render(<PermissionModePill sessionId="s1" currentMode="auto" onModeChange={onChange} />);
    fireEvent.click(screen.getByText('Auto')); // open
    const items = await screen.findAllByText('Auto');
    fireEvent.click(items[items.length - 1]);
    await waitFor(() => expect(mockUpdate).not.toHaveBeenCalled());
    expect(onChange).not.toHaveBeenCalled();
  });
});
