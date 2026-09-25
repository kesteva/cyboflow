/**
 * projectSurfaceProbe — modality from EVIDENCE (docs/proposals/
 * runbook-optional-verification.md §A2, F7, RS-9, T-F6).
 *
 * THE PROBLEM IT CLOSES. A composed task that declares nothing usable — no
 * modality, a `mobile` with no `app` block, a `native-screen` on a web-typed run
 * — and names no surface of its own resolves to its SHAPE, which is `web`. On an
 * iOS project that is the shiny-eagle failure: twelve lanes skipped, five
 * stamped `web` although they declared `native-screen`, each deployed into a
 * snapshot with nothing to open. The project's own Xcode files already say what
 * the deliverable is; this module reads them.
 *
 * WHAT IT READS, and in which order:
 *   1. an XcodeGen `project.yml` at the root — a target with `type: application`
 *      and `platform: iOS`;
 *   2. otherwise every `*.xcodeproj/project.pbxproj` at the root or one
 *      directory down — a `PBXNativeTarget` of product type
 *      `com.apple.product-type.application` whose `SDKROOT` (its own, else the
 *      project-level configuration of the same name) is `iphoneos`.
 * The scheme comes from a shared `xcshareddata/xcschemes/*.xcscheme` that
 * builds the target, otherwise the target's own name (XcodeGen and xcodebuild
 * both auto-create one scheme per target).
 *
 * LITERAL VALUES ONLY. A `PRODUCT_BUNDLE_IDENTIFIER` containing `$(` or `${`, a
 * target whose configurations disagree on it, several app targets with
 * different ids, or an XcodeGen target whose id could come from a file this
 * module does not read (`configFiles`, `templates`) is INCONCLUSIVE, and an
 * inconclusive answer changes nothing: the caller keeps today's shape. A wrong
 * bundle id is worse than none — it would install and attest a product this
 * request never claimed.
 *
 * PURE IO, FAIL-SOFT. No throws out of {@link probeProjectSurface}: an
 * unreadable directory, a malformed file or an oversized one is `none` or
 * `inconclusive`, never an error on the enqueue's critical path.
 */
import * as fsPromises from 'node:fs/promises';
import { basename, join } from 'node:path';
import { INFERRED_APP_KEY } from '../../../../shared/types/visualVerification';
import type { MobileAppSpec, VerificationTaskV1 } from '../../../../shared/types/visualVerification';

/** What the probe found. Only `ios-app` may change a request. */
export type ProjectSurfaceProbeResult =
  | { kind: 'ios-app'; app: MobileAppSpec; source: 'xcodegen' | 'pbxproj'; detail: string }
  | { kind: 'none'; detail: string }
  | { kind: 'inconclusive'; detail: string };

/** A project file larger than this is not read (a generated pbxproj this size is not a hand-kept app project). */
const MAX_PROJECT_FILE_BYTES = 8 * 1024 * 1024;

/** One-level-down directories never searched for an `.xcodeproj`: dependency and build output trees. */
const SKIPPED_SUBDIRS = new Set(['node_modules', 'Pods', 'Carthage', 'build', 'DerivedData', 'vendor']);

/** A build-setting value that is not a literal (an Xcode or shell expansion). */
function isNonLiteral(value: string): boolean {
  return value.includes('$(') || value.includes('${');
}

/**
 * Tag an inferred `app` block with the engine-only {@link INFERRED_APP_KEY}. The
 * tag is invisible to the type (`MobileAppSpec` has no such field) and to the
 * wire parser, and rides `task_json` because the scheduler serializes the task
 * object as-is.
 */
export function tagInferredApp(app: MobileAppSpec): MobileAppSpec {
  return Object.assign({ ...app }, { [INFERRED_APP_KEY]: true });
}

/**
 * The task a probe hit turns `task` into: `modality: 'mobile'` plus the tagged
 * `app` block, everything else untouched. The existing `app.platform` rung of
 * `resolveTaskModality` then stamps the row `mobile`.
 */
export function withInferredApp<T extends Pick<VerificationTaskV1, 'modality' | 'app'>>(task: T, app: MobileAppSpec): T {
  return { ...task, modality: 'mobile', app: tagInferredApp(app) };
}

async function readSmallFile(path: string): Promise<string | null> {
  try {
    const stat = await fsPromises.stat(path);
    if (!stat.isFile() || stat.size > MAX_PROJECT_FILE_BYTES) return null;
    return await fsPromises.readFile(path, 'utf8');
  } catch {
    return null;
  }
}

