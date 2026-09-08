/**
 * Applying a RUNG-1 operation — the denylist, the target rules, and the three
 * structural edits themselves (docs/proposals/lane-runbook-bootstrap.md §8.1).
 *
 * READ §15A FIRST. This is the one path in the whole feature whose safety claim
 * is REVIEW-BACKED rather than structural. Both adversarial reviews concluded
 * independently that an autonomous edit to an executable config file cannot be
 * made structurally safe — a config file decides what is built and what is
 * served, and no validator short of understanding the project can rule out a
 * change that alters either. The user's decision was to keep rung 1 and accept
 * that, so this module's job is to narrow the blast radius as far as it goes
 * without a human in the loop, and the compensating controls (a separate commit,
 * the artifact, a finding that NAMES the edited file) are the actual guarantee.
 *
 * THE NARROWING, CONCRETELY. Every edit here is performed against a PARSED or
 * UNIQUELY-MATCHED target — never a diff, never a line range, never a regex
 * sweep:
 *
 *   - `add-script` parses `package.json` and adds one key, refusing to overwrite
 *     an existing one.
 *   - `port-from-env` replaces one integer literal, and only when that literal
 *     occurs EXACTLY ONCE in the file.
 *   - `relax-strict-port` flips one boolean literal, and only when the setting
 *     occurs EXACTLY ONCE.
 *
 * AMBIGUITY IS A REJECTION, ALWAYS. Two matches is not "pick the first" — a
 * literal `5173` that appears both in a `server.port` and in a proxy target is
 * a case where the agent's model of the file is demonstrably incomplete, and
 * guessing there is how a machine edit silently repoints a proxy. Every
 * multi-match path below returns an error, which degrades to today's skip.
 *
 * PURE — string and JSON transforms over content the caller supplies. The
 * controller does the reading and the writing, so every rule here is testable
 * against a literal.
 */
import type { Rung1Operation } from './runbookDraft';
import { targetFileForOperation } from './runbookDraft';
import { normalizePathSeparators } from '../../utils/posixPath';

/**
 * Paths a rung-1 operation may NEVER touch, whatever shape it claims.
 *
 * These are not "risky files" in general — they are the files where a machine
 * edit escapes the review surface this rung depends on. A lockfile edit changes
 * what every later install resolves; `.github/` and CI configs change what runs
 * on push, outside this repo's own review; `.claude/` changes agent permissions
 * (the repo's settings file has historically been able to disable the approval
 * gate outright); `scripts/` is executable code a `package.json` script would
 * then invoke, which would route straight around the "commands must resolve to a
 * declared script" rule.
 *
 * Matched against the POSIX-normalized, repo-relative path.
 */
/*
 * CASE-INSENSITIVE, AND THAT IS LOAD-BEARING RATHER THAN TIDY. macOS ships a
 * case-INsensitive filesystem by default, so `.Claude/settings.json` and
 * `.claude/settings.json` are the same file while a case-sensitive pattern sees
 * only one of them — and the repo `.claude/settings.json` is a file whose
 * contents decide whether the approval gate binds at all. `.git/` and `.husky/`
 * were added at the same time: hooks and repo config are executed, which is the
 * property this list is actually about.
 */
export const RUNG1_DENIED_PATH_PATTERNS: readonly RegExp[] = [
  /(^|\/)pnpm-lock\.yaml$/i,
  /(^|\/)package-lock\.json$/i,
  /(^|\/)yarn\.lock$/i,
  /(^|\/)bun\.lockb$/i,
  /(^|\/)\.github\//i,
  /(^|\/)\.gitlab-ci\.yml$/i,
  /(^|\/)\.circleci\//i,
  /(^|\/)azure-pipelines\.yml$/i,
  /(^|\/)\.claude\//i,
  /(^|\/)\.cyboflow\//i,
  /(^|\/)scripts\//i,
  /(^|\/)\.git\//i,
  /(^|\/)\.husky\//i,
];

/** Result of applying an operation to one file's content. */
export type Rung1ApplyResult = { ok: true; content: string } | { ok: false; error: string };

/**
 * Normalize an agent-proposed path to a repo-relative POSIX path, or reject it.
 *
 * ESCAPE IS THE FAILURE MODE, not exotic syntax. An absolute path or a `..`
 * segment would let an operation reach outside the run's worktree entirely —
 * past the denylist, past the branch, into the user's home directory or another
 * project's checkout. Both are rejected outright rather than resolved and
 * re-checked, because a normalize-then-validate step is exactly where traversal
 * bugs live.
 */
export function normalizeRung1Path(file: string): { ok: true; path: string } | { ok: false; error: string } {
  const raw = normalizePathSeparators(file.trim());
  if (raw.length === 0) return { ok: false, error: 'operation target path is empty' };
  if (raw.startsWith('/') || /^[A-Za-z]:\//.test(raw)) {
    return { ok: false, error: `operation target must be repo-relative, not absolute: ${file}` };
  }
  const parts = raw.split('/').filter((p) => p.length > 0 && p !== '.');
  if (parts.some((p) => p === '..')) {
    return { ok: false, error: `operation target must not escape the worktree: ${file}` };
  }
  if (parts.length === 0) return { ok: false, error: 'operation target path is empty' };
  return { ok: true, path: parts.join('/') };
}

