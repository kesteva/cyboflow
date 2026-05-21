---
id: TASK-699
idea: IDEA-014
status: ready
created: 2026-05-20T00:00:00Z
files_owned:
  - frontend/src/components/cyboflow/RunView.tsx
  - frontend/src/components/cyboflow/__tests__/RunView.test.tsx
files_readonly:
  - main/src/services/streamParser/schemas.ts
  - main/src/services/streamParser/derivers.ts
  - shared/types/claudeStream.ts
  - .soloflow/active/findings/SPRINT-026-findings.md
acceptance_criteria:
  - criterion: "RunView.SystemEventRow no longer contains the api_retry or compact subtype branches"
    verification: "grep -nE \"subtype === 'api_retry'|subtype === 'compact'\" frontend/src/components/cyboflow/RunView.tsx returns 0 matches"
  - criterion: "RunView.tsx no longer imports SystemApiRetryEvent or SystemCompactEvent"
    verification: "grep -nE 'SystemApiRetryEvent|SystemCompactEvent' frontend/src/components/cyboflow/RunView.tsx returns 0 matches"
  - criterion: "SystemApiRetryEvent / SystemCompactEvent exports remain intact in shared/types/claudeStream.ts (retention rationale per TASK-681 preserved)"
    verification: "grep -nE 'export interface SystemApiRetryEvent|export interface SystemCompactEvent' shared/types/claudeStream.ts returns 2 matches"
  - criterion: "RunView unit test no longer asserts that api_retry / compact subtypes render through SystemEventRow"
    verification: "grep -nE \"routes a system/api_retry|routes a system/compact[^_]\" frontend/src/components/cyboflow/__tests__/RunView.test.tsx returns 0 matches"
  - criterion: "RunView unit test asserts api_retry and compact subtype payloads route to UnknownEventRow (the Unrecognized event label)"
    verification: "grep -nE \"api_retry .*Unrecognized|compact .*Unrecognized|routes (an? )?retired api_retry|routes (an? )?retired compact\" frontend/src/components/cyboflow/__tests__/RunView.test.tsx returns ≥2 matches"
  - criterion: "pnpm --filter frontend test exits 0 with the RunView.test.tsx assertions passing"
    verification: "pnpm --filter frontend test exits 0"
  - criterion: "pnpm typecheck exits 0 (no orphaned-import errors after removing the two type names from RunView.tsx)"
    verification: "pnpm typecheck exits 0"
depends_on: []
estimated_complexity: low
epic: claude-agent-sdk-migration
test_strategy:
  needed: true
  justification: "Sibling test RunView.test.tsx contains two asserts that exercise the now-dead api_retry and compact branches (lines 245-264, 266-283). These tests will fail unless updated. They must be transformed to assert the post-TASK-681 truth: subtype api_retry/compact narrowing-rejects and routes through UnknownEventRow with the Unrecognized event label visible."
  targets:
    - behavior: "An event with payload.subtype === 'api_retry' (which the main-process narrower would reject) reaches the renderer with event.type === 'unknown' and renders via UnknownEventRow (visible 'Unrecognized event' label)"
      test_file: "frontend/src/components/cyboflow/__tests__/RunView.test.tsx"
      type: component
    - behavior: "An event with payload.subtype === 'compact' (also rejected by the narrower) renders via UnknownEventRow with the Unrecognized event label"
      test_file: "frontend/src/components/cyboflow/__tests__/RunView.test.tsx"
      type: component
---

# B1 — Remove dead api_retry / compact renderer branches in RunView

## Objective

Eliminate dead code in `frontend/src/components/cyboflow/RunView.tsx:58-76`. TASK-681 retired the `api_retry` and `compact` subtypes from `systemUnionSchema` (`main/src/services/streamParser/schemas.ts:97-100`). At runtime `TypedEventNarrowing.narrow()` rejects those payloads, `deriveEventType` returns `"unknown"`, and the events route to `UnknownEventRow` — never to the api_retry/compact branches inside `SystemEventRow`. Per FIND-SPRINT-026-15, the two branches are unreachable. Delete them, drop the now-unused imports, and update the two RunView unit tests that exercise them so they reflect the post-narrowing truth.

