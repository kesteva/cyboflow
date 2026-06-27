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

const CATALOGUE: PluginEntry[] = [
  { id: 'formatter@acme', name: 'formatter', marketplace: 'acme', scope: 'user', version: '1.0.0', lastUpdated: null, projectPath: null },
  { id: 'linter@acme', name: 'linter', marketplace: 'acme', scope: 'user', version: '2.0.0', lastUpdated: null, projectPath: null },
];

beforeEach(() => {
  mockUpdate.mockReset().mockResolvedValue({ success: true });
  mockList.mockReset().mockResolvedValue(structuredClone(CATALOGUE));
});

describe('PluginTogglePill', () => {
  it('shows the bare "Plugins" label when nothing is enabled', async () => {
    render(<PluginTogglePill sessionId="s1" selected={[]} onChange={vi.fn()} />);
    expect(screen.getByText('Plugins')).toBeInTheDocument();
    await waitFor(() => expect(mockList).toHaveBeenCalled()); // flush the catalogue fetch
  });

  it('shows the enabled count', async () => {
    render(<PluginTogglePill sessionId="s1" selected={['formatter@acme']} onChange={vi.fn()} />);
    expect(screen.getByText('Plugins · 1')).toBeInTheDocument();
    await waitFor(() => expect(mockList).toHaveBeenCalled());
  });

  it('lists installed plugins by short name', async () => {
    render(<PluginTogglePill sessionId="s1" selected={[]} onChange={vi.fn()} />);
    fireEvent.click(screen.getByText('Plugins'));
    expect(await screen.findByText('formatter')).toBeInTheDocument();
    expect(screen.getByText('linter')).toBeInTheDocument();
  });

  it('ENABLES a plugin by adding its id to the allow set (persists the selection directly)', async () => {
    const onChange = vi.fn();
    render(<PluginTogglePill sessionId="s1" selected={[]} onChange={onChange} />);
    fireEvent.click(screen.getByText('Plugins'));
    fireEvent.click(await screen.findByText('formatter'));
    await waitFor(() => expect(mockUpdate).toHaveBeenCalledWith('s1', ['formatter@acme']));
    expect(onChange).toHaveBeenCalledWith(['formatter@acme']);
  });

  it('DISABLES a plugin by removing its id from the allow set', async () => {
    const onChange = vi.fn();
    render(<PluginTogglePill sessionId="s1" selected={['formatter@acme']} onChange={onChange} />);
    fireEvent.click(screen.getByText('Plugins · 1'));
    fireEvent.click(await screen.findByText('formatter'));
    await waitFor(() => expect(mockUpdate).toHaveBeenCalledWith('s1', []));
    expect(onChange).toHaveBeenCalledWith([]);
  });
});
