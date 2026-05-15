---
id: TASK-601
idea: SPRINT-009-compound
status: ready
created: 2026-05-15T00:00:00Z
files_owned:
  - main/src/orchestrator/workflowRegistry.ts
  - main/src/orchestrator/__tests__/workflowRegistry.test.ts
files_readonly:
  - main/src/ipc/cyboflow.ts
  - .soloflow/active/findings/SPRINT-009-findings.md
acceptance_criteria:
  - criterion: "DEFAULT_SOLOFLOW_WORKFLOWS no longer hardcodes a specific SoloFlow plugin version anywhere in the file"
    verification: "grep -n '0\\.9\\.12' main/src/orchestrator/workflowRegistry.ts returns 0 matches"
  - criterion: "Plugin path discovery resolves the highest-semver subdirectory under `~/.claude/plugins/cache/soloflow/soloflow-dev/` at runtime"
    verification: "grep -nE 'glob|readdirSync.*soloflow|resolveSoloFlowPluginRoot|SOLOFLOW_PLUGIN_ROOT' main/src/orchestrator/workflowRegistry.ts returns at least one resolver function definition"
  - criterion: "An env-var override (`SOLOFLOW_PLUGIN_ROOT`) takes precedence over filesystem discovery so users with non-standard installs can pin a path"
    verification: "grep -n 'SOLOFLOW_PLUGIN_ROOT' main/src/orchestrator/workflowRegistry.ts returns at least one match in the resolver"
  - criterion: "If neither env var nor filesystem discovery succeeds, the fallback path uses a documented constant rather than crashing — and the failure is logged at WARN level"
    verification: "grep -n 'FALLBACK_SOLOFLOW_VERSION\\|could not discover.*soloflow' main/src/orchestrator/workflowRegistry.ts returns at least one match each"
  - criterion: "WorkflowRegistry.seed surfaces a sentinel (e.g. permission_mode='unknown' OR an explicit log.error) when the .md file read fails, instead of silently defaulting to 'default'"
    verification: "grep -n 'extractPermissionMode\\|seed' main/src/orchestrator/workflowRegistry.ts shows the catch branch logs at logger.error level (not just warn) AND/OR sets a distinguishable sentinel value the test can assert on"
  - criterion: "All existing workflowRegistry.test.ts tests pass"
    verification: "pnpm --filter main exec vitest run src/orchestrator/__tests__/workflowRegistry.test.ts exits 0"
  - criterion: "New tests assert that the resolver picks the highest semver from a fixture directory and that env-var override wins"
    verification: "grep -n 'resolveSoloFlowPluginRoot\\|SOLOFLOW_PLUGIN_ROOT' main/src/orchestrator/__tests__/workflowRegistry.test.ts returns at least 2 test cases"
depends_on: []
estimated_complexity: low
epic: workflow-runs-and-day3-gate
test_strategy:
  needed: true
  justification: "The path resolver is new pure logic that must be deterministic given a tmp-dir fixture; existing tests already cover seed() but a new test class is required for the version-discovery behavior."
  targets:
    - behavior: "resolveSoloFlowPluginRoot returns the env-var value when SOLOFLOW_PLUGIN_ROOT is set"
      test_file: "main/src/orchestrator/__tests__/workflowRegistry.test.ts"
      type: unit
    - behavior: "resolveSoloFlowPluginRoot picks the lexicographically/semver-highest subdirectory when multiple versions are present"
      test_file: "main/src/orchestrator/__tests__/workflowRegistry.test.ts"
      type: unit
    - behavior: "resolveSoloFlowPluginRoot falls back to the documented constant when neither env var nor filesystem discovery succeeds, and logs a WARN"
      test_file: "main/src/orchestrator/__tests__/workflowRegistry.test.ts"
      type: unit
    - behavior: "DEFAULT_SOLOFLOW_WORKFLOWS resolves the 5 workflow paths against the discovered root, not against a hardcoded version"
      test_file: "main/src/orchestrator/__tests__/workflowRegistry.test.ts"
      type: unit
    - behavior: "WorkflowRegistry.seed logs at ERROR (not just WARN) when a workflow .md file cannot be read, and the inserted row reflects the sentinel"
      test_file: "main/src/orchestrator/__tests__/workflowRegistry.test.ts"
      type: unit