async function listDir(path: string): Promise<string[]> {
  try {
    return (await fsPromises.readdir(path, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Old-style (OpenStep) property list — the pbxproj format
// ---------------------------------------------------------------------------

type PlistValue = string | PlistValue[] | { [key: string]: PlistValue };

/** Tokenize an OpenStep plist: punctuation, quoted strings and bare words; comments dropped. */
function tokenizePlist(text: string): string[] | null {
  const tokens: string[] = [];
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
      i += 1;
    } else if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      if (end < 0) return null;
      i = end + 2;
    } else if (c === '/' && text[i + 1] === '/') {
      const end = text.indexOf('\n', i + 2);
      i = end < 0 ? n : end + 1;
    } else if ('{}()=;,'.includes(c)) {
      tokens.push(c);
      i += 1;
    } else if (c === '"') {
      let out = '';
      i += 1;
      while (i < n && text[i] !== '"') {
        if (text[i] === '\\' && i + 1 < n) {
          const esc = text[i + 1];
          out += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc;
          i += 2;
        } else {
          out += text[i];
          i += 1;
        }
      }
      if (i >= n) return null;
      i += 1;
      // A quoted string is marked so it can never be read back as punctuation.
      tokens.push(`"${out}`);
    } else {
      let j = i;
      while (j < n && !' \t\n\r{}()=;,"'.includes(text[j]) && !(text[j] === '/' && (text[j + 1] === '*' || text[j + 1] === '/'))) {
        j += 1;
      }
      tokens.push(`"${text.slice(i, j)}`);
      i = j;
    }
  }
  return tokens;
}

/** Parse an OpenStep plist into nested dicts/arrays/strings; `null` on any syntax error. */
export function parseOpenStepPlist(text: string): PlistValue | null {
  const tokens = tokenizePlist(text);
  if (tokens === null) return null;
  let pos = 0;
  const parseValue = (): PlistValue | null => {
    const tok = tokens[pos];
    if (tok === undefined) return null;
    pos += 1;
    if (tok === '{') {
      const dict: { [key: string]: PlistValue } = {};
      while (tokens[pos] !== '}') {
        const key = tokens[pos];
        if (key === undefined || !key.startsWith('"')) return null;
        pos += 1;
        if (tokens[pos] !== '=') return null;
        pos += 1;
        const value = parseValue();
        if (value === null) return null;
        if (tokens[pos] !== ';') return null;
        pos += 1;
        dict[key.slice(1)] = value;
      }
      pos += 1;
      return dict;
    }
    if (tok === '(') {
      const arr: PlistValue[] = [];
      while (tokens[pos] !== ')') {
        const value = parseValue();
        if (value === null) return null;
        arr.push(value);
        if (tokens[pos] === ',') pos += 1;
        else if (tokens[pos] !== ')') return null;
      }
      pos += 1;
      return arr;
    }
    return tok.startsWith('"') ? tok.slice(1) : null;
  };
  const root = parseValue();
  return root !== null && pos === tokens.length ? root : null;
}

function asDict(value: PlistValue | undefined): { [key: string]: PlistValue } | null {
  return value !== undefined && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function asString(value: PlistValue | undefined): string | null {
  return typeof value === 'string' ? value : null;
}

/** One app target read out of a project file, before the cross-target decision. */
interface AppTargetCandidate {
  name: string;
  /** The literal bundle id, or the reason none could be read. */
  bundleId: { ok: true; value: string } | { ok: false; reason: string };
}

/** The iOS application targets a parsed pbxproj declares. */
function iosAppTargetsFromPbxproj(root: PlistValue): AppTargetCandidate[] | null {
  const objects = asDict(asDict(root)?.objects);
  if (objects === null) return null;
  const configsOf = (listId: string | null): Array<{ name: string; settings: { [key: string]: PlistValue } }> => {
    const list = listId !== null ? asDict(objects[listId]) : null;
    const ids = list !== null && Array.isArray(list.buildConfigurations) ? list.buildConfigurations : [];
    const out: Array<{ name: string; settings: { [key: string]: PlistValue } }> = [];
    for (const id of ids) {
      const config = typeof id === 'string' ? asDict(objects[id]) : null;
      if (config === null) continue;
      out.push({ name: asString(config.name) ?? '', settings: asDict(config.buildSettings) ?? {} });
    }
    return out;
  };

  const projectObject = Object.values(objects)
    .map(asDict)
    .find((o) => o !== null && o.isa === 'PBXProject');
  const projectConfigs = new Map(
    configsOf(asString(projectObject?.buildConfigurationList)).map((c) => [c.name, c.settings]),
  );

  const targets: AppTargetCandidate[] = [];
  for (const value of Object.values(objects)) {
    const target = asDict(value);
    if (target === null || target.isa !== 'PBXNativeTarget') continue;
    if (target.productType !== 'com.apple.product-type.application') continue;
    const name = asString(target.name);
    if (name === null || name.length === 0) continue;
    const configs = configsOf(asString(target.buildConfigurationList));
    const setting = (config: { name: string; settings: { [key: string]: PlistValue } }, key: string): string | null =>
      asString(config.settings[key]) ?? asString(projectConfigs.get(config.name)?.[key]);
    if (!configs.some((c) => setting(c, 'SDKROOT') === 'iphoneos')) continue;
    const ids = new Set(configs.map((c) => setting(c, 'PRODUCT_BUNDLE_IDENTIFIER')).filter((v): v is string => v !== null));
    targets.push({ name, bundleId: literalBundleId(ids) });
  }
  return targets;
}

/** The one literal bundle id a target's configurations agree on, or why there is none. */
function literalBundleId(ids: Set<string>): AppTargetCandidate['bundleId'] {
  if (ids.size === 0) return { ok: false, reason: 'declares no PRODUCT_BUNDLE_IDENTIFIER' };
  const values = [...ids];
  const expanded = values.find(isNonLiteral);
  if (expanded !== undefined) return { ok: false, reason: `PRODUCT_BUNDLE_IDENTIFIER "${expanded}" is not a literal` };
  if (values.length > 1) {
    return { ok: false, reason: `its configurations declare different bundle ids (${values.join(', ')})` };
  }
  return { ok: true, value: values[0] };
}

// ---------------------------------------------------------------------------
// XcodeGen project.yml — a deliberately tiny block-YAML reader
// ---------------------------------------------------------------------------

/** A block-YAML node: a scalar, a mapping, or an opaque sequence (never read). */
type YamlNode = { kind: 'scalar'; value: string } | { kind: 'map'; entries: Map<string, YamlNode> } | { kind: 'seq' };

interface YamlLine {
  indent: number;
  text: string;
}

/** Drop a trailing ` # comment` outside quotes. */
function stripYamlComment(line: string): string {
  let quote: string | null = null;
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i];
    if (quote !== null) {
      if (c === quote) quote = null;
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === '#' && (i === 0 || line[i - 1] === ' ' || line[i - 1] === '\t')) {
      return line.slice(0, i);
    }
  }
  return line;
}

