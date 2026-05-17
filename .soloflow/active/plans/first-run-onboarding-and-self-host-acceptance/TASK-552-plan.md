---
id: TASK-552
idea: IDEA-012
idea_id: IDEA-012
status: in-flight
created: "2026-05-11T00:00:00Z"
files_owned:
  - main/src/ipc/project.ts
  - main/src/utils/gitignoreWriter.ts
  - main/src/utils/gitignoreWriter.test.ts
files_readonly:
  - main/src/services/worktreeManager.ts
  - frontend/src/types/project.ts
acceptance_criteria:
  - criterion: "On projects:create handler success, .cyboflow/worktrees/ is appended to <projectPath>/.gitignore if not already present."
    verification: "Read main/src/ipc/project.ts; the projects:create handler calls ensureGitignoreEntry(project.path, '.cyboflow/worktrees/') AFTER the createProject call and BEFORE returning success."
  - criterion: "If .gitignore does not exist, it is created with the single line '.cyboflow/worktrees/\n'."
    verification: "Unit test in main/src/utils/gitignoreWriter.test.ts: temp dir with no .gitignore → call ensureGitignoreEntry → assert .gitignore exists with exact content '.cyboflow/worktrees/\n'."
  - criterion: "If .gitignore already contains the entry (with or without trailing slash, with or without leading slash, on any line), no duplicate is appended."
    verification: "Unit tests for three idempotency cases: existing '.cyboflow/worktrees/', '.cyboflow/worktrees', '/.cyboflow/worktrees/' — all three must short-circuit without writing."
  - criterion: "If .gitignore exists but does not end with a newline, ensureGitignoreEntry prepends a newline before the new entry to avoid joining lines."
    verification: "Unit test: pre-populate .gitignore with 'node_modules' (no trailing newline) → call → assert resulting file is 'node_modules\n.cyboflow/worktrees/\n'."
  - criterion: "Errors writing to .gitignore (e.g., permission denied, directory not writable) are logged but do not fail project creation — the project still appears in the project list."
    verification: "Unit test: mock fs.writeFileSync to throw → call ensureGitignoreEntry → assert no exception propagates; in project.ts handler, ensureGitignoreEntry is wrapped in try/catch with console.error."
depends_on: []
estimated_complexity: low
epic: first-run-onboarding-and-self-host-acceptance
test_strategy:
  needed: true
  justification: "Pure file-IO helper with branching idempotency rules. Easy to test, easy to regress; a typo in the entry-pattern match (leading slash vs no leading slash) would silently duplicate lines forever."
  targets:
    - behavior: Creates .gitignore from scratch if missing
      test_file: main/src/utils/gitignoreWriter.test.ts
      type: unit
    - behavior: Idempotent across all forms of the entry
      test_file: main/src/utils/gitignoreWriter.test.ts
      type: unit
    - behavior: Handles trailing-newline-missing case
      test_file: main/src/utils/gitignoreWriter.test.ts
      type: unit
    - behavior: Swallows fs errors without throwing
      test_file: main/src/utils/gitignoreWriter.test.ts
      type: unit
---
# Auto-Write .cyboflow/worktrees/ to Project .gitignore on Project Add

## Objective

When a user adds (or initializes) a project, the project's `.gitignore` must contain `.cyboflow/worktrees/` so the deterministic-named worktrees Cyboflow creates under `<repo>/.cyboflow/worktrees/` (per `workflow-runs-and-day3-gate` epic, ROADMAP-001.md line 116) do not appear as untracked changes in the user's main checkout. This is a zero-friction default that removes a manual setup step the user would otherwise have to repeat per project.

## Implementation Steps

1. Create `main/src/utils/gitignoreWriter.ts` exporting `ensureGitignoreEntry(projectPath: string, entry: string): void`:
   - Compute `gitignorePath = path.join(projectPath, '.gitignore')`.
   - If `fs.existsSync(gitignorePath)` is false, write `entry + '\n'` and return.
   - Otherwise read the file as utf8.
   - Normalize each line: trim trailing whitespace, strip leading `/`, strip trailing `/`. Normalize the target entry the same way.
   - If any normalized line matches the normalized entry, return (idempotent).
   - Determine if the file ends with `\n`; if not, prepend `\n` to the new write content.
   - Append `entry + '\n'` using `fs.appendFileSync`.
   - Wrap the entire body in try/catch — log to `console.error` with prefix `[gitignoreWriter]`, never throw.

2. Modify `main/src/ipc/project.ts`:
   - Import `ensureGitignoreEntry` from `../utils/gitignoreWriter`.
   - In the `projects:create` IPC handler, after `databaseService.createProject(...)` returns a project, BEFORE the analytics tracking block (around line 153), call `ensureGitignoreEntry(projectData.path, '.cyboflow/worktrees/')` wrapped in try/catch that logs but does not return error to the renderer.
   - Also call it in the `projects:activate` handler? **No** — activation does not mutate the project filesystem and should remain idempotent. Only call on create.

3. Create `main/src/utils/gitignoreWriter.test.ts` covering:
   - Missing .gitignore → file created with single entry + newline.
   - Existing .gitignore with the exact entry → no write.
   - Existing .gitignore with `.cyboflow/worktrees` (no trailing slash) → no write (idempotent match).
   - Existing .gitignore with `/.cyboflow/worktrees/` (leading slash) → no write.
   - Existing .gitignore not ending in newline → newline-prefixed append produces correctly-separated lines.
   - `fs.writeFileSync` mocked to throw → function returns void without rethrowing.

4. Do NOT modify worktreeManager — that service creates worktrees but the .gitignore concern is project-lifecycle, not worktree-lifecycle.

## Acceptance Criteria

See frontmatter. The key property is idempotency: a user re-adding the same project, or pre-creating their own .gitignore entry, must produce zero duplicate lines.

## Test Strategy

Unit tests under `main/src/utils/gitignoreWriter.test.ts` covering the four branches (missing file, entry present in three forms, missing trailing newline, fs error). No integration test against the IPC handler is needed — that wiring is a single function call.

## Hardest Decision

Whether to also append `.cyboflow/worktrees/` on `projects:activate` (which is the path that gets called when an existing project is re-opened). Picked NO. Rationale: activation is a UX flow that should not surprise users by mutating their filesystem. The first activation after upgrading from an early Cyboflow build that lacked this entry will need a manual fix — but the alternative (write-on-activate) means every re-open touches .gitignore, which violates least-surprise. This is the safer default.

## Rejected Alternatives

- Calling out to `git check-ignore` to verify. Rejected — slower, requires git CLI, and the literal-line-match approach is correct for 100% of realistic .gitignore contents.
- Using `ignore` npm package for parsing. Rejected — adding a dep for a 30-line helper is overkill, and `ignore` does not have an "add entry idempotently" API anyway.

## Lowest Confidence Area

The line-normalization match logic for unusual `.gitignore` patterns — e.g., a glob like `.cyboflow/**` or a negation `!.cyboflow/worktrees/important.txt`. The current spec treats those as non-matches and would still append our literal line, producing a redundant but non-harmful entry. If the self-host run surfaces a project where a user has a glob entry that already covers this path, refine the matcher; for v1 it is acceptable noise.
