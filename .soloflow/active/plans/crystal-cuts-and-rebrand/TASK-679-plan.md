---
id: TASK-679
idea: SPRINT-025-compounder
status: ready
created: 2026-05-20T00:00:00Z
files_owned:
  - main/src/utils/runGit.ts
  - main/src/utils/__tests__/runGit.test.ts
  - main/src/ipc/file.ts
  - main/src/services/commitManager.ts
files_readonly:
  - main/src/utils/shellEscape.ts
  - main/src/services/gitStatusManager.ts
  - main/src/services/executionTracker.ts
  - main/src/ipc/git.ts
  - main/src/ipc/dashboard.ts
  - main/src/services/gitPlumbingCommands.ts
  - main/src/services/gitDiffManager.ts
acceptance_criteria:
  - criterion: "A new helper module exists at `main/src/utils/runGit.ts` exporting `runGit(cwd: string, args: string[], options?: { encoding?: 'utf8' | 'buffer'; maxBuffer?: number; env?: NodeJS.ProcessEnv }): string | Buffer` (sync, backed by `execFileSync('git', args, ...)`) and `runGitAsync(cwd, args, options): Promise<string | Buffer>` (async, backed by `execFile` + `promisify`)."
    verification: "Run `test -f main/src/utils/runGit.ts` (exit 0) and `grep -n 'export function runGit\\|export function runGitAsync\\|export async function runGitAsync' main/src/utils/runGit.ts` returns at least 2 hits."
  - criterion: "`main/src/ipc/file.ts` lines ~245 and ~275 (`execAsync(\\\\`git commit -F ${tmpFile}\\\\`)`) are migrated to `runGitAsync(session.worktreePath, ['commit', '-F', tmpFile])`. The require('child_process') / require('util') / promisify shim above those calls is removed if no other call site depends on it within the same block."
    verification: "Run `grep -n 'git commit -F' main/src/ipc/file.ts` and confirm 0 hits. Run `grep -n 'runGitAsync\\|runGit\\b' main/src/ipc/file.ts` and confirm at least 2 hits."
  - criterion: "`main/src/services/commitManager.ts` lines 197 (`execSync(\\\\`git merge-base HEAD ${mainBranch}\\\\`)`) and 203 (`execSync(\\\\`git reset --soft ${mergeBase}\\\\`)`) are migrated to `runGit(worktreePath, ['merge-base', 'HEAD', mainBranch])` and `runGit(worktreePath, ['reset', '--soft', mergeBase])`."
    verification: "Run `grep -nE 'execSync\\(.*git (merge-base|reset)' main/src/services/commitManager.ts` and confirm 0 hits. Run `grep -n 'runGit\\b' main/src/services/commitManager.ts` and confirm at least 2 hits."
  - criterion: "Unit tests for `runGit` and `runGitAsync` cover the adversarial-arg case: an arg containing `$(touch /tmp/cyboflow-rungit-pwned)` is passed as a positional arg and the marker file is NOT created (proving `execFile` does not invoke a shell)."
    verification: "Run `pnpm --filter @cyboflow/main test -- runGit.test.ts`; exit 0 and the adversarial test case appears in the passing list."
  - criterion: "All previously passing tests in the main workspace continue to pass — no behavioral regression introduced by the migration of the 4 sites (2 in file.ts, 2 in commitManager.ts)."
    verification: "Run `pnpm --filter @cyboflow/main test`; exit 0."
  - criterion: "Typecheck passes."
    verification: "Run `pnpm typecheck`; exit code 0."
depends_on: []
estimated_complexity: medium
epic: crystal-cuts-and-rebrand
test_strategy:
  needed: true
  justification: "The runGit helper is a new utility shared across several call sites — needs direct unit tests covering: (a) success path with arg array; (b) adversarial-arg case proving no shell parsing; (c) error path (non-zero exit propagates with stderr); (d) options (cwd, encoding, env). The 4 migrated call sites are exercised by existing commitManager and file.ts integration tests."
  targets:
    - behavior: "runGit / runGitAsync invoke git with positional args; an arg containing $(...) is treated as a literal string, not a shell command."
      test_file: "main/src/utils/__tests__/runGit.test.ts"
      type: unit
    - behavior: "Non-zero git exit codes throw an error containing the stderr message."
      test_file: "main/src/utils/__tests__/runGit.test.ts"
      type: unit
    - behavior: "cwd, encoding, and env options are honored."
      test_file: "main/src/utils/__tests__/runGit.test.ts"
      type: unit
    - behavior: "Existing commitManager tests still pass after migrating the merge-base + reset --soft call sites."
      test_file: "main/src/services/__tests__/commitManager.test.ts"
      type: integration
    - behavior: "Existing file.ts IPC tests (git:commit handler) still pass after migrating the two `git commit -F` call sites."
      test_file: "main/src/ipc/__tests__/file.test.ts"
      type: integration
