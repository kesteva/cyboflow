/**
 * deviceHierarchy unit tests, against REAL dumps captured on the B0 host
 * (Xcode 27.0, iOS 27.0 simulator, 2026-09-24) — the format is undocumented, so
 * the fixtures are the specification:
 *  - `hierarchy-settings.txt`: the Settings root list, captured through a
 *    non-workspace `DeviceInteractionStartSession` + Synthesize with
 *    `activationBundleId: com.apple.Preferences`. Carries quoted labels with
 *    commas, bare `value:` attributes, `placeholderValue:`, and a `Button
 *    'Dictate'` listed twice at one frame.
 *  - `hierarchy-springboard.txt`: the home screen / app switcher, with several
 *    windows, bare values carrying commas (`value: SSID, 3 of 3 Wi-Fi...`), and a
 *    non-ASCII time label.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  blockFor,
  findElements,
  foregroundBlock,
  foregroundBundleId,
  parseDeviceHierarchy,
  resolveTap,
  swipePoints,
  windowFrame,
  type ApplicationBlock,
  type HierarchyElement,
} from '../deviceHierarchy';

const FIXTURES = join(__dirname, 'fixtures');
const settingsText = readFileSync(join(FIXTURES, 'hierarchy-settings.txt'), 'utf8');
const springboardText = readFileSync(join(FIXTURES, 'hierarchy-springboard.txt'), 'utf8');

function settingsBlock(): ApplicationBlock {
  const block = blockFor(parseDeviceHierarchy(settingsText), 'com.apple.Preferences');
  if (block === null) throw new Error('fixture has no Settings block');
  return block;
}

/** The two-app shape from the device-interaction skill, where the second app must be activated. */
const MULTI_APP = [
  'Device orientation: Landscape Right',
  '------------------------',
  'Application bundle identifier: com.some.app',
  'Application UI orientation: Landscape Left',
  "Application, pid: 123, label: 'Some App'",
  ' Window, {{0.0, 0.0}, {1133.0, 744.0}}, hitPoint: {566.5, 372.0}',
  "  Button, {{10.0, 10.0}, {50.0, 20.0}}, label: 'Login', hitPoint: {35.0, 20.0}",
  '------------------------',
  'Application bundle identifier: com.some.other.app',
  'Application UI orientation: Landscape Left',
  "Application, pid: 333, label: ' '",
  ' Window, {{0.0, 0.0}, {1133.0, 744.0}}, hitPoint: {566.5, 372.0}, activationBundleId: com.some.other.app',
  "  Button, {{140.0, 205.0}, {20.0, 20.0}}, label: 'Login2', hitPoint: {150.0, 215.0}, activationBundleId: com.some.other.app",
  '',
].join('\n');

describe('parseDeviceHierarchy — the Settings fixture', () => {
  const parsed = parseDeviceHierarchy(settingsText);

  it('reads the header: device orientation, one block, bundle id, pid, label, UI orientation', () => {
    expect(parsed.deviceOrientation).toBe('Unknown');
    expect(parsed.blocks).toHaveLength(1);
    const block = parsed.blocks[0] as ApplicationBlock;
    expect(block.bundleId).toBe('com.apple.Preferences');
    expect(block.pid).toBe(17785);
    expect(block.label).toBe('Settings');
    expect(block.orientation).toBe('Portrait');
  });

  it('recognises every line of a real dump (no unknown lines)', () => {
    expect(parsed.unknownLineCount).toBe(0);
    const elementLines = settingsText.split('\n').filter((line) => /^ +\S/.test(line)).length;
    expect(parsed.blocks[0]?.elements).toHaveLength(elementLines);
  });

  it('reads role, frame, depth, identifier, a comma-carrying quoted label, and hitPoint', () => {
    const account = settingsBlock().elements.find(
      (element) => element.identifier === 'com.apple.settings.primaryAppleAccount',
    ) as HierarchyElement;
    expect(account.role).toBe('Button');
    expect(account.depth).toBe(20);
    expect(account.frame).toEqual({ x: 16, y: 168, width: 370, height: 90.3 });
    expect(account.label).toBe(
      'Apple Account, Sign in to access your iCloud data, the App Store, Apple services, and more.',
    );
    expect(account.hitPoint).toEqual({ x: 201, y: 213.2 });
  });

  it('reads a bare value and a placeholderValue without swallowing the hitPoint', () => {
    const block = settingsBlock();
    const scrollBar = block.elements.find((element) => element.label === 'Vertical scroll bar, 2 pages');
    expect(scrollBar?.value).toBe('0%');
    expect(scrollBar?.hitPoint).toEqual({ x: 384, y: 464 });
    const search = block.elements.find((element) => element.role === 'SearchField');
    expect(search?.placeholderValue).toBe('Search');
    expect(search?.hitPoint).toEqual({ x: 201, y: 822 });
  });

  it('links parents by depth: a row StaticText sits under its Button', () => {
    const block = settingsBlock();
    const text = block.elements.find(
      (element) => element.role === 'StaticText' && element.label === 'General',
    ) as HierarchyElement;
    const parent = block.elements[text.parentIndex as number] as HierarchyElement;
    expect(parent.role).toBe('Button');
    expect(parent.identifier).toBe('com.apple.settings.general');
    expect(block.elements[0]?.role).toBe('Window');
    expect(block.elements[0]?.parentIndex).toBeNull();
  });
});

