---
id: IDEA-018
type: BUG
status: draft
created: 2026-05-20T00:45:00Z
source: live_debugging_session
roadmap_epic: "orchestrator-and-trpc-router"
title: "RunView receives only 1 envelope per run despite ~148 raw_events persisted; PreToolUse approvals never surface in Review Queue"
---

# Symptom

After SPRINT-022 (panelId/runId alignment, skipPersistence flag) and the four
follow-up fixes landed today (commits `3d17a19`, `d3142db`, `715b6c9`), workflow
runs successfully reach status `completed` and persist ~140-150 `raw_events`
rows per run, but **only one envelope reaches the renderer** (`session_info`)
and **no PreToolUse approval ever surfaces in the Review Queue rail**.

Observed during the 2026-05-19 evening session against project `Tester-mctest`
running the `prune` workflow.  Three runs end-to-end (run IDs prefix
`49d160bb...`, `0d33e508...`, `4369fcfd...`).  Identical symptom each time.

## Evidence

- **raw_events count per run:** 148, 120, ~150 — claude actually ran 10+ turns
  and produced full SDK event streams.
- **Renderer console** (after instrumenting `subscribeToStreamEvents` in
  `frontend/src/utils/cyboflowApi.ts:96`):
  ```
  [cyboflowApi] stream event #1 for 4369fcfd: unknown
  ```
  No event #2, #3, etc.
- **Result event payload** (read from raw_events table) for run `0d33e508`:
  > "I'm hitting a persistent 'Internal approval-router error' on every tool
  > call (Bash, Glob, etc.), so I can't proceed with `/soloflow:prune`.
  > This isn't a permission denial — no prompt is appearing for you to approve
  > — it looks like a harness/router issue on this session."

  Claude exited gracefully after the approval-router race rejected every tool
  call.  The race was fixed in commit `715b6c9` for runs going forward, BUT the
  renderer envelope problem persists for the post-fix run `4369fcfd`.

- **Worktree contents:** no file changes — claude never executed any tool, so
  no diff to show.  Expected once the loop completes for real.

## What was fixed today (groundwork)

1. **`3d17a19` — `fix: wire RunQueueRegistry into RunLauncher`**
   RunLauncher's 11th ctor param was unwired in `index.ts:640`; the SDK-substrate
   guard at `runLauncher.ts:154` short-circuited and never enqueued
   `RunExecutor.execute()`.  Runs sat at `starting` forever.

2. **`d3142db` — `fix: stop reconciliation from dropping stuck_detected_at`**
   Tier 2 reconciliation in `reconcileWorkflowRunsSchema()` treated
   `stuck_detected_at` as drift and rebuilt the table to drop it.  StuckDetector
   then threw `SqliteError` on every boot, which propagated as an unhandled
   rejection out of `Orchestrator.start()` and prevented
   `ApprovalRouter.initialize()` from running.

3. **`715b6c9` — `fix: transition to running pre-spawn; silence Crystal validation`**
   - `RunExecutor.onLifecycleTransition('pre_spawn')` now calls
     `lifecycleTransitions.running(runId)` BEFORE the SDK spawns.  Previously
     the transition fired only on `onFirstMessage` (first JSON output event),
     racing with the SDK's in-process PreToolUse hook — the hook would see
     `status='starting'` and reject with `RunNotRunningError`.
   - Crystal-era `claudeCodeManager` listeners in `events.ts` (output / spawned /
     exit / error) skip Crystal session validation when panelId / sessionId
     matches the 32-char no-dash hex shape of a cyboflow run ID.
   - Renderer `subscribeToStreamEvents` logs the first 3 events and every 25th
     thereafter — confirmed only event #1 ever reaches the renderer.

## Open hypotheses for next session

### H1 — Backend stops publishing after the first event

The bridge at `main/src/orchestrator/runEventBridge.ts:170-246` is supposed to
publish every JSON output event whose panelId matches runId.  Two sub-hypotheses:

- **H1a — TypedEventNarrowing throws on subsequent events.**  If `narrow(p.data)`
  raises for the second+ event types (`assistant`, `user`, `stream_event`,
  `result`, `rate_limit_event`), the listener catches and returns — log line
  is `[runEventBridge] narrowing threw unexpectedly`.  Worth grepping the
  backend log for that string.

