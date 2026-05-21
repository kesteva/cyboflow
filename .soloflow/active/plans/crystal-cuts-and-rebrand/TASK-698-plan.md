---
id: TASK-698
idea: SPRINT-027-compound
status: ready
created: 2026-05-20T00:00:00Z
files_owned:
  - main/src/utils/runGit.ts
files_readonly:
  - main/src/utils/__tests__/runGit.test.ts
  - main/src/services/commitManager.ts
  - main/src/services/gitDiffManager.ts
  - main/src/services/gitPlumbingCommands.ts
  - main/src/services/gitStatusManager.ts
  - main/src/services/executionTracker.ts
  - main/src/ipc/git.ts
  - main/src/ipc/file.ts
  - main/src/ipc/dashboard.ts
acceptance_criteria:
  - criterion: "encoding field removed from RunGitOptions; no 'buffer' literal in runGit.ts"
    verification: "grep -n 'encoding' main/src/utils/runGit.ts returns 0 in the interface block; grep -nE \"'buffer'|\\\"buffer\\\"\" main/src/utils/runGit.ts returns 0."
  - criterion: "runGit and runGitAsync no longer reference options.encoding or the dead Buffer-to-string coercion"
    verification: "grep -nE \"options\\.encoding|toString\\('utf8'\\)\" main/src/utils/runGit.ts returns 0."
  - criterion: "No caller passes encoding: 'buffer' anywhere"
    verification: "grep -rniE \"encoding\\s*:\\s*['\\\"]buffer['\\\"]\" main/src/ --include='*.ts' returns 0."
  - criterion: "TypeScript compilation succeeds"
    verification: "cd main && npx tsc --noEmit -> exit 0."
  - criterion: "runGit unit tests pass unchanged"
    verification: "cd main && npx vitest run src/utils/__tests__/runGit.test.ts -> exit 0."
  - criterion: "Full main suite passes"
    verification: "cd main && npx vitest run -> exit 0."
depends_on: []
estimated_complexity: low
epic: crystal-cuts-and-rebrand
test_strategy:
  needed: false
  justification: "Pure type-narrowing + dead-code removal. Existing runGit.test.ts asserts no buffer path. Full-suite vitest + tsc --noEmit are sufficient regression coverage; no caller passes buffer."
---

# Narrow RunGitOptions: remove dead 'buffer' encoding option

## Objective

Remove the dead `encoding: 'utf8' | 'buffer'` option from RunGitOptions. Both runGit and runGitAsync always return string regardless. The type lies. Zero callers pass `encoding: 'buffer'` (pre-flight verified).

## Implementation Steps

1. Pre-flight: `grep -rniE "encoding\s*:\s*['\"]buffer['\"]" main/src/ --include='*.ts'` -> expect 0. STOP if any hit.

2. Rewrite `main/src/utils/runGit.ts`:
   - Drop `encoding?` from `RunGitOptions` (keep only `maxBuffer?: number; env?: NodeJS.ProcessEnv;`).
   - In runGit: pass `encoding: 'utf8'` literal to execFileSync; return its result directly (no `result.toString('utf8')` branch).
   - In runGitAsync: same — pass `encoding: 'utf8'` literal; return stdout directly.
   - Update top-of-file JSDoc to mention the buffer option was removed in TASK-698; future Buffer needs should add a separate `runGitBinary` rather than re-introducing polymorphism.

3. `cd main && npx tsc --noEmit` -> exit 0. Resolve any type errors.

4. `cd main && npx vitest run src/utils/__tests__/runGit.test.ts` -> exit 0.

5. `cd main && npx vitest run` -> exit 0.

6. Final sweep: re-run pre-flight grep; should still be 0.

## Hardest Decision

Keep the RunGitOptions interface vs inlining. Kept: 8 caller files reference it by name; inlining is churn-heavy.

## Rejected Alternatives

- Option (b) — TS overloads: speculative, no caller needs Buffer.
- Runtime warning on encoding:'buffer': still lies via static return type.
- runGitBinary now: speculative; document the path for future.

## Lowest Confidence Area

Node's execFileSync return-type inference under inline `encoding: 'utf8'`. If tsc complains the return is `string | Buffer`, fall back to `return execFileSync(...).toString();` or `as string` cast.
