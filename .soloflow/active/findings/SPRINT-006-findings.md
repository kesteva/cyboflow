---
sprint: SPRINT-006
pending_count: 3
last_updated: "2026-05-13T19:45:00Z"
---

# Findings Queue

## FIND-SPRINT-006-3
- **source:** TASK-253 (code-reviewer)
- **type:** cleanup
- **severity:** low
- **status:** open
- **location:** main/src/orchestrator/__tests__/Orchestrator.test.ts:132-136
- **description:** In the "stop drains the run queue registry" test, the task body writes `taskFinished = false; taskFinished = true;` — the first assignment is dead because the outer-scope `let taskFinished = false;` already provides that initial value. The inline `// initially false` comment is misleading, since the read at line 142 happens BEFORE the task runs (the gate is still locked), not while the task is mid-execution. The test passes, but the intent of the dead write is unclear and a future reader may "fix" it incorrectly.
- **suggested_action:** Drop the `taskFinished = false; // initially false` line so the task body is just `taskFinished = true;`. The outer initialization already guarantees the pre-state.
- **resolved_by:**

## FIND-SPRINT-006-2
- **source:** TASK-253 (code-reviewer)
- **type:** cleanup
- **severity:** low
- **status:** open
- **location:** main/src/orchestrator/Orchestrator.ts:72-75
- **description:** `Orchestrator.ts` re-exports `RunQueueRegistry`, `EventEmitter`, and the `OrchestratorDeps` type at the bottom of the file as a "caller convenience." No call sites currently consume these re-exports (verified by grep across `main/src/` — there are no imports from `'./orchestrator/Orchestrator'` other than direct class imports in tests). The convenience is speculative and adds two extra public surface symbols (`EventEmitter`, `RunQueueRegistry`) that callers can already import from their canonical locations. If a caller wires `OrchestratorDeps` from a single import, that's the only re-export that earns its keep.
- **suggested_action:** When TASK-254/255 wires the orchestrator from `main/src/index.ts`, either delete the unused `EventEmitter` / `RunQueueRegistry` re-exports or confirm them by use. The `OrchestratorDeps` re-export is fine — it lives next to its consumer.
- **resolved_by:**

## FIND-SPRINT-006-1
- **source:** TASK-251 (code-reviewer)
- **type:** bug
- **severity:** low
- **status:** open
- **location:** package.json:54-70 (root `dependencies`) vs main/package.json:18-35
- **description:** `electron-store@^11.0.0` is declared in `main/package.json` but not in the root `package.json`. The TASK-251 plan's own rationale (Implementation Step 3) states "The root list is what electron-builder reads when assembling `node_modules/**/*` into the asar; missing the root list means the packaged app will throw at first `require('trpc-electron')`". By that same rationale, packaged builds may also be missing `electron-store` at runtime in the main process. This pre-dates TASK-251 (not introduced by this commit) but was surfaced while reviewing the parity logic just added for trpc-electron/p-queue/superjson.
- **suggested_action:** Verify in a packaged build whether `require('electron-store')` resolves; if it does, document why (electron-builder's `npmRebuild`/`buildDependenciesFromSource` interaction may already pull workspace deps), and either remove the parity-claim from future task plans or add electron-store to root for consistency. If it doesn't resolve, add `"electron-store": "^11.0.0"` to root dependencies.
- **resolved_by:**
