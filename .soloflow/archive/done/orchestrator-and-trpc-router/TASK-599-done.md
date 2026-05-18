---
id: TASK-599
sprint: SPRINT-016
epic: orchestrator-and-trpc-router
status: done
summary: "preload.ts allows cyboflow:stream:<runId> on/off subscriptions and off() removes the correct wrapper, unblocking TASK-602 stream publisher"
executor_loops: 1
code_review_rounds: 0
visual_mobile: skipped_user_preference
visual_web: skipped_user_preference
---

# TASK-599 Done

## Outcome

`main/src/preload.ts` previously dropped every `electron.on('cyboflow:stream:<runId>', ...)` subscription because the channel was not in `validChannels`, AND `electron.off()` called `removeListener(channel, callback)` instead of `removeListener(channel, wrapper)`. Both bugs are fixed by a module-level `electronListenerWrappers: Map<string, Map<callback, wrapper>>` storage, a widened channel guard accepting `channel.startsWith('cyboflow:stream:')`, and an `off()` body that looks up the stored wrapper before calling `removeListener`. Inner-Map cleanup on `size === 0` prevents long-term growth.

## Verification

- Verifier verdict: APPROVED (after one typecheck retry — initial commit had a TS2345 because the inner Map value type didn't admit the `Electron.IpcRendererEvent` first-arg of the wrapper; widened to `(event: Electron.IpcRendererEvent, ...args: unknown[]) => void` in commit 22d16ce).
- Code review verdict: CLEAN.
- Test writer: NO_TESTS_NEEDED — `main/src/preload.ts` is excluded from vitest coverage (`main/vitest.config.ts:18`) and the contextBridge/ipcRenderer surface cannot be exercised in a plain Node test runner. Behavior is exercised end-to-end by TASK-602's stream publisher.
