---
id: TASK-352
idea: IDEA-008
status: ready
created: 2026-05-11T00:00:00Z
files_owned:
  - main/src/services/worktreeManager.ts
  - main/src/orchestrator/runLauncher.ts
  - main/src/orchestrator/__tests__/runLauncher.test.ts
  - main/src/services/__tests__/worktreeManager.test.ts
files_readonly:
  - main/src/orchestrator/workflowRegistry.ts
  - main/src/services/sessionManager.ts
  - docs/cyboflow_system_design.md
  - shared/types/workflows.ts
  - .gitignore
acceptance_criteria:
  - criterion: "`WorktreeManager.createDeterministicWorktree(projectPath, workflowName, runId)` creates a worktree at `<projectPath>/.cyboflow/worktrees/<workflowName>/<runId8>` where `runId8` is the first 8 chars of `runId`"
    verification: "Test `worktreeManager.test.ts > createDeterministicWorktree > path matches scheme`: call with projectPath=/tmp/foo, workflowName='sprint', runId='a3f2b1c09d8e...'; assert returned worktreePath ends with `.cyboflow/worktrees/sprint/a3f2b1c0`."
  - criterion: "The git branch created for the worktree is `cyboflow/<workflowName>/<runId8>` (matching the same 8-char suffix)"
    verification: "Test `createDeterministicWorktree > branch matches scheme`: inspect the returned `baseBranch` / branch metadata; assert `cyboflow/sprint/a3f2b1c0` is created. In integration with git, verify via `git branch --list 'cyboflow/sprint/a3f2b1c0'` in the test fixture repo."
  - criterion: "When `ensureGitignoreEntry(projectPath)` runs against a project whose `.gitignore` does NOT contain `.cyboflow/worktrees/`, the line `.cyboflow/worktrees/` is appended (with a trailing newline)"
    verification: "Test `runLauncher.test.ts > ensureGitignoreEntry > appends entry when missing`: create temp dir with .gitignore containing only 'node_modules'; call ensureGitignoreEntry; read .gitignore; assert it now contains '.cyboflow/worktrees/'."
  - criterion: "When `.gitignore` already contains `.cyboflow/worktrees/` (with or without a trailing slash, exact line match), the function does NOT append a duplicate"
    verification: "Test `ensureGitignoreEntry > idempotent when entry present`: pre-seed .gitignore with '.cyboflow/worktrees/\\n'; call ensureGitignoreEntry; assert file content is unchanged (no duplicate appended)."
  - criterion: "When `.gitignore` does not exist, `ensureGitignoreEntry` creates it with the single line `.cyboflow/worktrees/`"
    verification: "Test `ensureGitignoreEntry > creates .gitignore when missing`: temp dir with no .gitignore; call function; assert file exists with content '.cyboflow/worktrees/\\n'."
  - criterion: "`RunLauncher.launch(workflowId)` orchestrates: workflowRegistry.createRun → ensureGitignoreEntry → createDeterministicWorktree → UPDATE workflow_runs with worktree_path and branch_name. After launch, workflow_runs row has non-null worktree_path and branch_name."
    verification: "Test `runLauncher.test.ts > launch > updates workflow_runs row with worktree metadata`: spy on createDeterministicWorktree and workflowRegistry; call launch; assert workflow_runs row in DB has worktree_path matching the scheme and branch_name matching `cyboflow/<workflow>/<runId8>`."
  - criterion: "Worktree creation uses `withLock('worktree-create-<projectPath>-<runId8>')` to prevent concurrent creates from clashing on the same path"
    verification: "grep -n \"withLock\\(\\s*[\\`'\\\"]worktree-create\" main/src/services/worktreeManager.ts returns at least 1 match in or near the new `createDeterministicWorktree` method body."
depends_on: [TASK-351]
estimated_complexity: medium
epic: workflow-runs-and-day3-gate
test_strategy:
  needed: true
  justification: "Deterministic naming is a load-bearing invariant (queue groups, branch cleanup commands assume the scheme); .gitignore mutation has three branches (missing file, missing entry, entry present) each of which must be exact; the orchestration sequence in RunLauncher.launch is what wires every downstream task — a regression here breaks the whole pipeline."
  targets:
    - behavior: "createDeterministicWorktree path matches the cyboflow/<workflow>/<runId8> scheme"
      test_file: "main/src/services/__tests__/worktreeManager.test.ts"
      type: unit
    - behavior: "createDeterministicWorktree creates the matching git branch"
      test_file: "main/src/services/__tests__/worktreeManager.test.ts"
      type: integration
    - behavior: "ensureGitignoreEntry covers append / idempotent / create-new cases"
      test_file: "main/src/orchestrator/__tests__/runLauncher.test.ts"
      type: unit
    - behavior: "RunLauncher.launch updates workflow_runs row with worktree_path and branch_name"
      test_file: "main/src/orchestrator/__tests__/runLauncher.test.ts"
      type: unit
