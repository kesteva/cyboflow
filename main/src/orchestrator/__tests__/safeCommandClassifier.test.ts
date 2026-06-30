/**
 * Unit tests for safeCommandClassifier — the acceptEdits widened read-only
 * surface. The safety contract is "provably read-only or refuse", so the tests
 * lean hard on the REFUSAL side: anything that could mutate, chain, redirect, or
 * substitute must NOT auto-approve.
 */
import { describe, it, expect } from 'vitest';
import {
  isSafeReadOnlyBashCommand,
  isSafeReadOnlyToolCall,
  ACCEPT_EDITS_SAFE_READONLY_TOOLS,
} from '../safeCommandClassifier';

describe('isSafeReadOnlyBashCommand — read-only git', () => {
  it.each([
    'git status',
    'git status -s',
    'git diff',
    'git diff --stat HEAD~1',
    'git log --oneline -20',
    'git show HEAD',
    'git blame README.md',
    'git rev-parse HEAD',
    'git rev-list --count HEAD',
    'git ls-files',
    'git branch',
    'git branch -a -v',
    'git branch --merged',
    'git tag',
    'git tag -l',
    'git remote',
    'git remote -v',
    'git remote show origin',
    'git remote get-url origin',
    'git config --list',
    'git config --get user.name',
    'git stash list',
    'git stash show',
  ])('allows read-only git: %s', (cmd) => {
    expect(isSafeReadOnlyBashCommand(cmd)).toBe(true);
  });

  it.each([
    'git add .',
    'git commit -m "x"',
    'git push',
    'git pull',
    'git fetch',
    'git checkout main',
    'git switch -c feat',
    'git reset --hard',
    'git restore .',
    'git clean -fd',
    'git merge main',
    'git rebase main',
    'git cherry-pick abc',
    'git revert HEAD',
    'git rm file',
    'git mv a b',
    'git stash',
    'git stash pop',
    'git stash drop',
    'git branch newbranch',
    'git branch -d old',
    'git branch --set-upstream-to=origin/x',
    'git tag v1.0',
    'git tag -d v1.0',
    'git remote add origin url',
    'git remote remove origin',
    'git config user.name "x"',
    'git -C /other status', // leading global option → refused (conservative)
    'git', // bare git
  ])('refuses mutating / unparsable git: %s', (cmd) => {
    expect(isSafeReadOnlyBashCommand(cmd)).toBe(false);
  });
});

describe('isSafeReadOnlyBashCommand — read-only shell utilities', () => {
  it.each([
    'ls',
    'ls -la src',
    'pwd',
    'cat package.json',
    'head -50 file.ts',
    'tail -n 20 log.txt',
    'wc -l file',
    'grep -rn foo src',
    'rg pattern',
    'echo hi',
    'which node',
    'stat file',
    'sort file',
    'uniq file',
    'cut -d, -f1 file',
    'diff a b',
  ])('allows read-only utility: %s', (cmd) => {
    expect(isSafeReadOnlyBashCommand(cmd)).toBe(true);
  });

  it.each([
    'rm -rf /',
    'rm file',
    'mv a b',
    'cp a b',
    'mkdir x',
    'touch x',
    'chmod +x x',
    'curl http://evil',
    'wget http://evil',
    'npm install',
    'pnpm add foo',
    'node script.js',
    'python x.py',
    'sed -i s/a/b/ file', // in-place edit
    'find . -delete', // find can delete
    'env FOO=bar rm -rf x', // env runs sub-programs
    'xargs rm',
    'kill -9 123',
  ])('refuses mutating / executing utility: %s', (cmd) => {
    expect(isSafeReadOnlyBashCommand(cmd)).toBe(false);
  });
});

describe('isSafeReadOnlyBashCommand — shell control / injection refusal', () => {
  it.each([
    'git status && rm -rf .', // chaining a destructive command
    'git status; rm -rf .',
    'cat file | tee out', // tee writes
    'git log > out.txt', // redirection
    'cat < secrets',
    'git status &', // backgrounding
    'echo $(rm -rf /)', // command substitution
    'echo `rm -rf /`',
    'ls && git push',
  ])('refuses chained / redirected / substituted command: %s', (cmd) => {
    expect(isSafeReadOnlyBashCommand(cmd)).toBe(false);
  });

  it('allows a safe compound where EVERY segment is read-only', () => {
    expect(isSafeReadOnlyBashCommand('git status && git diff')).toBe(true);
    expect(isSafeReadOnlyBashCommand('ls && cat file && git log')).toBe(true);
    // The operator only affects control flow; both segments are read-only.
    expect(isSafeReadOnlyBashCommand('git status || echo bad')).toBe(true);
  });

  it('refuses if any single segment of a compound is unsafe', () => {
    expect(isSafeReadOnlyBashCommand('git status && git commit -m x')).toBe(false);
    expect(isSafeReadOnlyBashCommand('cat a | rm b')).toBe(false);
  });

  it('refuses empty / whitespace commands', () => {
    expect(isSafeReadOnlyBashCommand('')).toBe(false);
    expect(isSafeReadOnlyBashCommand('   ')).toBe(false);
  });
});

describe('isSafeReadOnlyToolCall', () => {
  it('allows the read-only first-party tools', () => {
    for (const tool of ACCEPT_EDITS_SAFE_READONLY_TOOLS) {
      expect(isSafeReadOnlyToolCall(tool, {})).toBe(true);
    }
  });

  it('does NOT treat edit tools as the read-only surface (caller ORs them separately)', () => {
    expect(isSafeReadOnlyToolCall('Edit', { file_path: '/x' })).toBe(false);
    expect(isSafeReadOnlyToolCall('Write', { file_path: '/x' })).toBe(false);
  });

  it('classifies Bash by its command input', () => {
    expect(isSafeReadOnlyToolCall('Bash', { command: 'git status' })).toBe(true);
    expect(isSafeReadOnlyToolCall('Bash', { command: 'rm -rf /' })).toBe(false);
    expect(isSafeReadOnlyToolCall('Bash', {})).toBe(false); // no command
    expect(isSafeReadOnlyToolCall('Bash', { command: 42 })).toBe(false); // wrong type
  });

  it('refuses unknown / network / mutating tools', () => {
    expect(isSafeReadOnlyToolCall('WebFetch', { url: 'http://x' })).toBe(false);
    expect(isSafeReadOnlyToolCall('NotebookEdit', {})).toBe(false);
    expect(isSafeReadOnlyToolCall('SomeMcpTool', {})).toBe(false);
  });
});
