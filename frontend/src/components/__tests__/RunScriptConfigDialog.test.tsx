/**
 * RunScriptConfigDialog — the informational "no run script configured" prompt.
 *
 * NOTE (deviation from the B10 spec's "save calls update+closes" wording): this
 * component is a purely informational dialog, not a script editor. It has no
 * save/update mutation — its only action is "Open Project Settings" (close then
 * hand off) plus Close/X. Tests pin the ACTUAL behavior.
 */
import '@testing-library/jest-dom';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { RunScriptConfigDialog } from '../RunScriptConfigDialog';

describe('RunScriptConfigDialog', () => {
  it('renders nothing when closed', () => {
    const { container } = render(
      <RunScriptConfigDialog isOpen={false} onClose={vi.fn()} onOpenSettings={vi.fn()} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('"Open Project Settings" closes first, then hands off to onOpenSettings', () => {
    const calls: string[] = [];
    const onClose = vi.fn(() => calls.push('close'));
    const onOpenSettings = vi.fn(() => calls.push('settings'));
    render(<RunScriptConfigDialog isOpen onClose={onClose} onOpenSettings={onOpenSettings} />);
    fireEvent.click(screen.getByRole('button', { name: /open project settings/i }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
    // Ordering: dialog closes before the settings surface opens.
    expect(calls).toEqual(['close', 'settings']);
  });

  it('Close button dismisses via onClose without touching onOpenSettings', () => {
    const onClose = vi.fn();
    const onOpenSettings = vi.fn();
    render(<RunScriptConfigDialog isOpen onClose={onClose} onOpenSettings={onOpenSettings} />);
    fireEvent.click(screen.getByRole('button', { name: /^close$/i }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onOpenSettings).not.toHaveBeenCalled();
  });

  it('omits the settings CTA entirely when onOpenSettings is not supplied', () => {
    render(<RunScriptConfigDialog isOpen onClose={vi.fn()} />);
    expect(screen.queryByRole('button', { name: /open project settings/i })).toBeNull();
  });
});
