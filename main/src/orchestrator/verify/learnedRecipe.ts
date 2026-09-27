/**
 * learnedRecipe — HARNESS-SIDE validation of the recipe a passing explore
 * request reports (`report.recipeJson`), before anything may be learned from it
 * (docs/proposals/runbook-optional-verification.md §A5 "Validation").
 *
 * WHAT A RECIPE IS. An explore agent that stood the deliverable up reports the
 * exact commands it used as ONE portable-runbook entry for its modality,
 * serialized to a string (the Codex strict schema stays trivial that way, F6).
 * The harness parses it here with the portable-runbook parser — wrapped as a
 * one-modality runbook, so the entry parser's cross-field rules (mobile carries
 * `app` and no `serve`, `bundle-identity` on the same bundle id, …) apply
 * unchanged — and then applies the rules a machine-authored recipe needs
 * beyond the parser's shape checks.
 *
 * THE PINNED PROOF IS THE SOLE VALIDATOR OF AN AGENT-AUTHORED RECIPE. Nothing in
 * this module makes a recipe trustworthy: it only keeps out one that is unsafe
 * to execute (a dependency mutation, a write outside the snapshot, a
 * build-setting override on mobile) or that could never execute as written (a
 * leased port, UDID or snapshot path baked in as a literal, an undeclared
 * script). A recipe that clears every rule is stored as an UNPROVEN draft, and
 * only the lane's next ordinary request — executing it verbatim as a learned
 * pin and passing through the ordinary engine-enforced `markProven` — can
 * promote it.
 *
 * A REJECTION MEANS NOTHING IS LEARNED; THE VERDICT IS UNAFFECTED. Every answer
 * here is a value, never a throw, and the runner attaches it to a result whose
 * status was already decided.
 *
 * PURE — every input is a value the caller already read (the runner holds the
 * snapshot, the leases and the composed task).
 */
import {
  parseVerifyRunbookV1,
  type VerifyRunbookModality,
  type VerifyRunbookModalityEntry,
  type VerifyRunbookV1,
} from '../../../../shared/types/verifyRunbook';
import type { VerificationModality, VerificationTaskV1 } from '../../../../shared/types/visualVerification';
import { findForbiddenTaskCommands } from './dependencyCommandGuard';
import { SHELL_COMPOSITION_PATTERN, validateDraftedRunbook } from './runbookDraftValidation';
import { checkMobileBuildIsolation } from './runbookStore';
import { isBindableLeverName, type DroppedLever } from './runbookLevers';

/** The request-scoped values a recipe must never carry as literals (§A5 "All"). */
export interface LearnedRecipeLeases {
  /** Every port this request leased — the serve port and the driver's CDP port. */
  ports: number[];
  /** The leased simulator's UDID; `null` off the mobile path. */
  udid: string | null;
  /** The detached snapshot worktree the request executed in. */
  snapshotPath: string | null;
}

/** The harness's answer about one reported recipe. */
export type LearnedRecipeValidation =
  | { ok: true; entry: VerifyRunbookModalityEntry; levers?: VerifyRunbookV1['levers'] }
  | { ok: false; reason: string };

/**
 * The xcodebuild options a learned mobile build may use (§A1.4 "build the
 * snapshot as-is"), split by whether they take a value. Anything else — a
 * build-setting override, `-xcconfig`, `-resultBundlePath` somewhere outside
 * the snapshot, an action other than `build` — is a rejection: the recipe is
 * executed verbatim on every later request once proven, so an allowlist is the
 * only safe direction.
 */
const XCODEBUILD_VALUE_FLAGS = new Set([
  '-project',
  '-workspace',
  '-scheme',
  '-configuration',
  '-sdk',
  '-destination',
  '-derivedDataPath',
  '-clonedSourcePackagesDirPath',
]);
const XCODEBUILD_BARE_FLAGS = new Set(['-skipPackagePluginValidation', '-skipMacroValidation']);
const XCODEBUILD_SETTINGS = new Set(['CODE_SIGNING_ALLOWED=NO', 'CODE_SIGNING_REQUIRED=NO']);
const XCODEBUILD_ACTIONS = new Set(['build']);
/** The two flags whose VALUE may (and, for the second, must) be the request's DerivedData lever. */
const DERIVED_DATA_VALUE_FLAGS = new Set(['-derivedDataPath', '-clonedSourcePackagesDirPath']);

/** The generic literal-UDID shape, the same one the store's §7.2 isolation guard refuses. */
const LITERAL_UDID_PATTERN = /\b[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}\b/;
/** The snapshot provisioner's mkdtemp prefix — any path under it is this request's, and dies with it. */
const SNAPSHOT_DIR_MARKER = 'cyboflow-verify-';