/**
 * The full target check: normalize, then apply the denylist, then apply the
 * per-kind rules about WHICH file each operation is even allowed to name.
 *
 * `add-script`'s target is fixed at the root `package.json` by
 * {@link targetFileForOperation}, so the per-kind rule there is that no nested
 * package manifest qualifies — editing a workspace package's scripts is a
 * different change with a different blast radius, and the runbook's commands run
 * from the repo root.
 */
export function validateRung1Target(
  operation: Rung1Operation,
): { ok: true; path: string } | { ok: false; error: string } {
  const normalized = normalizeRung1Path(targetFileForOperation(operation));
  if (!normalized.ok) return normalized;
  const path = normalized.path;

  for (const pattern of RUNG1_DENIED_PATH_PATTERNS) {
    if (pattern.test(path)) {
      return { ok: false, error: `operation target is denylisted for autonomous edits: ${path}` };
    }
  }

  if (operation.kind === 'add-script' && path.toLowerCase() !== 'package.json') {
    return { ok: false, error: `add-script may only edit the root package.json (got ${path})` };
  }
  if (operation.kind !== 'add-script' && path.split('/').at(-1)?.toLowerCase() === 'package.json') {
    // package.json changes are confined to `scripts`, and `add-script` is the
    // only operation that can express that confinement. A textual substitution
    // inside a manifest would be an arbitrary JSON edit wearing a narrow
    // operation's name.
    //
    // Matched on the BASENAME, not on the root path: a workspace manifest at
    // `apps/web/package.json` is a manifest too, and `relax-strict-port` would
    // otherwise happily flip a boolean inside one (it has no extension rule of
    // its own, unlike `port-from-env`).
    return { ok: false, error: `${operation.kind} may not edit ${path}; only add-script may edit a manifest` };
  }
  return { ok: true, path };
}

/** Detect the indent a JSON document already uses, so a rewrite does not reformat it. */
function detectJsonIndent(source: string): string | number {
  const match = /\n(\s+)"/.exec(source);
  if (!match) return 2;
  const indent = match[1];
  return indent.includes('\t') ? '\t' : indent.length;
}

/**
 * `add-script` — parse the manifest, add ONE key under `scripts`, re-serialize.
 *
 * ADDITION ONLY. An operation naming an existing script is rejected rather than
 * applied, and this is the single most important rule in the file: overwriting
 * `build` or `dev` is precisely "change what gets built or served", the hazard
 * that made rung 1 unsafe to grant structurally. A project that already has the
 * script does not need this operation at all.
 *
 * The rewrite preserves the file's existing indentation and its trailing
 * newline, so the committed diff is one line and a human reviewing it sees the
 * change rather than a reformat.
 */
