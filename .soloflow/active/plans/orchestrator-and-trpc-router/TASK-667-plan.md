---
id: TASK-667
idea: TASK-667-debug-envelope-drop
status: ready
created: 2026-05-19T00:00:00Z
files_owned:
  - main/src/orchestrator/runEventBridge.ts
  - main/src/orchestrator/__tests__/runEventBridge.test.ts
  - main/src/events.ts
files_readonly:
  - main/src/orchestrator/runExecutor.ts
  - main/src/orchestrator/__tests__/runExecutor.test.ts
  - main/src/services/streamParser/typedEventNarrowing.ts
  - main/src/services/streamParser/derivers.ts
  - main/src/services/streamParser/schemas.ts
  - main/src/index.ts
  - main/src/preload.ts
  - frontend/src/utils/cyboflowApi.ts
  - frontend/src/components/cyboflow/RunView.tsx
  - frontend/src/stores/cyboflowStore.ts
  - cyboflow-backend-debug.log
  - cyboflow-frontend-debug.log
acceptance_criteria:
  - criterion: "Diagnostic milestone: a written hypothesis-confirmation note exists in the task body's Implementation Notes section identifying which of H1a / H1b / H2 is the root cause, supported by concrete counts from a single fresh run — backend-side raw_events row count for the runId, backend-side bridge-publish call count, and renderer-side `[cyboflowApi] stream event #N` log lines. The note must name the exact log lines or grep commands that produced each count."
    verification: "Read this plan's Implementation Notes section AFTER step 1 has been executed; it names the runId of the diagnostic run, gives three numeric counts (raw_events / bridge-publish / renderer-stream-event), and concludes with one of: 'CONFIRMED H1a', 'CONFIRMED H1b', 'CONFIRMED H2', or 'NONE — escalate'."
  - criterion: "If H1a is confirmed (TypedEventNarrowing.narrow throws on a non-system variant): runEventBridge.ts:192 try/catch block survives unchanged in its fail-soft contract (the catch never silently drops the publish path), AND the underlying narrowing bug is fixed in main/src/services/streamParser/typedEventNarrowing.ts or main/src/services/streamParser/schemas.ts so that ALL six SDK event variants the SDK emits today (system / assistant / user / stream_event / result / rate_limit_event) narrow without throwing. If H1a is NOT confirmed, this AC is N/A and must be marked so."
    verification: "If H1a confirmed: a fresh end-to-end run produces renderer-side `[cyboflowApi] stream event #N` lines for at least N=3, AND `grep -c '\\[runEventBridge\\] narrowing threw' cyboflow-backend-debug.log` returns 0 for that run's lifetime. A new unit test in runEventBridge.test.ts feeds one of each of the 6 SDK variants and asserts publish fires 6 times with no warn. If H1a NOT confirmed: this AC's row in Implementation Notes reads 'N/A — root cause was <H1b|H2>'."
  - criterion: "If H1b is confirmed (publisher.publish throws past the first event): the root cause is fixed at its source (e.g. webContents-send failure mode, BrowserWindow state check, channel-name reuse) rather than papered over with broader try/catch. The existing fail-soft try/catch at runEventBridge.ts:224-231 remains. If H1b is NOT confirmed, this AC is N/A."
    verification: "If H1b confirmed: a fresh end-to-end run produces N>=3 `[cyboflowApi] stream event #N` lines AND `grep -c '\\[runEventBridge\\] publisher.publish threw' cyboflow-backend-debug.log` returns 0 for that run. The fix is described in Implementation Notes with the specific failure mode named. If H1b NOT confirmed: N/A row."
  - criterion: "If H2 is confirmed (renderer IPC listener is torn down between events): RunView.tsx's useEffect lifecycle no longer tears the listener down mid-stream. Either (a) activeRunId stops changing identity unnecessarily, or (b) the subscription survives identity-stable re-renders, or (c) the subscription moves out of the per-component useEffect into a store-level singleton that persists across mounts. The fix preserves the cleanup-on-unmount contract for legitimate unmounts. If H2 is NOT confirmed, this AC is N/A."
    verification: "If H2 confirmed: a fresh end-to-end run shows N>=3 `[cyboflowApi] stream event #N` lines in the renderer console, AND the renderer DevTools 'Components' panel shows the RunView's useEffect cleanup callback fires exactly 0 or 1 times during the run (1 on unmount, 0 during the run). If H2 NOT confirmed: N/A row."
  - criterion: "Cosmetic noise patch: the Crystal-baseline `manager.on('spawned')` listener in `attachProcessLifecycleHandlers` (main/src/events.ts:506) short-circuits when the panelId or sessionId is a cyboflow run ID, matching the pattern already applied to the four cyboflow-specific listeners at events.ts:821, :872, :934, :1084."
    verification: "grep -n 'isCyboflowRunId' main/src/events.ts returns at least 6 hits (was 5). The new hit is inside the body of `manager.on('spawned')` at events.ts:506 and short-circuits BEFORE the validatePanelEventContext / validateEventContext call at lines 507-509. Run a fresh end-to-end cyboflow workflow run and confirm `grep -c '\\[Crystal Validation\\]' cyboflow-backend-debug.log` (or whatever string Crystal's logValidationFailure emits) returns 0 for that run's duration."
  - criterion: "panelId === runId === sessionId invariant from TASK-663 is preserved end-to-end. No new code path introduces a mismatched ID, and no existing call site is rewritten to pass a derived/prefixed value."
    verification: "grep -n 'panelId.*runId\\|panelId === runId' main/src/orchestrator/runExecutor.ts shows the invariant comment unchanged. grep -nE 'panelId: `?\\$\\{?runId' main/src/orchestrator/ returns zero matches (no template-string prefix sneaking in)."
  - criterion: "skipPersistence: true is still set on RunExecutor's bridgeEvents call (TASK-664 invariant). No regression to double-INSERT."
    verification: "grep -n 'skipPersistence: true' main/src/orchestrator/runExecutor.ts returns exactly one match on the bridgeEventsImpl call site at ~line 337. A fresh end-to-end run produces a raw_events row count consistent with single-write semantics (within ±5 rows of the prior baseline — this is approximate because event volume varies, but a 2x doubling would be unmistakable)."
  - criterion: "The renderer's first envelope is no longer the ONLY envelope. A fresh end-to-end workflow run produces at least 3 entries in the renderer console matching `[cyboflowApi] stream event #` and the RunView shows distinct event blocks scrolling past, not just one frozen `session_info` blob."
    verification: "Manual smoke against the `Tester-mctest` project running the `prune` workflow (or any cyboflow workflow): start a run, watch the renderer DevTools console, confirm `[cyboflowApi] stream event #1`, `#2`, `#3` all appear, and that `useCyboflowStore.getState().streamEvents.length >= 3` by the time the run reports `completed`. This is the user-acceptance gate."
  - criterion: "All existing runEventBridge.test.ts cases continue to pass; any new tests added for the confirmed hypothesis (e.g. the 6-variant narrowing test for H1a) pass."
    verification: "`pnpm --filter main test -- --run main/src/orchestrator/__tests__/runEventBridge.test.ts main/src/orchestrator/__tests__/runExecutor.test.ts` exits 0. `pnpm typecheck` exits 0. `pnpm lint` exits 0."
