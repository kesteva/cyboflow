/**
 * permissionRules — pure matcher + loader for Claude Code permission
 * allow/deny/ask rules, used to honor user/project `permissions.allow` grants
 * inside the PreToolUse hook.
 *
 * ## Why this exists
 *
 * cyboflow routes every tool call through the in-app ApprovalRouter via the
 * PreToolUse hook. Because the hook is first in the CLI's permission order
 * (hooks → deny → allow → ask), the `settingSources: ['user','project']` that
 * claudeCodeManager passes to the SDK are inert — the CLI never reaches its own
 * allow-rule evaluation. This module re-implements the subset of Claude's
 * allow-rule matching needed so the hook can auto-allow a tool the user already
 * granted, instead of prompting again (FIND-SPRINT-043-3 / TASK-797).
 *
 * ## Safety posture
 *
 * The matcher is deliberately conservative: a non-match (or anything it cannot
 * confidently parse) falls through to ApprovalRouter — i.e. the user is still
 * asked. The failure mode is "asked when it could have auto-allowed", never
 * "auto-allowed when it should have asked". Specifically for Bash:
 *  - prefix rules (`Bash(git add:*)`) match on a WORD boundary, so `git add`
 *    does not match `git addendum`;
 *  - compound commands are split (quote-aware) on `&&`, `||`, `;`, `|`, and a
 *    raw newline, and EVERY segment must independently match an allow rule;
 *  - a segment containing command substitution (`$(` or a backtick) is never
 *    auto-allowed, to prevent `cat $(rm -rf /)`-style smuggling.
 *
 * deny rules currently only SUPPRESS an auto-allow (the tool then routes to
 * ApprovalRouter where the user can still reject) — they are not turned into a
 * hard SDK deny, matching cyboflow's existing "ask for everything" baseline.
 *
 * ask rules suppress an auto-allow the same way, and for the same reason. A
 * user who writes `ask: ["Bash(git push:*)"]` alongside a broader
 * `allow: ["Bash(git:*)"]` has stated that this narrower case must reach a
 * human; because the hook preempts the CLI's own rule evaluation (above), the
 * CLI can no longer enforce that for us. Without this, the broad allow silently
 * swallowed the narrower ask — auto-allowing exactly what the user asked to be
 * asked about, which inverts the safety posture stated below. Routing an ask
 * match to ApprovalRouter satisfies the user's intent precisely: a human decides.
 *
 * ## Trust model (repo-trust hole, deep-review 2026-08 P0; per-project trust, migration 127)
 *
 * Allow rules are only honored from the USER settings file
 * (`~/.claude/settings.json`) UNLESS the project has been explicitly marked
 * trusted. Project-level files under the worktree (`.claude/settings.json`
 * and `.claude/settings.local.json`) contribute SUPPRESSORS only (deny and
 * ask rules) by default: both arrive via clone/worktree checkout (and even an
 * untracked local file can be written by a compromised agent in an earlier
 * session), so a hostile repo shipping `"allow": ["Bash"]` must not disable
 * the approval gate. Suppressors can only narrow, never grant, so honoring
 * them from the repo is always safe, trusted or not.
 *
 * Trust is decided PER PROJECT via `setProjectPermissionTrustResolver` (see
 * below) — the boot wiring in main/src/index.ts injects a resolver backed by
 * the `projects.permission_trust` column (migration 127), stamped by a
 * one-time dialog shown at project creation or the first session/run launch
 * in the project (main/src/services/permissionTrustPrompt.ts).
 * `CYBOFLOW_TRUST_PROJECT_PERMISSION_RULES=1` remains a global override that
 * trusts every project regardless of its stamp — useful for CI/dev, but the
 * per-project resolver is the normal path.
 *
 * Unsupported specifier kinds (e.g. Read/Edit path globs) intentionally do NOT
 * auto-allow in v1 — they keep prompting, which is no worse than today.
 *
 * Standalone-typecheck invariant: NO imports from 'electron', 'better-sqlite3',
 * or any concrete service in main/src/services/*. `fs`/`path`/`os` are fine.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

/** A parsed permission rule: `ToolName` or `ToolName(content)`. */
export interface ParsedRule {
  toolName: string;
  /** The text inside the parentheses, or undefined for a bare tool-name rule. */
  content?: string;
}