function unquoteYamlScalar(raw: string): string {
  const v = raw.trim();
  if (v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))) {
    return v.slice(1, -1);
  }
  return v;
}

/**
 * Read the block-mapping skeleton of a YAML document. Enough for XcodeGen's
 * `targets:` / `options:` layout; anything outside that subset (sequences,
 * flow collections, anchors) is kept opaque or verbatim, and the caller treats
 * an opaque value as "not a literal".
 */
export function parseBlockYaml(text: string): YamlNode {
  const lines: YamlLine[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    if (rawLine.includes('\t')) continue;
    const body = stripYamlComment(rawLine).replace(/\s+$/, '');
    if (body.trim().length === 0 || body.trim() === '---' || body.trim() === '...') continue;
    lines.push({ indent: body.length - body.trimStart().length, text: body.trimStart() });
  }
  let i = 0;
  const isSeqItem = (line: YamlLine): boolean => line.text === '-' || line.text.startsWith('- ');
  const parseBlock = (indent: number): YamlNode => {
    if (i < lines.length && isSeqItem(lines[i])) {
      while (i < lines.length && (lines[i].indent > indent || (lines[i].indent === indent && isSeqItem(lines[i])))) i += 1;
      return { kind: 'seq' };
    }
    const entries = new Map<string, YamlNode>();
    while (i < lines.length && lines[i].indent === indent && !isSeqItem(lines[i])) {
      const line = lines[i];
      const match = /^("[^"]*"|'[^']*'|[^:]+?)\s*:(?:\s+(.*))?$/.exec(line.text);
      i += 1;
      if (match === null) {
        // Not a mapping entry: skip it and anything nested under it.
        while (i < lines.length && lines[i].indent > indent) i += 1;
        continue;
      }
      const key = unquoteYamlScalar(match[1]);
      const rest = match[2]?.trim() ?? '';
      if (rest.length > 0) {
        entries.set(key, { kind: 'scalar', value: unquoteYamlScalar(rest) });
        while (i < lines.length && lines[i].indent > indent) i += 1;
      } else if (i < lines.length && (lines[i].indent > indent || (lines[i].indent === indent && isSeqItem(lines[i])))) {
        entries.set(key, parseBlock(lines[i].indent));
      } else {
        entries.set(key, { kind: 'scalar', value: '' });
      }
    }
    return { kind: 'map', entries };
  };
  return lines.length > 0 ? parseBlock(lines[0].indent) : { kind: 'map', entries: new Map() };
}

