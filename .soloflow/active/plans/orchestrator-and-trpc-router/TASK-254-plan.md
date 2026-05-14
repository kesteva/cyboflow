---
id: TASK-254
idea: IDEA-006
idea_id: IDEA-006
status: in-flight
created: "2026-05-11T00:00:00Z"
files_owned:
  - main/src/orchestrator/trpc/context.ts
  - main/src/orchestrator/trpc/trpc.ts
  - main/src/orchestrator/trpc/router.ts
  - main/src/orchestrator/trpc/routers/runs.ts
  - main/src/orchestrator/trpc/routers/approvals.ts
  - main/src/orchestrator/trpc/routers/workflows.ts
  - main/src/orchestrator/trpc/routers/events.ts
  - main/src/orchestrator/trpc/throttle.ts
  - main/src/orchestrator/trpc/__tests__/throttle.test.ts
  - main/src/orchestrator/trpc/__tests__/router.test.ts
  - shared/types/trpc.ts
files_readonly:
  - .soloflow/active/ideas/IDEA-006.md
  - .soloflow/active/research/ROADMAP-001-research-architecture.md
  - .soloflow/active/research/ROADMAP-001-research-risks.md
  - .soloflow/active/research/ROADMAP-001-research-ecosystem.md
  - main/src/orchestrator/Orchestrator.ts
  - main/src/orchestrator/RunQueueRegistry.ts
  - main/src/orchestrator/types.ts
acceptance_criteria:
  - criterion: "main/src/orchestrator/trpc/context.ts exports createContext(): { userId: 'local' } as a synchronous function returning the auth-principal placeholder"
    verification: "grep -n 'createContext' main/src/orchestrator/trpc/context.ts shows the named export; grep -n \"userId: 'local'\" main/src/orchestrator/trpc/context.ts shows the placeholder literal"
  - criterion: "main/src/orchestrator/trpc/trpc.ts initializes tRPC with superjson transformer and the createContext type from context.ts; exports router, publicProcedure, protectedProcedure (middleware that asserts ctx.userId is defined)"
    verification: "grep -nE 'initTRPC|transformer: superjson|publicProcedure|protectedProcedure' main/src/orchestrator/trpc/trpc.ts shows all four names"
  - criterion: "main/src/orchestrator/trpc/router.ts exports appRouter combining cyboflow.runs, cyboflow.approvals, cyboflow.workflows, cyboflow.events as nested routers under the 'cyboflow' namespace, and exports type AppRouter = typeof appRouter"
    verification: "grep -nE 'cyboflow:|export type AppRouter' main/src/orchestrator/trpc/router.ts shows the cyboflow namespace and the type alias"
  - criterion: "cyboflow.runs router defines list, start, cancel, get procedures (zod input validation); cyboflow.approvals defines listPending, approve, reject; cyboflow.workflows defines list, get; cyboflow.events defines onStreamEvent and onApprovalCreated as subscriptions"
    verification: "grep -nE '(list|start|cancel|get|listPending|approve|reject|onStreamEvent|onApprovalCreated):' main/src/orchestrator/trpc/routers/*.ts shows all 11 procedure definitions across the four files (each procedure key followed by `: publicProcedure` or `: protectedProcedure`)"
  - criterion: "Every procedure body is a placeholder: queries/mutations throw new TRPCError({ code: 'NOT_IMPLEMENTED', message: 'TODO: implemented in <future-epic>' }); subscriptions yield from an async generator that produces zero events and then awaits a never-resolving promise (placeholder for the real event source)"
    verification: "grep -nE \"code: 'NOT_IMPLEMENTED'\" main/src/orchestrator/trpc/routers/runs.ts main/src/orchestrator/trpc/routers/approvals.ts main/src/orchestrator/trpc/routers/workflows.ts shows at least 9 occurrences (one per query/mutation); grep -nE 'async function\\*|async \\*' main/src/orchestrator/trpc/routers/events.ts shows the generator-subscription pattern"
  - criterion: "main/src/orchestrator/trpc/throttle.ts exports throttleAsyncIterator<T>(source: AsyncIterable<T>, hz: number): AsyncGenerator<T> that coalesces source events to at most hz emissions per second; the cyboflow.events.onStreamEvent subscription wraps its source iterator with throttleAsyncIterator(source, 60)"
    verification: "grep -n 'throttleAsyncIterator' main/src/orchestrator/trpc/throttle.ts main/src/orchestrator/trpc/routers/events.ts shows the export and the usage; grep -n 'hz' main/src/orchestrator/trpc/throttle.ts shows the rate parameter"
  - criterion: "Throttle unit tests prove: (a) at 60Hz, 1000 source events over 1 simulated second produce 60 ± 5 emissions; (b) the latest event wins (coalescing semantics, not dropping)"
    verification: Run pnpm --filter main test -- throttle and confirm both test cases pass
  - criterion: "Router shape test asserts (via tRPC's createCaller) that appRouter.cyboflow.runs.list exists and throws NOT_IMPLEMENTED; appRouter.cyboflow.approvals.listPending exists and throws NOT_IMPLEMENTED; the router type-checks under typeof appRouter"
    verification: "Run pnpm --filter main test -- router and confirm test 'router exposes cyboflow namespace with NOT_IMPLEMENTED placeholders' passes"
  - criterion: AppRouter type is re-exported from shared/types/trpc.ts so the frontend can import it without crossing the main/ boundary directly
    verification: "grep -n 'AppRouter' shared/types/trpc.ts shows a type re-export from the main orchestrator router"
  - criterion: Zero electron imports across main/src/orchestrator/trpc/ — standalone-typecheck invariant continues to hold
    verification: "grep -rnE \"from ['\\\"]electron['\\\"]\" main/src/orchestrator/trpc/ returns 0 matches"