/**
 * Merged allow/deny/ask rule strings from user + project settings.
 *
 * `ask` is REQUIRED, not optional, deliberately: it guards the "never
 * auto-allow when it should have asked" invariant, and a construction site that
 * forgets it should fail the build rather than silently fall open.
 */
export interface MergedPermissionRules {
  allow: string[];
  deny: string[];
  ask: string[];
}

/** Shell control operators that separate independently-evaluated commands. */
const SHELL_SEPARATORS = ['&&', '||', ';', '|'];

/**
 * Newline characters, which separate commands exactly as the operators above do
 * — a distinct constant because they are single chars matched after the
 * two-char operator check, and because their omission was a real auto-approval
 * bypass rather than a stylistic gap (see {@link splitShellSegments}).
 */
const SHELL_NEWLINE_SEPARATORS = ['\n', '\r'];

/**
 * Parse a raw rule string into `{ toolName, content }`.
 *
 * `Bash(git add:*)` → `{ toolName: 'Bash', content: 'git add:*' }`
 * `WebSearch`       → `{ toolName: 'WebSearch' }`
 *
 * Returns null for malformed input (empty, or `(` without a closing `)`).
 */
export function parsePermissionRule(rule: string): ParsedRule | null {
  const trimmed = rule.trim();
  if (trimmed.length === 0) return null;

  const open = trimmed.indexOf('(');
  if (open === -1) {
    return { toolName: trimmed };
  }
  if (!trimmed.endsWith(')')) return null;

  const toolName = trimmed.slice(0, open).trim();
  const content = trimmed.slice(open + 1, -1).trim();
  if (toolName.length === 0) return null;
  return content.length === 0 ? { toolName } : { toolName, content };
}

/**
 * Split a shell command into independently-evaluated segments on `&&`, `||`,
 * `;`, `|`, and a RAW NEWLINE, ignoring separators inside single or double
 * quotes.
 *
 * Quote-aware so `git commit -m "a && b"` yields one segment, not three.
 *
 * The newline is a separator for the same reason the others are: a shell runs
 * `git status\nrm -rf ~` as two commands. It was omitted originally, and every
 * consumer here evaluates a segment by its FIRST token — so that command
 * arrived as ONE segment reading `git status` with `rm -rf ~` trailing as
 * unexamined positionals, and both {@link bashCommandAllowed} and the
 * acceptEdits classifier declared it safe. Splitting on it is what makes
 * "every segment must independently classify" mean what it says.
 */
