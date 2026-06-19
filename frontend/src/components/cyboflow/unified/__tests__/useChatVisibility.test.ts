import { describe, it, expect } from 'vitest';
import {
  resolveChatVisibility,
  resolveChatStatus,
  type ChatVisibilityInput,
} from '../useChatVisibility';

/**
 * The visibility matrix is the core contract of the Unified Chat View — every
 * cell of (transport × mode × running × ptyOpen) is asserted here so the chrome
 * can never silently drift between the SDK and PTY surfaces.
 */

const make = (over: Partial<ChatVisibilityInput>): ChatVisibilityInput => ({
  transport: 'sdk',
  mode: 'quick',
  running: false,
  ptyOpen: false,
  ...over,
});

describe('resolveChatVisibility', () => {
  it('SDK · quick — full SDK chrome + rail', () => {
    const v = resolveChatVisibility(make({ transport: 'sdk', mode: 'quick' }));
    expect(v).toMatchObject({
      isSDK: true,
      isQuick: true,
      showRail: true,
      showCheckpoint: true,
      showSettings: true,
      showModelEffort: true,
      modelEffortDisabled: false,
      inputVisible: true,
      showSettingsToggles: true,
    });
  });

  it('SDK · flow — rail + checkpoint gone, settings/model stay', () => {
    const v = resolveChatVisibility(make({ transport: 'sdk', mode: 'flow' }));
    expect(v.showRail).toBe(false); // rail is quick-only
    expect(v.showCheckpoint).toBe(false); // checkpoint is quick-only
    expect(v.showSettings).toBe(true);
    expect(v.showModelEffort).toBe(true);
    expect(v.inputVisible).toBe(true); // SDK input always visible
  });

  it('SDK · flow · running — model/effort flagged disabled (design lock)', () => {
    const v = resolveChatVisibility(make({ transport: 'sdk', mode: 'flow', running: true }));
    expect(v.modelEffortDisabled).toBe(true);
    expect(v.showModelEffort).toBe(true); // disabled, not hidden
  });

  it('PTY · quick — composer hidden until ⌃G; no rail/settings', () => {
    const closed = resolveChatVisibility(make({ transport: 'interactive', mode: 'quick', ptyOpen: false }));
    expect(closed.isSDK).toBe(false);
    expect(closed.inputVisible).toBe(false); // hidden until ⌃G
    expect(closed.showSettings).toBe(false);
    expect(closed.showSettingsToggles).toBe(false);
    expect(closed.showModelEffort).toBe(false);
    expect(closed.showRail).toBe(false); // rail needs SDK
    expect(closed.showCheckpoint).toBe(true); // checkpoint is quick (any transport)

    const open = resolveChatVisibility(make({ transport: 'interactive', mode: 'quick', ptyOpen: true }));
    expect(open.inputVisible).toBe(true); // ⌃G revealed
  });

  it('PTY · flow — composer hidden until ⌃G; no rail/checkpoint/settings', () => {
    const closed = resolveChatVisibility(make({ transport: 'interactive', mode: 'flow', ptyOpen: false }));
    expect(closed.inputVisible).toBe(false);
    expect(closed.showRail).toBe(false);
    expect(closed.showCheckpoint).toBe(false); // flow, not quick
    expect(closed.showSettings).toBe(false);

    const open = resolveChatVisibility(make({ transport: 'interactive', mode: 'flow', ptyOpen: true }));
    expect(open.inputVisible).toBe(true);
  });

  it('ptyOpen never reveals/affects an SDK composer (always visible)', () => {
    const a = resolveChatVisibility(make({ transport: 'sdk', ptyOpen: false }));
    const b = resolveChatVisibility(make({ transport: 'sdk', ptyOpen: true }));
    expect(a.inputVisible).toBe(true);
    expect(b.inputVisible).toBe(true);
  });
});

describe('resolveChatStatus', () => {
  it('maps (mode, running) to the four pill states', () => {
    expect(resolveChatStatus({ mode: 'quick', running: false })).toBe('interactive');
    expect(resolveChatStatus({ mode: 'quick', running: true })).toBe('generating');
    expect(resolveChatStatus({ mode: 'flow', running: false })).toBe('paused');
    expect(resolveChatStatus({ mode: 'flow', running: true })).toBe('executing');
  });
});