describe('parseDeviceHierarchy — the SpringBoard fixture', () => {
  const parsed = parseDeviceHierarchy(springboardText);

  it('reads the springboard block with its blank label and pid', () => {
    expect(parsed.blocks).toHaveLength(1);
    const block = parsed.blocks[0] as ApplicationBlock;
    expect(block.bundleId).toBe('com.apple.springboard');
    expect(block.pid).toBe(12669);
    expect(block.label).toBe(' ');
    expect(parsed.unknownLineCount).toBe(0);
  });

  it('keeps a bare value that itself carries commas whole', () => {
    const block = parsed.blocks[0] as ApplicationBlock;
    const wifi = block.elements.find((element) => element.identifier === '3 of 3 Wi-Fi bars');
    expect(wifi?.value).toBe('SSID, 3 of 3 Wi-Fi...');
    expect(wifi?.hitPoint).toEqual({ x: 322.8, y: 32.3 });
    const battery = block.elements.find((element) => element.label === '100% battery power');
    expect(battery?.value).toBe('Not charging');
  });

  it('finds the app-switcher card for the app under test by identifier', () => {
    const block = parsed.blocks[0] as ApplicationBlock;
    const [card] = findElements(block, 'card:com.example.fixtureapp:sceneID:com.example.fixtureapp-default');
    expect(card?.label).toBe('FixtureApp');
  });

  it('windowFrame picks the largest top-level Window, not the 134x291 sliver', () => {
    expect(windowFrame(parsed.blocks[0] as ApplicationBlock)).toEqual({ x: 0, y: 0, width: 402, height: 874 });
  });
});

describe('tolerance', () => {
  it('never throws on foreign or empty text', () => {
    expect(parseDeviceHierarchy('')).toEqual({ deviceOrientation: null, blocks: [], unknownLineCount: 0 });
    const parsed = parseDeviceHierarchy('hello\nworld\n');
    expect(parsed.blocks).toEqual([]);
    expect(parsed.unknownLineCount).toBe(2);
  });

  it('skips an unknown line and an unknown attribute, keeping the rest of the block', () => {
    const text = [
      'Application bundle identifier: com.example.app',
      "Application, pid: 42, label: 'Example'",
      'Some future header: value',
      ' Window, {{0.0, 0.0}, {100.0, 200.0}}, hitPoint: {50.0, 100.0}',
      "  Button, {{0.0, 0.0}, {10.0, 10.0}}, futureKey: 'x, y', label: 'Go', isRemoteLeafPlaceholder, hitPoint: {5.0, 5.0}",
      '  garbage line without a frame',
    ].join('\r\n');
    const parsed = parseDeviceHierarchy(text);
    expect(parsed.unknownLineCount).toBe(2);
    const button = parsed.blocks[0]?.elements[1] as HierarchyElement;
    expect(button.label).toBe('Go');
    expect(button.flags).toEqual(['isRemoteLeafPlaceholder']);
    expect(button.hitPoint).toEqual({ x: 5, y: 5 });
  });

  it("reads a label carrying an apostrophe, and an element with no hitPoint", () => {
    const text = [
      'Application bundle identifier: com.example.app',
      "Application, pid: 7, label: 'Example'",
      " StaticText, {{0.0, 0.0}, {10.0, 10.0}}, label: 'Don't stop', hitPoint: {1.0, 2.0}",
      " StaticText, {{0.0, 0.0}, {10.0, 10.0}}, label: 'Unreachable', hitPoint: ",
    ].join('\n');
    const elements = parseDeviceHierarchy(text).blocks[0]?.elements as HierarchyElement[];
    expect(elements[0]?.label).toBe("Don't stop");
    expect(elements[1]?.label).toBe('Unreachable');
    expect(elements[1]?.hitPoint).toBeUndefined();
  });

  it('reads a pid line that is missing or unreadable as null, not as a crash', () => {
    const parsed = parseDeviceHierarchy(
      ['Application bundle identifier: com.example.app', 'Application, pid: nope'].join('\n'),
    );
    expect(parsed.blocks[0]?.pid).toBeNull();
  });
});