export function splitShellSegments(command: string): string[] {
  const segments: string[] = [];
  let current = '';
  let quote: "'" | '"' | null = null;

  for (let i = 0; i < command.length; i++) {
    const ch = command[i];

    if (quote) {
      current += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      current += ch;
      continue;
    }

    const two = command.slice(i, i + 2);
    if (two === '&&' || two === '||') {
      segments.push(current);
      current = '';
      i++; // consume the second operator char
      continue;
    }
    if (ch === ';' || ch === '|' || SHELL_NEWLINE_SEPARATORS.includes(ch)) {
      segments.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  segments.push(current);

  return segments.map((s) => s.trim()).filter((s) => s.length > 0);
}

/** True if a command segment contains command substitution we refuse to trust. */
export function hasCommandSubstitution(segment: string): boolean {
  return segment.includes('$(') || segment.includes('`');
}

/**
 * Match a single Bash specifier (rule content) against one command segment.
 *
 * `git add:*` → prefix match: segment === 'git add' OR starts with 'git add '.
 * `done`      → exact match: segment === 'done'.
 */
function matchBashSpecifier(content: string, segment: string): boolean {
  if (content.endsWith(':*')) {
    const prefix = content.slice(0, -2).trim();
    if (prefix.length === 0) return false; // `Bash(:*)` — refuse to match-all here
    return segment === prefix || segment.startsWith(prefix + ' ');
  }
  // Exact-match rule (no wildcard).
  return segment === content;
}

/**
 * True if every segment of `command` matches at least one Bash allow rule.
 * Returns false if any segment is unmatched or contains command substitution.
 */
function bashCommandAllowed(command: string, bashContents: string[]): boolean {
  const segments = splitShellSegments(command);
  if (segments.length === 0) return false;

  return segments.every((segment) => {
    if (hasCommandSubstitution(segment)) return false;
    return bashContents.some((content) => matchBashSpecifier(content, segment));
  });
}

/**
 * True if ANY segment of `command` matches a Bash suppressor (deny/ask) rule.
 *
 * The quantifier is the whole point, and it is the OPPOSITE of
 * bashCommandAllowed's. A grant must cover EVERY segment to be safe; a
 * suppressor must fire if it touches ANY segment. Sharing the `every` matcher
 * for both — which is what this module used to do — let a compound command slip
 * a suppressed segment past its own rule: with `allow: ["Bash(git:*)"]` and
 * `deny: ["Bash(git push:*)"]`, the command `git add . && git push` did not
 * match deny (the `git add .` segment isn't a push) yet DID match allow (both
 * segments are `git`), so it auto-allowed the very push the user denied.
 */
function bashCommandSuppressed(command: string, bashContents: string[]): boolean {
  return splitShellSegments(command).some((segment) =>
    bashContents.some((content) => matchBashSpecifier(content, segment)),
  );
}

/** Extract the registrable domain (host) from a URL string, or null. */
function urlDomain(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

/**
 * True if the (toolName, input) pair matches at least one of `rules`.
 *
 * Handles: bare tool-name rules, Bash specifiers (prefix/exact, compound-safe),
 * and WebFetch(domain:X). Other specifier kinds do not match (conservative).
 *
 * `mode` selects the Bash quantifier over a compound command's segments:
 * 'grant' requires EVERY segment to match (used for allow), 'suppress' requires
 * only SOME segment to match (used for deny and ask). See bashCommandSuppressed.
 * It is inert for every non-Bash tool, whose rules match a single subject.
 */
function matchesAny(
  toolName: string,
  input: Record<string, unknown>,
  rules: ParsedRule[],
  mode: 'grant' | 'suppress' = 'grant',
): boolean {
  const forTool = rules.filter((r) => r.toolName === toolName);
  if (forTool.length === 0) return false;

  // Bare tool-name rule covers the whole tool.
  if (forTool.some((r) => r.content === undefined)) return true;

  if (toolName === 'Bash') {
    const command = typeof input.command === 'string' ? input.command.trim() : '';
    if (command.length === 0) return false;
    const contents = forTool.map((r) => r.content).filter((c): c is string => c !== undefined);
    return mode === 'suppress'
      ? bashCommandSuppressed(command, contents)
      : bashCommandAllowed(command, contents);
  }

  if (toolName === 'WebFetch') {
    const url = typeof input.url === 'string' ? input.url : '';
    const host = urlDomain(url);
    if (host === null) return false;
    return forTool.some((r) => {
      if (r.content === undefined) return false;
      const m = /^domain:(.+)$/.exec(r.content);
      return m !== null && (host === m[1] || host.endsWith('.' + m[1]));
    });
  }

  // Unsupported specifier kind (e.g. Read/Edit path globs): do not auto-allow.
  return false;
}

/**
 * Decide whether a tool call is pre-approved by the merged allow rules.
 *
 * Returns true only when the call matches an allow rule AND matches neither a
 * deny nor an ask rule. A true result means "skip ApprovalRouter, auto-allow".
 * A false result means "route to ApprovalRouter as usual".
 *
 * deny and ask are both auto-allow SUPPRESSORS and are checked first, so a
 * narrow suppressor always beats a broad allow regardless of rule order.
 */
export function isToolAllowed(
  toolName: string,
  input: Record<string, unknown>,
  rules: MergedPermissionRules,
): boolean {
  const parse = (raw: string[]): ParsedRule[] =>
    raw.map(parsePermissionRule).filter((r): r is ParsedRule => r !== null);

  if (matchesAny(toolName, input, parse(rules.deny), 'suppress')) return false;
  if (matchesAny(toolName, input, parse(rules.ask), 'suppress')) return false;
  return matchesAny(toolName, input, parse(rules.allow), 'grant');
}

// ---------------------------------------------------------------------------
// Settings loading (fs)
// ---------------------------------------------------------------------------

interface SettingsFileShape {
  permissions?: {
    allow?: unknown;
    deny?: unknown;
    ask?: unknown;
  };
}

function readRuleArray(filePath: string, key: 'allow' | 'deny' | 'ask'): string[] {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw) as SettingsFileShape;
    const arr = parsed.permissions?.[key];
    if (!Array.isArray(arr)) return [];
    return arr.filter((x): x is string => typeof x === 'string');
  } catch {
    // Missing / unreadable / malformed settings file → no rules from it.
    return [];
  }
}

/**
 * Per-project trust resolver, injected by the Electron main process at boot
 * (main/src/index.ts, mirroring the setStreamParserPerfBump pattern in
 * shared/streamParser/rawEventsSink.ts) so this module stays free of
 * `electron` / `main/src/services/*` imports (standalone-typecheck invariant).
 *
 * Defaults to "never trust" — a caller before boot wiring (or a resolver that
 * throws) gets the fail-closed answer, matching this module's existing
 * safety posture: a non-match must fall through to asking, never to an
 * auto-allow.
 */
let projectTrustResolver: (projectDir: string) => boolean = () => false;

/**
 * Inject the per-project trust resolver. `fn` is called with the worktree
 * path passed to {@link loadMergedPermissionRules} and must return whether
 * that project's owning row has `permission_trust === 'trusted'`. Any throw
 * from `fn` is treated as untrusted (fail-closed) — see
 * {@link loadMergedPermissionRules}.
 */
export function setProjectPermissionTrustResolver(fn: (projectDir: string) => boolean): void {
  projectTrustResolver = fn;
}

/**
 * True if either project settings file (`.claude/settings.json` or
 * `.claude/settings.local.json` under `projectDir`) declares a non-empty
 * `permissions.allow` array. Used to decide whether the per-project trust
 * prompt (main/src/services/permissionTrustPrompt.ts) has anything to ask about — a repo with no
 * allow rules never needs a trust decision.
 */
export function projectSettingsContainAllowRules(projectDir: string): boolean {
  const projectFiles = [
    path.join(projectDir, '.claude', 'settings.json'),
    path.join(projectDir, '.claude', 'settings.local.json'),
  ];
  return projectFiles.some((file) => readRuleArray(file, 'allow').length > 0);
}

/**
 * Load and merge `permissions.allow` / `permissions.deny` / `permissions.ask`
 * from the user (`~/.claude/settings.json`) and project
 * (`<projectDir>/.claude/settings.json` and `.claude/settings.local.json`)
 * settings files.
 *
 * Trust model (see module header): allow rules are honored from the USER file
 * always, and from project files only when the project is trusted — either
 * globally via `CYBOFLOW_TRUST_PROJECT_PERMISSION_RULES=1`, or per-project via
 * the injected {@link setProjectPermissionTrustResolver} resolver (fail-closed
 * on throw). Project files contribute suppressors (deny and ask) unconditionally,
 * because their content is repo-controlled and a hostile repo must not be able
 * to grant itself auto-approval regardless of trust. Deny and ask rules are
 * always a union of every present file. Results are de-duplicated to keep the
 * matcher cheap.
 *
 * @param projectDir - The session cwd (worktree path) whose `.claude/` is read.
 * @param homeDir    - Override for the user home dir (tests). Defaults to os.homedir().
 */
export function loadMergedPermissionRules(
  projectDir: string,
  homeDir: string = os.homedir(),
): MergedPermissionRules {
  const userFile = path.join(homeDir, '.claude', 'settings.json');
  const projectFiles = [
    path.join(projectDir, '.claude', 'settings.json'),
    path.join(projectDir, '.claude', 'settings.local.json'),
  ];
  let resolvedTrust = false;
  try {
    resolvedTrust = projectTrustResolver(projectDir);
  } catch {
    // Fail-closed: a throwing resolver must never be read as "trusted".
    resolvedTrust = false;
  }
  const trustProject = process.env.CYBOFLOW_TRUST_PROJECT_PERMISSION_RULES === '1' || resolvedTrust;

  const allow = new Set<string>();
  const deny = new Set<string>();
  const ask = new Set<string>();

  for (const r of readRuleArray(userFile, 'allow')) allow.add(r);
  for (const r of readRuleArray(userFile, 'deny')) deny.add(r);
  for (const r of readRuleArray(userFile, 'ask')) ask.add(r);
  for (const file of projectFiles) {
    if (trustProject) {
      for (const r of readRuleArray(file, 'allow')) allow.add(r);
    }
    for (const r of readRuleArray(file, 'deny')) deny.add(r);
    for (const r of readRuleArray(file, 'ask')) ask.add(r);
  }

  return { allow: [...allow], deny: [...deny], ask: [...ask] };
}
