---
id: TASK-002
idea: IDEA-001
status: ready
created: "2026-05-11T00:00:00Z"
files_owned:
  - main/src/services/taskQueue.ts
  - main/src/services/worktreeNameGenerator.ts
  - main/src/index.ts
  - main/src/ipc/session.ts
  - main/src/ipc/types.ts
  - package.json
files_readonly:
  - main/src/services/simpleTaskQueue.ts
  - main/src/services/worktreeManager.ts
  - main/src/services/sessionManager.ts
  - docs/cyboflow_system_design.md
  - .soloflow/active/research/ROADMAP-001-research-risks.md
acceptance_criteria:
  - criterion: "`bull` is not imported in any TypeScript file under `main/src/`"
    verification: "`grep -rn --include='*.ts' -E \"from ['\\\"]bull['\\\"]|require\\\\(['\\\"]bull['\\\"]\" main/src/` returns zero matches"
  - criterion: "`bull` is not listed in `package.json` dependencies or devDependencies"
    verification: "`node -e \"const p=require('./package.json'); process.exit((p.dependencies && p.dependencies.bull) || (p.devDependencies && p.devDependencies.bull) ? 1 : 0)\"` returns exit 0"
  - criterion: "`taskQueue.ts` no longer references `Bull` type, `redisOptions`, `REDIS_URL`, or `useSimpleQueue` branching"
    verification: "`grep -nE 'Bull|REDIS_URL|useSimpleQueue|redisOptions' main/src/services/taskQueue.ts` returns zero matches"
  - criterion: "`WorktreeNameGenerator` class and file are deleted"
    verification: "`test ! -f main/src/services/worktreeNameGenerator.ts` returns exit 0"
  - criterion: No source files import `WorktreeNameGenerator`
    verification: "`grep -rn --include='*.ts' 'WorktreeNameGenerator\\|worktreeNameGenerator' main/src/ frontend/src/ shared/` returns zero matches"
  - criterion: "`@anthropic-ai/sdk` is removed from `package.json` (only used by the deleted WorktreeNameGenerator)"
    verification: "`node -e \"const p=require('./package.json'); process.exit((p.dependencies && p.dependencies['@anthropic-ai/sdk']) ? 1 : 0)\"` returns exit 0"
  - criterion: "`taskQueue.ts` generates fallback worktree names deterministically without any API call"
    verification: "`grep -n 'anthropic\\|Anthropic' main/src/services/taskQueue.ts` returns zero matches"
  - criterion: "Build and typecheck succeed: `pnpm run build:main && pnpm typecheck` exit 0"
    verification: Run both commands from repo root; both exit 0
depends_on: []
estimated_complexity: medium
epic: crystal-cuts-and-rebrand
test_strategy:
  needed: false
  justification: Pure deletion. The replaced behavior (deterministic local naming) is a one-line fallback inside an existing code path; existing session-creation tests (if any) will exercise it via the normal `pnpm test` path. The grep-based ACs are sufficient to prove the deletion is structural. The build + typecheck steps prove no callers were missed.
---
# Delete Bull Import and WorktreeNameGenerator API Hop

## Objective

Two inherited Crystal artifacts are still live in `taskQueue.ts` despite the design doc claiming they should be gone:

1. **`import Bull from 'bull'`** at line 1 of `taskQueue.ts` and `"bull": "^4.16.3"` in `package.json` dependencies. The conditional `useSimpleQueue` branch means production code uses `SimpleQueue`, but Bull is still pulled into the bundle, brings `ioredis` as a transitive dependency, and produces ECONNREFUSED log noise if `REDIS_URL` is ever set.
2. **`WorktreeNameGenerator` (line 5 import, line 189 call)** makes an Anthropic Haiku API call at session creation to generate a "human-readable" worktree name. This adds an offline-breaking API hop, fails silently when the API is unreachable, and produces non-deterministic names. Cyboflow's design (§5.4) requires deterministic `cyboflow/<workflow>/<runId8>` naming — but this task is the *negative half* of that work: delete the AI hop and replace with a deterministic local fallback. The full `cyboflow/<workflow>/<runId8>` scheme is owned by the `workflow-runs-and-day3-gate` epic.

After this task: only `SimpleQueue`, no Bull, no API call at name generation, deterministic local-only worktree naming (using the existing fallback algorithm already inside `WorktreeNameGenerator` — the slug-from-prompt logic).

## Implementation Steps

1. **Run the pre-flight grep**:
   