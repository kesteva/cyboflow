/**
 * Settings — "Shortcuts" tab round-trip. Bound to
 * config.keyboardShortcuts (sparse override map; shared/types/keyboardShortcuts.ts).
 * Verifies a loaded override renders its formatted binding, that recording a
 * new chord updates the row in place, and that Save carries the resulting map
 * into the batched API.config.update call.
 *
 * Two guard families are pinned here because both bind unintended keys:
 *   - the Record button's keydown handler must be INERT unless that row is
 *     actually recording, or Space/Enter (keyboard activation), Tab (focus
 *     move), and any keystroke after an Escape-cancel would be captured as the
 *     new binding;
 *   - a chord with no Cmd/Ctrl must not commit at all — it would make that
 *     character untypeable app-wide (the engine has no input guard).
 */
import '@testing-library/jest-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { Settings } from '../Settings';
import type { AppConfig } from '../../types/config';
import { formatKeybinding, KEYBOARD_SHORTCUT_DEFAULTS } from '../../../../shared/types/keyboardShortcuts';
import { getShortcutPlatform } from '../../utils/shortcutPlatform';
import { useKeyboardShortcutsStore } from '../../stores/keyboardShortcutsStore';

const configGet = vi.fn();
const configUpdate = vi.fn();
const getVersionInfo = vi.fn();
const projectsGetAll = vi.fn();

vi.mock('../../utils/api', () => ({
  API: {
    config: {
      get: (...a: unknown[]) => configGet(...a),
      update: (...a: unknown[]) => configUpdate(...a),
    },
    projects: {
      getAll: (...a: unknown[]) => projectsGetAll(...a),
    },
    getVersionInfo: (...a: unknown[]) => getVersionInfo(...a),
  },
}));

vi.mock('../../contexts/ThemeContext', () => ({
  useTheme: () => ({ theme: 'paper', setTheme: vi.fn() }),
}));

vi.mock('../../stores/configStore', () => ({
  useConfigStore: () => ({ fetchConfig: vi.fn().mockResolvedValue(undefined) }),
}));

// jsdom's default navigator does not report "Mac" (userAgent mentions
// jsdom/Node, platform is unset), so this resolves 'other' — asserted, not
// assumed, since the rendered/expected text below is built from it either way.
const platform = getShortcutPlatform();

function baseConfig(over: Partial<AppConfig> = {}): AppConfig {
  return {
    ...over,
  };
}

beforeEach(() => {
  configGet.mockReset().mockResolvedValue({ success: true, data: baseConfig() });
  configUpdate.mockReset().mockResolvedValue({ success: true });
  getVersionInfo.mockReset().mockResolvedValue({ success: true, data: { variant: 'dev' } });
  projectsGetAll.mockReset().mockResolvedValue({ success: true, data: [] });
  useKeyboardShortcutsStore.setState({ overrides: {}, hydrated: false });
});