depends_on:
  - TASK-253
estimated_complexity: medium
epic: orchestrator-and-trpc-router
test_strategy:
  needed: true
  justification: "The throttle is the documented memory-leak mitigation for tRPC v11 subscriptions under high event rates (e.g., long Bash output). Its coalescing semantics and rate must be locked by tests because a regression here is invisible in normal use but catastrophic during the 1-day self-host bar. The router shape test gates the contract that downstream code (TASK-255, the renderer IPC link wiring) will subscribe to."
  targets:
    - behavior: throttleAsyncIterator emits at most 60 events per second when the source produces 1000 events per second
      test_file: main/src/orchestrator/trpc/__tests__/throttle.test.ts
      type: unit
    - behavior: "throttleAsyncIterator coalesces — when multiple source events occur within one 1/60s tick, the latest event is emitted (not the first, not all of them, not dropped silently)"
      test_file: main/src/orchestrator/trpc/__tests__/throttle.test.ts
      type: unit
    - behavior: appRouter.cyboflow.runs.list (and analogous procedures) return NOT_IMPLEMENTED via createCaller
      test_file: main/src/orchestrator/trpc/__tests__/router.test.ts
      type: unit
    - behavior: "createContext() returns { userId: 'local' } and the protectedProcedure middleware accepts it"
      test_file: main/src/orchestrator/trpc/__tests__/router.test.ts
      type: unit
---
# tRPC Router Skeleton, Auth Context, and 60Hz Throttle

## Objective

Build the typed renderer ↔ orchestrator contract for the new `cyboflow.*` surface: a tRPC v11 router with four sub-routers (runs, approvals, workflows, events), a context that carries a placeholder auth principal `{ userId: 'local' }`, and a server-side 60Hz throttle utility that coalesces high-frequency stream events before they cross the IPC boundary. Procedure bodies are deliberate NOT_IMPLEMENTED placeholders — the shape is the contract this epic locks; the bodies fill in across the approval-router epic, the workflow-runs epic, and the stream-parser-to-main epic. The throttle is the load-bearing mitigation for the tRPC v11 subscription memory-leak risk under high event rates (long Bash output, large file reads).

## Implementation Steps

