/**
 * deviceHierarchy — the parser for the UI-hierarchy text file Xcode 27's
 * `DeviceInteractionSynthesize` writes next to every capture
 * (docs/proposals/runbook-optional-verification.md §B0, §B4.5, §B4.6).
 *
 * THE FORMAT IS UNDOCUMENTED. What this module knows comes from two places,
 * both committed as evidence: real dumps captured on the B0 host
 * (`__tests__/fixtures/hierarchy-*.txt`) and the `device-interaction` skill
 * text compiled into `IDEDeviceInteraction.framework`. The shape is:
 *
 *   Device orientation: Unknown
 *   ------------------------
 *   Application bundle identifier: com.apple.Preferences
 *   Application UI orientation: Portrait
 *   Application, pid: 17785, label: 'Settings'
 *    Window, {{0.0, 0.0}, {402.0, 874.0}}, hitPoint: {201.0, 437.0}
 *     Button, {{16.0, 380.3}, {370.0, 52.0}}, identifier: 'com.apple.settings.general', label: 'General', hitPoint: {201.0, 406.3}
 *
 * One application BLOCK per app with windows on screen, separated by dashed
 * lines; one indented element line per accessibility element, where the
 * indent (one space per level) is the tree depth. When more than one app is on
 * screen, the skill says element lines of an app that must be activated first
 * carry an `activationBundleId: <id>` suffix.
 *
 * TOLERANCE IS THE CONTRACT. A line this parser does not recognise is counted
 * and skipped, never thrown on: the runner parses a fresh hierarchy after every
 * Synthesize, and a new attribute Apple adds next release must degrade to "one
 * attribute not read", not to a verb that cannot resolve any tap target.
 * Values are observed both QUOTED (`label: 'Apple Account, Sign in to …'`,
 * carrying commas) and BARE (`value: SSID, 3 of 3 Wi-Fi...`, also carrying
 * commas), so the attribute scanner splits on `, <key>:` boundaries, never on a
 * bare comma.
 *
 * PURE MODULE: no I/O. The runner reads the file at `hierarchyPath` and hands
 * the text in.
 */

/** A point in the hierarchy's coordinate space (points, not pixels). */
export interface HierarchyPoint {
  x: number;
  y: number;
}

