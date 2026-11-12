import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { PreflightChecklist, summarizeChecks } from '../PreflightChecklist';
import { makeCheck, makePreflight } from './fixtures';

describe('PreflightChecklist', () => {
  it('summarizes and starts collapsed', () => {
    const results = makePreflight().results;
    render(<PreflightChecklist hostId="h2" results={results} running={false} />);
    expect(screen.getByTestId('preflight-summary-h2')).toHaveTextContent('2 passed · 1 warning · 1 arrive later');
    expect(screen.queryByTestId('preflight-row-git')).toBeNull();
  });

  it('expands to one row per check with status glyphs and a copyable fix', () => {
    const results = makePreflight().results;
    render(<PreflightChecklist hostId="h2" results={results} running={false} />);
    fireEvent.click(screen.getByTestId('preflight-toggle-h2'));
    expect(screen.getAllByTestId(/^preflight-row-/)).toHaveLength(4);
    expect(screen.getByTestId('preflight-row-sleep-settings')).toHaveAttribute('data-status', 'warn');
    expect(screen.getByTestId('preflight-row-mcp-roundtrip')).toHaveAttribute('data-status', 'skipped');
    expect(screen.getByTestId('preflight-row-mcp-roundtrip')).toHaveTextContent('Arrives with remote flows');
    expect(screen.getByTestId('preflight-row-sleep-settings')).toHaveTextContent('sudo pmset -a sleep 0');
    expect(screen.getByTestId('preflight-copy-sleep-settings')).toBeInTheDocument();
    expect(screen.queryByTestId('preflight-copy-git')).toBeNull();
  });

  it('renders live rows while running, auto-expanded', () => {
    render(<PreflightChecklist hostId="h2" results={[makeCheck({ id: 'arch', label: 'Architecture' })]} running />);
    expect(screen.getByTestId('preflight-row-arch')).toBeInTheDocument();
    expect(screen.getByText('Checking…')).toBeInTheDocument();
  });

  it('running with nothing decided yet says Checking', () => {
    render(<PreflightChecklist hostId="h2" results={[]} running />);
    expect(screen.getByTestId('preflight-summary-h2')).toHaveTextContent('Checking…');
  });

  it('summarizeChecks leads with failures', () => {
    expect(summarizeChecks([makeCheck({ status: 'fail' }), makeCheck({ id: 'git' })])).toBe('1 failed · 1 passed');
    expect(summarizeChecks([])).toBe('No checks yet');
  });
});
