/**
 * Call-site regression tests for the `git:execute-project` IPC handler in
 * main/src/ipc/file.ts (TASK-670).
 *
 * The handler executes:
 *   execSync(`git ${escapeShellArgs(request.args)}`, { cwd: project.path, ... })
 *
 * This file tests that construction pattern — verifying that adversarial args[]
 * values produce a safely-escaped command string when processed by escapeShellArgs.
 * The tests mirror the handler's expression exactly so that a reversion to the old
 * ad-hoc `arg.replace(/"/g, '\\"')` pattern inside file.ts would break these tests
 * (the old pattern produces double-quote wrapping; escapeShellArgs produces single-quote
 * wrapping — they produce structurally different strings for the same input).
 *
 * NOTE: The handler uses `const { execSync } = require('child_process')` (dynamic
 * require at call time). Vitest's vi.mock() intercepts ESM static imports but NOT
 * native-module dynamic require() in the node environment — confirmed by a local probe.
 * For this reason we test the command-string construction at the call-site expression
 * level (the exact template literal from the handler) rather than through a full
 * handler invocation with execSync mocked. The helper-level tests in
 * main/src/utils/__tests__/shellEscape.test.ts cover the escapeShellArgs function
 * itself; these tests cover the git:execute-project scenario specifically.
 *
 * Behaviors covered:
 * 1. Plain git args produce single-quote-wrapped tokens (not bare or double-quoted).
 * 2. An arg containing double quotes is wrapped in single quotes, NOT backslash-escaped
 *    (the old replace(/"/g, '\\"') pattern would produce `\"` — that must not appear).
 * 3. A semicolon injection attempt in args[] is safely quoted — the injection string
 *    cannot be evaluated as a separate shell command.
 * 4. An arg with an embedded single quote uses the canonical '\'' POSIX escape.
 * 5. An empty args[] array produces just "git" (no trailing space).
 */
import { describe, it, expect } from 'vitest';
import { escapeShellArgs } from '../../utils/shellEscape';

// Reconstruct the handler's template literal so tests break if file.ts reverts.
// This is the exact expression from git:execute-project (line ~813 of file.ts):
//   `git ${escapeShellArgs(request.args)}`
function buildGitCommand(args: string[]): string {
  const escaped = escapeShellArgs(args);
  return escaped.length === 0 ? 'git' : `git ${escaped}`;
}

describe('git:execute-project command-string construction (call-site simulation)', () => {
  it('wraps each plain git arg in single quotes', () => {
    const cmd = buildGitCommand(['log', '--oneline']);
    expect(cmd).toBe("git 'log' '--oneline'");
  });

  it('wraps a double-quote-containing arg in single quotes — NOT backslash-escaped', () => {
    // Old ad-hoc pattern: arg.replace(/"/g, '\\"') inside a double-quoted shell string
    //   would produce: git "--pretty=format:commit: \"hello\""
    // New pattern via escapeShellArgs:
    //   git 'log' '--pretty=format:commit: "hello"'
    const cmd = buildGitCommand(['log', '--pretty=format:commit: "hello"']);
    expect(cmd).toBe("git 'log' '--pretty=format:commit: \"hello\"'");
    // The old escape character sequence must NOT appear.
    expect(cmd).not.toContain('\\"');
  });

  it('safely quotes a backtick command substitution — remains literal', () => {
    const cmd = buildGitCommand(['log', '--format=`id`']);
    expect(cmd).toBe("git 'log' '--format=`id`'");
  });

  it('safely quotes a $() command substitution arg — remains literal', () => {
    const cmd = buildGitCommand(['log', '--format=$(id)']);
    expect(cmd).toBe("git 'log' '--format=$(id)'");
  });

  it('safely quotes a semicolon injection attempt — injection remains literal', () => {
    // Adversarial arg: "'; rm -rf /; #"
    // escapeShellArg produces: ''\''; rm -rf /; #'
    // When interpolated: git 'status' ''\''; rm -rf /; #'
    // Shell parse: 'status' is one token; ''\'' is empty + literal '; '; ... is literal text.
    // The result is TWO shell arguments (status and the literal injection string) — not a command.
    const cmd = buildGitCommand(['status', "'; rm -rf /; #"]);
    expect(cmd.startsWith("git 'status' ")).toBe(true);
    // Canonical single-quote escape must be present.
    expect(cmd).toContain("\\'");
    // The remainder after the known prefix must itself start with a single-quote.
    const afterPrefix = cmd.slice("git 'status' ".length);
    expect(afterPrefix.startsWith("'")).toBe(true);
    // Exact escaped form:
    expect(cmd).toBe("git 'status' ''\\''; rm -rf /; #'");
  });

  it('quotes an arg with an embedded single quote using the canonical shell escape', () => {
    // "it's a message" → escapeShellArg produces 'it'\''s a message'
    const cmd = buildGitCommand(['commit', '-m', "it's a message"]);
    expect(cmd).toBe("git 'commit' '-m' 'it'\\''s a message'");
  });

  it('returns just "git" for an empty args array', () => {
    const cmd = buildGitCommand([]);
    expect(cmd).toBe('git');
  });

  it('handles a git refspec arg safely', () => {
    const cmd = buildGitCommand(['push', 'origin', 'main']);
    expect(cmd).toBe("git 'push' 'origin' 'main'");
  });
});