describe('Settings — Keyboard shortcuts section', () => {
  it('renders every default binding, formatted, when no overrides are stored', async () => {
    render(<Settings isOpen onClose={vi.fn()} initialTab="shortcuts" />);
    const row = await screen.findByTestId('shortcut-record-newSession');
    expect(row).toHaveTextContent(formatKeybinding(KEYBOARD_SHORTCUT_DEFAULTS.newSession, platform));
  });

  it('renders a loaded override as its formatted binding, not the default', async () => {
    configGet.mockResolvedValue({
      success: true,
      data: baseConfig({ keyboardShortcuts: { toggleBacklog: 'mod+shift+l' } }),
    });
    render(<Settings isOpen onClose={vi.fn()} initialTab="shortcuts" />);

    const row = await screen.findByTestId('shortcut-record-toggleBacklog');
    expect(row).toHaveTextContent(formatKeybinding('mod+shift+l', platform));
    expect(row).not.toHaveTextContent(formatKeybinding(KEYBOARD_SHORTCUT_DEFAULTS.toggleBacklog, platform));
  });

  it('recording a new chord updates the row to the newly captured binding', async () => {
    render(<Settings isOpen onClose={vi.fn()} initialTab="shortcuts" />);
    const row = await screen.findByTestId('shortcut-record-newSession');
    expect(row).toHaveTextContent(formatKeybinding(KEYBOARD_SHORTCUT_DEFAULTS.newSession, platform));

    fireEvent.click(row);
    expect(row).toHaveTextContent('Press a key');

    // Capture mod+shift+p — the modifier that maps to 'mod' depends on platform.
    fireEvent.keyDown(row, {
      key: 'p',
      metaKey: platform === 'mac',
      ctrlKey: platform !== 'mac',
      shiftKey: true,
    });

    expect(row).toHaveTextContent(formatKeybinding('mod+shift+p', platform));
    expect(row).not.toHaveTextContent('Press a key');
  });

  it('a bare modifier keypress does not commit a binding; Escape cancels recording', async () => {
    render(<Settings isOpen onClose={vi.fn()} initialTab="shortcuts" />);
    const row = await screen.findByTestId('shortcut-record-newSession');

    fireEvent.click(row);
    expect(row).toHaveTextContent('Press a key');

    fireEvent.keyDown(row, { key: 'Meta', metaKey: true });
    expect(row).toHaveTextContent('Press a key');

    fireEvent.keyDown(row, { key: 'Escape' });
    expect(row).toHaveTextContent(formatKeybinding(KEYBOARD_SHORTCUT_DEFAULTS.newSession, platform));
  });

  it('a keydown on a Record button that is NOT recording changes nothing', async () => {
    render(<Settings isOpen onClose={vi.fn()} initialTab="shortcuts" />);
    const row = await screen.findByTestId('shortcut-record-newSession');
    const original = formatKeybinding(KEYBOARD_SHORTCUT_DEFAULTS.newSession, platform);
    expect(row).toHaveTextContent(original);

    configUpdate.mockClear();

    // Space / Enter are how a keyboard user ACTIVATES the button; Tab moves
    // focus off it. None of them may be captured as a binding, and none may be
    // preventDefault'd (that is what would trap focus on the button).
    for (const key of [' ', 'Enter', 'Tab', 'b']) {
      const event = fireEvent.keyDown(row, { key, cancelable: true, bubbles: true });
      expect(event).toBe(true); // fireEvent returns false only when preventDefault ran
      expect(row).toHaveTextContent(original);
    }

    expect(row).not.toHaveTextContent('Press a key');
    expect(configUpdate).not.toHaveBeenCalled();
  });

  it('a keystroke after an Escape-cancel is not captured as the new binding', async () => {
    render(<Settings isOpen onClose={vi.fn()} initialTab="shortcuts" />);
    const row = await screen.findByTestId('shortcut-record-newSession');
    const original = formatKeybinding(KEYBOARD_SHORTCUT_DEFAULTS.newSession, platform);

    fireEvent.click(row);
    expect(row).toHaveTextContent('Press a key');

    fireEvent.keyDown(row, { key: 'Escape' });
    expect(row).toHaveTextContent(original);

    // Tab-out after the cancel: recording is over, so this is an ordinary
    // keystroke on a focused button — it must not bind 'tab', must not be
    // preventDefault'd (that would trap focus on the button), and must not put
    // the row back into any capture state.
    const notPrevented = fireEvent.keyDown(row, { key: 'Tab', cancelable: true, bubbles: true });
    expect(notPrevented).toBe(true);
    expect(row).toHaveTextContent(original);
    expect(row).not.toHaveTextContent(/press a key|needs/i);

    fireEvent.click(screen.getByRole('button', { name: /save/i }));
    await waitFor(() =>
      expect(configUpdate).toHaveBeenCalledWith(expect.objectContaining({ keyboardShortcuts: {} })),
    );
  });

  it('a chord with no Cmd/Ctrl is refused: nothing commits and recording continues', async () => {
    render(<Settings isOpen onClose={vi.fn()} initialTab="shortcuts" />);
    const row = await screen.findByTestId('shortcut-record-newSession');

    fireEvent.click(row);

    // Bare letter — would make 'b' untypeable app-wide.
    fireEvent.keyDown(row, { key: 'b' });
    expect(row).toHaveTextContent(/needs/i);
    expect(row).not.toHaveTextContent(formatKeybinding('b', platform));

    // Shift-only is just typing a capital B; alt-only composes glyphs on mac.
    fireEvent.keyDown(row, { key: 'b', shiftKey: true });
    expect(row).toHaveTextContent(/needs/i);
    fireEvent.keyDown(row, { key: 'b', altKey: true });
    expect(row).toHaveTextContent(/needs/i);

    // Still recording — a real chord lands normally right after.
    fireEvent.keyDown(row, {
      key: 'b',
      metaKey: platform === 'mac',
      ctrlKey: platform !== 'mac',
    });
    expect(row).toHaveTextContent(formatKeybinding('mod+b', platform));

    fireEvent.click(screen.getByRole('button', { name: /save/i }));
    await waitFor(() =>
      expect(configUpdate).toHaveBeenCalledWith(
        expect.objectContaining({ keyboardShortcuts: { newSession: 'mod+b' } }),
      ),
    );
  });

  it('saving carries the recorded overrides into API.config.update and pushes them into the live store', async () => {
    render(<Settings isOpen onClose={vi.fn()} initialTab="shortcuts" />);
    const row = await screen.findByTestId('shortcut-record-newSession');

    fireEvent.click(row);
    fireEvent.keyDown(row, {
      key: 'p',
      metaKey: platform === 'mac',
      ctrlKey: platform !== 'mac',
      shiftKey: true,
    });
    expect(row).toHaveTextContent(formatKeybinding('mod+shift+p', platform));

    fireEvent.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() =>
      expect(configUpdate).toHaveBeenCalledWith(
        expect.objectContaining({ keyboardShortcuts: { newSession: 'mod+shift+p' } }),
      ),
    );
    expect(useKeyboardShortcutsStore.getState().overrides).toEqual({ newSession: 'mod+shift+p' });
  });

  it('recording a chord equal to the default drops any existing override for that action', async () => {
    configGet.mockResolvedValue({
      success: true,
      data: baseConfig({ keyboardShortcuts: { newSession: 'mod+shift+n' } }),
    });
    render(<Settings isOpen onClose={vi.fn()} initialTab="shortcuts" />);
    const row = await screen.findByTestId('shortcut-record-newSession');
    expect(row).toHaveTextContent(formatKeybinding('mod+shift+n', platform));

    fireEvent.click(row);
    fireEvent.keyDown(row, {
      key: 'n',
      metaKey: platform === 'mac',
      ctrlKey: platform !== 'mac',
    });
    expect(row).toHaveTextContent(formatKeybinding(KEYBOARD_SHORTCUT_DEFAULTS.newSession, platform));

    fireEvent.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() =>
      expect(configUpdate).toHaveBeenCalledWith(expect.objectContaining({ keyboardShortcuts: {} })),
    );
  });
});
