---
id: TASK-605
sprint: SPRINT-015
epic: testing-infrastructure
status: done
summary: "Added withTempDir(prefix, fn) helper with try/finally cleanup; migrated 4 leaking + 2 already-clean sites to per-it withTempDir; tmp dir leaks eliminated"
executor_loops: 0
code_review_rounds: 0
visual_mobile: skipped_user_preference
visual_web: skipped_user_preference
---

# TASK-605 — Done

Created `main/src/__test_fixtures__/tmp.ts` exporting `withTempDir<T>(prefix, fn)`. Helper mkdtempSyncs a unique dir under `os.tmpdir()` with `${prefix}${randomUUID().slice(0,8)}-` namespacing, runs the callback, and unconditionally cleans up via `rmSync(dir, { recursive: true, force: true })` in a try/finally — wrapped in an inner try/catch so EBUSY/EPERM on Windows/NFS don't mask the original failure. Wrote 4 unit tests covering creation, cleanup-on-resolve, cleanup-on-throw, and best-effort cleanup when the dir is already gone.

Migrated 4 leaking sites (`runLauncher.test.ts`, `cyboflow.test.ts`) to per-`it` withTempDir wrappers. Also migrated the two already-clean optional sites (`mcpConfigWriter.test.ts`, `worktreeManager.test.ts`) for consistency, per "migrate both or neither" AC4. Added clarifying `// Manual lifecycle (not withTempDir)` comments at the two intentional manual-lifecycle sites (`cyboflowTestHarness.ts:223-225` for harness-owned dir surviving across launchPair/teardown, `cyboflow-day3-gate.spec.ts:62` for beforeAll/afterAll shared dir).

After running tests, `ls $TMPDIR | grep -E 'runlauncher-test-|cyboflow-ipc-test-|cyboflow-gate-wf-|cyboflow-day3-'` returns no rows. 317 main tests pass; 1 gate test passes.

Code-reviewer noted FIND-SPRINT-015-16: two additional leaking sites (`gitignoreWriter.test.ts`, `workflowRegistry.test.ts`) outside `files_owned` — queued for compound.

Commits:
- `9eb23bc` — feat(TASK-605): add withTempDir test helper + 4 unit tests
- `e3c1763` — fix(TASK-605): migrate runLauncher.test.ts to withTempDir
- `948088b` — fix(TASK-605): migrate cyboflow.test.ts to withTempDir
- `e4bd1eb` — docs(TASK-605): add withTempDir comment in cyboflowTestHarness.ts
- `43d974a` — docs(TASK-605): add withTempDir comment in cyboflow-day3-gate.spec.ts
- `e35c2e7` — refactor(TASK-605): migrate mcpConfigWriter + worktreeManager tests to withTempDir