describe('multi-app blocks and the foreground app', () => {
  const parsed = parseDeviceHierarchy(MULTI_APP);

  it('splits on the dashed separator into one block per app', () => {
    expect(parsed.deviceOrientation).toBe('Landscape Right');
    expect(parsed.blocks.map((block) => [block.bundleId, block.pid])).toEqual([
      ['com.some.app', 123],
      ['com.some.other.app', 333],
    ]);
    expect(blockFor(parsed, 'com.some.other.app')?.elements[1]?.activationBundleId).toBe('com.some.other.app');
  });

  it('the foreground app is the one block needing no activation', () => {
    expect(foregroundBundleId(parsed)).toBe('com.some.app');
    expect(foregroundBlock(parsed, 'com.some.app')?.pid).toBe(123);
    // The pid-pinning read still sees the background app's block.
    expect(foregroundBlock(parsed, 'com.some.other.app')).toBeNull();
    expect(blockFor(parsed, 'com.some.other.app')?.pid).toBe(333);
  });

  it('a single-block dump is foreground by definition', () => {
    expect(foregroundBundleId(parseDeviceHierarchy(settingsText))).toBe('com.apple.Preferences');
    expect(foregroundBlock(parseDeviceHierarchy(settingsText), 'com.example.other')).toBeNull();
  });

  it('reports no foreground when every block (or none) needs activation', () => {
    const allAnnotated = MULTI_APP.replace(
      "label: 'Login', hitPoint: {35.0, 20.0}",
      "label: 'Login', hitPoint: {35.0, 20.0}, activationBundleId: com.some.app",
    );
    expect(foregroundBundleId(parseDeviceHierarchy(allAnnotated))).toBeNull();
    expect(foregroundBundleId(parseDeviceHierarchy(''))).toBeNull();
  });

  it('a tap on an element of the other app carries its activationBundleId', () => {
    const resolved = resolveTap(blockFor(parsed, 'com.some.other.app') as ApplicationBlock, 'Login2');
    expect(resolved).toMatchObject({ x: 150, y: 215, activationBundleId: 'com.some.other.app' });
  });
});

describe('findElements', () => {
  it('matches a label or an identifier exactly first', () => {
    const block = settingsBlock();
    expect(findElements(block, 'General').map((element) => element.role)).toEqual(['Button', 'StaticText']);
    expect(findElements(block, 'com.apple.settings.accessibility').map((element) => element.label)).toEqual([
      'Accessibility',
    ]);
  });

  it('falls back to a case-insensitive match only when nothing matches exactly', () => {
    const block = settingsBlock();
    expect(findElements(block, '  general ').map((element) => element.role)).toEqual(['Button', 'StaticText']);
    expect(findElements(block, 'COM.APPLE.SETTINGS.CAMERA')).toHaveLength(1);
    expect(findElements(block, '')).toEqual([]);
  });

  it('a blank target matches nothing, even elements whose own label is blank', () => {
    const block = parseDeviceHierarchy(
      [
        'Application bundle identifier: com.example.app',
        " Other, {{0.0, 0.0}, {10.0, 10.0}}, label: ' ', hitPoint: {5.0, 5.0}",
        " Other, {{0.0, 0.0}, {10.0, 10.0}}, label: '', hitPoint: {6.0, 6.0}",
      ].join('\n'),
    ).blocks[0] as ApplicationBlock;
    expect(block.elements.map((element) => element.label)).toEqual([' ', '']);
    expect(findElements(block, ' ')).toEqual([]);
    expect(findElements(block, '')).toEqual([]);
    expect('none' in resolveTap(block, ' ')).toBe(true);
  });
});

