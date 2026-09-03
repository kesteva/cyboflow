/**
 * Behavioral tests for the window-state geometry helpers
 * (main/src/utils/windowState.ts) — pure functions, no electron import, no
 * mocks. Every rejection path of sanitizeWindowState, the clamp/ceiling/center
 * math of the geometry helpers, and the fs round-trip incl. its failure modes
 * (missing file, corrupt JSON, wrong shape) read as first-run defaults, never
 * a crash. The BrowserWindow persistence controller is driven through a fake
 * window (EventEmitter + state flags) under fake timers, so the debounce,
 * close flush, and the normal-vs-maximized-vs-fullscreen bookkeeping are
 * exercised without electron.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { EventEmitter } from 'events';

import {
  MIN_WINDOW_HEIGHT,
  MIN_WINDOW_WIDTH,
  WINDOW_STATE_SAVE_DEBOUNCE_MS,
  attachWindowStatePersistence,
  clampWindowBounds,
  defaultWindowBounds,
  loadWindowState,
  saveWindowState,
  sanitizeWindowState,
  windowStateFilePath,
  type PersistableWindow,
  type SavedWindowState,
  type WindowRect,
} from '../windowState';

const WORK_AREA: WindowRect = { x: 0, y: 0, width: 1920, height: 1080 };

/** The MIN_VISIBLE_PX invariant from clampWindowBounds: at least 120px of the
 * window must overlap the work area on every edge. */
function clampedIsVisible(b: WindowRect, area: WindowRect = WORK_AREA): boolean {
  const overlapX = Math.min(b.x + b.width, area.x + area.width) - Math.max(b.x, area.x);
  const overlapY = Math.min(b.y + b.height, area.y + area.height) - Math.max(b.y, area.y);
  return overlapX >= 120 && overlapY >= 120;
}

describe('sanitizeWindowState', () => {
  it('accepts a valid state, preserving every field', () => {
    const raw = {
      bounds: { x: -1920, y: 0, width: 1400, height: 900 },
      maximized: true,
    };
    expect(sanitizeWindowState(raw)).toEqual({
      bounds: { x: -1920, y: 0, width: 1400, height: 900 },
      maximized: true,
    });
  });

  it('rounds non-integer fields to integers', () => {
    const r = sanitizeWindowState({
      bounds: { x: 10.4, y: -20.6, width: 800.4, height: 600.5 },
      maximized: false,
    });
    expect(r).toEqual({ bounds: { x: 10, y: -21, width: 800, height: 601 }, maximized: false });
  });

  it.each([
    ['not an object', 'nope'],
    ['a bare number', 42],
    ['null', null],
    ['undefined', undefined],
    ['an array (no usable bounds)', [1, 2, 3]],
    ['missing bounds', { maximized: false }],
    ['null bounds', { bounds: null }],
    ['bounds not an object', { bounds: '1400x900' }],
  ])('rejects %s', (_name, raw) => {
    expect(sanitizeWindowState(raw)).toBeNull();
  });

  it.each(['x', 'y', 'width', 'height'] as const)('rejects non-finite bounds.%s', (field) => {
    for (const bad of [NaN, Infinity]) {
      const bounds: Record<string, number> = { x: 0, y: 0, width: 1400, height: 900 };
      bounds[field] = bad;
      expect(sanitizeWindowState({ bounds })).toBeNull();
    }
  });

  it.each(['x', 'y', 'width', 'height'] as const)('rejects a string in bounds.%s', (field) => {
    const bounds: Record<string, unknown> = { x: 0, y: 0, width: 1400, height: 900 };
    bounds[field] = '100';
    expect(sanitizeWindowState({ bounds })).toBeNull();
  });

  it('rejects a sliver rect (width or height below 200) and accepts exactly 200', () => {
    expect(sanitizeWindowState({ bounds: { x: 0, y: 0, width: 199, height: 600 } })).toBeNull();
    expect(sanitizeWindowState({ bounds: { x: 0, y: 0, width: 800, height: 199 } })).toBeNull();
    expect(sanitizeWindowState({ bounds: { x: 0, y: 0, width: 200, height: 200 }, maximized: false })).not.toBeNull();
  });

  it('rejects absurd dimensions (corruption, not a real display)', () => {
    expect(
      sanitizeWindowState({ bounds: { x: 0, y: 0, width: 1_000_000, height: 600 } }),
    ).toBeNull();
  });

  it('rejects absurd coordinates but accepts the 100000 boundary', () => {
    expect(sanitizeWindowState({ bounds: { x: 100_001, y: 0, width: 800, height: 600 } })).toBeNull();
    expect(sanitizeWindowState({ bounds: { x: 0, y: -100_001, width: 800, height: 600 } })).toBeNull();
    const ok = sanitizeWindowState({
      bounds: { x: 100_000, y: -100_000, width: 800, height: 600 },
      maximized: false,
    });
    expect(ok?.bounds).toEqual({ x: 100_000, y: -100_000, width: 800, height: 600 });
  });

  it('rejects a non-boolean maximized (garbage file = first run, bounds included)', () => {
    const bounds = { x: 0, y: 0, width: 800, height: 600 };
    expect(sanitizeWindowState({ bounds, maximized: 'yes' })).toBeNull();
    expect(sanitizeWindowState({ bounds, maximized: 1 })).toBeNull();
    expect(sanitizeWindowState({ bounds })).toBeNull();
    expect(sanitizeWindowState({ bounds, maximized: false })?.maximized).toBe(false);
  });
});

