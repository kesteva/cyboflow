/**
 * windowState — persist the main window's bounds across launches, with a
 * display-aware first-run default. A fixed, unpersisted size forgets every
 * manual resize, cramps the fixed-width UI columns on large monitors, and can
 * overflow the work area on small or scaled displays.
 *
 * The bounds live in a JSON file under userData — deliberately NOT localStorage:
 * the window is created by the main process before any renderer exists. The
 * geometry math is pure and unit-tested; nothing here imports electron —
 * index.ts hands the work area in as plain arguments, so the math stays
 * testable in host-Node vitest.
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
 * coordinates). A null result means "treat as first run", never a crash.
 */
export function sanitizeWindowState(raw: unknown): SavedWindowState | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const candidate = raw as { bounds?: unknown; maximized?: unknown };
  if (!isSaneRect(candidate.bounds)) return null;
  return {
    bounds: {
      x: Math.round(candidate.bounds.x),
      y: Math.round(candidate.bounds.y),
      width: Math.round(candidate.bounds.width),
      height: Math.round(candidate.bounds.height),
    },
    maximized: candidate.maximized === true,
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
 * Force a window rect onto a work area: dimensions at least the minimums, and
 * at least MIN_VISIBLE_PX of the window overlapping the work area at every
 * edge (shift x/y into range; a window larger than the work area on an axis
 * can't keep the visibility band on both edges, so it is pinned to the work
 * area's origin). Pure integer math — safe to feed straight to BrowserWindow.
 */
export function clampWindowBounds(bounds: WindowRect, workArea: WindowRect): WindowRect {
  const width = Math.max(MIN_WINDOW_WIDTH, Math.round(bounds.width));
  const height = Math.max(MIN_WINDOW_HEIGHT, Math.round(bounds.height));

  // One axis of the pin-and-band rule: keep at least MIN_VISIBLE_PX of the
  // window past the area's leading edge AND MIN_VISIBLE_PX short of its far
  // edge. A window larger than the area on this axis can't do both — pin to
  // the area's origin instead.
  const clampAxis = (pos: number, size: number, areaPos: number, areaSize: number): number => {
    if (size > areaSize) return areaPos;
    const min = areaPos + MIN_VISIBLE_PX - size;
    const max = areaPos + areaSize - MIN_VISIBLE_PX;
    return Math.max(min, Math.min(Math.round(pos), max));
  };

  return {
    x: clampAxis(bounds.x, width, workArea.x, workArea.width),
    y: clampAxis(bounds.y, height, workArea.y, workArea.height),
    width,
    height,
  };
}

/** Where the state lives inside a userData directory. */
export function windowStateFilePath(userDataDir: string): string {
  return path.join(userDataDir, 'window-state.json');
}

/**
 * Read + sanitize the persisted state. ANY failure — missing file (first run),
 * unreadable, invalid JSON, wrong shape — returns null, which the caller must
 * treat as "size for the display", never a crash.
 */
export function loadWindowState(userDataDir: string): SavedWindowState | null {
  try {
    const raw = fs.readFileSync(windowStateFilePath(userDataDir), 'utf8');
    return sanitizeWindowState(JSON.parse(raw));
  } catch {
    return null;
  }
}

/**
 * Persist the state. Best-effort: a read-only dir, full disk, or AV lock on
 * the file must never take the app down over a window rect — log and continue.
 * A small file, so a direct writeFileSync is atomic enough in practice.
 */
export function saveWindowState(userDataDir: string, state: SavedWindowState): void {
  try {
    fs.writeFileSync(windowStateFilePath(userDataDir), JSON.stringify(state), 'utf8');
  } catch (err) {
    console.error('[windowState] failed to persist window state:', err);
  }
}