function yamlChild(node: YamlNode | undefined, key: string): YamlNode | undefined {
  return node?.kind === 'map' ? node.entries.get(key) : undefined;
}

function yamlScalar(node: YamlNode | undefined): string | null {
  return node?.kind === 'scalar' ? node.value : null;
}

/** Every `key` scalar anywhere under `node`; `opaque` when one sits behind a value this reader cannot see into. */
function collectYamlSetting(node: YamlNode | undefined, key: string, out: { values: Set<string>; opaque: boolean }): void {
  if (node?.kind !== 'map') return;
  for (const [k, child] of node.entries) {
    if (k === key) {
      if (child.kind === 'scalar' && !child.value.startsWith('*') && !child.value.startsWith('&')) out.values.add(child.value);
      else out.opaque = true;
    } else if (k === '<<') {
      out.opaque = true;
    } else {
      collectYamlSetting(child, key, out);
    }
  }
}

/** The iOS application targets an XcodeGen spec declares. */
function iosAppTargetsFromXcodeGen(doc: YamlNode): AppTargetCandidate[] {
  const targets = yamlChild(doc, 'targets');
  if (targets?.kind !== 'map') return [];
  const prefix = yamlScalar(yamlChild(yamlChild(doc, 'options'), 'bundleIdPrefix'));
  const projectConfigFiles = yamlChild(doc, 'configFiles') !== undefined;
  const out: AppTargetCandidate[] = [];
  for (const [name, target] of targets.entries) {
    if (yamlScalar(yamlChild(target, 'type')) !== 'application') continue;
    if (yamlScalar(yamlChild(target, 'platform')) !== 'iOS') continue;
    const found = { values: new Set<string>(), opaque: false };
    collectYamlSetting(yamlChild(target, 'settings'), 'PRODUCT_BUNDLE_IDENTIFIER', found);
    if (found.opaque) {
      out.push({ name, bundleId: { ok: false, reason: 'PRODUCT_BUNDLE_IDENTIFIER is not a plain literal' } });
      continue;
    }
    if (found.values.size === 0) {
      // XcodeGen's documented default is `<bundleIdPrefix>.<target name>` — but
      // only when nothing this reader cannot see (an xcconfig, a template)
      // could set the real one.
      const hidden =
        projectConfigFiles || yamlChild(target, 'configFiles') !== undefined || yamlChild(target, 'templates') !== undefined;
      if (prefix !== null && prefix.length > 0 && !hidden) found.values.add(`${prefix}.${name}`);
      else if (hidden) {
        out.push({ name, bundleId: { ok: false, reason: 'its bundle id may come from an xcconfig or template this probe does not read' } });
        continue;
      }
    }
    out.push({ name, bundleId: literalBundleId(found.values) });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Schemes
// ---------------------------------------------------------------------------

/**
 * The shared scheme that builds `targetName`, searched in each directory's
 * `xcshareddata/xcschemes`. Prefers a scheme named exactly after the target,
 * else the first (alphabetical) scheme whose BuildableReference names it.
 */
async function sharedSchemeFor(targetName: string, containers: string[]): Promise<string | null> {
  const matches: string[] = [];
  for (const container of containers) {
    const dir = join(container, 'xcshareddata', 'xcschemes');
    let files: string[];
    try {
      files = (await fsPromises.readdir(dir)).filter((f) => f.endsWith('.xcscheme')).sort();
    } catch {
      continue;
    }
    for (const file of files) {
      const xml = await readSmallFile(join(dir, file));
      if (xml === null) continue;
      const refs = xml.match(/<BuildableReference\b[^>]*>/g) ?? [];
      const builds = refs.some((ref) => {
        const blueprint = /BlueprintName\s*=\s*"([^"]*)"/.exec(ref)?.[1];
        const buildable = /BuildableName\s*=\s*"([^"]*)"/.exec(ref)?.[1];
        return blueprint === targetName && (buildable === undefined || buildable.endsWith('.app'));
      });
      if (builds) matches.push(basename(file, '.xcscheme'));
    }
  }
  if (matches.length === 0) return null;
  return matches.includes(targetName) ? targetName : [...matches].sort()[0];
}