describe('defaultWindowBounds', () => {
  it('sizes 80% of a large work area, clamped to the 1600×1000 ceiling, centered', () => {
    // 3440×1440 display → 2752×1152 wanted, clamped to 1600×1000.
    const b = defaultWindowBounds({ x: 0, y: 0, width: 3440, height: 1440 });
    expect(b).toEqual({ x: 920, y: 220, width: 1600, height: 1000 });
  });

  it('stays inside a 1366×768 laptop work area (80% figure, minimum height)', () => {
    const b = defaultWindowBounds({ x: 0, y: 0, width: 1366, height: 728 });
    expect(b.width).toBe(1093); // round(1366 * 0.8)
    expect(b.height).toBe(640); // 728 * 0.8 = 582 → lifted to the minimum
    expect(b.x).toBe(137); // centered: round((1366 - 1093) / 2)
    expect(b.y).toBe(44);
    // Fully inside the work area.
    expect(b.x).toBeGreaterThanOrEqual(0);
    expect(b.y).toBeGreaterThanOrEqual(0);
    expect(b.x + b.width).toBeLessThanOrEqual(1366);
    expect(b.y + b.height).toBeLessThanOrEqual(728);
  });

  it('honors the 960×640 minimum on a tiny work area (still centered)', () => {
    const b = defaultWindowBounds({ x: 0, y: 0, width: 800, height: 500 });
    expect(b.width).toBe(MIN_WINDOW_WIDTH);
    expect(b.height).toBe(MIN_WINDOW_HEIGHT);
    expect(b.x).toBe(Math.round((800 - MIN_WINDOW_WIDTH) / 2));
    expect(b.y).toBe(Math.round((500 - MIN_WINDOW_HEIGHT) / 2));
  });

  it('centers within an offset work area (secondary display)', () => {
    const area: WindowRect = { x: -1920, y: 600, width: 1920, height: 1080 };
    const b = defaultWindowBounds(area);
    // 80% = 1536×864 (inside the ceiling); centered on the area's origin.
    expect(b).toEqual({ x: -1728, y: 708, width: 1536, height: 864 });
  });

});