/** An element's frame, `{{x, y}, {width, height}}` in the dump. */
export interface HierarchyFrame {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** One accessibility element line. */
export interface HierarchyElement {
  /** Position within its block, in dump order. */
  index: number;
  /** Tree depth: the element line's leading-space count (a top-level Window is 1). */
  depth: number;
  /** `index` of the nearest shallower element above this one, or `null` at the top. */
  parentIndex: number | null;
  /** The XCUI element type as printed: `Window`, `Button`, `StaticText`, `Other`, … */
  role: string;
  frame: HierarchyFrame;
  label?: string;
  identifier?: string;
  value?: string;
  placeholderValue?: string;
  /** The framework's own computed tap point — the skill says to prefer it over any estimate. */
  hitPoint?: HierarchyPoint;
  /** Present only when another app must be activated before this element can be driven. */
  activationBundleId?: string;
  /** Bare markers with no value, e.g. `isRemoteLeafPlaceholder`. */
  flags?: string[];
}

/** One `Application bundle identifier:` block. */
export interface ApplicationBlock {
  /** `null` only for a malformed block whose header line never arrived. */
  bundleId: string | null;
  /** From the `Application, pid: N, …` line; `null` when that line is missing or unreadable. */
  pid: number | null;
  label: string | null;
  /** `Application UI orientation:` — e.g. `Portrait`. */
  orientation: string | null;
  elements: HierarchyElement[];
}

export interface ParsedHierarchy {
  /** `Device orientation:` — observed as `Unknown` on a portrait simulator. */
  deviceOrientation: string | null;
  blocks: ApplicationBlock[];
  /** Non-blank lines no rule recognised. Diagnostics only; never an error. */
  unknownLineCount: number;
}

/** A tap target the resolver settled on. */
export interface ResolvedTapPoint {
  x: number;
  y: number;
  element: HierarchyElement;
  /** Carried over from the element: the caller must activate this app before tapping. */
  activationBundleId?: string;
}

/** Why a tap target could not be resolved to exactly one point. */
export type TapResolution =
  | ResolvedTapPoint
  | { ambiguous: HierarchyElement[] }
  | { none: string[] };

/** Bound on the candidate list a `none` resolution reports, so a verb's refusal stays readable. */
const MAX_NONE_CANDIDATES = 40;

const NUMBER = String.raw`[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?`;
const FRAME_LINE = new RegExp(
  String.raw`^( +)([^,{}]+?),?\s*\{\{\s*(${NUMBER})\s*,\s*(${NUMBER})\s*\}\s*,\s*\{\s*(${NUMBER})\s*,\s*(${NUMBER})\s*\}\s*\}(.*)$`,
);
const POINT_VALUE = new RegExp(String.raw`^\{\s*(${NUMBER})\s*,\s*(${NUMBER})\s*\}$`);
const SEPARATOR_LINE = /^-{3,}\s*$/;
const BUNDLE_HEADER = /^Application bundle identifier:\s*(.*?)\s*$/;
const ORIENTATION_HEADER = /^Application UI orientation:\s*(.*?)\s*$/;
const DEVICE_ORIENTATION = /^Device orientation:\s*(.*?)\s*$/;
const APPLICATION_LINE = /^Application,(.*)$/;
const ATTRIBUTE_KEY = /^([A-Za-z_][A-Za-z0-9_]*)(:[ \t]*)?/;
/** What may follow a closing quote for it to BE the closing quote: end, or `, <key>:` / `, <flag>`. */
const AFTER_CLOSING_QUOTE = /^\s*$|^,\s*[A-Za-z_][A-Za-z0-9_]*(?::|,|\s*$)/;

interface ScannedAttributes {
  values: Map<string, string>;
  flags: string[];
}

/**
 * Split the text after an element's frame into `key: value` pairs and bare
 * flags. First occurrence of a key wins (a duplicated key is not something the
 * dump has been seen to do, and first-wins keeps the choice deterministic).
 */
function scanAttributes(rest: string): ScannedAttributes {
  const values = new Map<string, string>();
  const flags: string[] = [];
  let i = 0;
  while (i < rest.length) {
    while (i < rest.length && (rest[i] === ',' || rest[i] === ' ' || rest[i] === '\t')) i += 1;
    if (i >= rest.length) break;
    const keyMatch = ATTRIBUTE_KEY.exec(rest.slice(i));
    if (keyMatch === null) {
      // Not a key: skip to the next `, ` boundary rather than giving up on the line.
      const next = rest.indexOf(', ', i);
      if (next < 0) break;
      i = next;
      continue;
    }
    const key = keyMatch[1] as string;
    i += keyMatch[0].length;
    if (keyMatch[2] === undefined) {
      // A bare marker (`isRemoteLeafPlaceholder`). Consume up to the next comma.
      if (!flags.includes(key)) flags.push(key);
      const next = rest.indexOf(',', i);
      i = next < 0 ? rest.length : next;
      continue;
    }

    let value: string;
    if (rest[i] === "'") {
      // Quoted: the closing quote is the first `'` followed by end-of-line or
      // by `, <key>` — so a label carrying an apostrophe ("Don't") or a comma
      // still reads whole.
      let search = i + 1;
      let close = -1;
      for (;;) {
        const q = rest.indexOf("'", search);
        if (q < 0) break;
        if (AFTER_CLOSING_QUOTE.test(rest.slice(q + 1))) {
          close = q;
          break;
        }
        search = q + 1;
      }
      if (close < 0) {
        value = rest.slice(i + 1);
        i = rest.length;
      } else {
        value = rest.slice(i + 1, close);
        i = close + 1;
      }
    } else if (rest[i] === '{') {
      const close = rest.indexOf('}', i);
      const end = close < 0 ? rest.length : close + 1;
      value = rest.slice(i, end);
      i = end;
    } else {
      // Bare: runs to the next `, <key>:` boundary, so `SSID, 3 of 3 Wi-Fi...`
      // stays one value.
      const boundary = /,\s*(?=[A-Za-z_][A-Za-z0-9_]*:\s)/g;
      boundary.lastIndex = i;
      const found = boundary.exec(rest);
      const end = found === null ? rest.length : found.index;
      value = rest.slice(i, end).trim();
      i = end;
    }
    if (!values.has(key)) values.set(key, value);
  }
  return { values, flags };
}

function parsePoint(raw: string | undefined): HierarchyPoint | undefined {
  if (raw === undefined) return undefined;
  const match = POINT_VALUE.exec(raw.trim());
  if (match === null) return undefined;
  const x = Number.parseFloat(match[1] as string);
  const y = Number.parseFloat(match[2] as string);
  return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : undefined;
}

function newBlock(bundleId: string | null): ApplicationBlock {
  return { bundleId, pid: null, label: null, orientation: null, elements: [] };
}

/**
 * Parse one hierarchy dump. Never throws; an empty or foreign text yields zero
 * blocks, which every helper below treats as "nothing on screen".
 */
export function parseDeviceHierarchy(text: string): ParsedHierarchy {
  const blocks: ApplicationBlock[] = [];
  let deviceOrientation: string | null = null;
  let unknownLineCount = 0;
  let current: ApplicationBlock | null = null;
  /** Depth → index of the latest element at that depth, for parentIndex. */
  let depthStack: Array<{ depth: number; index: number }> = [];

  const finish = (): void => {
    if (current !== null && (current.bundleId !== null || current.elements.length > 0)) {
      blocks.push(current);
    }
    current = null;
    depthStack = [];
  };
  const ensureBlock = (): ApplicationBlock => {
    if (current === null) current = newBlock(null);
    return current;
  };

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/\s+$/, '');
    if (line.length === 0) continue;