// ---------------------------------------------------------------------------
// The probe
// ---------------------------------------------------------------------------

/** Decide across every app target found in one source. */
async function decide(
  targets: AppTargetCandidate[],
  source: 'xcodegen' | 'pbxproj',
  schemeContainers: string[],
): Promise<ProjectSurfaceProbeResult | null> {
  if (targets.length === 0) return null;
  const unreadable = targets.find((t) => !t.bundleId.ok);
  if (unreadable !== undefined && !unreadable.bundleId.ok) {
    return { kind: 'inconclusive', detail: `${source}: app target "${unreadable.name}" ${unreadable.bundleId.reason}` };
  }
  const ids = new Set(targets.map((t) => (t.bundleId.ok ? t.bundleId.value : '')));
  if (ids.size > 1) {
    return {
      kind: 'inconclusive',
      detail: `${source}: several iOS app targets with different bundle ids (${targets.map((t) => t.name).join(', ')})`,
    };
  }
  const target = targets[0];
  const bundleId = target.bundleId.ok ? target.bundleId.value : '';
  const shared = await sharedSchemeFor(target.name, schemeContainers);
  const scheme = shared ?? target.name;
  return {
    kind: 'ios-app',
    app: { platform: 'ios-simulator', bundleId, scheme },
    source,
    detail: `${source}: iOS app target "${target.name}" (${bundleId}), scheme "${scheme}" (${shared !== null ? 'shared scheme' : 'target name'})`,
  };
}

/** Every `*.xcodeproj` at `root` or one directory down (dependency/build trees skipped). */
async function findXcodeProjects(root: string): Promise<{ projects: string[]; workspaces: string[] }> {
  const projects: string[] = [];
  const workspaces: string[] = [];
  const scan = async (dir: string): Promise<string[]> => {
    const subdirs = await listDir(dir);
    for (const name of subdirs) {
      if (name.endsWith('.xcodeproj')) projects.push(join(dir, name));
      else if (name.endsWith('.xcworkspace')) workspaces.push(join(dir, name));
    }
    return subdirs;
  };
  const top = await scan(root);
  for (const name of top) {
    if (name.startsWith('.') || name.endsWith('.xcodeproj') || name.endsWith('.xcworkspace') || SKIPPED_SUBDIRS.has(name)) continue;
    await scan(join(root, name));
  }
  return { projects, workspaces };
}

/**
 * Probe `root` (a run worktree or snapshot) for an iOS application surface.
 * Never throws; see the module doc for what each answer means.
 */
export async function probeProjectSurface(root: string): Promise<ProjectSurfaceProbeResult> {
  try {
    const { projects, workspaces } = await findXcodeProjects(root);
    const schemeContainers = [...projects, ...workspaces];

    const yml = await readSmallFile(join(root, 'project.yml'));
    if (yml !== null) {
      const decided = await decide(iosAppTargetsFromXcodeGen(parseBlockYaml(yml)), 'xcodegen', schemeContainers);
      if (decided !== null) return decided;
    }

    const targets: AppTargetCandidate[] = [];
    for (const project of projects) {
      const text = await readSmallFile(join(project, 'project.pbxproj'));
      if (text === null) continue;
      const parsed = parseOpenStepPlist(text);
      const found = parsed !== null ? iosAppTargetsFromPbxproj(parsed) : null;
      if (found === null) {
        return { kind: 'inconclusive', detail: `pbxproj: ${join(basename(project), 'project.pbxproj')} could not be parsed` };
      }
      targets.push(...found);
    }
    const decided = await decide(targets, 'pbxproj', schemeContainers);
    if (decided !== null) return decided;
    return { kind: 'none', detail: 'no iOS application target in project.yml or any project.pbxproj' };
  } catch (err) {
    return { kind: 'inconclusive', detail: `probe failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}
