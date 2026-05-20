---
id: TASK-670
idea: SPRINT-023
status: ready
created: 2026-05-19T00:00:00Z
files_owned:
  - main/src/ipc/file.ts
  - main/src/services/worktreeManager.ts
  - main/src/services/runCommandManager.ts
files_readonly:
  - main/src/utils/shellEscape.ts
  - main/src/utils/commandExecutor.ts
  - main/src/utils/shellDetector.ts
  - main/src/ipc/git.ts
acceptance_criteria:
  - criterion: "No ad-hoc double-quote escape pattern (`.replace(/\"/g, '\\\\\"')`) survives in `main/src`."
    verification: "grep -rnE \"\\.replace\\(/\\\"/g, '\\\\\\\\\\\"'\\)\" main/src --include='*.ts' returns 0 matches."
  - criterion: "No ad-hoc single-quote escape pattern (`.replace(/'/g, \"'\\\"'\\\"'\")`) survives outside `main/src/utils/shellEscape.ts`."
    verification: "grep -rn \"replace(/'/g\" main/src --include='*.ts' returns matches ONLY inside main/src/utils/shellEscape.ts (the canonical helper itself)."
  - criterion: "`main/src/ipc/file.ts` `git:execute-project` handler uses `escapeShellArg` (or `escapeShellArgs`) from `main/src/utils/shellEscape.ts` to build the git command string."
    verification: "grep -nE 'escapeShellArg|escapeShellArgs|buildSafeCommand' main/src/ipc/file.ts returns >=1 match; grep -n '/\"/g' main/src/ipc/file.ts returns 0 matches."
  - criterion: "`main/src/services/worktreeManager.ts` no longer hand-escapes the commit message; uses `buildGitCommitCommand` or `escapeShellArg`."
    verification: "grep -nE 'escapeShellArg|buildGitCommitCommand' main/src/services/worktreeManager.ts returns >=1 match; grep -n 'fullMessage.replace' main/src/services/worktreeManager.ts returns 0 matches."
  - criterion: "`main/src/services/runCommandManager.ts` no longer hand-escapes the worktree path; uses `escapeShellArg`."
    verification: "grep -nE 'escapeShellArg' main/src/services/runCommandManager.ts returns >=1 match; grep -n \"replace(/'/g\" main/src/services/runCommandManager.ts returns 0 matches."
  - criterion: "Injection-attempt smoke test: a worktree path containing `'; touch /tmp/cyboflow-injected-$$; #` (or equivalent) is safely quoted and does not spawn an attacker shell command. (Verified by unit test, not a real exec.)"
    verification: "cd main && pnpm test:unit -- shellEscape runCommandManager exit 0 with the new injection-string test cases present."
  - criterion: "pnpm typecheck and pnpm lint pass."
    verification: "pnpm typecheck && pnpm lint exit 0"
  - criterion: "pnpm build:main succeeds."
    verification: "pnpm build:main exit 0"
depends_on: []
estimated_complexity: medium
epic: crystal-cuts-and-rebrand
test_strategy:
  needed: true
  justification: "Three shell-arg interpolation sites are being migrated to centralized helpers. New unit tests should assert that adversarial inputs (containing single quotes, double quotes, semicolons, backticks, command substitution sequences) are safely escaped by the call sites that now use the helpers. The existing `shellEscape.ts` may have direct unit tests already; if so, extend them — otherwise create."
  targets:
    - behavior: "`escapeShellArg` round-trips strings containing single quotes safely (no shell-evaluable construct survives)."
      test_file: "main/src/utils/__tests__/shellEscape.test.ts"
      type: unit
    - behavior: "`escapeShellArg` round-trips strings containing double quotes, backticks, and `$(...)` safely."
      test_file: "main/src/utils/__tests__/shellEscape.test.ts"
      type: unit
    - behavior: "`buildSafeCommand` produces a command string whose tokens, when evaluated by `bash -c`, match the input args exactly (no command splitting)."
      test_file: "main/src/utils/__tests__/shellEscape.test.ts"
      type: unit
