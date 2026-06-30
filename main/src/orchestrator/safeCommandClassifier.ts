/**
 * safeCommandClassifier — pure classifier for "relatively safe, read-only"
 * tool calls that `acceptEdits` ("Allow edits") mode auto-approves WITHOUT
 * routing through the approval gate.
 *
 * Why this exists: users expect "Allow edits" to mean "don't nag me about
 * routine, non-destructive work" — not literally "only Edit/Write/MultiEdit".
 * A flow that auto-allows edits but still prompts for `git status` or a file
 * Read is annoying and defeats the mode. This module widens the acceptEdits
 * auto-approve surface to:
 *   1. read-only first-party tools (Read / Glob / Grep / LS / NotebookRead /
 *      TodoWrite), and
 *   2. Bash invocations that are provably read-only single commands — read-only
 *      git plumbing/porcelain (status, diff, log, show, …) plus a curated set of
 *      read-only shell utilities (ls, cat, grep, …).
 *
 * Safety model (conservative by construction — a false "safe" auto-runs a
 * command with NO prompt, so the bar is "provably read-only or refuse"):
 *   - Compound commands are split quote-aware on `&&`, `||`, `;`, `|`
 *     ({@link splitShellSegments}); EVERY segment must independently classify
 *     safe, so `git status && rm -rf .` is refused (the `rm` segment fails).
 *   - Any segment with command substitution (`$(…)` / backticks) is refused
 *     ({@link hasCommandSubstitution}) — its real effect is unknowable here.
 *   - Any segment with redirection or backgrounding (`>`, `<`, `&`) is refused;
 *     `sed -i` is excluded; `find`/`env`/`xargs`/`awk` are NOT in the safe set
 *     (they can mutate or execute via `-delete`/`-exec`/sub-programs).
 *   - git subcommands that mutate in ANY form (commit, push, checkout, reset,
 *     clean, rebase, merge, add, rm, …) are simply absent from the allowlists.
 *     The few dual-use subcommands (branch/tag/remote/config/stash) are admitted
 *     only in their read-only flag/positional forms.
 *
 * Standalone-typecheck invariant (shared with permissionModeMapper): NO imports
 * from 'electron', 'better-sqlite3', or any concrete service in
 * main/src/services/*. Reuses the quote-aware splitter from permissionRules.
 */
import { splitShellSegments, hasCommandSubstitution } from './permissionRules';

// ---------------------------------------------------------------------------
// Tool-name sets
// ---------------------------------------------------------------------------

/**
 * Read-only first-party tools auto-approved under acceptEdits. None of these
 * mutate the filesystem, the repo, or any external system: Read/Glob/Grep/LS/
 * NotebookRead inspect files; TodoWrite only updates the agent's own task list.
 */
export const ACCEPT_EDITS_SAFE_READONLY_TOOLS: ReadonlySet<string> = new Set([
  'Read',
  'Glob',
  'Grep',
  'LS',
  'NotebookRead',
  'TodoWrite',
]);

// ---------------------------------------------------------------------------
// Bash classification
// ---------------------------------------------------------------------------

/**
 * git subcommands that are read-only in EVERY invocation regardless of flags or
 * positionals — inspecting history, refs, blobs, or working-tree state. (Notably
 * absent: branch/tag/remote/config/stash — dual-use, handled below — and every
 * mutating subcommand: add, commit, push, pull, fetch, checkout, switch, reset,
 * restore, rm, mv, clean, merge, rebase, cherry-pick, revert, apply, am, stash
 * (bare), init, clone, gc, prune, …)
 */
const ALWAYS_READONLY_GIT_SUBCOMMANDS: ReadonlySet<string> = new Set([
  'status',
  'diff',
  'log',
  'show',
  'blame',
  'shortlog',
  'reflog',
  'rev-parse',
  'rev-list',
  'describe',
  'ls-files',
  'ls-tree',
  'cat-file',
  'grep',
  'show-branch',
  'whatchanged',
  'name-rev',
  'merge-base',
  'count-objects',
  'verify-commit',
  'verify-tag',
  'var',
]);

/**
 * Mutating `git branch` flags. `git branch` with only NON-mutating flags (and no
 * positional, which would name a new branch) lists branches → read-only.
 */
const MUTATING_BRANCH_FLAGS: ReadonlySet<string> = new Set([
  '-d',
  '-D',
  '-m',
  '-M',
  '-c',
  '-C',
  '--delete',
  '--move',
  '--copy',
  '--force',
  '--edit-description',
  '--set-upstream-to',
  '-u',
  '--unset-upstream',
]);

/**
 * Read-only shell utilities. Deliberately excludes anything that can mutate or
 * execute a sub-program without a shell metacharacter we already reject:
 * `sed` (-i edits in place), `find` (-delete/-exec), `env`/`xargs`/`nohup`/
 * `timeout` (run arbitrary programs), `awk` (system()/print-to-file).
 */