    const frameMatch = FRAME_LINE.exec(line);
    if (frameMatch !== null) {
      const block = ensureBlock();
      const depth = (frameMatch[1] as string).length;
      const frame: HierarchyFrame = {
        x: Number.parseFloat(frameMatch[3] as string),
        y: Number.parseFloat(frameMatch[4] as string),
        width: Number.parseFloat(frameMatch[5] as string),
        height: Number.parseFloat(frameMatch[6] as string),
      };
      if (![frame.x, frame.y, frame.width, frame.height].every(Number.isFinite)) {
        unknownLineCount += 1;
        continue;
      }
      const { values, flags } = scanAttributes(frameMatch[7] as string);
      while (depthStack.length > 0 && (depthStack[depthStack.length - 1] as { depth: number }).depth >= depth) {
        depthStack.pop();
      }
      const parent = depthStack[depthStack.length - 1];
      const element: HierarchyElement = {
        index: block.elements.length,
        depth,
        parentIndex: parent === undefined ? null : parent.index,
        role: (frameMatch[2] as string).trim(),
        frame,
      };
      const label = values.get('label');
      if (label !== undefined) element.label = label;
      const identifier = values.get('identifier');
      if (identifier !== undefined) element.identifier = identifier;
      const value = values.get('value');
      if (value !== undefined) element.value = value;
      const placeholder = values.get('placeholderValue');
      if (placeholder !== undefined) element.placeholderValue = placeholder;
      const hitPoint = parsePoint(values.get('hitPoint'));
      if (hitPoint !== undefined) element.hitPoint = hitPoint;
      const activation = values.get('activationBundleId')?.trim();
      if (activation !== undefined && activation.length > 0) element.activationBundleId = activation;
      if (flags.length > 0) element.flags = flags;
      block.elements.push(element);
      depthStack.push({ depth, index: element.index });
      continue;
    }

    if (SEPARATOR_LINE.test(line)) {
      finish();
      continue;
    }
    const bundle = BUNDLE_HEADER.exec(line);
    if (bundle !== null) {
      // A header always opens a fresh block, even without a separator before it.
      if (current !== null && (current as ApplicationBlock).bundleId !== null) finish();
      const block = ensureBlock();
      const id = (bundle[1] as string).trim();
      block.bundleId = id.length > 0 ? id : null;
      continue;
    }
    const orientation = ORIENTATION_HEADER.exec(line);
    if (orientation !== null) {
      ensureBlock().orientation = (orientation[1] as string) || null;
      continue;
    }
    const appLine = APPLICATION_LINE.exec(line);
    if (appLine !== null) {
      const { values } = scanAttributes(appLine[1] as string);
      const block = ensureBlock();
      const pid = Number.parseInt(values.get('pid') ?? '', 10);
      block.pid = Number.isInteger(pid) && pid > 0 ? pid : null;
      const label = values.get('label');
      block.label = label === undefined ? null : label;
      continue;
    }
    const device = DEVICE_ORIENTATION.exec(line);
    if (device !== null) {
      deviceOrientation = (device[1] as string) || null;
      continue;
    }
    unknownLineCount += 1;
  }
  finish();
  return { deviceOrientation, blocks, unknownLineCount };
}