prerequisites:
  - check: "test -f main/src/utils/shellEscape.ts && grep -q 'export function escapeShellArg' main/src/utils/shellEscape.ts"
    fix: "(no fix needed — file should exist; if missing, restore from git history)"
    description: "The migration target helper must exist before any call site can be updated."
    blocking: true
---

# Migrate 3 ad-hoc shell-arg interpolation sites to `escapeShellArg` / `buildSafeCommand`

## Objective

TASK-628 consolidated commit-footer helpers but left three shell-arg interpolation sites still using ad-hoc string-replace escaping. The most consequential is `main/src/ipc/file.ts:811-816` (the `git:execute-project` IPC handler) which interpolates user-supplied `request.args[]` into a shell string via `arg.replace(/"/g, '\\"')` — a real shell-injection surface: any arg containing a single quote, backtick, dollar sign, or semicolon escapes the quoted argument and is evaluated by the shell. `main/src/services/worktreeManager.ts:653` does the same with the commit message, and `main/src/services/runCommandManager.ts:78` uses a hand-rolled single-quote escape `worktreePath.replace(/'/g, "'\"'\"'")` that, while structurally similar to what `escapeShellArg` produces, duplicates non-trivial escape logic that should live in one place. This task migrates all three sites to the canonical helpers in `main/src/utils/shellEscape.ts`.

## Implementation Steps

