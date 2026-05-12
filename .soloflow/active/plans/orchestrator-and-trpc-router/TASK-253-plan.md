---
id: TASK-253
idea: IDEA-006
idea_id: IDEA-006
status: ready
created: 2026-05-11T00:00:00Z
files_owned:
  - main/src/orchestrator/Orchestrator.ts
  - main/src/orchestrator/types.ts
  - main/src/orchestrator/__tests__/Orchestrator.test.ts
files_readonly:
  - .soloflow/active/ideas/IDEA-006.md
  - .soloflow/active/research/ROADMAP-001-research-architecture.md
  - .soloflow/active/research/ROADMAP-001-research-risks.md
  - .soloflow/active/roadmaps/ROADMAP-001.md
  - docs/ARCHITECTURE.md
  - main/src/orchestrator/RunQueueRegistry.ts
acceptance_criteria:
  - criterion: "main/src/orchestrator/Orchestrator.ts exports a class with start(): Promise<void> and stop(): Promise<void> public methods and a constructor that accepts a dependencies object (no globals, no top-level singletons)"
    verification: "grep -nE 'class Orchestrator|async start\\(|async stop\\(' main/src/orchestrator/Orchestrator.ts shows the class declaration and both lifecycle methods"
  - criterion: "Orchestrator constructor takes injected dependencies: { db: DatabaseLike; logger: LoggerLike; eventBus: EventEmitter; runQueues: RunQueueRegistry } — all interfaces, NO concrete imports from main/src/services/* and NO 'electron' imports"
    verification: "grep -nE \"from ['\\\"]electron['\\\"]|from ['\\\"]\\.\\./services\" main/src/orchestrator/Orchestrator.ts returns 0 matches; the constructor signature lists the four named dependencies"
  - criterion: "main/src/orchestrator/types.ts defines DatabaseLike and LoggerLike interfaces narrow enough to mock in unit tests (no Electron / better-sqlite3 / fs imports in the type file)"
    verification: "grep -nE \"from ['\\\"]electron['\\\"]|from ['\\\"]better-sqlite3['\\\"]|from ['\\\"]fs\" main/src/orchestrator/types.ts returns 0 matches; the file exports DatabaseLike and LoggerLike type/interface declarations"
  - criterion: "start() is idempotent (a second call while running is a no-op) and stop() drains the RunQueueRegistry via runQueues.drainAll() before resolving"
    verification: "Inspect the Orchestrator.test.ts case 'stop drains the run queue registry' and case 'start is idempotent' both pass"
  - criterion: "Unit test in main/src/orchestrator/__tests__/Orchestrator.test.ts constructs an Orchestrator with fully in-memory mocks (no real DB, no Electron) and asserts start()/stop() succeed — proves the standalone-testability invariant"
    verification: "Run pnpm --filter main test -- Orchestrator and confirm test 'instantiates with in-memory dependencies' passes"
  - criterion: "Standalone-typecheck invariant: the orchestrator module compiles without an electron module being present in node_modules — verified by a tsc invocation scoped to main/src/orchestrator/ that excludes external types"
    verification: "Run `npx tsc --noEmit --project main/tsconfig.json --listFiles 2>&1 | grep '/orchestrator/' | grep -E 'node_modules/(electron|better-sqlite3)' | wc -l` and confirm 0 — no orchestrator file pulls in electron or better-sqlite3 types transitively"
depends_on: [TASK-251, TASK-252]
estimated_complexity: medium
epic: orchestrator-and-trpc-router
test_strategy:
  needed: true
  justification: "The standalone-typecheck invariant is the load-bearing discipline of this epic — the orchestrator must be testable in isolation so v2 team-tier extraction is an IPC-link swap, not a refactor. A test that instantiates it with in-memory mocks is the lowest-cost proof of that invariant."
  targets:
    - behavior: "Orchestrator instantiates with in-memory DatabaseLike and LoggerLike mocks (no electron, no better-sqlite3) and start()/stop() resolve without error"
      test_file: "main/src/orchestrator/__tests__/Orchestrator.test.ts"
      type: "unit"
    - behavior: "start() called twice without an intervening stop() is a no-op on the second call"
      test_file: "main/src/orchestrator/__tests__/Orchestrator.test.ts"
      type: "unit"
    - behavior: "stop() awaits runQueues.drainAll() before resolving"
      test_file: "main/src/orchestrator/__tests__/Orchestrator.test.ts"
      type: "unit"
---

# Orchestrator Class with start()/stop() and No Electron Imports

## Objective

Create `main/src/orchestrator/Orchestrator.ts` as the single entry point that the rest of the application boots and shuts down. The class accepts all its collaborators (DB, logger, event bus, run-queue registry) via constructor injection — no top-level singletons, no globals, no Electron imports. This preserves the day-1 discipline ("§6.3 build orchestrator as if separate process"): the team-tier v2 extraction becomes a transport swap (replace the in-process EventEmitter + better-sqlite3 with a remote-process bridge) rather than a refactor. The unit test that instantiates it from in-memory mocks is the gate that proves the invariant.