depends_on: []
estimated_complexity: medium
epic: orchestrator-and-trpc-router
test_strategy:
  needed: true
  justification: "Diagnosis-first plan: the specific fix is conditional on which hypothesis is confirmed, so the test surface is also conditional. Two things are unconditionally testable and must be covered: (1) the cosmetic noise patch at events.ts:506 (a small change but a sibling-test scan of main/src/__tests__/ should be done to confirm whether an events.ts test file exists), and (2) whichever runEventBridge code path the confirmed hypothesis touches. For H1a, a 6-variant narrowing regression test must be added to runEventBridge.test.ts to prevent recurrence. For H1b, a test that asserts publish fail-soft logs once-and-only-once per failure (already covered by existing case 3, but the new failure mode may need its own case). For H2, the test lives in a renderer-side Vitest file or Playwright E2E — leave that decision to the executor based on what infra exists; do not invent a new test harness for this task."
  targets:
    - behavior: "If H1a confirmed — TypedEventNarrowing.narrow() handles each of the 6 live SDK variants (system/init, assistant, user, stream_event, result, rate_limit_event) without throwing or returning UnknownStreamEvent for valid payloads."
      test_file: "main/src/orchestrator/__tests__/runEventBridge.test.ts"
      type: unit
    - behavior: "Cosmetic noise patch — manager.on('spawned') at events.ts:506 short-circuits on cyboflow run IDs (32-char hex). Sibling-test scan: check main/src/__tests__/ and main/src/__tests__/events*.test.ts for an existing events.ts harness; if absent, document why no test is added (events.ts has historically been integration-tested via Playwright, not unit-tested) and rely on the end-to-end run as the gate."
      test_file: "main/src/__tests__/events.test.ts"
      type: unit
    - behavior: "Conditional on confirmed hypothesis (H1b or H2 path): add the corresponding regression test in the file the executor identifies as canonical. Do not pre-commit to a path here — record the decision in Implementation Notes after diagnosis."
      test_file: "TBD-after-diagnosis"
      type: unit