/** The block for `bundleId`, or `null` — the pid-pinning read (§B4.6), whether or not it is foreground. */
export function blockFor(hierarchy: ParsedHierarchy, bundleId: string): ApplicationBlock | null {
  return hierarchy.blocks.find((block) => block.bundleId === bundleId) ?? null;
}

/**
 * Which app is in the foreground, or `null` when the dump does not say
 * unambiguously.
 *
 * One block ⇒ that app. Several ⇒ the skill's rule: an element that must be
 * activated before it can be driven carries `activationBundleId`, so the
 * foreground app is the ONE block none of whose elements carry the annotation.
 * Zero or several such blocks ⇒ `null`. The ledger (§B5) counts a capture as
 * pass evidence only when this equals the app under test, so an unreadable
 * answer must be `null`, never a guess.
 */
export function foregroundBundleId(hierarchy: ParsedHierarchy): string | null {
  const named = hierarchy.blocks.filter((block) => block.bundleId !== null);
  if (named.length === 0) return null;
  if (named.length === 1) return (named[0] as ApplicationBlock).bundleId;
  const active = named.filter((block) =>
    block.elements.every((element) => element.activationBundleId === undefined),
  );
  return active.length === 1 ? (active[0] as ApplicationBlock).bundleId : null;
}

/** The block for `bundleId` when that app is the foreground one (see {@link foregroundBundleId}), else `null`. */
export function foregroundBlock(hierarchy: ParsedHierarchy, bundleId: string): ApplicationBlock | null {
  return foregroundBundleId(hierarchy) === bundleId ? blockFor(hierarchy, bundleId) : null;
}

/**
 * Elements whose label OR identifier matches `textOrId`: exact matches first;
 * only when there are none, a case-insensitive, whitespace-trimmed match. The
 * two tiers never mix, so an exact `General` is never made ambiguous by an
 * unrelated `general`.
 */
export function findElements(block: ApplicationBlock, textOrId: string): HierarchyElement[] {
  // A blank target names nothing. The exact tier would otherwise match every
  // element whose label is itself blank (SpringBoard's labels are `' '`).
  if (textOrId.trim().length === 0) return [];
  const exact = block.elements.filter(
    (element) => element.label === textOrId || element.identifier === textOrId,
  );
  if (exact.length > 0) return exact;
  const needle = textOrId.trim().toLowerCase();
  return block.elements.filter(
    (element) =>
      element.label?.trim().toLowerCase() === needle || element.identifier?.trim().toLowerCase() === needle,
  );
}

function isAncestor(block: ApplicationBlock, ancestor: HierarchyElement, element: HierarchyElement): boolean {
  let parent = element.parentIndex;
  while (parent !== null) {
    if (parent === ancestor.index) return true;
    parent = block.elements[parent]?.parentIndex ?? null;
  }
  return false;
}

/**
 * Resolve a `mobile-tap <text-or-id>` target to exactly one point, from a
 * hierarchy captured immediately before the tap (§B4.5).
 *
 * Two collapses run before "ambiguous" is declared, both because they are the
 * SAME control on screen, not two choices:
 *  - a candidate that has a matching DESCENDANT candidate is dropped in favour
 *    of the deepest one (`Button 'General'` wraps `StaticText 'General'`; the
 *    inner point lies inside the button, so tapping it taps both);
 *  - candidates at an IDENTICAL hitPoint are one (the dump has been seen to
 *    list a `Button 'Dictate'` twice at the same frame).
 *
 * Anything still plural is `ambiguous` and the verb refuses — guessing between
 * two distinct on-screen controls is how a verification "passes" by tapping
 * the wrong one. Candidates without a hitPoint cannot be tapped and are
 * ignored; `none` lists the block's tappable labels/identifiers so the refusal
 * can tell the agent what IS on screen.
 */