## Implementation Steps

1. **Create `main/src/orchestrator/types.ts`.** Export narrow interfaces:
   - `DatabaseLike` — minimal surface the orchestrator uses (e.g. `prepare(sql: string): { run(...args: unknown[]): { changes: number }; get(...args: unknown[]): unknown; all(...args: unknown[]): unknown[]; }`, `transaction(fn: (...args: unknown[]) => unknown): (...args: unknown[]) => unknown`). Do NOT import from `better-sqlite3` — declare the shape locally so the orchestrator does not transitively depend on the native module.
   - `LoggerLike` — `{ info(msg: string, meta?: Record<string, unknown>): void; warn(...): void; error(...): void; debug(...): void; }`.
   - `OrchestratorDeps` — `{ db: DatabaseLike; logger: LoggerLike; eventBus: EventEmitter; runQueues: RunQueueRegistry }`. Import `EventEmitter` from `'node:events'` only — that's a Node built-in, not Electron.
2. **Create `main/src/orchestrator/Orchestrator.ts`.** Imports: `EventEmitter` from `'node:events'`, `RunQueueRegistry` from `'./RunQueueRegistry'`, types from `'./types'`. No imports from `'electron'`, no imports from `'../services/*'`, no imports from `'better-sqlite3'`.
3. **Implement the class:**
   - `private running = false;`
   - constructor stores `this.deps = deps` (typed as `OrchestratorDeps`)
   - `async start(): Promise<void>` — if `this.running` is true, log a warning and return. Otherwise set `this.running = true` and log `'orchestrator.start'`. Leave the body otherwise empty (the per-domain wiring — stream parser router, approval router — is added by later epics; this task is the shell).
   - `async stop(): Promise<void>` — if `!this.running`, return. Set `this.running = false`. Log `'orchestrator.stop.begin'`. `await this.deps.runQueues.drainAll();`. Log `'orchestrator.stop.complete'`.
   - `isRunning(): boolean` — getter for observability.
4. **Add a top-of-file JSDoc** to `Orchestrator.ts` stating the standalone-typecheck invariant in plain language and pointing to ROADMAP-001 §6.3.
5. **Create `main/src/orchestrator/__tests__/Orchestrator.test.ts`.** Use vitest. Build a fake `DatabaseLike` (in-memory `Map`), a fake `LoggerLike` (collects calls into arrays), a real `EventEmitter`, and a real `RunQueueRegistry`. Three test cases per test_strategy targets.
6. **Run `pnpm --filter main test -- Orchestrator`** — all three tests pass.
7. **Run the standalone-typecheck gate.** `pnpm --filter main typecheck` exits 0. Then run `grep -rnE "from ['\"]electron['\"]|from ['\"]\\.\\./services|from ['\"]better-sqlite3['\"]" main/src/orchestrator/` and confirm 0 matches — the orchestrator subtree is electron-free.

## Acceptance Criteria

All six AC entries hold. The shape grep, the import-zero grep, the typecheck, and the three test cases compose the gate.

## Test Strategy

Unit tests at `main/src/orchestrator/__tests__/Orchestrator.test.ts` using vitest. The defining test is "instantiates with in-memory dependencies and start()/stop() resolve" — this is the standalone-testability proof. Mocks are entirely local to the test file (no shared fixture file yet; one will appear when the suite grows past ~3 tests). No vitest module mocks needed — the constructor injection means we pass plain objects.

## Hardest Decision

**Whether to import `EventEmitter` from `'node:events'` or accept it via injection.** Node built-ins do not break the standalone-testability invariant (they are not Electron, not main-process-only, not native modules). Importing directly keeps the orchestrator boilerplate small. The injection alternative would require callers to pass an emitter at construction time — needless ceremony for v1, since the orchestrator owns the event bus by definition. Choice: import from `'node:events'`. The invariant we care about is "no electron, no better-sqlite3, no native modules", not "zero imports".

## Rejected Alternatives

- **Top-level singleton (`export const orchestrator = new Orchestrator(...)`)**. Easier wiring, breaks standalone testability. Rejected.
- **Inherit from `EventEmitter` directly.** Conflates the orchestrator's lifecycle with its event-bus role. Rejected — keep them separate so the eventBus dependency can be swapped (e.g. a typed pub/sub library) without touching Orchestrator's surface.
- **Pull `DatabaseService` (Crystal's concrete class) as the `db` dep.** That would transitively pull `better-sqlite3` and Electron's `app.getPath` calls. Rejected — `DatabaseLike` is the abstraction; the real injection happens in `main/src/index.ts` (which already has Electron context). The orchestrator does not know its db is `better-sqlite3`.

## Lowest Confidence Area

The exact shape of `DatabaseLike`. The orchestrator does not yet use it (start/stop are empty), so the interface is a guess pending the workflow-runs / raw-events / approvals downstream tasks. The risk is over-narrowing now and having to widen later, which is a non-breaking change. Acceptable.
