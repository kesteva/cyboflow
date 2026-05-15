---
id: TASK-599
idea: SPRINT-009-compound
status: ready
created: 2026-05-15T00:00:00Z
files_owned:
  - main/src/preload.ts
files_readonly:
  - frontend/src/utils/cyboflowApi.ts
  - frontend/src/components/cyboflow/RunView.tsx
  - .soloflow/active/findings/SPRINT-009-findings.md
acceptance_criteria:
  - criterion: "preload.ts allows `electron.on('cyboflow:stream:<runId>', handler)` to register without being silently dropped"
    verification: "grep -n \"channel.startsWith('cyboflow:stream:')\" main/src/preload.ts returns at least one match in the `on()` whitelist branch"
  - criterion: "preload.ts allows `electron.off('cyboflow:stream:<runId>', handler)` to remove the previously-registered handler"
    verification: "grep -n \"channel.startsWith('cyboflow:stream:')\" main/src/preload.ts returns at least one match in the `off()` whitelist branch"
  - criterion: "off() actually removes the wrapper that on() registered (not the bare callback)"
    verification: "grep -n 'wrapperByCallback\\|listenerWrappers\\|Map<string, Map<' main/src/preload.ts returns at least one wrapper-storage construct, and `removeListener` is called with the stored wrapper"
  - criterion: "Existing `permission:request` channel continues to work via the same on/off pair"
    verification: "grep -n \"'permission:request'\" main/src/preload.ts shows the channel is still in the validChannels list and the same wrapper-storage applies"
depends_on: []
estimated_complexity: low
epic: orchestrator-and-trpc-router
test_strategy:
  needed: false
  justification: "preload.ts has no existing sibling test file (verified via Glob: `main/src/preload.test.ts` does not exist; `main/src/__tests__/` does not exist) and is excluded from vitest coverage (see `main/vitest.config.ts:18`). The change is exercised end-to-end by the day-3 gate spec only when a stream-event publisher exists (TASK-602). Adding a unit test for preload would require mocking the entire Electron contextBridge surface for two-line behaviour; the cost outweighs the benefit. The fix is verified by code review + the green path TASK-602 will exercise."
---

# Fix preload.ts cyboflow:stream:* whitelist + off() wrapper-removal bug

## Objective

`main/src/preload.ts` currently silently drops every `electron.on('cyboflow:stream:<runId>', ...)` subscription because the channel is not in the `validChannels` whitelist, AND the matching `electron.off()` removes the wrong callback reference (the bare `callback`, not the wrapper that `on()` registered). Together the two bugs make `cyboflowApi.subscribeToStreamEvents` (called by `RunView.tsx` on mount) a no-op. This task fixes both bugs in the existing `electron` contextBridge surface so that any future stream-event publisher (TASK-602) can actually deliver events to the renderer.

## Implementation Steps

1. Open `main/src/preload.ts` and locate the `contextBridge.exposeInMainWorld('electron', { ... })` block at lines 609-628.
2. Add a module-level wrapper-storage map immediately above the `contextBridge.exposeInMainWorld('electron', ...)` call: `const electronListenerWrappers = new Map<string, Map<(...args: unknown[]) => void, (...args: unknown[]) => void>>();` (channel → callback → wrapper). The outer map keys by channel string so per-runId entries don't collide; the inner map keys by the user-supplied callback reference so `off()` can find the wrapper that `on()` stored.
3. Replace the `on()` body so that:
   - It accepts any channel matching the existing whitelist OR `channel.startsWith('cyboflow:stream:')`.
   - It builds a `wrapper = (_event, ...args) => callback(...args)` and stores it in the map: get-or-create the inner map for `channel`, then `inner.set(callback, wrapper)`.
   - It calls `ipcRenderer.on(channel, wrapper)`.
4. Replace the `off()` body so that:
   - It accepts the same widened channel set (existing whitelist OR `channel.startsWith('cyboflow:stream:')`).
   - It looks up `inner = electronListenerWrappers.get(channel)`; if present, look up `wrapper = inner.get(callback)`.
   - If found, call `ipcRenderer.removeListener(channel, wrapper)` and `inner.delete(callback)`. If `inner.size === 0` after delete, also `electronListenerWrappers.delete(channel)` to avoid unbounded growth.
   - If no wrapper is stored (caller passed a callback that was never `on`'d, or the channel is not whitelisted), no-op silently.
5. Verify the existing `permission:request` channel still works through the same wrapper-storage path — do not branch the implementation; the same code path serves both the whitelist entries and the prefix match.
6. Manual verification: `grep -n 'cyboflow:stream' main/src/preload.ts` must show the prefix check appearing in BOTH the `on()` and the `off()` branches.

## Acceptance Criteria

The four AC entries in the frontmatter. Critically, after this change a renderer-side call sequence of `on('cyboflow:stream:abc', cb)` followed by `off('cyboflow:stream:abc', cb)` must leave the underlying `ipcRenderer` listener count at zero — the bug today leaves it at one because `removeListener(channel, callback)` does nothing when the registered listener was a wrapper.

## Test Strategy

`needed: false` — see frontmatter justification. preload.ts is excluded from the unit-test coverage configuration; testing it would require mocking Electron's `contextBridge` and `ipcRenderer`, which is disproportionate for a two-line whitelist + map-based wrapper fix. The behavior is exercised in production by TASK-602's stream publisher, and code review of the wrapper-storage map is the primary gate.

## Hardest Decision

Whether to use one map keyed by `(channel, callback)` tuple or a nested `Map<string, Map<Function, Function>>`. Picked the nested map because it cleans up per-channel state when a runId completes (delete the inner map when empty), which matters because runIds are per-execution and the outer map would grow unbounded over a long-lived app session.

## Rejected Alternatives

- **Use a `WeakMap<Function, Function>` keyed by callback only.** Rejected because `off()` cannot iterate WeakMaps to find the entry, and we cannot key a Map by `(channel, callback)` tuple without a stable hash. The nested-Map approach is the standard Electron-preload pattern for this exact bug.
- **Store the wrapper as a property on the callback function itself (`callback.__wrapper = wrapper`).** Rejected because frozen function objects from external callers cannot be mutated; also leaks memory if the callback outlives all its subscriptions.

## Lowest Confidence Area

Whether `electron.invoke(channel, ...args)` (line 611) needs the same channel-whitelisting treatment. Today `invoke` accepts any channel string, which is overly permissive but matches the original Crystal contract. Changing it is out of scope for B2; flag for a future security pass.
