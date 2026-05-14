---
sprint: SPRINT-006
pending_count: 6
last_updated: "2026-05-14T05:00:00.000Z"
---
# Findings Queue

## FIND-SPRINT-006-9
- **source:** TASK-255 (code-reviewer)
- **type:** cleanup
- **severity:** low
- **status:** open
- **location:** main/src/index.ts:698
- **description:** When `mainWindow` is null at the orchestrator-wiring block, `attachOrchestratorTrpc` is silently skipped: `if (mainWindow) { attachOrchestratorTrpc(...) }`. This is a quiet failure mode — the orchestrator starts but the renderer's tRPC bridge is never installed, so every `trpc.*` call from the renderer will fail with the trpc-electron "Could not find `electronTRPC` global" error or similar. In practice, `createWindow()` is awaited immediately above this block so `mainWindow` should never be null here, but the guard hides a logically-impossible state without surfacing it. Either drop the guard (and assert with `mainWindow!` or `if (!mainWindow) throw ...`) or log a warning when the guard kicks in.
- **suggested_action:** Replace `if (mainWindow) { attachOrchestratorTrpc(...) }` with `if (!mainWindow) throw new Error('mainWindow is null after createWindow — cannot attach orchestrator tRPC'); attachOrchestratorTrpc(...)`. The throw fails loudly at startup rather than producing a half-wired app where the renderer's typed surface silently breaks.
- **resolved_by:** 

## FIND-SPRINT-006-6
- **source:** TASK-254 (code-reviewer)
- **type:** bug
- **severity:** medium
- **status:** resolved
- **location:** frontend/tsconfig.json (include) vs shared/types/trpc.ts
- **description:** TASK-254's AC #9 says the AppRouter is re-exported from `shared/types/trpc.ts` "so the frontend can import it without crossing the main/ boundary directly." However, `frontend/tsconfig.json` currently sets `"include": ["src"]` — it does NOT include `../shared`, while `main/tsconfig.json` does (`"include": ["src/**/*", "../shared/**/*"]`). When the next task in this epic wires the renderer-side tRPC client and tries `import type { AppRouter } from 'shared/types/trpc'` (or whatever the alias resolves to), tsc will not find the file under the frontend project. The re-export file itself compiles fine under main's tsconfig (which is why standalone-typecheck passes), but the consumer side will fail.
- **suggested_action:** In the renderer-wiring follow-up (TASK-255 or equivalent), either (a) add `"../shared/**/*"` to `frontend/tsconfig.json` `include`, (b) add a path alias and `references`, or (c) build shared as its own project with `composite: true` and reference it from both `main` and `frontend`. Option (c) is cleanest if shared starts to grow.
- **resolved_by:** TASK-255

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

## FIND-SPRINT-006-5
- **source:** TASK-254 (verifier)
- **type:** anti-pattern
- **severity:** medium
- **status:** open
- **location:** main/src/orchestrator/trpc/routers/events.ts:48
- **description:** `makePlaceholderAsyncIterator<T>` is declared as `async function*` (an async generator) but its body never reaches a `yield` statement — it only `await`s the abort signal and returns. ESLint's `require-yield` rule rightly flags this and pnpm lint now reports `1 error` where the baseline (pre-TASK-254) had `0 errors, 228 warnings`. The generator is consumed via `for await (const ev of source) yield ev;` and via `throttleAsyncIterator(source, 60)`, so behaviourally it is a never-yielding iterable; the lint error is real and CI-failing. Two fixes are equivalent in semantics: (a) add a defensive `if (false) yield undefined as T;` to satisfy the rule, (b) add a `// eslint-disable-next-line require-yield` directive with a one-line rationale, or (c) replace the function with a hand-rolled object implementing `AsyncIterable<T>` (no async-generator syntax). Option (c) is cleanest because the function genuinely is not generator-shaped — it's a one-shot abort-await with a typed empty stream.
- **suggested_action:** Replace `async function* makePlaceholderAsyncIterator` with a plain async function returning an AsyncIterable: `function makePlaceholderAsyncIterator<T>(signal: AbortSignal): AsyncIterable<T> { return { async *[Symbol.asyncIterator]() { if (signal.aborted) return; await new Promise<void>((r) => signal.addEventListener('abort', () => r(), { once: true })); } }; }` — or apply the eslint-disable directive if you want to keep the current shape. Either way, `pnpm --filter main lint` must exit 0.
- **resolved_by:** 

## FIND-SPRINT-006-4
- **source:** TASK-254 (executor)
- **type:** bug
- **severity:** medium
- **status:** open
- **location:** main/node_modules/better-sqlite3
- **description:** better-sqlite3 native module compiled against NODE_MODULE_VERSION 136 but current Node.js requires 137. Affects 22 tests across transitions.test.ts, rawEventsSink.test.ts, fileMigrationRunner.test.ts, and cyboflowSchema.test.ts. Tests in those suites all fail with the same binding error. Unrelated to TASK-254 changes — pre-existing environment issue. Fix: run npm rebuild better-sqlite3 or pnpm rebuild --filter main.
- **suggested_action:** Run: cd main && pnpm rebuild better-sqlite3, or rebuild with the Electron version: electron-rebuild -f -w better-sqlite3
- **resolved_by:** 

## FIND-SPRINT-006-7
- **type:** scope_deviation
- **source:** TASK-255 (executor)
- **severity:** low
- **status:** resolved
- **location:** frontend/tsconfig.json
- **description:** required to meet AC: frontend tsconfig must include ../shared to resolve AppRouter type import — directly addresses FIND-SPRINT-006-6
- **resolved_by:** verifier — files_owned: plan explicitly owns frontend/tsconfig.json (line 13 of TASK-255-plan.md), this is not a scope deviation

## FIND-SPRINT-006-8
- **type:** scope_deviation
- **source:** TASK-255 (executor)
- **severity:** low
- **status:** resolved
- **location:** frontend/package.json
- **description:** required to meet AC: frontend must declare @trpc/client, trpc-electron, superjson as dependencies for trpcClient.ts to typecheck and bundle correctly
- **resolved_by:** verifier — files_owned: plan explicitly owns frontend/package.json (line 14 of TASK-255-plan.md), this is not a scope deviation

## FIND-SPRINT-006-10
- **type:** scope_deviation
- **source:** TASK-255 (executor)
- **severity:** low
- **status:** resolved
- **location:** main/src/database/database.ts
- **description:** required to meet AC: DatabaseService needs a public getDb() accessor so the inline DatabaseLike adapter in index.ts can forward prepare() and transaction() calls without a type-erasure cast. The as unknown as DatabaseLike cast in index.ts:687 was the code-review blocker for TASK-255.
- **resolved_by:** verifier — plan-prescribed: Implementation Step 3 explicitly anticipates "TASK-253's DatabaseLike shape may need a tiny adapter object; if so, define it inline rather than expanding the orchestrator's surface." The getDb() accessor is the minimum surface needed for that inline adapter to delegate without exposing the private better-sqlite3 handle as public. Also AC-prescribed: removing the as unknown as DatabaseLike cast was required to satisfy "structural typecheck without cast bypass" surfaced by code review.