describe('clampWindowBounds', () => {
  it('preserves already-valid input', () => {
    const bounds = { x: 100, y: 80, width: 1280, height: 800 };
    expect(clampWindowBounds(bounds, WORK_AREA)).toEqual(bounds);
  });

  it('shifts a window hanging off any edge back into the 120px visibility band', () => {
    const lt = clampWindowBounds({ x: -1500, y: -1400, width: 960, height: 640 }, WORK_AREA);
    expect(lt.x).toBe(-840);
    // y is floored at the work area's top rather than banded — see the
    // title-bar test below.
    expect(lt.y).toBe(0);
    expect(clampedIsVisible(lt)).toBe(true);
    const rb = clampWindowBounds({ x: 1900, y: 1070, width: 960, height: 640 }, WORK_AREA);
    expect(rb.x).toBe(WORK_AREA.width - 120);
    expect(rb.y).toBe(WORK_AREA.height - 120);
    expect(clampedIsVisible(rb)).toBe(true);
  });

  it('honors the 120px visibility band boundary: exactly 120px visible passes, 119 shifts', () => {
    // x = -840 → right edge at 120 → exactly MIN_VISIBLE_PX visible → preserved.
    expect(clampWindowBounds({ x: -840, y: 0, width: 960, height: 640 }, WORK_AREA).x).toBe(-840);
    // One pixel further out → shifted back to the band edge.
    expect(clampWindowBounds({ x: -841, y: 0, width: 960, height: 640 }, WORK_AREA).x).toBe(-840);
    // Right edge exactly at area-width - 120 → preserved; one further → shifted.
    expect(clampWindowBounds({ x: 1800, y: 0, width: 960, height: 640 }, WORK_AREA).x).toBe(1800);
    expect(clampWindowBounds({ x: 1801, y: 0, width: 960, height: 640 }, WORK_AREA).x).toBe(1800);
    // The bottom band applies on y too.
    expect(clampWindowBounds({ x: 0, y: 960, width: 960, height: 640 }, WORK_AREA).y).toBe(960);
    expect(clampWindowBounds({ x: 0, y: 961, width: 960, height: 640 }, WORK_AREA).y).toBe(960);
  });

  it('never places the title bar above the work area', () => {
    // A window whose top edge is off screen cannot be dragged back, so y is
    // floored at the work area's top instead of being banded like x. Reachable
    // whenever a saved position refers to a display that is no longer attached.
    expect(clampWindowBounds({ x: 0, y: -1, width: 960, height: 640 }, WORK_AREA).y).toBe(0);
    expect(clampWindowBounds({ x: 0, y: -520, width: 960, height: 640 }, WORK_AREA).y).toBe(0);
    expect(clampWindowBounds({ x: 0, y: -5000, width: 960, height: 640 }, WORK_AREA).y).toBe(0);

    // Same floor on a work area that does not start at the origin.
    const area: WindowRect = { x: -1920, y: -1080, width: 1920, height: 1080 };
    expect(clampWindowBounds({ x: -1000, y: -2000, width: 960, height: 640 }, area).y).toBe(-1080);
  });

  it('shrinks a window larger than the work area to fit it (ultrawide → laptop)', () => {
    const laptop: WindowRect = { x: 0, y: 25, width: 1440, height: 875 };
    const clamped = clampWindowBounds({ x: 300, y: 200, width: 3000, height: 1300 }, laptop);
    expect(clamped).toEqual({ x: 0, y: 25, width: 1440, height: 875 });
    expect(clampedIsVisible(clamped, laptop)).toBe(true);
  });

  it('pins to the origin when the work area is below the minimums (window stays at minimum)', () => {
    const tiny: WindowRect = { x: 0, y: 0, width: 800, height: 500 };
    const clamped = clampWindowBounds({ x: 300, y: 200, width: 2400, height: 1500 }, tiny);
    expect(clamped).toEqual({ x: 0, y: 0, width: MIN_WINDOW_WIDTH, height: MIN_WINDOW_HEIGHT });
  });

  it('raises undersized dimensions to the minimums', () => {
    const clamped = clampWindowBounds({ x: 0, y: 0, width: 500, height: 400 }, WORK_AREA);
    expect(clamped.width).toBe(MIN_WINDOW_WIDTH);
    expect(clamped.height).toBe(MIN_WINDOW_HEIGHT);
  });

  it('works against an offset (multi-monitor) work area', () => {
    const area: WindowRect = { x: -1920, y: -1080, width: 1920, height: 1080 };
    const clamped = clampWindowBounds({ x: 500, y: 500, width: 960, height: 640 }, area);
    expect(clamped.x).toBe(-1920 + 1920 - 120);
    expect(clamped.y).toBe(-1080 + 1080 - 120);
  });
});

// -- loadWindowState / saveWindowState (thin fs wrappers) ---------------------