---

# Add SoloFlow plugin path discovery + fail-loud on workflow read failure

## Objective

`DEFAULT_SOLOFLOW_WORKFLOWS` in `main/src/orchestrator/workflowRegistry.ts:37-43` hardcodes the SoloFlow plugin path version `0.9.12` (5 copies, one per workflow), but the actually-installed version on the developer's machine is `0.10.3`. Combined with `seed()`'s swallow-and-default behavior at lines 119-128, every production auto-seed silently reads non-existent files and defaults all workflows to `permission_mode='default'`, defeating the entire approval-policy mechanism the system was designed to enforce. This task replaces the hardcoded version with a runtime discovery resolver (env var → filesystem glob highest semver → documented fallback constant) AND raises the file-read failure log level so the next breakage is loud.

## Implementation Steps

1. Add a new exported function `resolveSoloFlowPluginRoot(homeDir: string, env: NodeJS.ProcessEnv = process.env): { root: string; source: 'env' | 'discovered' | 'fallback' }` at the top of `main/src/orchestrator/workflowRegistry.ts`. Resolution order:
   - If `env.SOLOFLOW_PLUGIN_ROOT` is a non-empty string, return `{ root: env.SOLOFLOW_PLUGIN_ROOT, source: 'env' }` without touching the filesystem.
   - Otherwise, list `path.join(homeDir, '.claude/plugins/cache/soloflow/soloflow-dev')` via `fs.readdirSync({ withFileTypes: true })`. Filter to entries that (a) are directories AND (b) match `/^\d+\.\d+\.\d+$/`. Sort semver-descending using a small inline comparator (split on '.', compare each segment as Number). If at least one match, return `{ root: path.join(homeDir, '.claude/plugins/cache/soloflow/soloflow-dev', sorted[0]), source: 'discovered' }`.
   - Otherwise return `{ root: path.join(homeDir, '.claude/plugins/cache/soloflow/soloflow-dev', FALLBACK_SOLOFLOW_VERSION), source: 'fallback' }` and emit a `console.warn` (the function does not own the logger).
2. Add `export const FALLBACK_SOLOFLOW_VERSION = '0.10.3';` immediately above the resolver. This is the documented stale-state constant — it WILL go out of date, but at least the warning log will tell the operator to update it.
3. Replace `DEFAULT_SOLOFLOW_WORKFLOWS` with a function that takes the resolved root and returns descriptors:
   ```ts
   export function buildDefaultSoloFlowWorkflows(pluginRoot: string): WorkflowDescriptor[] {
     return [
       { name: 'soloflow', path: path.join(pluginRoot, 'commands/idea-extractor.md') },
       { name: 'planner',  path: path.join(pluginRoot, 'commands/planner.md') },
       { name: 'sprint',   path: path.join(pluginRoot, 'commands/sprint.md') },
       { name: 'compound', path: path.join(pluginRoot, 'commands/compound.md') },
       { name: 'prune',    path: path.join(pluginRoot, 'commands/prune.md') },
     ];
   }
   ```
   Keep `DEFAULT_SOLOFLOW_WORKFLOWS` as a deprecated re-export computed against the resolved root, OR remove it entirely if no other consumers exist.
4. Run `grep -rn 'DEFAULT_SOLOFLOW_WORKFLOWS' main/src/ frontend/src/ tests/` to enumerate every consumer. Only `main/src/ipc/cyboflow.ts:107` consumes it. Update that call site to use the new resolver:
   ```ts
   const homeDir = os.homedir();
   const { root: pluginRoot, source } = resolveSoloFlowPluginRoot(homeDir);
   if (source === 'fallback') {
     services.logger?.warn(`SoloFlow plugin discovery failed; using fallback version ${pluginRoot}`);
   }
   const descriptors = buildDefaultSoloFlowWorkflows(pluginRoot);
   ```
