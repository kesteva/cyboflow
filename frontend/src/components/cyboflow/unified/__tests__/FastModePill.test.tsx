import '@testing-library/jest-dom';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const setFastMode = vi.fn();
vi.mock('../../../../utils/api', () => ({
  API: { claudePanels: { setFastMode: (id: string, v: boolean) => setFastMode(id, v) } },
}));

import { FastModePill } from '../FastModePill';

beforeEach(() => {
  setFastMode.mockReset().mockResolvedValue({ success: true });
});

describe('FastModePill', () => {
  it('renders the Fast label and reflects the off state', () => {
    render(<FastModePill panelId="panel-1" fastMode={false} onChange={vi.fn()} />);
    const pill = screen.getByTestId('composer-fast-mode-pill');
    expect(pill).toHaveTextContent('Fast');
  });

  it('persists the toggle and reports the new value to the host', async () => {
    const onChange = vi.fn();
    render(<FastModePill panelId="panel-1" fastMode={false} onChange={onChange} />);
    fireEvent.click(screen.getByTestId('composer-fast-mode-pill'));
    await waitFor(() => expect(setFastMode).toHaveBeenCalledWith('panel-1', true));
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it('toggles back off when already on', async () => {
    const onChange = vi.fn();
    render(<FastModePill panelId="panel-1" fastMode onChange={onChange} />);
    fireEvent.click(screen.getByTestId('composer-fast-mode-pill'));
    await waitFor(() => expect(setFastMode).toHaveBeenCalledWith('panel-1', false));
    expect(onChange).toHaveBeenCalledWith(false);
  });

  it('does not report the change to the host when persistence fails', async () => {
    setFastMode.mockResolvedValue({ success: false, error: 'nope' });
    const onChange = vi.fn();
    render(<FastModePill panelId="panel-1" fastMode={false} onChange={onChange} />);
    fireEvent.click(screen.getByTestId('composer-fast-mode-pill'));
    await waitFor(() => expect(setFastMode).toHaveBeenCalled());
    expect(onChange).not.toHaveBeenCalled();
  });
});