function applyAddScript(
  operation: Extract<Rung1Operation, { kind: 'add-script' }>,
  content: string,
): Rung1ApplyResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (err) {
    return { ok: false, error: `package.json is not valid JSON: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, error: 'package.json is not a JSON object' };
  }
  const manifest = parsed as Record<string, unknown>;
  const scriptsValue = manifest.scripts;
  if (scriptsValue !== undefined && (typeof scriptsValue !== 'object' || scriptsValue === null || Array.isArray(scriptsValue))) {
    return { ok: false, error: 'package.json "scripts" is present but is not an object' };
  }
  const scripts = (scriptsValue ?? {}) as Record<string, unknown>;
  if (Object.prototype.hasOwnProperty.call(scripts, operation.scriptName)) {
    return {
      ok: false,
      error: `package.json already declares a "${operation.scriptName}" script; add-script never overwrites one`,
    };
  }

  const next: Record<string, unknown> = {
    ...manifest,
    scripts: { ...scripts, [operation.scriptName]: operation.command },
  };
  const serialized = JSON.stringify(next, null, detectJsonIndent(content));
  return { ok: true, content: content.endsWith('\n') ? `${serialized}\n` : serialized };
}

/**
 * Every occurrence of `literal` in `source` that is a STANDALONE token — not a
 * digit inside a longer number, and not part of an identifier. `5173` must not
 * match inside `15173` or `port5173`.
 */
function standaloneNumberOccurrences(source: string, literal: number): number[] {
  const text = String(literal);
  const found: number[] = [];
  let from = 0;
  for (;;) {
    const idx = source.indexOf(text, from);
    if (idx === -1) break;
    const before = idx === 0 ? '' : source[idx - 1];
    const after = source[idx + text.length] ?? '';
    const boundedBefore = !/[0-9A-Za-z_$.]/.test(before);
    const boundedAfter = !/[0-9A-Za-z_$.]/.test(after);
    if (boundedBefore && boundedAfter) found.push(idx);
    from = idx + text.length;
  }
  return found;
}

/** Env-var names are shell/JS identifiers; anything else would produce broken code. */
function isValidEnvVarName(name: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name);
}

/** Config files this operation can express itself in — it emits JavaScript. */
const PORT_FROM_ENV_EXTENSIONS = ['.js', '.mjs', '.cjs', '.ts', '.mts', '.cts'];

/**
 * `port-from-env` — replace ONE hardcoded port literal with a read of an env
 * var, keeping the original literal as the fallback.
 *
 * The emitted form is `Number(process.env.NAME ?? <port>)`: the project behaves
 * exactly as before when the variable is unset (so a human running `pnpm dev` by
 * hand sees no change), and honors the scheduler's leased port when it is set.
 * A substitution that simply deleted the default would change the project's
 * behavior for its own developers, which is not a change a machine gets to make
 * on its own.
 *
 * REQUIRES EXACTLY ONE OCCURRENCE. A port literal that appears twice — a server
 * port and a proxy target, say — is a file the agent has demonstrably not
 * modeled, and picking one is how a machine edit silently repoints a proxy.
 */
function applyPortFromEnv(
  operation: Extract<Rung1Operation, { kind: 'port-from-env' }>,
  content: string,
  path: string,
): Rung1ApplyResult {
  if (!PORT_FROM_ENV_EXTENSIONS.some((ext) => path.endsWith(ext))) {
    return {
      ok: false,
      error: `port-from-env writes a JavaScript expression and cannot apply to ${path} (expected one of ${PORT_FROM_ENV_EXTENSIONS.join(', ')})`,
    };
  }
  if (!isValidEnvVarName(operation.envVar)) {
    return { ok: false, error: `"${operation.envVar}" is not a valid environment-variable name` };
  }
  const occurrences = standaloneNumberOccurrences(content, operation.port);
  if (occurrences.length === 0) {
    return { ok: false, error: `the literal ${operation.port} does not occur in ${path}` };
  }
  if (occurrences.length > 1) {
    return {
      ok: false,
      error: `the literal ${operation.port} occurs ${occurrences.length} times in ${path}; an ambiguous target is never guessed at`,
    };
  }
  const at = occurrences[0];
  const replacement = `Number(process.env.${operation.envVar} ?? ${operation.port})`;
  return {
    ok: true,
    content: content.slice(0, at) + replacement + content.slice(at + String(operation.port).length),
  };
}

/**
 * `relax-strict-port` — flip ONE `<setting>: true` to `false`.
 *
 * Matches the setting as a key (bare or quoted, single or double) followed by
 * `:` and the literal `true`, which is the shape in every config dialect this
 * reaches: a JS object literal, a JSON file, a TS config object. As with
 * `port-from-env`, more than one match is a rejection.
 */
function applyRelaxStrictPort(
  operation: Extract<Rung1Operation, { kind: 'relax-strict-port' }>,
  content: string,
  path: string,
): Rung1ApplyResult {
  if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(operation.setting)) {
    return { ok: false, error: `"${operation.setting}" is not a valid setting name` };
  }
  const pattern = new RegExp(`(["']?)${operation.setting}\\1\\s*:\\s*true\\b`, 'g');
  const matches = [...content.matchAll(pattern)];
  if (matches.length === 0) {
    return { ok: false, error: `no \`${operation.setting}: true\` found in ${path}` };
  }
  if (matches.length > 1) {
    return {
      ok: false,
      error: `\`${operation.setting}: true\` occurs ${matches.length} times in ${path}; an ambiguous target is never guessed at`,
    };
  }
  const match = matches[0];
  const start = match.index ?? 0;
  const replaced = match[0].replace(/true\b/, 'false');
  return { ok: true, content: content.slice(0, start) + replaced + content.slice(start + match[0].length) };
}

/**
 * Apply one typed rung-1 operation to one file's content.
 *
 * The caller has already validated the target with {@link validateRung1Target}
 * and read the file; this function is the edit itself. It NEVER falls back and
 * NEVER partially applies — either it returns the exact content to write, or it
 * returns why it refused, and the refusal degrades the whole bootstrap to
 * today's skip with nothing written.
 */
export function applyRung1Operation(
  operation: Rung1Operation,
  content: string,
  path: string,
): Rung1ApplyResult {
  switch (operation.kind) {
    case 'add-script':
      return applyAddScript(operation, content);
    case 'port-from-env':
      return applyPortFromEnv(operation, content, path);
    case 'relax-strict-port':
      return applyRelaxStrictPort(operation, content, path);
  }
}

/**
 * A one-line human description of what an operation did, for the finding and the
 * artifact. This is the sentence a reviewer reads at the merge gate before
 * deciding whether to keep the edit, so it names the file and the change rather
 * than the operation's internal name.
 */
export function describeRung1Operation(operation: Rung1Operation): string {
  switch (operation.kind) {
    case 'add-script':
      return `added a \`${operation.scriptName}\` script to package.json running \`${operation.command}\``;
    case 'port-from-env':
      return `made the hardcoded port ${operation.port} in ${operation.file} read \`process.env.${operation.envVar}\` (falling back to ${operation.port})`;
    case 'relax-strict-port':
      return `set \`${operation.setting}\` to false in ${operation.file} so a busy port falls forward instead of failing the launch`;
  }
}
