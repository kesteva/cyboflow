---
id: TASK-678
idea: SPRINT-025-compounder
status: ready
created: 2026-05-20T00:00:00Z
files_owned:
  - main/src/services/gitDiffManager.ts
  - main/src/services/__tests__/gitDiffManager.test.ts
files_readonly:
  - main/src/utils/shellEscape.ts
  - main/src/utils/__tests__/shellEscape.test.ts
acceptance_criteria:
  - criterion: "Neither line 490 (`wc -l < \"${filePath}\"`) nor line 597 (`cat \"${filePath}\"`) of `main/src/services/gitDiffManager.ts` uses `execSync` with shell-interpolated filenames. Both sites either (a) read the file via `fs.readFileSync` / `fs.statSync` without invoking a shell, or (b) use `execFile`/`execFileSync` with arg arrays so filenames are passed as positional args, never parsed by the shell."
    verification: "Run `grep -nE 'execSync\\(.*\\$\\{filePath\\}|execSync\\(`?wc -l|execSync\\(`?cat' main/src/services/gitDiffManager.ts` and confirm 0 hits."
  - criterion: "An adversarial-filename test exists that asserts a filename containing `$(touch /tmp/cyboflow-pwned)`, backticks, or `${...}` substitution patterns does NOT execute the embedded shell command. The test must construct a git repo (or a stubbed `getUntrackedFiles`) with such a filename and call the public `getDiffStats` (line 466) and `createDiffForUntrackedFiles` paths."
    verification: "grep -n 'pwned\\|adversarial\\|injection' main/src/services/__tests__/gitDiffManager.test.ts returns at least 2 hits, AND running `pnpm --filter @cyboflow/main test -- gitDiffManager.test.ts` exits 0."
  - criterion: "All other behavior of `getDiffStats` and `createDiffForUntrackedFiles` is preserved: untracked file line counts still contribute to additions; untracked-file diff blocks still include the `diff --git a/<file> b/<file>` header, the `new file mode 100644` line, the `+++ b/<file>` line, the `@@ -0,0 +1,N @@` hunk header, and each file line prefixed with `+`."
    verification: "Run `pnpm --filter @cyboflow/main test -- gitDiffManager.test.ts` and confirm any existing tests that exercise these output shapes continue to pass. If no such test exists today, add at least one happy-path test alongside the adversarial test to lock in the diff output shape."
  - criterion: "Typecheck passes."
    verification: "Run `pnpm typecheck`; exit code 0."
depends_on: []
estimated_complexity: low
epic: crystal-cuts-and-rebrand
test_strategy:
  needed: true
  justification: "Security regression test is mandatory. The bug class (shell injection via untracked filename) must be locked in with an adversarial-filename test so a future regression to the unsafe interpolation pattern is caught immediately. No existing `gitDiffManager.test.ts` file exists today (`Glob: main/src/services/__tests__/gitDiffManager*` returned 0 files), so this task creates one. Sibling tests already use this pattern via `main/src/utils/__tests__/shellEscape.test.ts` (already added by TASK-670)."
  targets:
    - behavior: "A filename containing $(touch /tmp/cyboflow-pwned) does NOT create /tmp/cyboflow-pwned when getDiffStats() iterates untracked files."
      test_file: "main/src/services/__tests__/gitDiffManager.test.ts"
      type: integration
    - behavior: "A filename containing backticks does NOT execute the backticked command when createDiffForUntrackedFiles() reads file contents."
      test_file: "main/src/services/__tests__/gitDiffManager.test.ts"
      type: integration
    - behavior: "Happy path: a normal filename's untracked-file line count is correctly added to the diff stats; the produced diff block matches the canonical shape."
      test_file: "main/src/services/__tests__/gitDiffManager.test.ts"
      type: integration
---

# Eliminate shell injection in gitDiffManager.ts (lines 490 + 597)

## Objective

`main/src/services/gitDiffManager.ts:490` and `:597` interpolate filenames from `git ls-files --others` output into shell-invoked `execSync(\`wc -l < "${filePath}"\`)` and `execSync(\`cat "${filePath}"\`)` commands. A malicious repo containing a filename like `$(touch /tmp/pwned).txt` or `` `rm -rf ~`.md `` will execute attacker-chosen commands when a user opens that worktree's diff. TASK-670's shell-arg escape migration missed these two sites because they don't call git directly — they invoke `wc` and `cat`. The fix is to stop invoking a shell at all: read files with Node's `fs.readFileSync` / `fs.statSync` instead. This is both safer (no shell parser involved) and faster (no process spawn per file).

## Implementation Steps

