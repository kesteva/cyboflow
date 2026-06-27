import '@testing-library/jest-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { McpEntry } from '../../../../../../shared/types/integrations';

const mockUpdate = vi.fn();
vi.mock('../../../../utils/api', () => ({
  API: { sessions: { updateSessionMcps: (...args: unknown[]) => mockUpdate(...args) } },
}));

const mockList = vi.fn();
vi.mock('../../../../trpc/client', () => ({
  trpc: { cyboflow: { mcps: { list: { query: (...args: unknown[]) => mockList(...args) } } } },
}));

import { McpTogglePill } from '../McpTogglePill';

/** Two CLI-configured servers + the un-grantable single-writer `cyboflow` entry. */
const CATALOGUE: McpEntry[] = [
  { name: 'peekaboo', transport: 'stdio', url: null, command: 'peekaboo', args: [], scope: 'global' },
  { name: 'playwright', transport: 'http', url: 'http://localhost', command: null, args: [], scope: 'global' },
  { name: 'cyboflow', transport: 'stdio', url: null, command: 'node', args: [], scope: 'global' },
];

beforeEach(() => {
  mockUpdate.mockReset().mockResolvedValue({ success: true });
  mockList.mockReset().mockResolvedValue(structuredClone(CATALOGUE));
});

describe('McpTogglePill', () => {
  it('shows the bare "MCP" label when nothing is disabled', async () => {
    render(<McpTogglePill sessionId="s1" disabled={[]} onChange={vi.fn()} />);
    expect(screen.getByText('MCP')).toBeInTheDocument();
    await waitFor(() => expect(mockList).toHaveBeenCalled()); // flush the catalogue fetch
  });

  it('shows the "N off" deny count', async () => {
    render(<McpTogglePill sessionId="s1" disabled={['peekaboo']} onChange={vi.fn()} />);
    expect(screen.getByText('MCP · 1 off')).toBeInTheDocument();
    await waitFor(() => expect(mockList).toHaveBeenCalled());
  });

  it('lists catalogue servers but never the single-writer cyboflow entry', async () => {
    render(<McpTogglePill sessionId="s1" disabled={[]} onChange={vi.fn()} />);
    fireEvent.click(screen.getByText('MCP'));
    expect(await screen.findByText('peekaboo')).toBeInTheDocument();
    expect(screen.getByText('playwright')).toBeInTheDocument();
    expect(screen.queryByText('cyboflow')).toBeNull();
  });

  it('DISABLES an enabled server by adding it to the deny set (persists the complement)', async () => {
    const onChange = vi.fn();
    render(<McpTogglePill sessionId="s1" disabled={[]} onChange={onChange} />);
    fireEvent.click(screen.getByText('MCP'));
    fireEvent.click(await screen.findByText('peekaboo'));
    await waitFor(() => expect(mockUpdate).toHaveBeenCalledWith('s1', ['peekaboo']));
    expect(onChange).toHaveBeenCalledWith(['peekaboo']);
  });

  it('RE-ENABLES a disabled server by removing it from the deny set', async () => {
    const onChange = vi.fn();
    render(<McpTogglePill sessionId="s1" disabled={['peekaboo']} onChange={onChange} />);
    fireEvent.click(screen.getByText('MCP · 1 off'));
    fireEvent.click(await screen.findByText('peekaboo'));
    await waitFor(() => expect(mockUpdate).toHaveBeenCalledWith('s1', []));
    expect(onChange).toHaveBeenCalledWith([]);
  });
});
