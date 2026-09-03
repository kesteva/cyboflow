/**
 * windowState — persist the main window's bounds across launches, with a
 * display-aware first-run default. A fixed, unpersisted size forgets every
 * manual resize, cramps the fixed-width UI columns on large monitors, and can
 * overflow the work area on small or scaled displays.
 *
 * The bounds live in a JSON file under the per-kind data dir
 * (`<getCyboflowDirectory()>/electron/window-state.json`, passed in by index.ts
 * — never resolved here) — deliberately NOT localStorage: the window is created
 * by the main process before any renderer exists. Nothing here imports
 * electron: the geometry math takes plain rects and the persistence controller
 * takes a structural slice of BrowserWindow, so both stay testable in host-Node
 * vitest.
 */
import * as fs from 'fs';
import * as path from 'path';

/** A pixel rectangle, structurally Electron's `Rectangle`. */
export interface WindowRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SavedWindowState {
  bounds: WindowRect;
  maximized: boolean;
}

/** Floor for a restored window — small enough for a 1280×720 netbook work area. */
export const MIN_WINDOW_WIDTH = 960;
export const MIN_WINDOW_HEIGHT = 640;

/** First-run size: clamped proportions of the work area (see defaultWindowBounds). */
export const FIRST_RUN_MAX_WIDTH = 1600;
export const FIRST_RUN_MAX_HEIGHT = 1000;

/** How much of a restored window must overlap the work area to count as on-screen. */
const MIN_VISIBLE_PX = 120;

/**
 * Validation floor for a SAVED width/height — below this the file is corrupt
 * (first-run display sizing does a better job than trusting a sliver rect).
 * Distinct from MIN_WINDOW_WIDTH/HEIGHT, which are the restore-time clamp.
 */
const MIN_SANE_DIMENSION = 200;
/** A saved dimension beyond this is corruption, not a real window. */
const MAX_SANE_DIMENSION = 100_000;
/**
 * Coordinates may be negative (multi-monitor layouts place displays left of /
 * above the origin), but beyond this magnitude the file is corrupt, not a real
 * display position.
 */
const MAX_SANE_COORDINATE = 100_000;

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isSaneDimension(value: unknown): boolean {
  return isFiniteNumber(value) && value >= MIN_SANE_DIMENSION && value <= MAX_SANE_DIMENSION;
}

function isSaneCoordinate(value: unknown): boolean {
  return isFiniteNumber(value) && Math.abs(value) <= MAX_SANE_COORDINATE;
}

function isSaneRect(value: unknown): value is WindowRect {
  if (typeof value !== 'object' || value === null) return false;
  const r = value as Record<string, unknown>;
  return (
    isSaneDimension(r.width) &&
    isSaneDimension(r.height) &&
    isSaneCoordinate(r.x) &&
    isSaneCoordinate(r.y)
  );
}

/**
 * Validate a parsed JSON blob into a usable SavedWindowState, or null when
 * anything is off (wrong shape, non-finite numbers, sliver dims, absurd
 * coordinates, a non-boolean `maximized`). A null result means "treat as first
 * run", never a crash — and never a half-trusted file: a blob whose `maximized`
 * is garbage was not written by this code, so its bounds are not trusted either.
 */
export function sanitizeWindowState(raw: unknown): SavedWindowState | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const candidate = raw as { bounds?: unknown; maximized?: unknown };
  if (!isSaneRect(candidate.bounds)) return null;
  if (typeof candidate.maximized !== 'boolean') return null;
  return {
    bounds: {
      x: Math.round(candidate.bounds.x),
      y: Math.round(candidate.bounds.y),
      width: Math.round(candidate.bounds.width),
      height: Math.round(candidate.bounds.height),
    },
    maximized: candidate.maximized,
  };
}

/**
 * First-run sizing: 80% of the given work area clamped to
 * [MIN_WINDOW_WIDTH×MIN_WINDOW_HEIGHT, FIRST_RUN_MAX_WIDTH×FIRST_RUN_MAX_HEIGHT],
 * centered in that work area. On a 3440×1440 display that yields 1600×1000
 * (the clamp ceiling); on a 1366×768 laptop the 80% figure already fits and
 * the minimum keeps the window usable.
 */