5. Update `WorkflowRegistry.seed`'s catch branch (lines 119-128). Today it logs at WARN and inserts the row with `permission_mode='default'`. Change to: log at ERROR (use `this.logger.error` and include the file path) and insert with `permission_mode='default'` UNCHANGED — but record on the inserted row a sentinel that the row was a fallback (e.g. by logging the fully-resolved path so the operator can grep for "could not read workflow file" and immediately see whether the fallback path was the broken one). The ERROR-level log is the primary fail-loud signal; do NOT change the inserted permission_mode value (changing the value to 'unknown' would break the existing CHECK constraint — which is currently absent on `workflows.permission_mode` but is set on `workflow_runs.permission_mode_snapshot` to the same value).
6. Add new test cases to `main/src/orchestrator/__tests__/workflowRegistry.test.ts`:
   - `describe('resolveSoloFlowPluginRoot', () => { it('returns env-var value when SOLOFLOW_PLUGIN_ROOT is set'), it('picks the highest semver from a fixture dir with multiple versions'), it('returns fallback when no versions are installed') })` — use `mkdtempSync` to build a fake plugin dir with `0.9.12/`, `0.10.3/`, `0.10.10/` subdirs and assert the resolver picks `0.10.10`.
   - One new test for `seed()` confirming `logger.error` (not just `logger.warn`) is called when the file is missing.
7. Update the existing `seed()` "missing .md file logs WARN" test to assert `error` instead of `warn` — keep it semantically equivalent (the test was checking the swallow-and-log behavior; we are upgrading the level).

## Acceptance Criteria

See frontmatter. Critically: `grep -n '0.9.12' main/src/orchestrator/workflowRegistry.ts` must return 0 matches AFTER the change. The hardcoded version is the bug; eliminating its literal is the canonical fix.

## Test Strategy

5 new behavior tests + one updated test in `workflowRegistry.test.ts`. The version-discovery tests use `mkdtempSync` to build an isolated plugin-dir fixture so the test does not depend on the developer's actual `~/.claude/plugins/cache/soloflow/` state. Pair with B8 (TASK-605) to drop the manual mkdtempSync once `withTempDir` exists.

## Hardest Decision

Whether to log at ERROR or to set a distinguishable `permission_mode` sentinel value when seed() can't read the file. I chose ERROR-level log only (no value change) because (a) the `permission_mode` column has no CHECK constraint that would accept a sentinel value like `'unknown'` without a coordinated migration, (b) the downstream consumer is the approval router which only branches on the three known modes, and (c) loud logging is the lowest-risk fail-loud signal that doesn't ripple into other code. A distinguishable value would be marginally better operationally but requires schema and consumer changes, which deserve their own task.

## Rejected Alternatives

- **Read the version from `~/.claude/plugins/cache/soloflow/soloflow-dev/<version>/.claude-plugin/plugin.json` and pick the one with the latest `version` field.** Rejected as more complex than needed — directory-name semver sort is sufficient because the install layout uses semver dirnames as the source of truth.
- **Vendor the SoloFlow plugin into the cyboflow repo so there's no external resolution at all.** Rejected because the plugin updates independently and we don't want to fork it.
- **Hardcode `0.10.3` instead of `0.9.12`.** Rejected because the operator who hit this bug WILL hit it again on the next release (0.10.4, 0.11.0, ...). The fix is to stop hardcoding, not to update the hardcoded version.

## Lowest Confidence Area

Whether the semver comparator handles pre-release strings (`0.10.3-beta.1`). The plugin's published versions appear to be plain `MAJOR.MINOR.PATCH`, but if a future version ships a pre-release the resolver's regex will skip it (which is safer than picking a beta over a stable). If pre-releases become common, the resolver should accept them with a tie-breaker that prefers stable. Documented in code comment.