---

# Introduce runGit helper and migrate the 4 highest-priority execSync git sites

## Objective

Introduce `main/src/utils/runGit.ts` (sync + async variants, both backed by `execFile` so no shell is invoked) and migrate the 4 highest-priority of the ~23 `execSync(\`git ... ${value}\`)` sites in `main/`. The migrated sites are the two `git commit -F ${tmpFile}` calls in `main/src/ipc/file.ts` (lowest-risk, simplest single-token migrations that the IDEA explicitly called out) and the two `commitManager.ts` sites (`merge-base HEAD ${mainBranch}`, `reset --soft ${mergeBase}`). The remaining ~17 sites are out of scope for this task to keep the diff reviewable — they should be migrated in follow-up tasks (TASK-680..., to be planned later) once the helper is in place and proven.

## Implementation Steps

1. **Pre-flight: enumerate all sites and confirm scope.** Run:
   ```bash
   grep -rn 'execSync(`git\|execSync(.git' main/src/
   grep -rn 'execAsync(`git' main/src/
   ```
   Document the count before starting. The 4 in-scope sites:
   - `main/src/ipc/file.ts:245` — `execAsync(\`git commit -F ${tmpFile}\`)` (initial commit path)
   - `main/src/ipc/file.ts:275` — `execAsync(\`git commit -F ${tmpFile}\`)` (post-pre-commit-hook retry path)
   - `main/src/services/commitManager.ts:197` — `execSync(\`git merge-base HEAD ${mainBranch}\`)`
   - `main/src/services/commitManager.ts:203` — `execSync(\`git reset --soft ${mergeBase}\`)`

   The remaining ~17 sites stay as-is in this task and are tracked for follow-up. Add an inline `// TODO(TASK-680): migrate to runGit` comment above each remaining `execSync(\`git ...\`)` so the next task has an explicit grep target. Limit the comment to the 17 in-main-src sites, not the 1 site in `main/src/ipc/__tests__/fileGitExecuteProject.test.ts` (test file).

2. **Create `main/src/utils/runGit.ts`** with two exported functions:
   ```ts
   /**
    * Shell-free git invocation helpers.
    *
    * Both functions use Node's execFile (not exec/execSync with a shell), so
    * arguments are passed as positional parameters to the git binary and are
    * NEVER parsed by a shell. This eliminates the shell-injection class of bugs
    * that the legacy `execSync(\`git ... ${value}\`)` pattern exposes.
    *
    * Use runGit (sync) when the caller is already synchronous (e.g. inside a
    * non-async function or a pre-existing execSync chain). Prefer runGitAsync
    * for any new code path or any async caller.
    */
   import { execFile, execFileSync } from 'node:child_process';
   import { promisify } from 'node:util';

   const execFileAsyncPromise = promisify(execFile);

   export interface RunGitOptions {
     encoding?: 'utf8' | 'buffer';
     maxBuffer?: number;
     env?: NodeJS.ProcessEnv;
   }

   export function runGit(cwd: string, args: string[], options: RunGitOptions = {}): string {
     const encoding = options.encoding ?? 'utf8';
     const result = execFileSync('git', args, {
       cwd,
       encoding,
       maxBuffer: options.maxBuffer ?? 10 * 1024 * 1024, // 10 MB default; safer than execSync default
       env: options.env,
     });
     // execFileSync returns Buffer when encoding === 'buffer', else string.
     // We type the public surface as string for the common case; callers needing
     // Buffer can cast (rare).
     return typeof result === 'string' ? result : result.toString('utf8');
   }

   export async function runGitAsync(cwd: string, args: string[], options: RunGitOptions = {}): Promise<string> {
     const { stdout } = await execFileAsyncPromise('git', args, {
       cwd,
       encoding: (options.encoding ?? 'utf8') as BufferEncoding,
       maxBuffer: options.maxBuffer ?? 10 * 1024 * 1024,
       env: options.env,
     });
     return typeof stdout === 'string' ? stdout : stdout.toString('utf8');
   }
   ```
   Keep the API surface intentionally minimal — just the 3 options that the 4 migrated sites need. Future migrations can extend as required.

3. **Write unit tests** at `main/src/utils/__tests__/runGit.test.ts`. Cover:
   - Happy path: `runGit(process.cwd(), ['--version'])` returns a string starting with `'git version'`.
   - Same for `runGitAsync`.
   - Adversarial arg: `runGit(tmpDir, ['log', '-1', '--format=%s', '$(touch /tmp/cyboflow-rungit-pwned).txt'])`. The arg is passed as a single git positional; git will interpret it as a ref name, fail with "unknown revision or path", and the test asserts (a) the error is raised, AND (b) `fs.existsSync('/tmp/cyboflow-rungit-pwned')` is false after the call. This proves no shell parsing happened.
   - Error path: `runGit(process.cwd(), ['nonexistent-subcommand'])` throws; the thrown Error contains git's stderr.
   - cwd: a `runGit(otherDir, ['rev-parse', '--show-toplevel'])` returns `otherDir` (or its canonical form).
   - env: pass `env: { ...process.env, GIT_AUTHOR_NAME: 'TestAuthor' }` to a no-op command (`git --version`) and confirm no crash.

4. **Migrate `main/src/ipc/file.ts:245`** (initial commit). Current code (~lines 230-251):
   ```ts
   const { exec } = require('child_process');
   const { promisify } = require('util');
   const execAsync = promisify(exec);

   try {
     await execAsync('git add -A', { cwd: session.worktreePath });
     // ...
     await execAsync(`git commit -F ${tmpFile}`, { cwd: session.worktreePath });
   ```
   Change to:
   ```ts
   import { runGitAsync } from '../utils/runGit'; // add to top-of-file imports

   try {
     await runGitAsync(session.worktreePath, ['add', '-A']);
     // ...
     await runGitAsync(session.worktreePath, ['commit', '-F', tmpFile]);
   ```
   Note: this also migrates the `git add -A` call in the same block (line 236) — it's a same-block, same-pattern beneficiary. The `require('child_process')` / `require('util')` lines become unused IF this is the only block using `execAsync` in the file. Check with `grep -n 'execAsync' main/src/ipc/file.ts` after the migration — if 0 remaining usages, delete the require shim; if there are other usages (e.g. in the revert/cherry-pick handlers), leave it.

5. **Migrate `main/src/ipc/file.ts:275`** (post-pre-commit-hook retry, lines ~265-280). Same pattern as step 4:
   ```ts
   await runGitAsync(session.worktreePath, ['add', '-A']);
   // ...
   await runGitAsync(session.worktreePath, ['commit', '-F', tmpFile]);
   ```

6. **Migrate `main/src/services/commitManager.ts:197`** (merge-base). Current:
   ```ts
   const mergeBase = execSync(`git merge-base HEAD ${mainBranch}`, {
     cwd: worktreePath,
     encoding: 'utf8',
   }).trim();
   ```
   Change to:
   ```ts
   import { runGit } from '../utils/runGit'; // add to imports

   const mergeBase = runGit(worktreePath, ['merge-base', 'HEAD', mainBranch]).trim();
   ```

7. **Migrate `main/src/services/commitManager.ts:203`** (reset --soft). Current:
   ```ts
   execSync(`git reset --soft ${mergeBase}`, { cwd: worktreePath });
   ```
   Change to:
   ```ts
   runGit(worktreePath, ['reset', '--soft', mergeBase]);
   ```
   The return value is ignored — `runGit` returns the (empty) stdout from `git reset --soft` which is fine to discard.

8. **Add TODO comments to the remaining ~17 sites.** For each `execSync(\`git ...\`)` in `main/src/` NOT in this task's scope (the 6 in `gitDiffManager.ts` excluding the 2 already covered by TASK-678, plus those in `gitStatusManager.ts`, `executionTracker.ts`, `git.ts`, `dashboard.ts`, `gitPlumbingCommands.ts`), insert a one-line comment immediately above:
   ```ts
   // TODO(TASK-680): migrate to runGit(cwd, args[]) — see main/src/utils/runGit.ts
   ```
   Use a single grep-driven loop, not file-by-file manual edits. The grep target is `grep -rn 'execSync(\`git' main/src/` minus the 2 sites covered by this task minus the 2 in TASK-678 (already addressed in that task's scope by Node-native replacement).

9. **Re-run sweep grep as a completeness gate:**
   ```bash
   grep -nE 'execSync\(.*git (merge-base|reset)' main/src/services/commitManager.ts
   grep -n 'git commit -F' main/src/ipc/file.ts
   ```
   Expected: 0 hits for both.

10. **Run tests:**
    ```bash
    pnpm --filter @cyboflow/main test -- runGit.test.ts
    pnpm --filter @cyboflow/main test
    pnpm typecheck
    ```
    Expected: all exit 0.

## Acceptance Criteria

See frontmatter. New helper exists with sync + async variants; 4 sites migrated; adversarial test proves shell-free invocation; remaining sites have TODO markers for follow-up.

## Test Strategy

A new `runGit.test.ts` provides direct unit coverage of the helper. The migrated call sites are covered by existing integration tests in `commitManager.test.ts` and `file.test.ts` (if absent — confirm during step 10 — add minimal happy-path coverage to lock in the migration's behavior).

## Hardest Decision

**Whether to migrate all ~23 sites in one task or limit to 4 high-priority sites (chosen).** The IDEA explicitly flagged this as "large; Consider splitting into multiple tasks." Limiting to 4 sites for TASK-679:
- Keeps the diff under ~200 LoC, reviewable in one pass.
- Validates the helper on diverse call patterns (sync execSync, async execAsync, with-output, without-output).
- Leaves a clear, grep-discoverable TODO trail for follow-up tasks.
- Defers the harder migrations (e.g. `gitDiffManager.ts:357` `git diff origin/${mainBranch}...HEAD` where the `...` syntax has historically tripped up arg-array migrations on some git versions) to a task with more focused testing budget.

If a future contributor wants to do the full sweep in one shot, the TODO markers make it a mechanical translation — no design uncertainty remains after this task lands.

## Rejected Alternatives

- **Migrate all 23 sites in one PR.** Rejected for review burden. The IDEA explicitly suggested splitting.
- **Migrate ZERO sites, only land the helper.** Rejected — a helper with no production users is dead code that drifts. Proving the helper on real call sites (and especially on the highest-injection-risk `commit -F`/`merge-base`/`reset` sites) is the value.
- **Use `simple-git` (existing dependency in `package.json`?).** Rejected without further investigation. `simple-git` is a heavier abstraction; this task wants a thin shell-free `execFile` wrapper. If `simple-git` is already in use elsewhere, a follow-up sprint can consolidate.
- **Make `runGit` only return Buffer (force callers to decode).** Rejected — `'utf8'` default matches the existing `execSync(..., { encoding: 'utf8' })` ergonomics used by every site in the codebase. Callers that want raw bytes can opt in via `{ encoding: 'buffer' }`.

## Lowest Confidence Area

The exit behavior of `execFileSync` when git's stderr contains an expected-but-noisy message (e.g. `git merge-base` returning a SHA on stdout but a deprecation warning on stderr). `execFileSync` by default mixes stderr into the exception's `stderr` field, and a non-zero exit triggers a throw. The behavior should match `execSync`'s for the same git invocation, but the `merge-base` site at commitManager.ts:197 is inside a `try { ... } catch { ... }` block that intentionally swallows the error — verify that `runGit` throws on the same conditions `execSync` did (non-zero exit) and not on additional conditions (e.g. stderr output with exit 0). If a regression appears in commitManager's integration tests after migration, it's most likely this contract mismatch — the fix would be to add `{ stdio: ['ignore', 'pipe', 'ignore'] }` to suppress stderr at the spawn level, or to widen `runGit`'s return type to include stderr and let the caller decide.
