/**
 * Unit tests for shellEscape.ts helpers.
 *
 * Behaviors covered (per TASK-670 test_strategy):
 * 1. escapeShellArg correctly handles empty string, simple ASCII, and embedded single quotes.
 * 2. escapeShellArg wraps double quotes, backticks, and command substitution patterns safely.
 * 3. escapeShellArg handles adversarial injection strings (semicolons, operators, newlines).
 *
 * All assertions are on the produced string only — no actual shell is invoked.
 */
import { describe, it, expect } from 'vitest';
import { escapeShellArg } from '../shellEscape';

// ---------------------------------------------------------------------------
// escapeShellArg
// ---------------------------------------------------------------------------

describe('escapeShellArg', () => {
  it('returns empty single-quoted string for empty input', () => {
    expect(escapeShellArg('')).toBe("''");
  });

  it('wraps a simple ASCII string in single quotes', () => {
    expect(escapeShellArg('simple')).toBe("'simple'");
  });

  it('escapes an embedded single quote using the canonical shell sequence', () => {
    // "it's" → 'it'\''s'
    expect(escapeShellArg("it's")).toBe("'it'\\''s'");
  });

  it('wraps a string with double quotes inside single quotes — no additional escaping needed', () => {
    // Single-quote wrapping makes double quotes literal.
    expect(escapeShellArg('with "double" quotes')).toBe("'with \"double\" quotes'");
  });

  it('wraps backticks safely — no command substitution inside single quotes', () => {
    expect(escapeShellArg('`backtick`')).toBe("'`backtick`'");
  });

  it('wraps $(command) substitution safely — literal inside single quotes', () => {
    expect(escapeShellArg('$(rm -rf /)')).toBe("'$(rm -rf /)'");
  });

  it('wraps ${...} variable expansion safely — literal inside single quotes', () => {
    expect(escapeShellArg('${HOME}')).toBe("'${HOME}'");
  });

  it('safely handles an injection attempt with semicolons', () => {
    const malicious = "'; touch /tmp/cyboflow-injected-$$; #";
    const escaped = escapeShellArg(malicious);
    // The leading single quote is escaped via '\'' — the canonical POSIX shell mechanism.
    // Resulting string: ''\''; touch /tmp/cyboflow-injected-$$; #'
    // Shell parse: '' = empty, then \'' = literal single-quote, then '; touch ...' = literal rest.
    // When this string is evaluated by a shell it produces one argument, not a command injection.
    expect(escaped).toMatch(/^'/);
    // Canonical escape sequence must be present (backslash-quote)
    expect(escaped).toContain("\\'");
    // Exact canonical output:
    expect(escaped).toBe("''\\''; touch /tmp/cyboflow-injected-$$; #'");
  });

  it('safely handles a path with an embedded single quote', () => {
    const path = "/home/user's/project";
    expect(escapeShellArg(path)).toBe("'/home/user'\\''s/project'");
  });

  it('safely handles a string with && and || operators — they remain literal', () => {
    const input = 'value && rm -rf /';
    expect(escapeShellArg(input)).toBe("'value && rm -rf /'");
  });

  it('safely handles a string with newlines — single token, no command splitting', () => {
    const input = 'line1\nline2';
    expect(escapeShellArg(input)).toBe("'line1\nline2'");
  });

  it('safely handles multiple consecutive single quotes', () => {
    // "a''b" → each ' is replaced by '\'' so the escaped form is 'a'\'''\''b'
    expect(escapeShellArg("a''b")).toBe("'a'\\'''\\''b'");
  });

  it('wraps a flag with leading dashes (git subcommand flags) safely', () => {
    expect(escapeShellArg('--all')).toBe("'--all'");
  });

  it('wraps a git refspec safely', () => {
    expect(escapeShellArg('origin/main')).toBe("'origin/main'");
  });
});
