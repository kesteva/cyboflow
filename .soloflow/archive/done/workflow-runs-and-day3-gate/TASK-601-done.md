---
id: TASK-601
sprint: SPRINT-016
epic: workflow-runs-and-day3-gate
status: done
summary: "SoloFlow plugin path discovery (env > semver-glob > fallback), seed() fail-loud at ERROR, and a relative-path compat shim that round-trips correctly through cyboflow.ts:137"
executor_loops: 0
code_review_rounds: 1
visual_mobile: skipped_user_preference
visual_web: skipped_user_preference
---

# TASK-601 Done

## Outcome

Replaced the hardcoded SoloFlow plugin version `0.9.12` in `main/src/orchestrator/workflowRegistry.ts` with a runtime resolver `resolveSoloFlowPluginRoot()` that picks env-var override > highest-semver subdirectory under `~/.claude/plugins/cache/soloflow/soloflow-dev/` > a documented `FALLBACK_SOLOFLOW_VERSION='0.10.3'` constant (with a `console.warn` on the fallback path). `WorkflowRegistry.seed()`'s catch branch was upgraded from `logger.warn` to `logger.error` so a missing .md file is now loud. The `DEFAULT_SOLOFLOW_WORKFLOWS` export stays in place as a `@cyboflow-hidden` compat shim for the cyboflow.ts consumer; after one code-review retry, the shim now stores `path.relative(homeDir, descriptor.path)` so the consumer's `path.join(homeDir, wf.pathFromHome)` reconstructs the original absolute path (the round-1 implementation used absolute paths in `pathFromHome` with a false-`path.join` claim that would have produced doubled-prefix lookups at runtime). `os.homedir()` is now used consistently between shim and consumer.

## Verification

- Verifier (R1): APPROVED.
- Code-reviewer (R1): IMPROVEMENTS_NEEDED — compat-shim doubled-prefix bug.
- Code-reviewer (R2): CLEAN.
- Verifier (R2): APPROVED. 27/27 in target suite; 325/325 in main workspace; typecheck + lint clean.
- Test-writer: TESTS_WRITTEN (3 additional edge cases — whitespace-only env var, env-var-with-surrounding-whitespace, non-semver entries in cache dir).
