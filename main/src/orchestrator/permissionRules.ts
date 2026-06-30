/**
 * permissionRules — pure matcher + loader for Claude Code permission allow/deny
 * rules, used to honor user/project `permissions.allow` grants inside the
 * PreToolUse hook.
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
 *  - compound commands are split (quote-aware) on `&&`, `||`, `;`, `|` and
 *    EVERY segment must independently match an allow rule;
 *  - a segment containing command substitution (`$(` or a backtick) is never
 *    auto-allowed, to prevent `cat $(rm -rf /)`-style smuggling.
 *
 * deny rules currently only SUPPRESS an auto-allow (the tool then routes to
 * ApprovalRouter where the user can still reject) — they are not turned into a
 * hard SDK deny, matching cyboflow's existing "ask for everything" baseline.
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

/** Merged allow/deny rule strings from user + project settings. */
export interface MergedPermissionRules {
  allow: string[];
  deny: string[];
}

/** Shell control operators that separate independently-evaluated commands. */
const SHELL_SEPARATORS = ['&&', '||', ';', '|'];

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
 * `;`, and `|`, ignoring separators inside single or double quotes.
 *
 * Quote-aware so `git commit -m "a && b"` yields one segment, not three.
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
    if (ch === ';' || ch === '|') {
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
 */
function matchesAny(
  toolName: string,
  input: Record<string, unknown>,
  rules: ParsedRule[],
): boolean {
  const forTool = rules.filter((r) => r.toolName === toolName);
  if (forTool.length === 0) return false;

  // Bare tool-name rule grants the whole tool.
  if (forTool.some((r) => r.content === undefined)) return true;

  if (toolName === 'Bash') {
    const command = typeof input.command === 'string' ? input.command.trim() : '';
    if (command.length === 0) return false;
    const contents = forTool.map((r) => r.content).filter((c): c is string => c !== undefined);
    return bashCommandAllowed(command, contents);
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
 * Returns true only when the call matches an allow rule AND does not match a
 * deny rule. A true result means "skip ApprovalRouter, auto-allow". A false
 * result means "route to ApprovalRouter as usual".
 */
export function isToolAllowed(
  toolName: string,
  input: Record<string, unknown>,
  rules: MergedPermissionRules,
): boolean {
  const allow = rules.allow
    .map(parsePermissionRule)
    .filter((r): r is ParsedRule => r !== null);
  const deny = rules.deny
    .map(parsePermissionRule)
    .filter((r): r is ParsedRule => r !== null);

  if (matchesAny(toolName, input, deny)) return false;
  return matchesAny(toolName, input, allow);
}

// ---------------------------------------------------------------------------
// Settings loading (fs)
// ---------------------------------------------------------------------------

interface SettingsFileShape {
  permissions?: {
    allow?: unknown;
    deny?: unknown;
  };
}

function readRuleArray(filePath: string, key: 'allow' | 'deny'): string[] {
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
 * Load and merge `permissions.allow` / `permissions.deny` from the user
 * (`~/.claude/settings.json`) and project (`<projectDir>/.claude/settings.json`
 * and `.claude/settings.local.json`) settings files.
 *
 * Mirrors the SDK's `settingSources: ['user','project']`. Merge is a union of
 * allow and a union of deny across all present files; missing files contribute
 * nothing. Results are de-duplicated to keep the matcher cheap.
 *
 * @param projectDir - The session cwd (worktree path) whose `.claude/` is read.
 * @param homeDir    - Override for the user home dir (tests). Defaults to os.homedir().
 */
export function loadMergedPermissionRules(
  projectDir: string,
  homeDir: string = os.homedir(),
): MergedPermissionRules {
  const files = [
    path.join(homeDir, '.claude', 'settings.json'),
    path.join(projectDir, '.claude', 'settings.json'),
    path.join(projectDir, '.claude', 'settings.local.json'),
  ];

  const allow = new Set<string>();
  const deny = new Set<string>();
  for (const file of files) {
    for (const r of readRuleArray(file, 'allow')) allow.add(r);
    for (const r of readRuleArray(file, 'deny')) deny.add(r);
  }

  return { allow: [...allow], deny: [...deny] };
}