1. **Pre-flight: confirm the current attack surface.** Run:
   ```bash
   grep -nE 'execSync\(.*\$\{filePath\}|execSync\(`?wc -l|execSync\(`?cat' main/src/services/gitDiffManager.ts
   ```
   Expected: 2 hits (line 490 `wc -l`, line 597 `cat`). After this task, expected: 0 hits.

2. **Add `fs` import** at the top of `main/src/services/gitDiffManager.ts`. Check existing imports — if `fs` is not already imported, add:
   ```ts
   import * as fs from 'node:fs';
   ```
   (Or `import { readFileSync, statSync } from 'node:fs';` if the file prefers named imports — match the existing style.)

3. **Fix line 490 (`wc -l < "${filePath}"`).** The current block at lines 480-498 counts newlines per untracked file to compute `untrackedAdditions`. Replace the `execSync(\`wc -l < "${filePath}"\`, ...)` call with a Node-native read:
   ```ts
   try {
     const cleanFile = file.trim();
     const filePath = `${worktreePath}/${cleanFile}`;
     // Read the file directly — no shell involved, so filenames with $(...) /
     // backticks / ${...} cannot inject commands. Use 'utf8' to mirror the
     // semantics of `wc -l`, which counts newline characters in text mode.
     const content = fs.readFileSync(filePath, 'utf8');
     // `wc -l` counts \n occurrences (no trailing-newline adjustment); match that exactly.
     const lineCount = (content.match(/\n/g) || []).length;
     untrackedAdditions += lineCount;
   } catch {
     // Skip files that can't be read (binary, permission denied, missing, etc.)
   }
   ```
   The behavior preserved: each untracked file contributes its newline count to `untrackedAdditions`. The behavior changed: large binary files no longer cause an unbounded `wc` spawn (the read still returns a buffer, but readFileSync's behavior is bounded by the file size; for safety, a follow-up could add a size check via `fs.statSync` but that is out of scope here).

4. **Fix line 597 (`cat "${filePath}"`).** The current block at lines 585-622 reads each untracked file's full content to construct a diff-like output. Replace the `execSync(\`cat "${filePath}"\`, ...)` call with a `fs.readFileSync` that preserves the existing `maxBuffer: 1024 * 1024` (1 MB) bound:
   ```ts
   try {
     const cleanFile = file.trim();
     const filePath = `${worktreePath}/${cleanFile}`;
     // Pre-flight size check matches the previous `maxBuffer: 1MB` bound from
     // execSync — large files are skipped (caught below) to avoid OOM.
     const stat = fs.statSync(filePath);
     if (stat.size > 1024 * 1024) {
       throw new Error(`File too large: ${stat.size} bytes`);
     }
     const fileContent = fs.readFileSync(filePath, 'utf8');

     // Create a diff-like format for the new file (unchanged from before)
     diffOutput += `diff --git a/${cleanFile} b/${cleanFile}\n`;
     diffOutput += `new file mode 100644\n`;
     diffOutput += `index 0000000..0000000\n`;
     diffOutput += `--- /dev/null\n`;
     diffOutput += `+++ b/${cleanFile}\n`;

     const lines = fileContent.split('\n');
     if (lines.length > 0) {
       diffOutput += `@@ -0,0 +1,${lines.length} @@\n`;
       for (const line of lines) {
         diffOutput += `+${line}\n`;
       }
     }
   } catch (error) {
     // Skip files that can't be read (binary files, oversize, missing, etc.)
     const cleanFile = file.trim();
     this.logger?.verbose(`Could not read untracked file ${cleanFile}: ${error}`);
   }
   ```
   The diff-output shape (lines 603-616 in the original) is preserved byte-for-byte. The size bound (`maxBuffer: 1024 * 1024`) is reproduced explicitly via `fs.statSync` to match the previous behavior — files over 1 MB are skipped.

5. **Re-run the pre-flight grep** as a completeness gate:
   ```bash
   grep -nE 'execSync\(.*\$\{filePath\}|execSync\(`?wc -l|execSync\(`?cat' main/src/services/gitDiffManager.ts
   ```
   Expected: 0 hits.

6. **Create the test file** at `main/src/services/__tests__/gitDiffManager.test.ts`. The test must:
   - Create a temporary git repo (via `simple-git` or `execSync('git init', { cwd: tmpDir })` — `execSync` here is fine because the args are hard-coded constants, not interpolated).
   - Inside that repo, create files with adversarial names. **Filesystem caveat:** macOS APFS and Linux ext4 allow `$`, `` ` ``, `(`, `)`, and `{}` in filenames; if the test fails on Windows runners due to invalid filename characters, gate the test with `it.runIf(process.platform !== 'win32')`. Use a path like:
     - `'$(touch ' + path.join(os.tmpdir(), 'cyboflow-pwned-' + Date.now()) + ').txt'` — chosen to make the side-effect detectable.
     - `` '`echo backtick-pwned > ' + path.join(os.tmpdir(), 'cyboflow-pwned-bt.txt') + '`.md' `` — second variant.
   - Call `new GitDiffManager(logger).getDiffStats(tmpDir)` — this exercises the line-490 path via `getUntrackedFiles` → `wc -l` replacement.
   - Call `new GitDiffManager(logger).getDiff(tmpDir, ...)` (or whichever public method invokes `createDiffForUntrackedFiles`) — this exercises the line-597 path.
   - Assert the pwned marker file was NOT created: `expect(fs.existsSync(markerPath)).toBe(false)`.
   - Add a happy-path test: a normal filename `'normal.txt'` with two lines of content; assert `stats.additions === 2` (matches `wc -l`'s newline count) and the diff output contains `diff --git a/normal.txt b/normal.txt`, `+line1`, `+line2`.

7. **Run the new test file** in isolation:
   ```bash
   pnpm --filter @cyboflow/main test -- gitDiffManager.test.ts
   ```
   Expected: all assertions pass. If the adversarial-filename creation itself fails (filesystem rejection), record the failure path and gate appropriately.

8. **Run the full main workspace test suite** to confirm no consumer of `getDiffStats` / `createDiffForUntrackedFiles` is broken by the line-count or read-shape changes:
   ```bash
   pnpm --filter @cyboflow/main test
   ```

## Acceptance Criteria

See frontmatter. Zero shell-interpolated filename invocations remain in gitDiffManager.ts; adversarial-filename tests prove the injection vector is closed; existing behavior is preserved.

## Test Strategy

A new test file `main/src/services/__tests__/gitDiffManager.test.ts` covers:
1. Injection-vector closed: filenames containing `$(...)` and `` `...` `` do not execute the embedded command.
2. Behavioral parity: a normal 2-line untracked file produces `additions: 2` (matching `wc -l`'s newline count).
3. Diff-output shape preserved: the `diff --git a/...`, `new file mode`, `@@ -0,0 +1,N @@`, and `+`-prefixed line shapes match the prior `cat`-based implementation.

Mocking: none — use real temp directories and real git invocations. The test must be skippable on Windows where filename characters may differ.

## Hardest Decision

**Whether to use `fs.readFileSync` (Node-native) or migrate to `execFile('wc', ['-l', filePath])` / `execFile('cat', [filePath])` (still shell-free, but preserves external-binary semantics).** Chose Node-native because:
- It's strictly safer: zero possibility of any shell or PATH-resolution attack.
- It's faster: no process spawn per file.
- The semantics match closely enough — `wc -l`'s newline count is replicable with a single `String.match(/\n/g)`. The 1 MB cap from `maxBuffer` is replicable with `statSync`.
- It removes a dependency on `/usr/bin/wc` and `/usr/bin/cat` existing in the PATH (relevant on minimal containers).

The `execFile` alternative was the IDEA's preferred direction ("Migrate to `execFile`-backed `runGit(args[])` helper"). For `wc`/`cat` specifically, the Node-native path is simpler and dominates on all axes. For the actual `git` invocations in TASK-679 (B6), the `execFile`-backed helper is the right tool — those genuinely need git's behavior.

## Rejected Alternatives

- **Use `execFile('wc', ['-l', filePath])` / `execFile('cat', [filePath])`.** Rejected as above — Node-native is strictly better here. Would change my mind if the spec required preserving locale-dependent `wc` quirks (it doesn't).
- **Add `escapeShellArg(filePath)` and keep the `execSync` calls.** Rejected — escaping is a workaround when a shell is genuinely needed; here no shell is needed at all. Also fragile: a future contributor might forget the escape on a third site.
- **Only fix line 597 (the `cat` site) because it reads file contents, and leave line 490 (the `wc -l` site) because it "only" counts lines.** Rejected — both sites have identical injection surfaces. The shell parser doesn't care what the command does after substitution.

## Lowest Confidence Area

The exact public API surface to exercise from the new test. `getDiffStats` is called on a worktree path and returns `{ additions, deletions, filesChanged }`; the untracked-file accumulation is internal. To trigger `createDiffForUntrackedFiles`, the test likely needs to call a different public method (probably one of `getDiff`, `getDiffForCommit`, or `getCommitDiffStats`) and inspect the returned string. Mitigation: read the rest of `gitDiffManager.ts` to enumerate public methods at test-authoring time, and pick the one(s) that route through both code paths. If no single public method exercises both, write two tests — one per public method — covering one injection site each.