describe('resolveTap', () => {
  it('collapses a Button onto its own matching StaticText and taps the inner point', () => {
    expect(resolveTap(settingsBlock(), 'General')).toMatchObject({ x: 80.7, y: 406.3 });
  });

  it('collapses a NavigationBar identifier onto its title text', () => {
    expect(resolveTap(settingsBlock(), 'Settings')).toMatchObject({ x: 82.5, y: 140 });
  });

  it('resolves an identifier to that element hitPoint', () => {
    const resolved = resolveTap(settingsBlock(), 'com.apple.settings.accessibility');
    expect(resolved).toMatchObject({ x: 201, y: 458.3 });
    expect('element' in resolved && resolved.element.role).toBe('Button');
  });

  it('treats two entries at an identical hitPoint as one control', () => {
    expect(resolveTap(settingsBlock(), 'Dictate')).toMatchObject({ x: 350.3, y: 822 });
  });

  it('refuses a genuinely ambiguous target and lists both candidates', () => {
    // The `Search` settings row AND the search field are both labelled Search.
    const resolved = resolveTap(settingsBlock(), 'Search');
    expect('ambiguous' in resolved).toBe(true);
    if (!('ambiguous' in resolved)) return;
    expect(resolved.ambiguous.map((element) => element.hitPoint)).toEqual([
      { x: 77.7, y: 718.3 },
      { x: 50.3, y: 821.7 },
    ]);
  });

  it('reports none with the tappable names on screen', () => {
    const resolved = resolveTap(settingsBlock(), 'Bluetooth');
    expect('none' in resolved).toBe(true);
    if (!('none' in resolved)) return;
    expect(resolved.none).toContain('General');
    expect(resolved.none).toContain('com.apple.settings.camera');
    expect(resolved.none.length).toBeLessThanOrEqual(40);
    expect(new Set(resolved.none).size).toBe(resolved.none.length);
  });

  it('ignores matches without a hitPoint', () => {
    const block = parseDeviceHierarchy(
      [
        'Application bundle identifier: com.example.app',
        " StaticText, {{0.0, 0.0}, {10.0, 10.0}}, label: 'Ghost'",
      ].join('\n'),
    ).blocks[0] as ApplicationBlock;
    expect(resolveTap(block, 'Ghost')).toEqual({ none: [] });
  });
});

describe('windowFrame and swipePoints', () => {
  it('reads the Settings window frame', () => {
    expect(windowFrame(settingsBlock())).toEqual({ x: 0, y: 0, width: 402, height: 874 });
  });

  it('returns null for a block with no elements', () => {
    expect(windowFrame({ bundleId: 'x', pid: 1, label: null, orientation: null, elements: [] })).toBeNull();
  });

  it('maps each direction as the way the finger moves, clear of the screen edges', () => {
    const frame = { x: 0, y: 0, width: 402, height: 874 };
    expect(swipePoints(frame, 'up')).toEqual({ from: { x: 201, y: 611.8 }, to: { x: 201, y: 262.2 } });
    expect(swipePoints(frame, 'down')).toEqual({ from: { x: 201, y: 262.2 }, to: { x: 201, y: 611.8 } });
    expect(swipePoints(frame, 'left')).toEqual({ from: { x: 281.4, y: 437 }, to: { x: 120.6, y: 437 } });
    expect(swipePoints(frame, 'right')).toEqual({ from: { x: 120.6, y: 437 }, to: { x: 281.4, y: 437 } });
  });
});