const LEVER_KEYS: readonly DroppedLever['lever'][] = ['portEnv', 'nonceEnv', 'dataDirEnv', 'simUdidEnv', 'derivedDataEnv'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Split one command into argv the way a POSIX shell would for the shapes a
 * build step legitimately uses: whitespace-separated words, with `"…"` and
 * `'…'` quoting (the quotes are dropped, their content kept whole). Callers
 * reject shell composition BEFORE tokenizing, so no operator ever reaches here.
 * An unbalanced quote answers `null`.
 */
export function tokenizeCommand(command: string): string[] | null {
  const tokens: string[] = [];
  let current = '';
  let inToken = false;
  let quote: '"' | "'" | null = null;
  for (const ch of command) {
    if (quote !== null) {
      if (ch === quote) quote = null;
      else current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      inToken = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (inToken) tokens.push(current);
      current = '';
      inToken = false;
      continue;
    }
    current += ch;
    inToken = true;
  }
  if (quote !== null) return null;
  if (inToken) tokens.push(current);
  return tokens;
}

/** Whether `text` references one of `names` as `$NAME` or `${NAME}`. */
function referencesVar(text: string, names: readonly string[]): boolean {
  return names.some((name) => new RegExp(`\\$\\{?${escapeRegExp(name)}\\}?(?![A-Za-z0-9_])`).test(text));
}

/** The xcodebuild options whose value names a location in the SNAPSHOT (relative, contained). */
const SNAPSHOT_PATH_FLAGS = new Set(['-project', '-workspace']);
/** Shell expansion that can point a path anywhere: `$VAR`, `${VAR}`, `` `cmd` ``, `~`. */
const SHELL_EXPANSION_PATTERN = /[$`~]/;

/** Whether a (tokenized, unquoted) path value carries a `..` segment. */
function hasParentSegment(value: string): boolean {
  return value.split('/').includes('..');
}

/**
 * The lever spelling `value` starts with (`$NAME` / `${NAME}` for one of
 * `names`), or `null`. Only a prefix counts — `$HOME/x/$VERIFY_DERIVED_DATA`
 * references the lever but is not under it.
 */
function leverPrefix(value: string, names: readonly string[]): string | null {
  for (const name of names) {
    for (const spelling of [`\${${name}}`, `$${name}`]) {
      if (value === spelling || value.startsWith(`${spelling}/`)) return spelling;
    }
  }
  return null;
}

/**
 * Codex A5 review F2 — where a path-valued option may point. `-project` /
 * `-workspace` must name the snapshot as-is: relative, no expansion, no `..`
 * (a `$HOME/…` or `../../…` project builds a DIFFERENT tree that bundle
 * attestation cannot tell apart). `-derivedDataPath` must BE the lever, and
 * `-clonedSourcePackagesDirPath` the lever or a contained path beneath it —
 * `$VERIFY_DERIVED_DATA/../Shared` references the lever yet escapes it.
 */
function mobilePathValueViolation(flag: string, value: string, derivedDataVars: readonly string[]): string | null {
  if (hasParentSegment(value)) return `${flag} traverses out with a ".." segment ("${value}")`;
  if (flag === '-derivedDataPath') {
    return leverPrefix(value, derivedDataVars) === value
      ? null
      : `${flag} must be exactly the request's DerivedData lever ($VERIFY_DERIVED_DATA), got "${value}"`;
  }
  if (flag === '-clonedSourcePackagesDirPath') {
    const lever = leverPrefix(value, derivedDataVars);
    if (lever === null || SHELL_EXPANSION_PATTERN.test(value.slice(lever.length))) {
      return `${flag} must be under the request's DerivedData lever ($VERIFY_DERIVED_DATA), got "${value}"`;
    }
    return null;
  }
  if (SNAPSHOT_PATH_FLAGS.has(flag)) {
    if (SHELL_EXPANSION_PATTERN.test(value)) return `${flag} expands the environment ("${value}") — it must name the snapshot's own project`;
    if (value.startsWith('/')) return `${flag} is an absolute path ("${value}") — it must be relative to the snapshot`;
  }
  return null;
}

/**
 * §A1.4 — one learned mobile `build[]` step: a single `xcodebuild` invocation,
 * options from the allowlist only, and the DerivedData lever appearing ONLY as
 * the value of `-derivedDataPath` / `-clonedSourcePackagesDirPath` (the latter
 * must BE under it: a package clone anywhere else is a write outside the
 * request), every path value contained (`mobilePathValueViolation`).
 * `checkMobileBuildIsolation` runs after this over the whole entry.
 */