- **H1b — `publisher.publish` throws synchronously after the first event.**
  Wrapped in try/catch at `runEventBridge.ts:224-231`, logs at warn level.

In both cases, raw_events would still be 148 (because CCM's own
EventRouter+RawEventsSink pipeline inserts independently of the bridge).  This
matches the observed behavior.

### H2 — The renderer's IPC channel only receives the first event

`win.webContents.send('cyboflow:stream:${runId}', event)` at `index.ts:573` is
fire-and-forget.  If `webContents` is somehow buffer-full, throttled, or the
channel listener is being torn down after the first event, subsequent sends
go nowhere.  The preload bridge at `preload.ts:621-633` registers a permanent
`ipcRenderer.on`, so unbinding would only happen if `electron.off(channel,
handler)` is called — which only happens in the cleanup function of the
`useEffect` in `RunView.tsx:16-27`.  Could that effect be tearing down
between events?

### H3 — The Crystal-era `manager.on('spawned')` at events.ts:492 still fires

The screenshot in the user's final report shows a "Validation Claude Code
spawned event failed: Session 4369fcfd... not found" error even AFTER
`715b6c9`.  My fix patched the cyboflow-era listeners at events.ts:799 / 853 /
932 / 1082, but `events.ts:492` is a separate `manager.on('spawned')`
registered in a loop for each CLI manager via `cliManagerFactory`.  This is
cosmetic (logs only, doesn't block) but proves the silence patch is incomplete.

## Files to investigate first

```
main/src/orchestrator/runEventBridge.ts:170-246   # the bridge listener
main/src/orchestrator/runExecutor.ts:318-340       # how the bridge is wired
main/src/services/streamParser/typedEventNarrowing.ts  # narrow() failure modes
main/src/services/streamParser/derivers.ts         # deriveEventType for envelopes
frontend/src/components/cyboflow/RunView.tsx:16-27 # subscription useEffect
frontend/src/stores/cyboflowStore.ts:32-33         # appendStreamEvent
main/src/index.ts:569-575                          # cyboflowPublisher
main/src/events.ts:492                             # the missed Crystal listener
```

## Concrete next-session steps

1. **Verify H1 first** — read `cyboflow-backend-debug.log` for the latest run
   and grep for any `[runEventBridge]` warnings.  If narrowing or publish is
   throwing on event #2, the log will say so.

2. **If the backend is publishing all events** — instrument
   `main/src/index.ts:569-575` to log each `publish()` call.  If it logs 148
   but the renderer only receives 1, the bridge between `webContents.send` and
   the renderer is dropping events.

3. **If publish only fires once** — check `runEventBridge.ts` for a single-shot
   guard that shouldn't be there (e.g., the `firstMessageFired` flag at line
   163-164 is supposed to be single-shot for `onFirstMessage` only, but verify
   no other state accidentally tracks "first event" beyond that).

4. **Patch the remaining Crystal validation listener at events.ts:492** with
   the same `isCyboflowRunId` guard for full silence.

5. **Once events flow:** the next real moment-of-truth is the PreToolUse
   approval surfacing in the Review Queue.  ApprovalRouter is now initialized
   and the run reaches `running` before any tool call, so a tool call from
   claude should INSERT into `approvals` table and emit through whatever
   subscription the Review Queue uses.  That subscription path hasn't been
   exercised yet.

## Out of scope (do not bundle)

- RunView visual redesign (currently dumps each event as JSON; not a bug, just
  ugly).  IDEA-017 covers the broader shell-layout cleanup.
- Removing the migration-007 / canonical-schema drift.  The `stuck_detected_at`
  reconciliation fix is sufficient for now; aligning canonical schema with
  migration 007 is its own cleanup.
- tRPC subscription errors in the frontend boot log (`Symbol.asyncDispose
  already exists`, `No "subscription"-procedure on path
  "cyboflow.events.onStuckDetected"`).  Separate boot-time issues unrelated to
  the run-time event flow.
