/**
 * Mechanical ratchet: no production file under main/src may hand a `git`/`gh`
 * command to a SHELL-string runner.
 *
 * Repo-controlled data — branch names, remote names, refs — reaches these call
 * sites on an ordinary dashboard refresh, so `exec(\`git checkout ${branch}\`)`
 * makes a branch literally named `$(touch /tmp/pwned)` executable. The safe
 * primitive is main/src/utils/runGit.ts (execFile + argv array), and this test
 * is what keeps the invariant enforced rather than merely documented: a new
 * shell-string git call fails CI unless the file is added to LEGACY_ALLOWLIST
 * below, which is a deliberate, reviewable act.
 *
 * Scope note: the scan is CALL-SITE anchored — it flags a git/gh command string
 * literal sitting in the first argument of a shell runner. It deliberately does
 * NOT flag git command strings in general, because several modules build such
 * strings for DISPLAY (WorktreeManager.generateRebaseCommands, the
 * `executedCommands` breadcrumbs in its merge paths) or to CLASSIFY them
 * (orchestrator/safeCommandClassifier). It also cannot see a git string routed
 * through an intermediate variable; that gap is accepted in exchange for zero
 * false positives.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Walk up from the working directory to whichever ancestor holds `main/src` (or
 * is `main` itself), so the scan works whether vitest is rooted at the repo or
 * at main/. `import.meta` is unavailable under this package's CommonJS target.
 */
function locateSrcRoot(): string {
  let dir = process.cwd();
  for (;;) {
    for (const candidate of [path.join(dir, 'src'), path.join(dir, 'main', 'src')]) {
      if (fs.existsSync(path.join(candidate, 'utils', 'runGit.ts'))) return candidate;
    }
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error(`Could not locate main/src from ${process.cwd()}`);
    dir = parent;
  }
}

const SRC_ROOT = locateSrcRoot();

/**
 * Files that still contain shell-string git calls and were NOT migrated, each
 * with the reason. This list may shrink; growing it needs a reviewer to agree
 * the call site genuinely cannot use runGit.
 */
const LEGACY_ALLOWLIST: ReadonlyMap<string, string> = new Map([
  // Currently EMPTY: the last three entries (demoEnvironment, demoScriptContext,
  // interactiveClaudeManager) were migrated to gitExeFinder-resolved commands
  // (argv arrays or variable-first shell strings) in the win-cli-exec fix. New
  // entries need the same review bar as before.
]);

/**
 * Shell-string runners only. execFile/execFileSync/spawn take an argv array and
 * are the safe forms, so they are intentionally absent.
 */
const SHELL_RUNNERS = ['exec', 'execSync', 'execAsync', 'execWithShellPath'];

const SHELL_GIT_CALL = new RegExp(
  // Not preceded by `.` or a word char, so `db.exec(` and `RE.exec(` never match.
  String.raw`(?:^|[^.\w])(?:${SHELL_RUNNERS.join('|')})\s*\(\s*(?:\r?\n\s*)?['"\`]\s*(?:git|gh)[\s'"\`]`,
  'g',
);

function isProductionFile(relPath: string): boolean {
  if (!relPath.endsWith('.ts')) return false;
  if (relPath.endsWith('.test.ts') || relPath.endsWith('.itest.ts')) return false;
  const segments = relPath.split(path.sep);
  return !segments.includes('__tests__') && !segments.includes('__test_fixtures__') && segments[0] !== 'test';
}

function listProductionFiles(dir: string, prefix = ''): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? path.join(prefix, entry.name) : entry.name;
    if (entry.isDirectory()) {
      out.push(...listProductionFiles(path.join(dir, entry.name), rel));
    } else if (entry.isFile() && isProductionFile(rel)) {
      out.push(rel);
    }
  }
  return out;
}

interface Violation {
  file: string;
  line: number;
  text: string;
}

function findViolations(relPath: string): Violation[] {
  const source = fs.readFileSync(path.join(SRC_ROOT, relPath), 'utf8');
  return [...source.matchAll(SHELL_GIT_CALL)].map(match => {
    const before = source.slice(0, match.index);
    const line = before.split('\n').length;
    return { file: relPath, line, text: match[0].trim() };
  });
}

describe('no shell-string git execution in main/src', () => {
  const files = listProductionFiles(SRC_ROOT);

  it('finds production files to scan (guards against a broken walker)', () => {
    expect(files.length).toBeGreaterThan(200);
    expect(files).toContain(path.join('services', 'worktreeManager.ts'));
  });

  it('no non-allowlisted file passes a git/gh command to a shell runner', () => {
    const offenders = files
      .filter(f => !LEGACY_ALLOWLIST.has(f.split(path.sep).join('/')))
      .flatMap(findViolations);

    expect(
      offenders.map(v => `${v.file}:${v.line}  ${v.text}`),
      'Use runGit/runGitAsync/runGitCapture (main/src/utils/runGit.ts) with an argv array instead',
    ).toEqual([]);
  });

  it('every allowlist entry is still a real, still-offending file (no stale exemptions)', () => {
    for (const [relPath, reason] of LEGACY_ALLOWLIST) {
      const native = relPath.split('/').join(path.sep);
      expect(fs.existsSync(path.join(SRC_ROOT, native)), `${relPath} no longer exists`).toBe(true);
      expect(reason.length).toBeGreaterThan(20);
      expect(
        findViolations(native).length,
        `${relPath} no longer contains shell-string git — drop it from LEGACY_ALLOWLIST`,
      ).toBeGreaterThan(0);
    }
  });

  it('the scanner actually detects the pattern it claims to (self-check)', () => {
    const positives = [
      'await execAsync(`git checkout ${branch}`, { cwd });',
      "execSync('git status --porcelain', { cwd })",
      'await execWithShellPath(`git rebase ${mainBranch}`, { cwd })',
      "const out = await execAsync(\n  `gh pr list --head ${b}`,\n)",
    ];
    for (const sample of positives) {
      SHELL_GIT_CALL.lastIndex = 0;
      expect(SHELL_GIT_CALL.test(sample), sample).toBe(true);
    }

    const negatives = [
      "runGit(cwd, ['checkout', branch])",
      'executedCommands.push(`git rebase ${mainBranch} (in ${worktreePath})`)',
      'const match = PREFIX_RE.exec(name);',
      "this.db.exec('VACUUM')",
      "execFileSync('git', args, { cwd })",
    ];
    for (const sample of negatives) {
      SHELL_GIT_CALL.lastIndex = 0;
      expect(SHELL_GIT_CALL.test(sample), sample).toBe(false);
    }
  });
});