describe('loadWindowState / saveWindowState', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'window-state-test-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('round-trips a saved state through the documented file name', () => {
    const state = { bounds: { x: -100, y: 20, width: 1400, height: 900 }, maximized: true };
    saveWindowState(dir, state);
    expect(fs.existsSync(windowStateFilePath(dir))).toBe(true);
    expect(loadWindowState(dir)).toEqual(state);
  });

  it('returns null for a missing file (first run)', () => {
    expect(loadWindowState(dir)).toBeNull();
  });

  it('returns null for corrupt JSON', () => {
    fs.writeFileSync(windowStateFilePath(dir), '{not json', 'utf8');
    expect(loadWindowState(dir)).toBeNull();
  });

  it('returns null for a wrong-shape blob', () => {
    fs.writeFileSync(windowStateFilePath(dir), JSON.stringify({ bounds: { width: 3 } }), 'utf8');
    expect(loadWindowState(dir)).toBeNull();
  });

  it('never throws when the target directory does not exist (log-and-continue)', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() =>
      saveWindowState(
        path.join(dir, 'missing'),
        { bounds: { x: 0, y: 0, width: 1000, height: 700 }, maximized: false },
      ),
    ).not.toThrow();
    expect(errSpy).toHaveBeenCalledTimes(1);
  });

  it('writes via a temp file + rename, leaving no temp file behind', () => {
    saveWindowState(dir, { bounds: { x: 0, y: 0, width: 1000, height: 700 }, maximized: false });
    expect(fs.readdirSync(dir)).toEqual(['window-state.json']);
  });

  it('keeps the previous state when the write fails (target is never truncated)', () => {
    const good = { bounds: { x: 1, y: 2, width: 1000, height: 700 }, maximized: false };
    saveWindowState(dir, good);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    // Occupy the temp path with a directory so the staged write fails.
    fs.mkdirSync(`${windowStateFilePath(dir)}.${process.pid}.tmp`);
    saveWindowState(dir, { bounds: { x: 9, y: 9, width: 1000, height: 700 }, maximized: true });
    expect(errSpy).toHaveBeenCalledTimes(1);
    expect(loadWindowState(dir)).toEqual(good);
  });
});

// -- attachWindowStatePersistence (BrowserWindow wiring, fake window) ---------

/** A BrowserWindow stand-in: an EventEmitter plus settable state flags. */
class FakeWindow extends EventEmitter implements PersistableWindow {
  bounds: WindowRect = { x: 100, y: 100, width: 1400, height: 900 };
  maximized = false;
  minimized = false;
  fullScreen = false;
  destroyed = false;
  isDestroyed(): boolean {
    return this.destroyed;
  }
  isMaximized(): boolean {
    return this.maximized;
  }
  isMinimized(): boolean {
    return this.minimized;
  }
  isFullScreen(): boolean {
    return this.fullScreen;
  }
  getBounds(): WindowRect {
    return { ...this.bounds };
  }
}

