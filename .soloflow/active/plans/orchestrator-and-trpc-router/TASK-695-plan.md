---
id: TASK-695
idea: IDEA-021
status: in-flight
created: "2026-05-20T17:00:00Z"
files_owned:
  - patches/trpc-electron@0.1.2.patch
  - package.json
  - main/src/orchestrator/trpc/routers/events.ts
  - frontend/src/stores/reviewQueueSlice.ts
  - frontend/src/trpc/client.ts
  - main/src/orchestrator/trpc/__tests__/router.test.ts
  - frontend/src/stores/__tests__/reviewQueueSlice.test.ts
files_readonly:
  - frontend/src/utils/trpcClient.ts
  - frontend/src/stores/reviewQueueStore.ts
  - shared/types/stuckDetection.ts
  - main/src/orchestrator/trpc/router.ts
  - main/src/orchestrator/trpc/routers/approvals.ts
  - main/src/orchestrator/trpc/trpc.ts
  - main/src/orchestrator/stuckDetector.ts
  - main/src/index.ts
  - node_modules/trpc-electron/src/main/utils.ts
  - node_modules/trpc-electron/dist/main.cjs
  - node_modules/trpc-electron/dist/main.mjs
  - pnpm-lock.yaml
acceptance_criteria:
  - criterion: "Patch file exists targeting trpc-electron@0.1.2's main bundle to neuter the 'Symbol.asyncDispose already exists' throw."
    verification: "test -f patches/trpc-electron@0.1.2.patch && grep -q 'Symbol.asyncDispose already exists' patches/trpc-electron@0.1.2.patch"
  - criterion: package.json declares the patch under pnpm.patchedDependencies.
    verification: "node -e 'const p=require(\"./package.json\");process.exit(p.pnpm && p.pnpm.patchedDependencies && p.pnpm.patchedDependencies[\"trpc-electron@0.1.2\"] ? 0 : 1)'"
  - criterion: "After pnpm install, node_modules/trpc-electron/dist/main.cjs no longer contains 'Symbol.asyncDispose already exists'."
    verification: "pnpm install && ! grep -q 'Symbol.asyncDispose already exists' node_modules/trpc-electron/dist/main.cjs"
  - criterion: events.ts declares onStuckDetected subscription procedure and exports stuckEvents EventEmitter.
    verification: "grep -nE 'onStuckDetected:[[:space:]]*protectedProcedure' main/src/orchestrator/trpc/routers/events.ts && grep -nE 'export const stuckEvents = new EventEmitter' main/src/orchestrator/trpc/routers/events.ts"
  - criterion: reviewQueueSlice.ts no longer casts trpc.cyboflow.events through unknown.
    verification: "! grep -nE 'as unknown as StuckEventsClient' frontend/src/stores/reviewQueueSlice.ts"
  - criterion: reviewQueueSlice.ts no longer imports StuckEventsClient.
    verification: "! grep -nE 'StuckEventsClient' frontend/src/stores/reviewQueueSlice.ts"
  - criterion: Router tests include onStuckDetected subscription placeholder test.
    verification: "grep -nE 'cyboflow.events.onStuckDetected' main/src/orchestrator/trpc/__tests__/router.test.ts"
  - criterion: reviewQueueSlice test passes after cast-through-unknown removal.
    verification: pnpm --filter frontend test --run reviewQueueSlice
  - criterion: pnpm typecheck and pnpm lint exit 0.
    verification: "pnpm typecheck && pnpm lint"
  - criterion: "pnpm dev launches cleanly — cyboflow-frontend-debug.log contains no 'Symbol.asyncDispose already exists' and no 'No subscription-procedure on path cyboflow.events.onStuckDetected'."
    verification: "pnpm dev for >=10s, then quit; ! grep -q 'Symbol.asyncDispose already exists' cyboflow-frontend-debug.log && ! grep -q 'No subscription-procedure on path cyboflow.events.onStuckDetected' cyboflow-frontend-debug.log"
depends_on: []
estimated_complexity: medium
epic: orchestrator-and-trpc-router
test_strategy:
  needed: true
  justification: "Both fixes touch behavior covered by existing test suites: router.test.ts has placeholder subscription tests; reviewQueueSlice.test.ts has a mocked-tRPC test that must pass after the typed proxy access replaces the cast-through-unknown workaround."
  targets:
    - behavior: "onStuckDetected subscription exists, yields zero events before abort, terminates cleanly."
      test_file: main/src/orchestrator/trpc/__tests__/router.test.ts
      type: integration
    - behavior: reviewQueueSlice.subscribeToStuckEvents wires onData to applyStuckEvent without cast-through-unknown.
      test_file: frontend/src/stores/__tests__/reviewQueueSlice.test.ts
      type: unit