export function defaultWindowBounds(workArea: WindowRect): WindowRect {
  const width = Math.round(
    Math.min(FIRST_RUN_MAX_WIDTH, Math.max(MIN_WINDOW_WIDTH, workArea.width * 0.8)),
  );
  const height = Math.round(
    Math.min(FIRST_RUN_MAX_HEIGHT, Math.max(MIN_WINDOW_HEIGHT, workArea.height * 0.8)),
  );
  return {
    x: Math.round(workArea.x + (workArea.width - width) / 2),
    y: Math.round(workArea.y + (workArea.height - height) / 2),
    width,
    height,
  };
}

/**
 * Force a window rect onto a work area: dimensions at least the minimums and
 * at most the work area (a 3000px-wide window saved on an ultrawide must not
 * come back with half of it past the edge of a laptop screen), and at least
 * MIN_VISIBLE_PX of the window overlapping the work area (shift x/y into
 * range). Only a work area smaller than the minimums leaves a window larger
 * than the area on an axis; it can't keep the visibility band on both edges,
 * so it is pinned to the work area's origin. Pure integer math — safe to feed
 * straight to BrowserWindow.
 *
 * The two axes are not symmetric. x may sit either side of the area, but a
 * negative y offset puts the title bar above the work area, and a window whose
 * title bar is off screen cannot be dragged back.
 */
export function clampWindowBounds(bounds: WindowRect, workArea: WindowRect): WindowRect {
  const width = Math.min(
    Math.max(MIN_WINDOW_WIDTH, Math.round(bounds.width)),
    Math.max(MIN_WINDOW_WIDTH, Math.round(workArea.width)),
  );
  const height = Math.min(
    Math.max(MIN_WINDOW_HEIGHT, Math.round(bounds.height)),
    Math.max(MIN_WINDOW_HEIGHT, Math.round(workArea.height)),
  );

  // Horizontal: keep at least MIN_VISIBLE_PX of the window past the area's
  // leading edge AND MIN_VISIBLE_PX short of its far edge. A window wider than
  // the area (only possible below the minimums) can't do both, and one exactly
  // as wide should sit flush — pin to the area's origin in both cases.
  const clampX = (pos: number, size: number, areaPos: number, areaSize: number): number => {
    if (size >= areaSize) return areaPos;
    const min = areaPos + MIN_VISIBLE_PX - size;
    const max = areaPos + areaSize - MIN_VISIBLE_PX;
    return Math.max(min, Math.min(Math.round(pos), max));
  };

  // Vertical: the far-edge band is the same, but the near edge is a floor at
  // the top of the work area, not a band.
  const clampY = (pos: number, size: number, areaPos: number, areaSize: number): number => {
    if (size >= areaSize) return areaPos;
    const max = areaPos + areaSize - MIN_VISIBLE_PX;
    return Math.max(areaPos, Math.min(Math.round(pos), max));
  };

  return {
    x: clampX(bounds.x, width, workArea.x, workArea.width),
    y: clampY(bounds.y, height, workArea.y, workArea.height),
    width,
    height,
  };
}

/** Where the state lives inside the directory index.ts hands over. */
export function windowStateFilePath(stateDir: string): string {
  return path.join(stateDir, 'window-state.json');
}

/**
 * Read + sanitize the persisted state. ANY failure — missing file (first run),
 * unreadable, invalid JSON, wrong shape — returns null, which the caller must
 * treat as "size for the display", never a crash.
 */
export function loadWindowState(stateDir: string): SavedWindowState | null {
  try {
    const raw = fs.readFileSync(windowStateFilePath(stateDir), 'utf8');
    return sanitizeWindowState(JSON.parse(raw));
  } catch {
    return null;
  }
}

/**
 * Persist the state. Best-effort: a read-only dir, full disk, or AV lock on
 * the file must never take the app down over a window rect — log and continue.
 * Written to a sibling temp file and renamed over the target so a crash
 * mid-write leaves the previous state intact rather than a truncated file
 * (which would read as first-run and lose the geometry). Synchronous on
 * purpose: it is a ~100-byte write at most once per debounce window, and the
 * `close` flush must land before the process goes away.
 */