const SAFE_READONLY_SHELL_PROGRAMS: ReadonlySet<string> = new Set([
  'ls',
  'pwd',
  'cat',
  'head',
  'tail',
  'wc',
  'echo',
  'printf',
  'which',
  'whoami',
  'id',
  'date',
  'hostname',
  'uname',
  'basename',
  'dirname',
  'realpath',
  'readlink',
  'tree',
  'stat',
  'file',
  'du',
  'df',
  'grep',
  'egrep',
  'fgrep',
  'rg',
  'ag',
  'sort',
  'uniq',
  'cut',
  'column',
  'nl',
  'diff',
  'cmp',
  'comm',
]);

/** Tokenize a single shell segment on whitespace (segments are pre-split). */
function tokenize(segment: string): string[] {
  return segment.trim().split(/\s+/).filter((t) => t.length > 0);
}

/** Strip a trailing `=value` so `--set-upstream-to=origin/x` matches its flag. */
function flagName(token: string): string {
  const eq = token.indexOf('=');
  return eq === -1 ? token : token.slice(0, eq);
}

/**
 * True if a `git <args>` invocation (args = tokens AFTER `git`) is read-only.
 * The subcommand must be the FIRST token — a leading global option (`-C path`,
 * `-c k=v`, …) is refused rather than parsed, keeping the common
 * `git <subcommand>` form fast and the exotic forms safely prompted.
 */
function isSafeReadOnlyGitInvocation(args: string[]): boolean {
  const sub = args[0];
  if (sub === undefined || sub.startsWith('-')) return false;
  const subArgs = args.slice(1);

  if (ALWAYS_READONLY_GIT_SUBCOMMANDS.has(sub)) return true;

  switch (sub) {
    case 'branch':
      // List form only: no positional (would name a new branch) and no mutating
      // flag. `git branch`, `git branch -a -v`, `git branch --merged` pass;
      // `git branch foo` / `git branch -d foo` are refused.
      return (
        subArgs.every((t) => t.startsWith('-')) &&
        !subArgs.some((t) => MUTATING_BRANCH_FLAGS.has(flagName(t)))
      );
    case 'tag':
      // List form only: any positional would create/delete a tag.
      return subArgs.every((t) => t.startsWith('-'));
    case 'remote':
      // `git remote`, `git remote -v`, `git remote show [name]`,
      // `git remote get-url [name]` read; add/remove/rename/prune/set-url mutate.
      return (
        subArgs.length === 0 ||
        ['-v', '--verbose', 'show', 'get-url'].includes(subArgs[0])
      );
    case 'config':
      // Read forms only; a bare `git config k v` writes.
      return (
        subArgs.length > 0 &&
        ['--get', '--get-all', '--get-regexp', '--list', '-l'].includes(subArgs[0])
      );
    case 'stash':
      // `git stash list` / `git stash show` read; bare `git stash` and
      // pop/drop/apply/push/clear mutate the working tree or stash list.
      return subArgs.length > 0 && ['list', 'show'].includes(subArgs[0]);
    default:
      return false;
  }
}

/** True if one shell segment is a provably read-only command. */
function isSafeReadOnlySegment(segment: string): boolean {
  if (hasCommandSubstitution(segment)) return false;
  // Redirection (`>`/`<`) writes/reads files; a trailing `&` backgrounds. Any of
  // these escapes the "single read-only command" model splitShellSegments gives.
  if (/[<>&]/.test(segment)) return false;

  const tokens = tokenize(segment);
  if (tokens.length === 0) return false;
  const program = tokens[0];

  if (program === 'git') return isSafeReadOnlyGitInvocation(tokens.slice(1));
  return SAFE_READONLY_SHELL_PROGRAMS.has(program);
}

/**
 * True if a Bash `command` string is a provably read-only invocation safe to
 * auto-approve under acceptEdits. EVERY quote-aware segment must classify safe.
 */
export function isSafeReadOnlyBashCommand(rawCommand: string): boolean {
  const command = rawCommand.trim();
  if (command.length === 0) return false;
  const segments = splitShellSegments(command);
  if (segments.length === 0) return false;
  return segments.every(isSafeReadOnlySegment);
}

/** Extract the `command` string from a Bash tool input, or null. */
function extractBashCommand(toolInput: unknown): string | null {
  if (toolInput !== null && typeof toolInput === 'object' && 'command' in toolInput) {
    const command = (toolInput as { command?: unknown }).command;
    if (typeof command === 'string') return command;
  }
  return null;
}

/**
 * True if a read-only NON-edit tool call should be auto-approved under
 * acceptEdits: a safe read-only first-party tool, or a Bash call whose command
 * is a provably read-only invocation. The Edit/Write/MultiEdit set is handled by
 * the caller (ACCEPT_EDITS_AUTO_APPROVE_TOOLS) — this covers ONLY the widened
 * read-only surface so callers can OR the two together.
 */
export function isSafeReadOnlyToolCall(toolName: string, toolInput: unknown): boolean {
  if (ACCEPT_EDITS_SAFE_READONLY_TOOLS.has(toolName)) return true;
  if (toolName === 'Bash') {
    const command = extractBashCommand(toolInput);
    return command !== null && isSafeReadOnlyBashCommand(command);
  }
  return false;
}