---
# Fix tRPC subscription transport: resolve Symbol.asyncDispose polyfill clash and add onStuckDetected procedure

## Objective

Restore the renderer→main subscription channel by eliminating two distinct failures that together kill every tRPC subscription in dev. **(1)** `trpc-electron@0.1.2`'s main-process `makeAsyncResource` throws `Symbol.asyncDispose already exists` whenever a subscription's async-generator iterator already carries that symbol (which Node 22 attaches natively), killing every subscription including `onApprovalCreated`. **(2)** `cyboflow.events.onStuckDetected` was never declared on the router, so the stuck-detection slice falls back to a `cast through unknown` hack that fails at runtime with `'No subscription-procedure on path …'`. Fix A is sequenced before Fix B because without A no subscription works at all.

## Implementation Steps

**Sequence: Fix A (steps 1–5) must land first. Fix B (steps 6–11) builds on a working transport.**

1. **Diagnose the throwing call site.** Run:
   ```
   grep -n "Symbol.asyncDispose already exists" node_modules/trpc-electron/dist/main.cjs node_modules/trpc-electron/dist/main.mjs
   ```
   Expect one match in each file. If absent, STOP — the dep was already patched.

2. **Generate the patch via `pnpm patch`:** Run `pnpm patch trpc-electron@0.1.2`. pnpm prints a temp edit directory. In BOTH `dist/main.cjs` and `dist/main.mjs`:
   - Locate the function body containing the literal `"Symbol.asyncDispose already exists"` throw. The function looks like (name `ke` may differ): `function ke(r,e){const t=r;if(t[Symbol.asyncDispose])throw new Error("Symbol.asyncDispose already exists");return t[Symbol.asyncDispose]=e,t}`
   - Replace with: `function ke(r,e){const t=r;if(!t[Symbol.asyncDispose])t[Symbol.asyncDispose]=e;return t}`
   - Rationale: when Node 22 has attached its native `[Symbol.asyncDispose]`, it's functionally equivalent (calls `return()` on iterator). Keeping the existing dispose avoids the throw and preserves correctness.
   - Save and commit: `pnpm patch-commit '<temp-dir-path>'`. pnpm creates `patches/trpc-electron@0.1.2.patch` and adds `pnpm.patchedDependencies` to `package.json`.

3. **Verify the patch:**
   ```
   test -f patches/trpc-electron@0.1.2.patch
   grep -q 'Symbol.asyncDispose already exists' patches/trpc-electron@0.1.2.patch
   node -e 'console.log(require("./package.json").pnpm.patchedDependencies)'
   pnpm install
   ! grep -q 'Symbol.asyncDispose already exists' node_modules/trpc-electron/dist/main.cjs
   ```