1. **Pre-flight sweep grep — confirm the three target sites and any others.** Run all three:
   ```bash
   grep -rnE "\\.replace\\(/\"/g, '\\\\\\\\\"'\\)" main/src --include='*.ts'
   grep -rn "replace(/'/g" main/src --include='*.ts'
   grep -rn 'execSync(`git' main/src --include='*.ts'
   ```
   Expected matches:
   - Double-quote escape: `main/src/ipc/file.ts:814`, `main/src/services/worktreeManager.ts:653`.
   - Single-quote escape: `main/src/services/runCommandManager.ts:78`, `main/src/utils/shellEscape.ts:18` (the canonical helper — leave untouched).
   - `execSync(\`git`: `main/src/ipc/file.ts:811` is the primary, plus possibly other sites that already use `escapeShellArg` (verify by inspection).
   If additional ad-hoc escape sites surface that are NOT in the listed three files, STOP and surface them for triage — do not silently expand scope.

2. **Migrate `main/src/ipc/file.ts:794-822` (`git:execute-project` handler):**
   - Add import: `import { escapeShellArgs } from '../utils/shellEscape';` (verify exact relative path against `git.ts`'s existing import — it is `'../utils/shellEscape'`).
   - Replace the inline `request.args.map(arg => { ... }).join(' ')` block (lines ~811-817) with:
     ```ts
     const result = execSync(`git ${escapeShellArgs(request.args)}`, {
       cwd: project.path,
       encoding: 'utf-8',
       maxBuffer: 1024 * 1024 * 10, // 10MB buffer
     });
     ```
   - The previous logic only quoted args containing spaces, newlines, or double quotes. `escapeShellArgs` unconditionally single-quote-wraps every arg, which is safer and what `git.ts` already does for its own ad-hoc commands. Bare flags like `--all` will be wrapped as `'--all'` — git accepts quoted arguments identically.

3. **Migrate `main/src/services/worktreeManager.ts:649-657` (squash-and-commit block):**
   - Confirm the file already imports `appendCommitFooter` (line ~650 context). Add `escapeShellArg` to the existing `shellEscape` import block — or, if the file does not already import from `shellEscape.ts`, add `import { escapeShellArg } from '../utils/shellEscape';`.
   - Replace lines 652-654:
     ```ts
     // Old:
     // const escapedMessage = fullMessage.replace(/"/g, '\\"');
     // command = `git commit -m "${escapedMessage}"`;

     // New:
     command = `git commit -m ${escapeShellArg(fullMessage)}`;
     ```
   - Verify the surrounding `executedCommands.push('git commit -m "..." ...')` log line still reads sensibly; update to `executedCommands.push('git commit -m <message> (in ' + worktreePath + ')');` if needed for log clarity. The log is informational; do not log the actual message body.

4. **Migrate `main/src/services/runCommandManager.ts:77-79`:**
   - Add import: `import { escapeShellArg } from '../utils/shellEscape';`.
   - Replace lines 78-79:
     ```ts
     // Old:
     // const escapedWorktreePath = worktreePath.replace(/'/g, "'\"'\"'");
     // const commandWithEnv = `export WORKTREE_PATH='${escapedWorktreePath}' && ${commandLine}`;

     // New:
     const commandWithEnv = `export WORKTREE_PATH=${escapeShellArg(worktreePath)} && ${commandLine}`;
     ```
   - Note: `escapeShellArg` wraps in single quotes and handles embedded single quotes via `'\\''`. The resulting `commandWithEnv` reads `export WORKTREE_PATH='path/here' && ...` which is semantically identical to the previous hand-rolled form.

5. **Extend or create `main/src/utils/__tests__/shellEscape.test.ts`** (check whether it exists first via `ls main/src/utils/__tests__/`). If it does not exist, create it with these cases:
   - `escapeShellArg('')` returns `"''"`.
   - `escapeShellArg('simple')` returns `"'simple'"`.
   - `escapeShellArg("it's")` returns `"'it'\\''s'"`.
   - `escapeShellArg('with "double" quotes')` returns `"'with \"double\" quotes'"` (no escape inside single-quote wrap).
   - `escapeShellArg('`backtick`')` returns the literal backticks wrapped in single quotes (no command sub).
   - `escapeShellArg('$(rm -rf /)')` returns the literal `$(...)` wrapped — no command substitution.
   - `escapeShellArg("'; touch /tmp/x; #")` returns a safely escaped string that, if pasted into a shell, results in a literal positional argument and does NOT execute `touch`.
   - `escapeShellArgs(['--message', 'has spaces and "quotes"', 'and `backticks`'])` returns a string with three safely quoted tokens.
   - `buildSafeCommand('git', 'commit', '-m', 'hello world')` returns the expected string.

6. **Optional: add a runCommandManager-level test** that asserts a worktreePath containing single quotes is rendered into a `commandWithEnv` string that, when split on `&&`, yields a `WORKTREE_PATH=...` token wrapping the path safely. This is a unit-level assertion against the string built; do NOT actually spawn the pty in the test.

7. **Completeness gate — re-run the sweep greps:**
   ```bash
   grep -rnE "\\.replace\\(/\"/g, '\\\\\\\\\"'\\)" main/src --include='*.ts'    # expect 0 matches
   grep -rn "replace(/'/g" main/src --include='*.ts'                            # expect 1 match only: shellEscape.ts:18
   ```
   Both must satisfy the AC's stated counts before reporting COMPLETED.

8. **Build + typecheck + lint + tests:**
   ```bash
   pnpm typecheck
   pnpm lint
   pnpm build:main
   cd main && pnpm test:unit -- shellEscape
   ```
   All exit 0.

## Acceptance Criteria

- Three call sites migrated to centralized helpers (greps in AC).
- No ad-hoc double-quote escape pattern survives anywhere in `main/src`.
- The single-quote escape pattern survives ONLY inside `main/src/utils/shellEscape.ts` (the canonical helper).
- New / extended `shellEscape.test.ts` exercises adversarial inputs (single quotes, double quotes, backticks, `$(...)`, semicolons).
- `pnpm typecheck`, `pnpm lint`, `pnpm build:main`, and the targeted unit tests pass.

## Test Strategy

Add a unit test file `main/src/utils/__tests__/shellEscape.test.ts` (or extend if it exists). The tests exercise `escapeShellArg`, `escapeShellArgs`, and `buildSafeCommand` against:
- Empty string and ASCII control cases.
- Strings with embedded single quotes (the canonical hard case — the helper's escape mechanism is `'\\''`).
- Strings with embedded double quotes (must remain literal inside single-quote wrap).
- Strings with backticks, `$(...)`, and `${...}` (must not trigger command substitution).
- Strings with semicolons and `&&` / `||` operators (must remain literal, not split commands).
- Strings with newlines (must remain a single token).

No tests run actual shell commands — the assertions are on the produced string. The helper's correctness is what matters; the consumers (`file.ts`, `worktreeManager.ts`, `runCommandManager.ts`) inherit safety by delegation.

Optionally add one call-site-level test in `main/src/services/__tests__/runCommandManager.test.ts` (if it exists) asserting that a worktreePath with embedded quotes produces a safely-quoted `commandWithEnv` string — but this is secondary to the helper-level tests.

## Hardest Decision

**`escapeShellArgs` vs. spawn-with-array.** A safer migration would be to switch `git:execute-project` from `execSync(\`git ${args.join(' ')}\`)` to `spawn('git', args, { cwd })` — no shell, no escaping, no possibility of injection. This was considered and rejected for THIS task:
- Changing the exec model from `execSync` (sync, string-buffer return) to `spawn` (async, stream-based) requires rewriting the success-path return shape (`return { success: true, output: result }`) and the error-handling block (stdout/stderr buffer extraction). It is a larger refactor than the scope of this task, and risks breaking callers that rely on the synchronous string return.
- The downstream improvement (use `spawn` array-form) should be a follow-up task. For now, `escapeShellArgs` matches what `main/src/ipc/git.ts` already does for its own git interpolations — consistency over rewrite.

Reversal trigger: if a sibling task surfaces a need for streaming stdout from `git:execute-project` (large diffs, long-running operations), the spawn migration becomes natural and supersedes this escaping fix.

## Rejected Alternatives

- **Wrap the entire shell command in a template helper (`runGit(projectPath, args)`).** Considered — would deduplicate the cwd/maxBuffer/error-handling boilerplate across `git:execute-project` and other `execSync(\`git ...\`)` sites. Rejected as scope creep for this task; the work item explicitly says "Add a CODE-PATTERNS.md note pointing at the canonical helpers (deferred — handled in a separate task if appropriate)." Track as a follow-up.
- **Use `child_process.execFile` with the bare git binary.** Equivalent safety to spawn-with-array; same reason as Hardest Decision — out of scope for a defect fix.
- **Add a runtime allow-list of git subcommands.** Considered as defense-in-depth (the IPC handler accepts any `args[]`, so the renderer could request `git push --force origin main`). Rejected as a separate authorization concern — orthogonal to escaping. If desired, surface as a separate idea.

## Lowest Confidence Area

The `runCommandManager.ts:78` migration. The current hand-rolled escape (`worktreePath.replace(/'/g, "'\"'\"'")`) and `escapeShellArg`'s escape (`"'" + arg.replace(/'/g, "'\\''") + "'"`) produce structurally identical output for a path containing a single quote: both yield `'path'\''with'quote'`. But the surrounding template differs — the old form interpolates the escaped path INSIDE single quotes (`'${escapedWorktreePath}'`), while `escapeShellArg` wraps the entire value (the resulting interpolation becomes `${escapeShellArg(path)}` with no outer quotes). For typical paths (no single quotes) both produce `'path'`. For pathological paths with embedded single quotes, both produce the same `'path'\''embedded'\''rest'` form. Worth manually eyeballing the produced `commandWithEnv` strings for a few cases (plain path, path with space, path with single quote) before reporting COMPLETED — the test in step 6 covers this.

A second uncertainty: whether `escapeShellArgs(['--all'])` (producing `'--all'`) is accepted by git in all subcommand positions. Empirically yes — git tokenizes quoted flags identically to unquoted ones — but if a smoke test surfaces a git invocation that rejects the quoted form, fall back to passing the bare flag through unchanged. Not expected based on git's documented arg parsing.