function mobileStepViolation(step: string, index: number, derivedDataVars: readonly string[]): string | null {
  const label = `build[${index}]`;
  if (SHELL_COMPOSITION_PATTERN.test(step)) return `${label} is not a single invocation: ${step}`;
  const tokens = tokenizeCommand(step.trim());
  if (tokens === null || tokens.length === 0) return `${label} does not parse as one command: ${step}`;
  if (tokens[0] !== 'xcodebuild') return `${label} is not an xcodebuild invocation: ${step}`;
  for (let i = 1; i < tokens.length; i++) {
    const token = tokens[i];
    if (XCODEBUILD_VALUE_FLAGS.has(token)) {
      const value = tokens[i + 1];
      if (value === undefined || value.startsWith('-')) return `${label}: ${token} has no value: ${step}`;
      if (!DERIVED_DATA_VALUE_FLAGS.has(token) && referencesVar(value, derivedDataVars)) {
        return `${label}: the DerivedData lever may appear only as the -derivedDataPath / -clonedSourcePackagesDirPath value: ${step}`;
      }
      const pathViolation = mobilePathValueViolation(token, value, derivedDataVars);
      if (pathViolation !== null) return `${label}: ${pathViolation}: ${step}`;
      i += 1;
      continue;
    }
    if (XCODEBUILD_BARE_FLAGS.has(token) || XCODEBUILD_SETTINGS.has(token) || XCODEBUILD_ACTIONS.has(token)) continue;
    return `${label}: "${token}" is not an allowed xcodebuild option (only -project/-workspace/-scheme/-configuration/-sdk/-destination/-derivedDataPath/-clonedSourcePackagesDirPath, -skipPackagePluginValidation/-skipMacroValidation, the code-signing settings and the build action): ${step}`;
  }
  return null;
}

/**
 * §A5 "All" — a recipe describes HOW to stand the project up for ANY request,
 * so a value that belonged to THIS request makes it wrong on the next one: the
 * leased ports, the leased UDID (and any literal UDID at all), the snapshot's
 * path, or any other absolute path (for web/cdp-app that is also the "no step
 * may write outside the snapshot or `$VERIFY_DATA_DIR`" rule — every legitimate
 * location is a lever or relative to the snapshot root).
 */
function leakedLeaseViolation(command: string, leased: LearnedRecipeLeases): string | null {
  for (const port of leased.ports) {
    if (new RegExp(`(?<![0-9])${port}(?![0-9])`).test(command)) {
      return `carries the leased port ${port} as a literal (use \${PORT} / $VERIFY_PORT): ${command}`;
    }
  }
  if (leased.udid !== null && command.includes(leased.udid)) {
    return `carries the leased simulator UDID as a literal (use $VERIFY_SIM_UDID): ${command}`;
  }
  const udid = command.match(LITERAL_UDID_PATTERN);
  if (udid) return `carries a literal device UDID ("${udid[0]}"): ${command}`;
  if ((leased.snapshotPath !== null && command.includes(leased.snapshotPath)) || command.includes(SNAPSHOT_DIR_MARKER)) {
    return `carries this request's snapshot path as a literal: ${command}`;
  }
  const tokens = tokenizeCommand(command) ?? command.split(/\s+/);
  for (const token of tokens) {
    const value = token.includes('=') ? token.slice(token.indexOf('=') + 1) : token;
    if (value.startsWith('/') || value.startsWith('~')) {
      return `names an absolute path ("${value}") — a recipe may only reach the snapshot (relative paths) and the request's levers: ${command}`;
    }
  }
  return null;
}

/**
 * Validate one reported recipe for `modality`. `ok` hands back the parsed entry
 * and the levers it will be stored with — the recipe's own `levers` object when
 * it carries one, else `fallbackLevers` (the explore lever source that bound
 * this very run: a cdp-app recipe learned under a `dataDirEnv` lever must keep
 * binding it once pinned).
 *
 * `composed` is the task the request ran, for two cross-checks that tie the
 * recipe to what the HARNESS verified rather than to what the agent narrated:
 *   - web/cdp-app: explore reaches `passed` only on the VERBATIM composed
 *     `serve.cmd` (§A1.2), so the recipe's serve must be that command;
 *   - mobile: the recipe's bundle id must be the one `bundle-identity` attested.
 */