## Implementation Steps

1. **(Optional confidence step)** Read `main/src/services/streamParser/schemas.ts` lines 97-100 to confirm `systemUnionSchema` is `z.discriminatedUnion('subtype', [systemInitSchema, systemCompactBoundarySchema])`. This is the source-of-truth guarantee that api_retry/compact narrowing-rejects.

2. **Edit `frontend/src/components/cyboflow/RunView.tsx`:**
   - Lines 22-31: in the type import block from `'../../../../shared/types/claudeStream'`, remove `SystemApiRetryEvent,` and `SystemCompactEvent,`. Keep all other imports.
   - Lines 37-42: inside `SystemEventRow`, narrow the `payload` cast from
     ```
     const payload = event.payload as
       | SystemInitEvent
       | SystemApiRetryEvent
       | SystemCompactEvent
       | SystemCompactBoundaryEvent;
     ```
     to
     ```
     const payload = event.payload as
       | SystemInitEvent
       | SystemCompactBoundaryEvent;
     ```
   - Lines 58-66: delete the entire `if (payload.subtype === 'api_retry') { ... }` block, including the `SystemApiRetryEvent` cast and the returned `<div>`.
   - Lines 68-76: delete the entire `if (payload.subtype === 'compact') { ... }` block, including the `SystemCompactEvent` cast and the returned `<div>`.
   - Leave the `compact_boundary` branch and the fallback untouched.

3. **Edit `frontend/src/components/cyboflow/__tests__/RunView.test.tsx`:**
   - Lines 245-264: rewrite the `'routes a system/api_retry event to the typed system branch (non-init subtype)'` test. Change the test title to `'routes a retired system/api_retry payload to UnknownEventRow (post-TASK-681)'`. Keep the same `act(() => useCyboflowStore.getState().setActiveRun(...))` setup. Keep the `StreamEvent` object but set `type: 'unknown'` instead of `'system'` (mirroring what the main-process narrower actually produces). Change the body assertions to:
     ```
     expect(screen.getByText(/Unrecognized event/)).toBeInTheDocument();
     expect(screen.getAllByText(/unknown/).length).toBeGreaterThan(0);
     ```
   - Lines 266-283: rewrite the `'routes a system/compact event to the typed system branch (non-init subtype)'` test the same way — title becomes `'routes a retired system/compact payload to UnknownEventRow (post-TASK-681)'`, `type: 'unknown'`, body assertions check `/Unrecognized event/` and the inline `unknown` label.
   - Leave the `compact_boundary` test (lines 285-302) and all other tests untouched.

4. **Run frontend tests:** `pnpm --filter frontend test`. Confirm all RunView tests pass.

5. **Run typecheck:** `pnpm typecheck`. Confirm no orphan-import errors.

6. **Completeness gate before COMPLETED:** re-run the grep ACs above.

## Acceptance Criteria

See frontmatter.

## Test Strategy

Two existing tests in `RunView.test.tsx` currently assert that api_retry/compact payloads render through `SystemEventRow`. After this task those branches no longer exist; transform the tests to lock in the new truth (post-narrower envelope arrives with `type: 'unknown'` and `UnknownEventRow` renders the visible "Unrecognized event" label). Transformation is mechanical and preserves a runtime-observable assertion that the schema's exclusion of api_retry/compact propagates end-to-end.

## Hardest Decision

Whether to delete the two test cases outright or transform them. Transforming wins because pure deletion would silently drop the only end-to-end test that the schema's exclusion of api_retry/compact actually reaches the renderer envelope.

## Rejected Alternatives

- **Path B (re-add api_retry/compact to systemUnionSchema):** rejected per FIND-SPRINT-026-15 — TASK-681 retired them deliberately; the SDK no longer emits these shapes.
- **Delete the two tests instead of transforming them:** rejected — removes runtime safety net at low extra cost.

## Lowest Confidence Area

The assertion `screen.getAllByText(/unknown/).length).toBeGreaterThan(0)` — `UnknownEventRow` renders `event.type` inline; the word "unknown" may appear in multiple DOM nodes. `.length).toBeGreaterThan(0)` is permissive; tighten to `screen.getByText('unknown')` if stricter coupling is needed.