---

# Investigate and fix the renderer envelope-drop past event #1

## Objective

Workflow runs reach status `completed` and persist ~140-150 raw_events rows per run, but the renderer receives exactly one stream-event envelope (the initial `session_info` blob) and never gets a #2, #3, etc. This breaks the live event log AND blocks the human-in-the-loop approval rail (PreToolUse approval-request events also never surface). Diagnose which of three hypotheses (H1a narrowing throw, H1b publisher.publish throw, H2 renderer-side listener teardown) is the actual root cause, then apply the minimum fix for that case. Preserve the panelId === runId === sessionId invariant (TASK-663) and the skipPersistence: true flag on RunExecutor's bridge call (TASK-664). Bundle the small cosmetic patch to silence the missed Crystal `spawned`-listener "Session not found" noise in `attachProcessLifecycleHandlers`.

## Implementation Steps

### Phase 1 — Diagnosis (do not write any production code until this is done)

1. **Capture a clean baseline.** Stop any running cyboflow dev instance. Delete or truncate `cyboflow-backend-debug.log` and `cyboflow-frontend-debug.log` at the project root (both are truncated by `pnpm dev` automatically; this is belt-and-braces). Run `pnpm build:main`, then `pnpm dev`.

2. **Trigger ONE fresh workflow run.** In the running app, against the `Tester-mctest` project (or any cyboflow-configured project), launch the `prune` workflow. Note the runId from the renderer console's first `[cyboflowApi] stream event #1` line — that's the diagnostic run's ID. Wait until the run reaches `completed`.

3. **Collect three counts for that runId.** Open three terminals (or run sequentially):

   a. **Renderer-side envelope count.** Read `cyboflow-frontend-debug.log` (which captures renderer console output in dev) and count `[cyboflowApi] stream event #` lines for that runId:
      ```
      grep -cE '\[cyboflowApi\] stream event #[0-9]+ for <run-id-prefix>' cyboflow-frontend-debug.log
      ```
      Or directly inspect the renderer DevTools console. Expected count: 1 (per the bug). Confirmed if so, else the hypothesis space changes.

   b. **Backend bridge-publish count.** runEventBridge has no per-event success log today, so add a temporary one as a diagnostic. Edit `main/src/orchestrator/runEventBridge.ts` line ~225 (just after `publisher.publish(runId, envelope)`) to add ONE line:
      ```ts
      logger?.info?.('[runEventBridge] published', { runId, type: envelope.type });
      ```
      Rebuild (`pnpm build:main`), re-run the diagnostic workflow, and grep:
      ```
      grep -c '\[runEventBridge\] published' cyboflow-backend-debug.log
      ```
      This is the canonical "the bridge tried to publish N events" count. If `> 1` (e.g. ~140), H1a/H1b are EXCLUDED — the backend is publishing, the renderer isn't receiving. Jump to H2. If `== 1`, H1a or H1b is in play.

   c. **Raw events row count.** Open the cyboflow DB and count raw_events for the runId:
      ```
      sqlite3 ~/.cyboflow/sessions.db "SELECT event_type, COUNT(*) FROM raw_events WHERE run_id='<run-id>' GROUP BY event_type;"
      ```
      Expected: ~140-150 across mixed types. This count is set by the CCM-owned EventRouter+RawEventsSink pipeline at `claudeCodeManager.ts:247-255, ~341`, NOT by the bridge (because skipPersistence: true). So this count is independent of H1a/H1b — it confirms the SDK pipeline is healthy upstream of the bridge.