export function validateLearnedRecipe(args: {
  recipeJson: string;
  modality: VerificationModality;
  composed: Pick<VerificationTaskV1, 'serve' | 'app'>;
  /** The snapshot root's `package.json` text (web/cdp-app), `null` when absent or unreadable. */
  packageJsonRaw: string | null;
  leased: LearnedRecipeLeases;
  fallbackLevers?: VerifyRunbookV1['levers'];
}): LearnedRecipeValidation {
  const { modality } = args;
  if (modality === 'native-screen') return { ok: false, reason: 'native-screen is pinned-only and never learned' };
  const runbookModality: VerifyRunbookModality = modality;

  let decoded: unknown;
  try {
    decoded = JSON.parse(args.recipeJson);
  } catch (err) {
    return { ok: false, reason: `recipeJson is not valid JSON: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (!isRecord(decoded)) return { ok: false, reason: 'recipeJson is not an object' };
  const { levers: rawLevers, ...rawEntry } = decoded;
  const levers = rawLevers !== undefined ? rawLevers : args.fallbackLevers;
  const parsed = parseVerifyRunbookV1({
    version: 1,
    modalities: { [runbookModality]: rawEntry },
    ...(levers !== undefined ? { levers } : {}),
  });
  if (!parsed.ok) return { ok: false, reason: `recipe is not a valid runbook entry — ${parsed.error}` };
  const entry = parsed.runbook.modalities[runbookModality];
  if (entry === undefined) return { ok: false, reason: `recipe declares no "${modality}" entry` };
  const parsedLevers = parsed.runbook.levers;

  // Lever rules: a lever the binder would DROP binds nothing once pinned, and
  // one naming the execution environment is refused outright (runbookLevers).
  for (const key of LEVER_KEYS) {
    const name = parsedLevers?.[key];
    if (name !== undefined && !isBindableLeverName(key, name)) {
      return { ok: false, reason: `levers.${key} "${name}" is not a lever the harness would bind` };
    }
  }

  const build = entry.build ?? [];
  const commands = [...build, ...(entry.serve !== undefined ? [entry.serve.cmd] : [])];
  // The shared §7.2 dependency guard, for every modality.
  const forbidden = findForbiddenTaskCommands({
    version: 1,
    summary: 'learned recipe',
    behaviors: [],
    ...(build.length > 0 ? { build } : {}),
    ...(entry.serve !== undefined ? { serve: { cmd: entry.serve.cmd } } : {}),
  });
  if (forbidden.length > 0) return { ok: false, reason: `recipe mutates dependencies: ${forbidden.join(', ')}` };
  for (const command of commands) {
    const leak = leakedLeaseViolation(command, args.leased);
    if (leak !== null) return { ok: false, reason: `recipe ${leak}` };
  }

  if (runbookModality === 'mobile') {
    if (build.length === 0) return { ok: false, reason: 'a mobile recipe must carry its xcodebuild build step' };
    const derivedDataVars = ['VERIFY_DERIVED_DATA', ...(parsedLevers?.derivedDataEnv ? [parsedLevers.derivedDataEnv] : [])];
    for (let i = 0; i < build.length; i++) {
      const violation = mobileStepViolation(build[i], i, derivedDataVars);
      if (violation !== null) return { ok: false, reason: violation };
    }
    const isolation = checkMobileBuildIsolation(entry, parsedLevers);
    if (isolation !== null) return { ok: false, reason: isolation };
    const attested = args.composed.app?.bundleId;
    if (attested === undefined || entry.app?.bundleId !== attested) {
      return { ok: false, reason: `recipe app.bundleId does not match the attested bundle id (${attested ?? 'none'})` };
    }
  } else {
    const composedServe = args.composed.serve?.cmd;
    if (entry.serve === undefined || composedServe === undefined || entry.serve.cmd !== composedServe) {
      return {
        ok: false,
        reason: 'recipe serve.cmd is not the composed serve the harness verified (explore passes only on the verbatim composed serve)',
      };
    }
    if ((entry.serve.attach === 'cdp') !== (runbookModality === 'cdp-app')) {
      return { ok: false, reason: `recipe serve.attach does not match the ${modality} modality` };
    }
    const drafted = validateDraftedRunbook({
      runbook: parsed.runbook,
      modality: runbookModality,
      packageJsonRaw: args.packageJsonRaw,
    });
    if (!drafted.ok) return { ok: false, reason: drafted.rejection.message };
  }

  return { ok: true, entry, ...(parsedLevers !== undefined ? { levers: parsedLevers } : {}) };
}

/** Every command a learned entry executes, in order — for the review-surface findings. */
export function learnedRecipeCommands(entry: VerifyRunbookModalityEntry): string[] {
  return [
    ...(entry.build ?? []),
    ...(entry.serve !== undefined ? [entry.serve.cmd] : []),
    ...(entry.app !== undefined ? [`(install + launch ${entry.app.bundleId}, scheme ${entry.app.scheme})`] : []),
  ];
}
