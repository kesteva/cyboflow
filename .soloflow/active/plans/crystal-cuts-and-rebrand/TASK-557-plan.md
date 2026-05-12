---
id: TASK-557
idea: IDEA-001
status: ready
created: 2026-05-11T00:00:00Z
source_compound: SPRINT-001-proposal.md#B1
files_owned:
  - main/package.json
  - pnpm-lock.yaml
files_readonly:
  - package.json
  - main/src/services/taskQueue.ts
  - .soloflow/archive/done/crystal-cuts-and-rebrand/TASK-002-done.md
  - .soloflow/active/plans/crystal-cuts-and-rebrand/TASK-002-plan.md
  - .soloflow/active/findings/SPRINT-001-findings.md
acceptance_criteria:
  - criterion: "`main/package.json` no longer declares `bull`, `@types/bull`, or `@anthropic-ai/sdk`"
    verification: "`node -e \"const p=require('./main/package.json'); const d={...(p.dependencies||{}),...(p.devDependencies||{})}; process.exit(['bull','@types/bull','@anthropic-ai/sdk'].some(k=>k in d)?1:0)\"` returns exit 0"
  - criterion: "`pnpm-lock.yaml` has no root-importer or main-importer entry for `bull`, `@types/bull`, `@anthropic-ai/sdk`, or `openai`"
    verification: "`grep -nE \"^      (bull|openai|'@types/bull'|'@anthropic-ai/sdk'):\" pnpm-lock.yaml` returns zero matches"
  - criterion: "`pnpm install --frozen-lockfile` succeeds against the regenerated lockfile (CI parity check)"
    verification: "`pnpm install --frozen-lockfile` exits 0 with no `ERR_PNPM_OUTDATED_LOCKFILE` error"
  - criterion: "No source code imports Bull or `@anthropic-ai/sdk`"
    verification: "`grep -rnE \"from ['\\\"]@anthropic-ai/sdk['\\\"]|from ['\\\"]bull['\\\"]|require\\(['\\\"]@anthropic-ai/sdk['\\\"]\\)|require\\(['\\\"]bull['\\\"]\\)\" main/src frontend/src shared` returns zero matches"
  - criterion: "Main process builds, typechecks, and lints cleanly"
    verification: "`pnpm run build:main && pnpm typecheck && pnpm lint` all exit 0 from repo root"
depends_on: []
estimated_complexity: low
epic: crystal-cuts-and-rebrand
test_strategy:
  needed: false
  justification: "Purely a manifest + lockfile maintenance task. No source code is modified. The acceptance grep, build, and `pnpm install --frozen-lockfile` checks are sufficient verification. Adding a unit test would not exercise any new logic."
---

# Finish Dependency Cleanup (main/package.json + pnpm-lock.yaml)

## Objective

TASK-002 removed `bull`, `@types/bull`, and `@anthropic-ai/sdk` from the root `package.json`, but in this pnpm workspace the `main/` sub-package drives what actually gets installed for the main process. The three packages are still declared in `main/package.json` (lines 20, 24, 35), and `pnpm-lock.yaml` was never regenerated after TASK-001/TASK-002/TASK-006, so its root importer block still lists `@anthropic-ai/sdk`, `bull`, and `openai` as direct deps. `pnpm install --frozen-lockfile` (used in CI) still installs all three packages and their transitive trees. This task finishes the cleanup by deleting the three declarations from `main/package.json` and regenerating the lockfile in a single commit, restoring the invariant that the workspace's installed-package set matches its manifests.

## Implementation Steps

1. **Sweep pre-flight.** From repo root, confirm no source consumes the packages being removed:
   ```bash
   grep -rnE "from ['\"]@anthropic-ai/sdk['\"]|from ['\"]bull['\"]|require\(['\"]@anthropic-ai/sdk['\"]\)|require\(['\"]bull['\"]\)" main/src frontend/src shared
   ```
   Expected: zero matches. If any match surfaces, STOP and escalate — TASK-002 missed an import and the package cannot be removed yet.

2. **Edit `main/package.json`.** Remove these three lines exactly:
   - Line 20: `"@anthropic-ai/sdk": "^0.60.0",`
   - Line 24: `"bull": "^4.16.3",`
   - Line 35: `"@types/bull": "^4.10.0",`
   Leave surrounding commas valid (the next-line key after each removal must remain properly comma-separated). Verify resulting JSON parses: `node -e "JSON.parse(require('fs').readFileSync('main/package.json','utf8'))"` exits 0.

3. **Regenerate the lockfile.** From repo root run `pnpm install`. This will rewrite `pnpm-lock.yaml` to drop the now-undeclared specifiers from both the root and the `main` importer blocks. Do NOT pass `--frozen-lockfile` here — the whole point is to mutate the lockfile.