export function saveWindowState(stateDir: string, state: SavedWindowState): void {
  const target = windowStateFilePath(stateDir);
  const tmp = `${target}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(state), 'utf8');
    fs.renameSync(tmp, target);
  } catch (err) {
    console.error('[windowState] failed to persist window state:', err);
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      // The temp file is already gone or unremovable; nothing else to clean.
    }
  }
}

// -- BrowserWindow persistence controller ------------------------------------

/**
 * The slice of BrowserWindow the controller reads. Structural so a test can
 * drive it with a plain EventEmitter-backed fake; index.ts passes the real
 * window.
 */
export interface PersistableWindow {
  on(event: 'resize' | 'move' | 'close' | 'closed', listener: () => void): unknown;
  isDestroyed(): boolean;
  isMaximized(): boolean;
  isMinimized(): boolean;
  isFullScreen(): boolean;
  getBounds(): WindowRect;
}

export interface WindowStatePersistence {
  /** Write the current state now, cancelling any pending debounced write. */
  flush(): void;
  /** Cancel any pending write and stop tracking (idempotent). */
  dispose(): void;
}

/** resize/move fire in a flood during interactive drags; coalesce them. */
export const WINDOW_STATE_SAVE_DEBOUNCE_MS = 500;

/**
 * Wire persistence onto a window: resize/move arm a debounced write, `close`
 * flushes immediately (a quick open→close still records the final geometry),
 * `closed` cancels whatever is pending so a timer never fires into a destroyed
 * window.
 *
 * What gets written is tracked here in JS, NOT read back from the window at
 * write time, because the window cannot be trusted to know its own normal
 * geometry on every platform:
 *
 * - macOS `getNormalBounds()` returns Electron's cached `original_frame_`,
 *   which a user drag or resize never refreshes — only the constructor,
 *   `setBounds`, and the API-driven maximize/fullscreen do. So a window the
 *   user dragged to a new spot and then sent fullscreen (green button) or
 *   zoomed (title-bar double-click) would persist its LAUNCH-time frame and
 *   come back there next run. The one thing the feature exists to remember,
 *   lost on the most common macOS interaction.
 * - Windows reports `isMaximized() === false` while minimized, so quitting a
 *   maximized window from the taskbar would record it as un-maximized.
 *
 * Hence: the normal bounds are sampled via `getBounds()` only while the window
 * is in its normal state (not maximized / fullscreen / minimized), the
 * maximized flag only while not fullscreen / minimized, and every write emits
 * the last such sample. Fullscreen is deliberately not persisted as a state —
 * a fullscreen quit reopens as the normal or maximized window it was before.
 */
export function attachWindowStatePersistence(
  win: PersistableWindow,
  stateDir: string,
  initial: SavedWindowState,
): WindowStatePersistence {
  let lastNormalBounds: WindowRect = initial.bounds;
  let lastMaximized = initial.maximized;
  let timer: NodeJS.Timeout | null = null;
  let disposed = false;

  const sample = (): void => {
    if (win.isDestroyed() || win.isFullScreen() || win.isMinimized()) return;
    lastMaximized = win.isMaximized();
    if (!lastMaximized) lastNormalBounds = win.getBounds();
  };
  const cancel = (): void => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };
  const persist = (): void => {
    if (disposed) return;
    sample();
    saveWindowState(stateDir, { bounds: lastNormalBounds, maximized: lastMaximized });
  };
  const schedule = (): void => {
    if (disposed) return;
    cancel();
    timer = setTimeout(() => {
      timer = null;
      persist();
    }, WINDOW_STATE_SAVE_DEBOUNCE_MS);
  };
  const dispose = (): void => {
    cancel();
    disposed = true;
  };

  win.on('resize', schedule);
  win.on('move', schedule);
  win.on('close', () => {
    cancel();
    persist();
  });
  win.on('closed', dispose);

  return {
    flush: () => {
      cancel();
      persist();
    },
    dispose,
  };
}