---

# Deterministic Worktree Naming and .gitignore Auto-Write

## Objective

Replace Crystal's AI-driven worktree naming with the deterministic, sortable, greppable scheme `cyboflow/<workflow-name>/<runId8>`, with worktrees rooted at `<repo>/.cyboflow/worktrees/<workflow-name>/<runId8>/`. Auto-write `.cyboflow/worktrees/` to the repo's `.gitignore` on first run so the user's git status never shows worktree pollution. This is the substrate every subsequent task relies on: per-run `.mcp.json` is written into this path, Claude is spawned with this path as cwd, and `git branch -D 'cyboflow/*'` cleanly scrubs all Cyboflow branches in one command.

## Implementation Steps

1. **Extend `main/src/services/worktreeManager.ts`** with a new public method `createDeterministicWorktree`:
   ```ts
   async createDeterministicWorktree(
     projectPath: string,
     workflowName: string,
     runId: string,
     baseBranch?: string
   ): Promise<{ worktreePath: string; branchName: string; baseCommit: string; baseBranch: string }> {
     const runId8 = runId.slice(0, 8);
     const branchName = `cyboflow/${workflowName}/${runId8}`;
     const relativeDir = path.join('.cyboflow', 'worktrees', workflowName, runId8);
     return await withLock(`worktree-create-${projectPath}-${runId8}`, async () => {
       const worktreePath = path.join(projectPath, relativeDir);
       // ensure parent dir exists
       await fs.promises.mkdir(path.dirname(worktreePath), { recursive: true });
       // reuse existing createWorktree's internal git logic, but with the deterministic path/branch
       const baseDir = path.join(projectPath, '.cyboflow', 'worktrees', workflowName);
       // Call into the existing collision-cleanup + branch-create sequence inline
       // (see existing createWorktree implementation; refactor the post-baseDir-resolution
       // body into a private helper `_createAtPath(projectPath, worktreePath, branchName, baseBranch)`)
       return await this._createAtPath(projectPath, worktreePath, branchName, baseBranch);
     });
   }
   ```
   Refactor the body of the existing `createWorktree` from line ~80 onward into a private `_createAtPath(projectPath, worktreePath, branchName, baseBranch?)` helper so both the legacy `createWorktree` and the new `createDeterministicWorktree` share the git-worktree-add logic without duplication. The existing `createWorktree` keeps its API stable for Crystal session callers.

2. **Create `main/src/orchestrator/runLauncher.ts`** exporting `class RunLauncher`:
   ```ts
   import * as fs from 'fs/promises';
   import * as path from 'path';
   import type { WorkflowRegistry } from './workflowRegistry';
   import type { WorktreeManager } from '../services/worktreeManager';
   import type { DatabaseService } from '../database/database';
   import type { Logger } from '../utils/logger';

   export class RunLauncher {
     constructor(
       private db: DatabaseService,
       private workflowRegistry: WorkflowRegistry,
       private worktreeManager: WorktreeManager,
       private logger: Logger
     ) {}

     async launch(workflowId: number, projectPath: string): Promise<{ runId: string; worktreePath: string; branchName: string; permissionMode: string }> {
       await this.ensureGitignoreEntry(projectPath);
       const workflow = this.workflowRegistry.getById(workflowId);
       if (!workflow) throw new Error(`workflow ${workflowId} not found`);
       const { runId, permissionMode } = this.workflowRegistry.createRun(workflowId);
       const { worktreePath, branchName } = await this.worktreeManager.createDeterministicWorktree(
         projectPath, workflow.name, runId
       );
       this.db.getDatabase().prepare(
         'UPDATE workflow_runs SET worktree_path = ?, branch_name = ?, status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
       ).run(worktreePath, branchName, 'starting', runId);
       return { runId, worktreePath, branchName, permissionMode };
     }

     async ensureGitignoreEntry(projectPath: string): Promise<void> {
       const gitignorePath = path.join(projectPath, '.gitignore');
       const targetLine = '.cyboflow/worktrees/';
       let content = '';
       try {
         content = await fs.readFile(gitignorePath, 'utf-8');
       } catch (err: any) {
         if (err.code !== 'ENOENT') throw err;
         // .gitignore does not exist — create it with just the target line
         await fs.writeFile(gitignorePath, targetLine + '\n', 'utf-8');
         this.logger.info(`Created ${gitignorePath} with .cyboflow/worktrees/ entry`);
         return;
       }
       // Match the line exactly (with optional trailing slash, leading whitespace tolerated)
       const lines = content.split(/\r?\n/);
       const present = lines.some(l => l.trim() === '.cyboflow/worktrees/' || l.trim() === '.cyboflow/worktrees');
       if (present) return;
       const suffix = content.endsWith('\n') || content === '' ? '' : '\n';
       await fs.writeFile(gitignorePath, content + suffix + targetLine + '\n', 'utf-8');
       this.logger.info(`Appended .cyboflow/worktrees/ to ${gitignorePath}`);
     }
   }
   ```

3. **Write `main/src/services/__tests__/worktreeManager.test.ts`** (new file).
   - Use vitest. Use a real temp git repo (init via execSync) for the integration-style test of `createDeterministicWorktree`; the path-matching test can mock out the git execution and just verify the path/branch strings the manager computes.
   - Test cases: path scheme verification (use stub git), branch scheme verification (real git in temp dir).

4. **Write `main/src/orchestrator/__tests__/runLauncher.test.ts`**.
   - Cover `ensureGitignoreEntry` three branches with temp files (`os.tmpdir()` + `randomUUID()` for isolation).
   - Cover `launch()` end-to-end using mocked `WorkflowRegistry` (returns canned runId + permissionMode) and mocked `WorktreeManager.createDeterministicWorktree` (returns canned worktreePath + branchName). Verify the workflow_runs row is UPDATEd with these values and status='starting'.

5. **Do NOT delete the existing `createWorktree` method.** Crystal session creation still uses it. The deterministic method is additive. The roadmap's `crystal-cuts-and-rebrand` epic is responsible for ripping out the `WorktreeNameGenerator` API hop call site in `taskQueue.ts`; that work is out of scope for this task.

## Acceptance Criteria

See frontmatter. The 7 criteria together specify: (1-2) the path and branch scheme, (3-5) the three branches of `.gitignore` mutation, (6) the orchestration glue, (7) the lock primitive guarding concurrent creates.

## Test Strategy

See `test_strategy.targets`. The branch-creation test is integration-flavored (needs `git` in PATH for a temp repo); the path and `.gitignore` tests are pure-unit and run without git. CI environments running these tests need `git` installed — already a requirement of the existing test suite.

## Hardest Decision

Where to put the `.gitignore` mutation logic. Options:
- (a) Inside `WorktreeManager.createDeterministicWorktree` — couples worktree creation to filesystem write; harder to test in isolation; runs on every launch (wasteful but cheap).
- (b) In `RunLauncher.launch` orchestration — separates concerns; runs once per launch (same cost) but is conceptually the right layer.
- (c) On project add — runs once ever; lowest cost but fragile if user removes the line later.

Chose (b). The `RunLauncher` exists specifically to orchestrate the launch sequence; `.gitignore` write is part of that sequence. Per-launch idempotency is cheap (one stat + one string scan). The "on project add" hook (c) is a Phase 2 follow-up that can run the same function eagerly; doing both costs nothing because the function is idempotent. Roadmap epic `first-run-onboarding-and-self-host-acceptance` mentions "Auto-write `.cyboflow/worktrees/` entry to `.gitignore` on project add" — that's a later trigger of the same function; this task installs the function.

## Rejected Alternatives

- **AI-naming kept as fallback.** Rejected per IDEA-008 slice description and design doc §3 explicit cut. AI naming added an API hop, failed offline, produced non-deterministic names.
- **`runId8` = base32 of UUID instead of hex prefix.** Rejected; the existing roadmap text uses `cyboflow/sprint/a3f2b1c0` (hex), and hex is universally greppable. Base32 saves no real characters for an 8-char prefix.
- **Worktrees under `~/.cyboflow/worktrees/<projectId>/<workflow>/<runId8>/` instead of inside the repo.** Rejected per design doc §5.4: "Worktree parent directory: `<repo>/.cyboflow/worktrees/` — inside the repo to play well with the user's `.gitignore`, namespaced to avoid colliding with anything else." Putting worktrees inside the repo also makes them visible to the user's existing IDE / file watcher, which is a desired property.

## Lowest Confidence Area

The interaction between Crystal's existing `createWorktree` path (which still has callers in `sessionManager.ts` for legacy session creation) and the new deterministic path. Both share the underlying git-worktree-add logic via the `_createAtPath` refactor. If Crystal's session lifecycle ever drives a worktree at a path that collides with `<repo>/.cyboflow/worktrees/...`, the legacy code's collision cleanup (`git worktree remove --force`) could destroy a live Cyboflow run. Mitigation: the legacy path uses `worktrees/` (no `.cyboflow/` prefix), so collision is structurally impossible. Worth re-verifying when the `crystal-cuts-and-rebrand` epic finishes ripping out the legacy session creation paths.
