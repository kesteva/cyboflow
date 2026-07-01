import '@testing-library/jest-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { PluginEntry } from '../../../../../../shared/types/integrations';

const mockUpdate = vi.fn();
vi.mock('../../../../utils/api', () => ({
  API: { sessions: { updateSessionPlugins: (...args: unknown[]) => mockUpdate(...args) } },
}));

const mockList = vi.fn();
vi.mock('../../../../trpc/client', () => ({
  trpc: { cyboflow: { plugins: { list: { query: (...args: unknown[]) => mockList(...args) } } } },
}));

import { PluginTogglePill } from '../PluginTogglePill';

// The `enabled` field is consumed by the wizard (to seed the selection), not by
// the pill itself — the pill is a controlled component keyed off `selected`.
const CATALOGUE: PluginEntry[] = [
  { id: 'formatter@acme', name: 'formatter', marketplace: 'acme', scope: 'user', version: '1.0.0', enabled: true, lastUpdated: null, projectPath: null },
  { id: 'linter@acme', name: 'linter', marketplace: 'acme', scope: 'user', version: '2.0.0', enabled: false, lastUpdated: null, projectPath: null },
];
const ALL_ON = ['formatter@acme', 'linter@acme'];

beforeEach(() => {
  mockUpdate.mockReset().mockResolvedValue({ success: true });
  mockList.mockReset().mockResolvedValue(structuredClone(CATALOGUE));
});

describe('PluginTogglePill', () => {
  it('shows the bare "Plugins" label when every listed plugin is ON', async () => {
    render(<PluginTogglePill sessionId="s1" selected={ALL_ON} onChange={vi.fn()} />);
    expect(await screen.findByText('Plugins')).toBeInTheDocument();
    await waitFor(() => expect(mockList).toHaveBeenCalled()); // flush the catalogue fetch
  });

  it('shows the OFF count when some listed plugins are unchecked', async () => {
    render(<PluginTogglePill sessionId="s1" selected={['formatter@acme']} onChange={vi.fn()} />);
    // linter is installed but not selected → 1 off (awaits the catalogue fetch).
    expect(await screen.findByText('Plugins · 1 off')).toBeInTheDocument();
  });

  it('counts every installed plugin as off when none are selected', async () => {
    render(<PluginTogglePill sessionId="s1" selected={[]} onChange={vi.fn()} />);
    expect(await screen.findByText('Plugins · 2 off')).toBeInTheDocument();
  });

  it('lists installed plugins by short name', async () => {
    render(<PluginTogglePill sessionId="s1" selected={ALL_ON} onChange={vi.fn()} />);
    fireEvent.click(await screen.findByText('Plugins'));
    expect(await screen.findByText('formatter')).toBeInTheDocument();
    expect(screen.getByText('linter')).toBeInTheDocument();
  });

  it('turning a plugin OFF removes its id from the ON set (persists directly)', async () => {
    const onChange = vi.fn();
    render(<PluginTogglePill sessionId="s1" selected={ALL_ON} onChange={onChange} />);
    fireEvent.click(await screen.findByText('Plugins'));
    fireEvent.click(await screen.findByText('formatter'));
    await waitFor(() => expect(mockUpdate).toHaveBeenCalledWith('s1', ['linter@acme']));
    expect(onChange).toHaveBeenCalledWith(['linter@acme']);
  });

  it('turning a plugin back ON adds its id to the ON set', async () => {
    const onChange = vi.fn();
    render(<PluginTogglePill sessionId="s1" selected={['linter@acme']} onChange={onChange} />);
    fireEvent.click(await screen.findByText('Plugins · 1 off'));
    fireEvent.click(await screen.findByText('formatter'));
    await waitFor(() => expect(mockUpdate).toHaveBeenCalledWith('s1', ['linter@acme', 'formatter@acme']));
    expect(onChange).toHaveBeenCalledWith(['linter@acme', 'formatter@acme']);
  });

  it('updates the label OPTIMISTICALLY even when the prop does not change (stale fetched copy)', async () => {
    const onChange = vi.fn();
    const { rerender } = render(<PluginTogglePill sessionId="s1" selected={ALL_ON} onChange={onChange} />);
    fireEvent.click(await screen.findByText('Plugins'));
    fireEvent.click(await screen.findByText('formatter'));
    await waitFor(() => expect(mockUpdate).toHaveBeenCalledWith('s1', ['linter@acme']));
    rerender(<PluginTogglePill sessionId="s1" selected={ALL_ON} onChange={onChange} />);
    expect(screen.getByText('Plugins · 1 off')).toBeInTheDocument();
  });

  it('REVERTS the optimistic label when the persist fails', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    mockUpdate.mockResolvedValue({ success: false, error: 'boom' });
    render(<PluginTogglePill sessionId="s1" selected={ALL_ON} onChange={vi.fn()} />);
    fireEvent.click(await screen.findByText('Plugins'));
    fireEvent.click(await screen.findByText('formatter'));
    await waitFor(() => expect(mockUpdate).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByText('Plugins')).toBeInTheDocument());
    errSpy.mockRestore();
  });

  it('ADOPTS a genuinely-changed prop value (reload / session switch)', async () => {
    const { rerender } = render(<PluginTogglePill sessionId="s1" selected={ALL_ON} onChange={vi.fn()} />);
    expect(await screen.findByText('Plugins')).toBeInTheDocument();
    rerender(<PluginTogglePill sessionId="s1" selected={['formatter@acme']} onChange={vi.fn()} />);
    expect(await screen.findByText('Plugins · 1 off')).toBeInTheDocument();
  });
});