4. **Narrow further if the bridge-publish count is exactly 1.** Both H1a and H1b reach the publisher; the difference is WHERE the second-event handler aborts. Add a second diagnostic log at the entry of `onOutput` (runEventBridge.ts:170, right after the type-guard `if` at 178):
   ```ts
   logger?.info?.('[runEventBridge] onOutput entered', { runId, panelId: (payload as { panelId: string }).panelId, type: (payload as { type: string }).type });
   ```
   Rebuild, re-run, and grep:
   ```
   grep -c '\[runEventBridge\] onOutput entered' cyboflow-backend-debug.log
   ```
   - If `>> 1` (e.g. ~140), the listener IS firing per event, so the abort is downstream — likely H1a (narrowing throws on a non-system variant, the catch at line 193-199 logs at warn and returns BEFORE publish). Confirm with:
     ```
     grep -c '\[runEventBridge\] narrowing threw' cyboflow-backend-debug.log
     ```
     If `>= 139`, **H1a CONFIRMED**.
   - If `== 1`, the listener itself is detached. That points to an unexpected source-EventEmitter quirk, not H1a/H1b/H2 as described — escalate.
   - If `>> 1` but narrowing-threw is 0, the abort is even further downstream: likely H1b (publisher.publish throws). Confirm:
     ```
     grep -c '\[runEventBridge\] publisher.publish threw' cyboflow-backend-debug.log
     ```
     If `>= 139`, **H1b CONFIRMED**.

5. **Confirm H2 if bridge-publish was `>> 1`.** If step 3b showed the backend publishing ~140 events but the renderer console shows only 1, **H2 CONFIRMED** — the IPC channel or renderer listener is the bottleneck. Sub-diagnose:
   - Check preload.ts:621-633 — the listener-wrapper Map is per-channel; verify a single channel registration. Add a temporary `console.log('[preload] registered listener for', channel, 'callback count:', inner?.size)` inside the `on()` registrar to confirm only one wrapper is ever attached and not detached mid-run.
   - Check RunView.tsx useEffect cleanup. Add a temporary `console.log('[RunView] effect cleanup for runId', activeRunId)` inside the returned cleanup function. If you see `[RunView] effect cleanup` between event #1 and the next expected event, that's the smoking gun — the useEffect is re-running.

6. **Record the conclusion in Implementation Notes** at the bottom of this plan body (executor edits this plan in place during execution). The note must include:
   - The diagnostic runId.
   - The three counts (renderer / bridge-publish / raw_events).
   - The grep commands and their results.
   - One of: `CONFIRMED H1a`, `CONFIRMED H1b`, `CONFIRMED H2`, or `NONE — escalate`.

   Do NOT remove the diagnostic log lines yet — they stay until step 7 confirms the fix works.

### Phase 2 — Apply the conditional fix