4. **Verify lockfile cleanup.** Run the grep gate exactly as encoded in the acceptance criterion:
   ```bash
   grep -nE "^      (bull|openai|'@types/bull'|'@anthropic-ai/sdk'):" pnpm-lock.yaml
   ```
   Expected: zero matches. The pattern targets the indented `key:` lines inside `importers` / `dependencies` / `devDependencies` blocks (six spaces + key + colon) — the format used for both root (`.`) and `main` importer blocks per the current lockfile structure.

5. **CI-parity install.** Run `pnpm install --frozen-lockfile` to confirm the regenerated lockfile is internally consistent and won't fail CI. If this errors with `ERR_PNPM_OUTDATED_LOCKFILE`, step 3 produced a partial regeneration — re-run `pnpm install` and try again.

6. **Build / typecheck / lint gate.** From repo root: `pnpm run build:main && pnpm typecheck && pnpm lint`. All three must exit 0. The main-process build is the most likely tripwire: if any TypeScript file still has a transitive import of `bull` or `@anthropic-ai/sdk` (e.g. through a `import type` declaration), the build will fail and step 1's grep missed it.

7. **Commit both files together** with message `chore: remove bull/@types/bull/@anthropic-ai/sdk from main package + regenerate lockfile`. Per the global atomic-commit rule, stage exactly `main/package.json` and `pnpm-lock.yaml`.

## Acceptance Criteria

- `main/package.json` no longer contains `bull`, `@types/bull`, or `@anthropic-ai/sdk` keys in `dependencies` or `devDependencies`. Verified by the Node JSON-load gate in the frontmatter.
- `pnpm-lock.yaml` has zero importer-block entries for `bull`, `@types/bull`, `@anthropic-ai/sdk`, or `openai`. Verified by `grep -nE` on the indented key pattern.
- `pnpm install --frozen-lockfile` exits 0 — the lockfile is internally consistent.
- No source-tree import of `@anthropic-ai/sdk` or `bull` exists. Verified by recursive grep over `main/src`, `frontend/src`, `shared`.
- `pnpm run build:main && pnpm typecheck && pnpm lint` all exit 0 from repo root.

## Test Strategy

No new tests. This is a manifest + lockfile maintenance task with no behavior change. The acceptance grep, build, and `pnpm install --frozen-lockfile` checks fully cover the invariant the task establishes.

## Hardest Decision

Whether to also strip `openai` from the root-importer block of `pnpm-lock.yaml`. The root `package.json` already does NOT declare `openai` (TASK-001 removed it), but the lockfile's root importer block still lists it as a direct dep with `specifier: ^5.1.1` (line 38-40). Decision: yes, include it. The lockfile regeneration in step 3 will drop it automatically because pnpm reconciles `importers/.` against the manifest on every `pnpm install`. We don't need an explicit edit — the regen is implicit. The acceptance criterion's grep includes `openai` to guarantee the regen completed correctly; if the grep still finds it after step 3, that's a signal `pnpm install` was skipped or failed silently.

## Rejected Alternatives

- **Edit `pnpm-lock.yaml` by hand instead of regenerating.** Rejected. Hand-editing a pnpm lockfile produces an inconsistent state where the importer block disagrees with the snapshots/packages section; `pnpm install --frozen-lockfile` will then refuse to install. Always regenerate via `pnpm install`.
- **Run `pnpm remove bull @types/bull @anthropic-ai/sdk --filter main` instead of editing JSON directly.** This would work but produces extra noise in the diff (it reorders neighboring keys). Editing the three specific lines and letting `pnpm install` reconcile the lockfile is the smallest, most reviewable change. Would reconsider if the manifest already has key-ordering churn for unrelated reasons.
- **Skip the lockfile regen and only edit `main/package.json`.** Rejected. CI uses `pnpm install --frozen-lockfile`, which would then immediately fail on `ERR_PNPM_OUTDATED_LOCKFILE`. The lockfile is the authoritative source for CI installs.

## Lowest Confidence Area

The exact grep pattern for matching importer-block keys in `pnpm-lock.yaml`. The lockfile uses six-space indentation for importer-block keys, but the inner `dependencies:`/`devDependencies:` sections inside each importer use eight-space indentation. The pattern `^      (bull|...):` targets six-space only, which matches both the root (`.`) and `main` importers' top-level key lines. If the lockfile format ever changes (pnpm upgrade), this grep may produce false negatives. The build/typecheck/lint gate is the real safety net — if those pass, the package is definitively not installed regardless of what the grep returns.