4. **Document the fix in `frontend/src/trpc/client.ts`.** Insert a short JSDoc note above `createTRPCProxyClient` documenting that the clash is resolved via `patches/trpc-electron@0.1.2.patch` and NO renderer-side shim is required (renderer's `dist/renderer.mjs` already uses safe `Symbol.asyncDispose ?? (...)` nullish-fallback). Do NOT add runtime polyfill code.

5. **Quick smoke check.** Launch `pnpm dev`, leave for ≥10s, quit. Read `cyboflow-frontend-debug.log` — zero matches for `Symbol.asyncDispose already exists`. The `onApprovalCreated` subscription should log `connected` (not `disconnected`).

6. **Declare `stuckEvents` EventEmitter in `main/src/orchestrator/trpc/routers/events.ts`.** Below the existing `approvalEvents` declaration:
   ```ts
   /**
    * Main-process EventEmitter for stuck-run lifecycle events.
    * The emit-source bridge (StuckDetector → stuckEvents) belongs in
    * stuck-detection-and-observability's instantiation step in main/src/index.ts.
    * Until that wiring lands, the subscription procedure exists and is
    * type-safe but yields no events — sufficient to eliminate the
    * "No subscription-procedure on path" runtime error.
    */
   export const stuckEvents = new EventEmitter();
   ```

7. **Import `StuckDetectedEvent`:**
   ```ts
   import type { StuckDetectedEvent } from '../../../../../shared/types/stuckDetection';
   ```

8. **Add the `onStuckDetected` subscription procedure** after `onApprovalDecided`, mirroring its shape:
   ```ts
   onStuckDetected: protectedProcedure
     .subscription(async function* ({ signal }): AsyncGenerator<StuckDetectedEvent> {
       const abortSignal = signal ?? new AbortController().signal;
       const source = eventToAsyncIterable<StuckDetectedEvent>(
         stuckEvents,
         'detected',
         abortSignal,
       );
       for await (const ev of source) {
         yield ev;
       }
     }),
   ```

9. **Remove the cast-through-unknown workaround in `reviewQueueSlice.ts`:**
   - Delete line 188's `const events = trpc.cyboflow.events as unknown as StuckEventsClient;` and replace usage at line 190 with direct call: `const subscription = trpc.cyboflow.events.onStuckDetected.subscribe(undefined, { … });`.
   - Remove `StuckEventsClient` from the import (keep `StuckDetectedEvent` and `StuckReason`).
   - Update the JSDoc on lines 24-28 with a one-line note that TASK-695 added the procedure.

10. **Update tests:**
    - **`router.test.ts`** — add a third subscription placeholder test in existing `describe('appRouter subscription placeholders', ...)` block, copying `onApprovalCreated yields zero events and terminates on abort` but pointing at `cyboflow.events.onStuckDetected` with `undefined` input.
    - **`reviewQueueSlice.test.ts`** — the existing mock at line 25 already declares `onStuckDetected.subscribe` on `trpc.cyboflow.events`. After step 9 the production code accesses this path natively. No mock changes required; re-run to confirm. Run: `pnpm --filter frontend test --run reviewQueueSlice`.

11. **Final gates:** Each must exit 0:
    ```
    pnpm typecheck
    pnpm lint
    pnpm --filter main test --run trpc/__tests__/router
    pnpm --filter frontend test --run reviewQueueSlice
    ```
    Then `pnpm dev` for ≥10s, quit, grep log for the two error substrings — both absent.

## Acceptance Criteria

See frontmatter.

## Test Strategy

**Router test:** add `cyboflow.events.onStuckDetected yields zero events and terminates on abort` mirroring the existing `onApprovalCreated` placeholder test. Same `callSubscription` helper, `undefined` input, immediate abort.

**Slice test:** no new test cases — existing mock already declares `onStuckDetected.subscribe`. After step 9 the slice still compiles against the typed proxy.

No mocking changes for the asyncDispose patch — the patch is invisible to userland code.

## Hardest Decision

**Patch via `pnpm patch` vs. defensive renderer shim.** The IDEA suggested a renderer-side `Object.defineProperty(Symbol, 'asyncDispose', …)` shim in `frontend/src/trpc/client.ts`. I rejected that approach: investigation of `node_modules/trpc-electron/src/main/utils.ts:30-32` and the compiled `dist/main.cjs`/`dist/main.mjs` shows the throw is in the **main process**, inside `makeAsyncResource`, called by `iteratorResource` in `handleIPCMessage.ts:112`. The error surfaces in the renderer's `onError` handler only because tRPC serializes main-process errors back. A renderer-side shim cannot prevent the main-process throw. The renderer's own `dist/renderer.mjs:50` already uses the safe nullish-fallback pattern — nothing to shim there. `pnpm patch` targets the real defect surface and survives reinstalls.

## Rejected Alternatives

- **Bump `trpc-electron`.** Latest is 0.1.2; no patch release. Major version bump would require revisiting `createTRPCProxyClient` + `ipcLink` API — out of scope.
- **Pin `@trpc/server` / `@trpc/client` differently.** Mis-targeted — the bug is in `trpc-electron`'s `utils.ts`.
- **Renderer-side polyfill shim.** Cannot fix main-process throw.
- **Wire StuckDetector → stuckEvents in this task.** Tempting but belongs in `stuck-detection-and-observability` epic. Scoping it here would expand to a separate epic.

## Lowest Confidence Area

**Subscription works but yields no events until StuckDetector wiring lands.** This task adds the procedure and removes the cast, eliminating the `'No subscription-procedure on path'` error. But StuckDetector is currently not instantiated in `main/src/index.ts` (verified by grep). So `onStuckDetected` yields no events even after this task. That's correct per the hard boundary, but a verifier expecting `onStuckDetected` to deliver events in dev may file a false-positive regression. Mitigated by the inline JSDoc.

**Patch fragility.** `pnpm patch` produces a unified-diff against minified bundle. If `trpc-electron@0.1.2` republishes with different minification (low risk on mat-sz fork), patch fails to apply at install — visible immediately. Mitigation: regenerate via `pnpm patch trpc-electron@0.1.2` if it ever republishes.