7. **If H1a confirmed.** The bug is in `TypedEventNarrowing.narrow()` or its underlying `claudeStreamEventSchema`. The schema (`main/src/services/streamParser/schemas.ts`) declares variants for `system`, `assistant`, `user`, `stream_event`, `result` and others; `narrow()` contracts to never throw — it falls through to `{ kind: '__unknown__', raw }` on safeParse failure. If `narrow()` IS throwing, that means an exception is leaking out of `safeParse()` itself (rare but possible with malformed input), or a code path inside `narrow()` is unsafe (e.g. the `typeof parsed === 'object' && parsed !== null` guard at line 38 throws on a frozen prototype-less object — unlikely but worth checking).

   The real fix shape depends on the SDK variant that's tripping the throw. Steps:
   - Capture the warn-logged error message from the diagnostic (it includes the throw's `err.message`). Identify the variant from the surrounding context.
   - If the SDK emits a NEW variant the schema doesn't know about (likely `rate_limit_event` — note that this variant appears in the raw_events table but is NOT visible in the grep of `schemas.ts:type: z.literal\(` patterns above), add the missing schema variant to `schemas.ts` and `shared/types/claudeStream.ts`. Confirm the union in `claudeStreamEventSchema` now includes it.
   - If the throw is from a generic safeParse failure on a malformed payload, wrap `narrow()` so the `_typeCheck` invariant ("never throws") is restored.
   - Add the regression test described in `test_strategy.targets[0]` — feed one fixture per known SDK variant through `bridgeEvents()` and assert publish fires for each.

8. **If H1b confirmed.** The bug is in `cyboflowPublisher.publish` at `main/src/index.ts:569-575` — `win.webContents.send` is throwing past the first call. Likely sub-causes:
   - The first send happens while `mainWindow` is in a transient pre-load state and somehow `win.webContents.send` is buffering or silently failing on subsequent calls (unlikely but possible during dev-reload races).
   - A serialization error on a specific event variant — `webContents.send` requires structuredClone-safe payloads and will throw on a `Date` object that hasn't been ISO-stringified. Check: the envelope's `timestamp: new Date().toISOString()` at runEventBridge.ts:221 is fine, but `payload: typed` may contain a Date field the SDK emits raw. Confirm by inspecting the warn-logged error.
   - Fix: convert the offending field to a JSON-safe shape at the envelope-construction site (runEventBridge.ts:218-222), OR fix the publisher to JSON-stringify + JSON-parse before sending if that's the project's convention. Prefer the former — narrower fix.

9. **If H2 confirmed.** The renderer-side teardown is the culprit. The RunView useEffect at `RunView.tsx:16-27` depends only on `activeRunId`, so it shouldn't re-run unless `activeRunId` actually changes identity. Possible causes:
   - The store's `setActiveRun` is being called repeatedly with the same runId from somewhere (e.g. a parent component re-derives it on every render); since `setActiveRun` in `cyboflowStore.ts:28` does `set({ activeRunId: runId, streamEvents: [] })` — this REPLACES `activeRunId` with the same value, and Zustand's default equality is `Object.is`, so it should NOT trigger a useEffect re-run unless the action is called with a different reference (which can't happen for primitive strings). So this sub-case is unlikely.
   - More likely: the parent component is unmounting and remounting RunView (e.g. when the workflow-runs panel re-renders). React Strict Mode in development double-invokes effects, which would manifest as 2 immediate subscribe/unsubscribe pairs at mount — but that's a one-time effect, not a per-event teardown.
   - Most likely: the `appendStreamEvent` call inside the `onEvent` callback at `RunView.tsx:22` reads `useCyboflowStore.getState()` at call time, which is correct (Zustand snapshot). But if the COMPONENT is using `streamEvents` as a dependency-tracked selector (which it is, line 11), every event triggers a re-render. That re-render does NOT re-run the activeRunId effect unless React decides to re-run effects on every render (it doesn't). So the teardown must come from somewhere external.

   Fix candidates (pick the smallest one that works):
   - **Move the subscription to a Zustand-level singleton.** In `cyboflowStore.ts`, on `setActiveRun(runId)`, call `cyboflowApi.subscribeToStreamEvents` ONCE per runId and store the unsubscribe in the store's internal state (not in `CyboflowState` — keep it as a module-level `let unsubscribeFn: (() => void) | null` to avoid serialization issues). On `setActiveRun` to a new runId or `clearActiveRun`, call the prior unsubscribe and start a new one. RunView's useEffect becomes a no-op for subscriptions. This is the structurally correct fix and is what the TODO comment at `RunView.tsx:15` foreshadows for the tRPC migration.
   - **Or:** keep the subscription in RunView but use a `useRef` to gate it so React Strict Mode's double-invoke doesn't double-subscribe. This is the smaller fix but doesn't address the underlying re-mount risk.

   The executor decides which fix is appropriate based on what step 5's diagnostics actually showed. Document the choice in Implementation Notes.

### Phase 3 — Bundled cosmetic noise patch

10. **Patch the missed Crystal `spawned` listener.** Edit `main/src/events.ts`. Inside `attachProcessLifecycleHandlers` at line 506, the `manager.on('spawned', ...)` body currently calls `validatePanelEventContext` or `validateEventContext` immediately. The four cyboflow-specific listeners further down (events.ts:821, :872, :934, :1084) short-circuit on `isCyboflowRunId(panelId) || isCyboflowRunId(sessionId)` BEFORE validation. The same guard belongs at the top of this `manager.on('spawned')` handler. Insert the guard at the very start of the async callback body (line 507, before line 508's `const validation = ...`):

    ```ts
    // cyboflow workflow runs use isCyboflowRunId-shaped IDs and are handled
    // by runEventBridge; skip Crystal session validation (which would log
    // "Session not found" against the `sessions` table cyboflow never writes to).
    if (isCyboflowRunId(panelId) || isCyboflowRunId(sessionId)) return;
    ```

    No other lines in this listener change. The four downstream listeners already have the identical guard — this is straightforward pattern propagation.

### Phase 4 — Clean up diagnostics and verify

11. **Remove the diagnostic log lines added in steps 3b, 4, and 5.** These were instrumentation; they don't belong in the committed runEventBridge.ts. The only diagnostic-style log that may stay is the existing renderer-side log at `frontend/src/utils/cyboflowApi.ts:97-105` (added in commit 715b6c9 as instrumentation) — it samples the first 3 events and every 25th, which is appropriate for steady-state observability. Leave it as-is.

12. **Re-run the diagnostic workflow with the fix in place.** Confirm:
    - Renderer console shows `[cyboflowApi] stream event #1`, `#2`, `#3`, ... up to at least `#25` (the next-sampled milestone).
    - `useCyboflowStore.getState().streamEvents.length` is at least 3 by the time the run reaches `completed`.
    - The backend log shows zero new entries for `'Session not found'`-style validation noise during the run.
    - `sqlite3` raw_events count is consistent with the pre-fix baseline (no doubling — TASK-664 invariant preserved).

13. **Run typecheck + tests + lint.**
    ```
    pnpm typecheck
    pnpm --filter main test -- --run main/src/orchestrator/__tests__/runEventBridge.test.ts main/src/orchestrator/__tests__/runExecutor.test.ts
    pnpm lint
    ```
    All exit 0.

14. **Update Implementation Notes** with the final confirmed-hypothesis row marked DONE, the fix-shape applied, and the N/A status for the other two hypotheses.

## Acceptance Criteria

See frontmatter. Concretely: (a) diagnosis is recorded with three numeric counts; (b) the confirmed hypothesis's fix lands and is regression-tested; (c) the cosmetic noise patch lands at events.ts:506; (d) panelId===runId===sessionId invariant and skipPersistence:true are preserved; (e) the renderer receives N>=3 envelopes on a fresh run.

## Test Strategy

See `test_strategy` in frontmatter. Two unconditional targets (cosmetic patch, the confirmed-hypothesis regression test) and one TBD target whose canonical file is decided post-diagnosis.

The sibling-test scan for `main/src/events.ts`:
- `ls main/src/__tests__/` — check for any `events*.test.ts`.
- If present, the cosmetic patch's regression test goes there.
- If absent, document in Implementation Notes that events.ts is integration-tested via Playwright (the `pnpm test` chain) rather than unit-tested, and rely on the end-to-end smoke from step 12 as the gate. Do NOT invent a new test harness for a single-line guard.

For runEventBridge.test.ts (which DOES exist and is the canonical home), the new 6-variant test (if H1a confirmed) reads:

```ts
it('(h) narrows and publishes every live SDK variant without throwing', () => {
  const { publish, asPublisher } = makePublisher();
  const src = new EventEmitter();
  const db = makeDb(); // or makeRawEventsDb() after TASK-665
  bridgeEvents({
    runId: SP_RUN_ID,
    source: src,
    publisher: asPublisher,
    db,
    skipPersistence: true,
  });
  // Emit one event of each live SDK variant.
  emitOutput(src, SP_RUN_ID, systemEvent);
  emitOutput(src, SP_RUN_ID, assistantEvent);
  emitOutput(src, SP_RUN_ID, userEvent);
  emitOutput(src, SP_RUN_ID, streamEvent);   // add fixture
  emitOutput(src, SP_RUN_ID, resultEvent);   // add fixture
  emitOutput(src, SP_RUN_ID, rateLimitEvent); // add fixture if schema declares this variant
  expect(publish).toHaveBeenCalledTimes(6);
});
```

The `streamEvent`, `resultEvent`, and `rateLimitEvent` fixtures need to be added at the top of the test file alongside the existing `systemEvent` / `assistantEvent` / `userEvent` fixtures — match the schema shape from `main/src/services/streamParser/schemas.ts` (lines 151, 177, 201, 261 are the canonical variant declarations).

## Hardest Decision

**Whether to lead with diagnosis (this plan) or to ship a speculative "wrap everything in a broader try/catch and add more logging everywhere" fix.** Chose diagnosis-first. The three hypotheses have non-overlapping fix shapes — H1a is a schema/narrowing bug, H1b is a serialization or webContents-send bug, H2 is a renderer-state-management bug. Shipping a one-size-fits-all fix would either be too broad (papering over the real defect class) or too narrow (fixing only one and leaving the others latent). The five-minute cost of running the diagnostic workflow with two temporary log lines is far cheaper than two cycles of "fix-and-pray." The plan body is verbose because each hypothesis branch is a real fork — but only one branch executes.

## Rejected Alternatives

- **Skip diagnosis, blanket-wrap narrowing/publish in a broader try/catch and log everything.** Rejected: the existing try/catch blocks at runEventBridge.ts:193-199 and :224-231 are already fail-soft. Broadening them would mask the real bug rather than fix it. The renderer would still only receive 1 envelope; we'd just have a noisier log.
- **Move the renderer subscription to a tRPC subscription right now (the TODO at RunView.tsx:15).** Rejected: that's a larger migration (epic 7's tRPC cutover) and unrelated to whichever hypothesis confirms. Even if H2 confirms, the smallest fix is to hoist the subscription into the Zustand store as a module-level handle, not to swap the entire transport. The tRPC cutover stays scoped to its own epic.
- **Bundle the RunView visual redesign or the `cyboflow.events.onStuckDetected` missing-procedure fix.** Rejected: explicitly out of scope (see below).
- **Treat the cosmetic noise patch as a separate task.** Rejected: it's a one-line guard following an already-established four-site pattern. Bundling is appropriate per the SoloFlow "too small to justify a sibling task" heuristic.

## Lowest Confidence Area

**H2's exact mechanism.** The plan assumes the renderer-side bottleneck is either a useEffect re-run or a preload listener teardown, but it could also be a different ipcRenderer-side issue (e.g. main-process backpressure on the webContents-send channel under high event rates, manifesting as silent drop after the first send; or a Chromium-IPC channel-name length issue where `cyboflow:stream:<32-char-hex>` exceeds some implementation-specific limit and only the first send succeeds). Step 5's sub-diagnosis is intentionally permissive — the executor may find a fourth sub-cause and adapt. If none of the documented H2 sub-causes fit, escalate with the captured DevTools-side logs and stop; do NOT ship a speculative fix.

The second-lowest area is the H1a fix when the throw originates from a variant the schema declares but is somehow malformed on the wire. The expected outcome (add the variant or fix the schema) assumes a stable SDK contract; if the SDK is emitting a new sub-shape mid-flight, the fix may need to extend ClaudeStreamEvent's union — which has cross-cutting implications (every consumer of ClaudeStreamEvent gets a new branch). That's still a single-task scope, but the blast radius is larger than the typical narrowing patch.

## Implementation Notes

(Populated by the executor during Phase 1 diagnosis. Template:)

- Diagnostic runId: __
- Renderer envelope count (`grep -c '[cyboflowApi] stream event #' cyboflow-frontend-debug.log`): __
- Backend bridge-publish count (`grep -c '[runEventBridge] published' cyboflow-backend-debug.log`): __
- Raw events count (`sqlite3 ... raw_events WHERE run_id=...`): __
- `[runEventBridge] onOutput entered` count: __
- `[runEventBridge] narrowing threw` count: __
- `[runEventBridge] publisher.publish threw` count: __
- Confirmed hypothesis: __ (H1a / H1b / H2 / NONE)
- Fix applied: __
- N/A rationale for the unconfirmed hypotheses: __

## Out of Scope (do NOT bundle)

The following are explicitly out of scope and must NOT be touched in this task. They each have their own future task scope and bundling would obscure this task's diagnosis-and-conditional-fix story:

- **RunView visual redesign.** The current minimal JSON-blob renderer is intentional placeholder UI. Any redesign (collapsible blocks, syntax highlighting, role-based styling, virtualized list) belongs in a UX-focused task, not here.
- **`reconcileWorkflowRunsSchema` vs `006_cyboflow_schema.sql` migration cleanup.** Commit d3142db fixed the immediate `stuck_detected_at` drop; the broader question of "should reconcileWorkflowRunsSchema be deleted in favor of a real migration sequence" is a cyboflow-schema-migration-epic concern.
- **Renderer's pre-existing tRPC subscription errors.** The console errors `Symbol.asyncDispose already exists` and the missing `cyboflow.events.onStuckDetected` procedure are unrelated to the envelope-drop. Both are tracked by the future tRPC-cutover epic. Do not patch them here, do not add silencing try/catches.
- **Per-event-type log filters at the backend.** The diagnostic log lines added in Phase 1 are removed in Phase 4. Persistent per-event observability instrumentation belongs in a dedicated logging-and-observability task, not bundled here.
- **PreToolUse approval-router wiring.** This task fixes the envelope channel that approval-request events also travel through; the approval-router itself is approval-router-and-permission-fix-epic territory. Confirm in Phase 4 that approval-request envelopes now reach the renderer (they will, automatically, once the channel works), but do not extend the renderer's approval-rail UI in this task.