1. **`main/src/orchestrator/trpc/context.ts`.** Export `createContext(): Context` returning `{ userId: 'local' as const }` and `type Context = ReturnType<typeof createContext>`. JSDoc the placeholder: v2 team-tier swaps `'local'` for a real principal derived from a session token.
2. **`main/src/orchestrator/trpc/trpc.ts`.** Import `initTRPC` from `@trpc/server`, `superjson` from `superjson`, `Context` from `./context`. Initialize:
   ```ts
   const t = initTRPC.context<Context>().create({ transformer: superjson });
   export const router = t.router;
   export const publicProcedure = t.procedure;
   const isAuthed = t.middleware(({ ctx, next }) => {
     if (!ctx.userId) throw new TRPCError({ code: 'UNAUTHORIZED' });
     return next({ ctx: { userId: ctx.userId } });
   });
   export const protectedProcedure = t.procedure.use(isAuthed);
   ```
3. **`main/src/orchestrator/trpc/routers/runs.ts`.** Define `runsRouter = router({ list: protectedProcedure.input(z.object({ projectId: z.string().optional() })).query(() => { throw new TRPCError({ code: 'NOT_IMPLEMENTED', message: 'TODO: implemented in workflow-runs epic' }); }), start: protectedProcedure.input(...).mutation(...), cancel: ..., get: ... });`. Four procedures, all placeholder bodies. Input zod schemas should reflect the design doc's expected shapes (e.g. `start` takes `{ workflowId: string, projectId: string }`).
4. **`main/src/orchestrator/trpc/routers/approvals.ts`.** `listPending` (query), `approve` (mutation, input `{ approvalId: string, message?: string }`), `reject` (mutation, input `{ approvalId: string, message?: string }`). All NOT_IMPLEMENTED.
5. **`main/src/orchestrator/trpc/routers/workflows.ts`.** `list` (query, no input), `get` (query, input `{ workflowId: string }`). Both NOT_IMPLEMENTED.
6. **`main/src/orchestrator/trpc/routers/events.ts`.** Two subscriptions using the async-generator pattern (tRPC v11 native):
   ```ts
   onStreamEvent: protectedProcedure
     .input(z.object({ runId: z.string() }))
     .subscription(async function* ({ input, signal }) {
       const source = makePlaceholderAsyncIterator<StreamEvent>(signal); // never-yields generator for now
       for await (const ev of throttleAsyncIterator(source, 60)) {
         yield ev;
       }
     }),
   onApprovalCreated: protectedProcedure.subscription(async function* ({ signal }) {
     const source = makePlaceholderAsyncIterator<ApprovalCreated>(signal);
     for await (const ev of source) yield ev;
   })
   ```
   The `makePlaceholderAsyncIterator` is a local helper that yields nothing but respects `signal.aborted` (it `await`s `new Promise(resolve => signal.addEventListener('abort', resolve))` then returns). This makes the subscriptions wire-correct now without faking event sources; later epics replace `makePlaceholderAsyncIterator` with the EventEmitter-backed iterator from stream-parser-to-main.