export function resolveTap(block: ApplicationBlock, textOrId: string): TapResolution {
  const matches = findElements(block, textOrId).filter((element) => element.hitPoint !== undefined);
  if (matches.length === 0) return { none: tappableNames(block) };

  const deepest = matches.filter(
    (candidate) => !matches.some((other) => other !== candidate && isAncestor(block, candidate, other)),
  );
  const distinct: HierarchyElement[] = [];
  for (const candidate of deepest) {
    const point = candidate.hitPoint as HierarchyPoint;
    const duplicate = distinct.some((kept) => {
      const keptPoint = kept.hitPoint as HierarchyPoint;
      return keptPoint.x === point.x && keptPoint.y === point.y;
    });
    if (!duplicate) distinct.push(candidate);
  }
  if (distinct.length !== 1) return { ambiguous: distinct };

  const element = distinct[0] as HierarchyElement;
  const point = element.hitPoint as HierarchyPoint;
  const resolved: ResolvedTapPoint = { x: point.x, y: point.y, element };
  if (element.activationBundleId !== undefined) resolved.activationBundleId = element.activationBundleId;
  return resolved;
}

/** Distinct labels and identifiers of elements that carry a hitPoint, in dump order, bounded. */
function tappableNames(block: ApplicationBlock): string[] {
  const names: string[] = [];
  for (const element of block.elements) {
    if (element.hitPoint === undefined) continue;
    for (const name of [element.label, element.identifier]) {
      if (name === undefined || name.trim().length === 0 || names.includes(name)) continue;
      names.push(name);
      if (names.length >= MAX_NONE_CANDIDATES) return names;
    }
  }
  return names;
}

/**
 * The app's window frame, for mapping `mobile-swipe <dir>` onto coordinates:
 * the largest top-level `Window` (SpringBoard lists several, one of them a
 * 134×291 sliver), else the largest element of all, else `null` for an empty
 * block.
 */
export function windowFrame(block: ApplicationBlock): HierarchyFrame | null {
  const area = (frame: HierarchyFrame): number => frame.width * frame.height;
  const pickLargest = (elements: HierarchyElement[]): HierarchyFrame | null => {
    let best: HierarchyFrame | null = null;
    for (const element of elements) {
      if (best === null || area(element.frame) > area(best)) best = element.frame;
    }
    return best;
  };
  const windows = block.elements.filter((element) => element.role === 'Window' && element.parentIndex === null);
  return pickLargest(windows) ?? pickLargest(block.elements);
}

/** A swipe direction in the engine-neutral meaning `mobile-swipe` already has: the way the FINGER moves. */
export type HierarchySwipeDirection = 'up' | 'down' | 'left' | 'right';

/**
 * Start and end points for a swipe in `direction` across `frame`: through the
 * centre, from 70 % to 30 % of the span along the axis (and back for the
 * opposite direction), so neither end lands on a screen-edge system gesture
 * zone. `up` moves the finger upward, revealing content below — the same
 * meaning the Maestro rung gives `mobile-swipe up`, so a verb means one thing
 * on every engine.
 */
export function swipePoints(
  frame: HierarchyFrame,
  direction: HierarchySwipeDirection,
): { from: HierarchyPoint; to: HierarchyPoint } {
  const round = (n: number): number => Math.round(n * 10) / 10;
  const cx = round(frame.x + frame.width / 2);
  const cy = round(frame.y + frame.height / 2);
  const near = (origin: number, span: number): number => round(origin + span * 0.3);
  const far = (origin: number, span: number): number => round(origin + span * 0.7);
  switch (direction) {
    case 'up':
      return { from: { x: cx, y: far(frame.y, frame.height) }, to: { x: cx, y: near(frame.y, frame.height) } };
    case 'down':
      return { from: { x: cx, y: near(frame.y, frame.height) }, to: { x: cx, y: far(frame.y, frame.height) } };
    case 'left':
      return { from: { x: far(frame.x, frame.width), y: cy }, to: { x: near(frame.x, frame.width), y: cy } };
    case 'right':
      return { from: { x: near(frame.x, frame.width), y: cy }, to: { x: far(frame.x, frame.width), y: cy } };
  }
}
