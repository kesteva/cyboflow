import { describe, it, expect } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { deriveChips } from '../../../../../shared/types/persistentAgents';
import { CapabilityChips } from '../CapabilityChips';
import { bridgeDescriptor, cmaDescriptor } from './fixtures';

const bridgeSnapshot = { descriptor: bridgeDescriptor, descriptorVersion: 1, observed: {} };
const cmaSnapshot = { descriptor: cmaDescriptor, descriptorVersion: 1, observed: {} };

function labels(): string[] {
  const root = screen.getByTestId('capability-chips');
  return Array.from(root.children).map((el) => el.textContent ?? '');
}

describe('CapabilityChips', () => {
  it('unconfirmed chips end with (not confirmed) and use the neutral style', () => {
    render(<CapabilityChips snapshot={bridgeSnapshot} transport="relay-mcp" vendor="openai-dots" />);
    const unconfirmed = deriveChips(bridgeSnapshot, { transport: 'relay-mcp', vendor: 'openai-dots' }).filter(
      (c) => c.unconfirmed,
    );
    expect(unconfirmed.length).toBeGreaterThan(0);
    for (const c of unconfirmed) {
      expect(c.label.endsWith('(not confirmed)')).toBe(true);
      expect(screen.getByText(c.label).className).toContain('text-text-tertiary');
    }
  });

  it('an observed round trip removes the suffix from the messaging chip and styles it as success', () => {
    const snap = { ...bridgeSnapshot, observed: { 'round-trip': '2026-10-07T10:00:00.000Z' as const } };
    render(<CapabilityChips snapshot={snap} transport="relay-mcp" vendor="openai-dots" />);
    const first = labels()[0];
    expect(first).toBe('Messages when the agent checks in');
    expect(screen.getByText(first).className).toContain('text-status-success');
  });

  it('renders the literal label column for a Claude Managed Agents connection', () => {
    render(<CapabilityChips snapshot={cmaSnapshot} transport={null} vendor="anthropic-cma" />);
    expect(labels()).toEqual([
      'Two-way messages (not confirmed)',
      'Links (not confirmed)',
      'Opens PRs via GitHub (not confirmed)',
      'Live activity (not confirmed)',
      'Cost & tokens (not confirmed)',
      'Stop (not confirmed)',
      'No attachments',
      'Structured briefs',
    ]);
  });

  it('renders the literal label column for a ChatGPT dot over relay-mcp', () => {
    render(<CapabilityChips snapshot={bridgeSnapshot} transport="relay-mcp" vendor="openai-dots" />);
    expect(labels()).toEqual([
      'Messages when the agent checks in (not confirmed)',
      'Links (not confirmed)',
      'Reports PRs (not confirmed)',
      'No live activity',
      'No cost data',
      'No remote stop · use ChatGPT',
      'No attachments',
      'Briefs as messages',
    ]);
  });

  it('renders the literal label column for Muse over relay-http', () => {
    render(<CapabilityChips snapshot={bridgeSnapshot} transport="relay-http" vendor="meta-muse" />);
    expect(labels()).toEqual([
      'Messages, best effort (not confirmed)',
      'Links (not confirmed)',
      'Reports PRs (not confirmed)',
      'No live activity',
      'No cost data',
      'No remote stop · use Muse',
      'No attachments',
      'Briefs as messages',
    ]);
  });

  it('no chip truncates and the container wraps', () => {
    render(<CapabilityChips snapshot={cmaSnapshot} />);
    const root = screen.getByTestId('capability-chips');
    expect(root.className).toContain('flex-wrap');
    for (const chip of within(root).getAllByText(/./)) {
      expect(chip.className).not.toContain('truncate');
    }
  });

  it('renders deriveChips labels verbatim (the suffix comes from the shared function)', () => {
    render(<CapabilityChips snapshot={cmaSnapshot} transport={null} vendor="anthropic-cma" />);
    const expected = deriveChips(cmaSnapshot, { transport: null, vendor: 'anthropic-cma' }).map((c) => c.label);
    expect(labels()).toEqual(expected);
    expect(labels().some((l) => l.includes('(not confirmed) (not confirmed)'))).toBe(false);
  });
});