7. **`main/src/orchestrator/trpc/router.ts`.** Compose `appRouter = router({ cyboflow: router({ runs: runsRouter, approvals: approvalsRouter, workflows: workflowsRouter, events: eventsRouter }) })`. Export `type AppRouter = typeof appRouter`.
8. **`main/src/orchestrator/trpc/throttle.ts`.** Implement `throttleAsyncIterator<T>(source: AsyncIterable<T>, hz: number): AsyncGenerator<T>`. Algorithm: maintain a `latest: T | undefined` and a `dirty: boolean`. Consume the source in a background loop, overwriting `latest` and setting `dirty = true`. On a `setInterval(1000/hz)` tick, if `dirty`, yield `latest` and clear `dirty`. Clean up the background consumer on generator return/throw (use try/finally with a `done = true` flag the consumer loop checks). Document the coalescing semantics in the JSDoc.
9. **`shared/types/trpc.ts`.** Re-export `type AppRouter` from `'../../main/src/orchestrator/trpc/router'`. The frontend will import from `shared/types/trpc` so the dependency direction is shared → main, not frontend → main directly.
10. **`main/src/orchestrator/trpc/__tests__/throttle.test.ts`.** Vitest. Two tests: 60Hz rate cap (drive 1000 events at 1ms intervals, count emissions over 1s wall-clock — use `vi.useFakeTimers()` and explicit `vi.advanceTimersByTime` for determinism), and coalescing-latest semantics (emit events 1..10 within one tick window, assert the consumer sees only 10).
11. **`main/src/orchestrator/trpc/__tests__/router.test.ts`.** Vitest. Use `appRouter.createCaller(createContext())` to invoke `cyboflow.runs.list({})` and assert it throws a tRPC NOT_IMPLEMENTED error. Repeat for one procedure per sub-router. Add a test that `createContext()` returns `{ userId: 'local' }` and that `protectedProcedure` accepts it without throwing UNAUTHORIZED.
12. **Run `pnpm --filter main test -- throttle router`** — all four tests pass.
13. **Final sweep.** `grep -rnE "from ['\"]electron['\"]" main/src/orchestrator/trpc/` must return 0. `pnpm --filter main typecheck` exits 0.

## Acceptance Criteria

All ten AC entries hold. The shape greps (createContext, appRouter, sub-routers, throttle export, throttle usage, NOT_IMPLEMENTED placeholders, shared AppRouter re-export), the no-electron-imports grep, the four test cases, and the typecheck are the proof.

## Test Strategy

Unit tests at `main/src/orchestrator/trpc/__tests__/throttle.test.ts` and `main/src/orchestrator/trpc/__tests__/router.test.ts`, both vitest. The throttle tests use `vi.useFakeTimers()` for deterministic rate measurement — no wall-clock dependence. The router test uses tRPC's `createCaller(createContext())` to invoke procedures in-process without an IPC link, which is the supported way to unit-test routers per tRPC v11 docs. No mocks beyond fake timers.

## Hardest Decision

**Where the throttle lives and what it operates on.** Three viable shapes:
1. Throttle inside the subscription procedure body (per-subscription) — chosen.
2. Throttle on the EventEmitter source before subscriptions consume it — would coalesce events globally, but breaks the "raw_events stores full fidelity" invariant.
3. Throttle on the renderer client side after receiving via IPC — defeats the entire purpose, since the back-pressure problem is on the IPC queue.

Choice: option 1. The throttle is a per-subscription async-iterator transform, so the broadcast rate per renderer subscription is capped at 60Hz independently. The raw EventEmitter source is unthrottled; the `raw_events` DB writer (a separate consumer added in stream-parser-to-main) still gets every event.

## Rejected Alternatives

- **RxJS observables.** tRPC v11 still supports them, but async generators are the v11-native idiom and clean up on client disconnect via `return()` naturally. Rejected to avoid pulling in RxJS as a transitive dep.
- **`requestAnimationFrame`-style throttling.** Doesn't exist in Node main process; would need a polyfill. `setInterval(1000/60)` is the right primitive here.
- **First-wins vs latest-wins coalescing.** Latest-wins is correct for stream events — the renderer cares about "current state of this run", not "first event in the tick window". Locking this in the test is intentional.
- **Embedding the auth-principal placeholder inside `trpc.ts` instead of `context.ts`.** Separation gives the v2 swap a single file to replace. Kept separate.

## Lowest Confidence Area

The exact tRPC v11 subscription error semantics when the throttle's background consumer crashes (e.g., source throws). The spec says async generators clean up on `return()`/`throw()`, but the interaction between the throttle's inner background loop and the generator's lifecycle is subtle. The unit tests cover the happy path; an integration test against a real stream-event source (added in stream-parser-to-main) will surface any disconnect-cleanup leaks. If the test against the real source reveals a leak, the throttle gets an explicit `AbortSignal` parameter and propagates it to the inner consumer.