describe('attachWindowStatePersistence', () => {
  let dir: string;
  let win: FakeWindow;
  const INITIAL: SavedWindowState = {
    bounds: { x: 100, y: 100, width: 1400, height: 900 },
    maximized: false,
  };

  beforeEach(() => {
    vi.useFakeTimers();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'window-state-ctl-'));
    win = new FakeWindow();
  });

  afterEach(() => {
    vi.useRealTimers();
    fs.rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  function moveTo(x: number, y: number, width = win.bounds.width, height = win.bounds.height) {
    win.bounds = { x, y, width, height };
  }

  /** Snapshot of the state file: null when absent. */
  function fileState(): SavedWindowState | null {
    return loadWindowState(dir);
  }

  it('debounces a flood of resize/move into one write of the settled bounds', () => {
    attachWindowStatePersistence(win, dir, INITIAL);
    for (let i = 1; i <= 10; i++) {
      moveTo(100 + i, 100 + i, 1400 + i, 900 + i);
      win.emit('resize');
      vi.advanceTimersByTime(WINDOW_STATE_SAVE_DEBOUNCE_MS - 1);
    }
    expect(fileState()).toBeNull();
    vi.advanceTimersByTime(1);
    expect(fileState()).toEqual({
      bounds: { x: 110, y: 110, width: 1410, height: 910 },
      maximized: false,
    });
  });

  it('close flushes immediately, cancelling the pending timer', () => {
    attachWindowStatePersistence(win, dir, INITIAL);
    moveTo(50, 60);
    win.emit('move');
    win.emit('close');
    expect(fileState()?.bounds).toEqual({ x: 50, y: 60, width: 1400, height: 900 });
    // Had the timer survived, it would sample these post-close bounds.
    moveTo(1, 1);
    vi.advanceTimersByTime(WINDOW_STATE_SAVE_DEBOUNCE_MS * 2);
    expect(fileState()?.bounds).toEqual({ x: 50, y: 60, width: 1400, height: 900 });
  });

  it('a close before any resize/move writes the seeded (creation) bounds', () => {
    attachWindowStatePersistence(win, dir, { ...INITIAL, maximized: true });
    win.maximized = true;
    win.emit('close');
    expect(loadWindowState(dir)).toEqual({ ...INITIAL, maximized: true });
  });

  it('maximizing keeps the last NORMAL bounds and records maximized:true', () => {
    attachWindowStatePersistence(win, dir, INITIAL);
    moveTo(200, 150, 1500, 950);
    win.emit('move');
    vi.advanceTimersByTime(WINDOW_STATE_SAVE_DEBOUNCE_MS);
    // Maximize: the window now reports the full work area as its bounds.
    win.maximized = true;
    moveTo(0, 0, 2560, 1415);
    win.emit('resize');
    vi.advanceTimersByTime(WINDOW_STATE_SAVE_DEBOUNCE_MS);
    expect(loadWindowState(dir)).toEqual({
      bounds: { x: 200, y: 150, width: 1500, height: 950 },
      maximized: true,
    });
    // Un-maximize lands back on the normal rect and clears the flag.
    win.maximized = false;
    moveTo(200, 150, 1500, 950);
    win.emit('resize');
    vi.advanceTimersByTime(WINDOW_STATE_SAVE_DEBOUNCE_MS);
    expect(loadWindowState(dir)?.maximized).toBe(false);
  });

  it('macOS: a drag followed by fullscreen persists the DRAGGED bounds, not a stale frame', () => {
    // Regression for getNormalBounds() returning Electron's launch-time
    // original_frame_ on macOS — user drags never refresh it.
    attachWindowStatePersistence(win, dir, INITIAL);
    moveTo(400, 300, 1600, 1000);
    win.emit('move');
    vi.advanceTimersByTime(WINDOW_STATE_SAVE_DEBOUNCE_MS);
    // Green button: fullscreen fires a resize with the screen rect.
    win.fullScreen = true;
    moveTo(0, 0, 2560, 1440);
    win.emit('resize');
    vi.advanceTimersByTime(WINDOW_STATE_SAVE_DEBOUNCE_MS);
    // Cmd+Q from fullscreen.
    win.emit('close');
    expect(loadWindowState(dir)).toEqual({
      bounds: { x: 400, y: 300, width: 1600, height: 1000 },
      maximized: false,
    });
  });

  it('fullscreen never clobbers a maximized flag (quit from fullscreen reopens maximized)', () => {
    attachWindowStatePersistence(win, dir, INITIAL);
    win.maximized = true;
    moveTo(0, 0, 2560, 1415);
    win.emit('resize');
    vi.advanceTimersByTime(WINDOW_STATE_SAVE_DEBOUNCE_MS);
    win.maximized = false;
    win.fullScreen = true;
    moveTo(0, 0, 2560, 1440);
    win.emit('resize');
    win.emit('close');
    expect(loadWindowState(dir)).toEqual({ ...INITIAL, maximized: true });
  });

  it('Windows: closing while minimized-from-maximized still records maximized:true', () => {
    attachWindowStatePersistence(win, dir, INITIAL);
    win.maximized = true;
    win.emit('resize');
    vi.advanceTimersByTime(WINDOW_STATE_SAVE_DEBOUNCE_MS);
    // Minimized: Windows reports isMaximized()=false and a -32000 offscreen rect.
    win.maximized = false;
    win.minimized = true;
    moveTo(-32000, -32000, 160, 28);
    win.emit('resize');
    win.emit('close');
    expect(loadWindowState(dir)).toEqual({ ...INITIAL, maximized: true });
  });

  it('closed cancels a pending timer so nothing fires into a destroyed window', () => {
    attachWindowStatePersistence(win, dir, INITIAL);
    win.emit('move');
    win.emit('closed');
    win.destroyed = true;
    vi.advanceTimersByTime(WINDOW_STATE_SAVE_DEBOUNCE_MS * 2);
    expect(fileState()).toBeNull();
  });

  it('flush() writes now and is inert after dispose()', () => {
    const ctl = attachWindowStatePersistence(win, dir, INITIAL);
    moveTo(10, 20);
    ctl.flush();
    expect(fileState()?.bounds).toEqual({ x: 10, y: 20, width: 1400, height: 900 });
    ctl.dispose();
    moveTo(30, 40);
    win.emit('move');
    vi.advanceTimersByTime(WINDOW_STATE_SAVE_DEBOUNCE_MS);
    ctl.flush();
    expect(fileState()?.bounds).toEqual({ x: 10, y: 20, width: 1400, height: 900 });
  });
});
