---
id: IDEA-026-research
idea: IDEA-026
created: 2026-05-26T15:15:00Z
---

# Research Report — IDEA-026: Workflow Progress Visualization

## Area A: SVG Edge Routing Between Step Cards (Slice 3)

**Library comparison for a small fixed-column graph (5–10 nodes, 4–6 columns, loopback edges):**

| Library | Version | Last Updated | Downloads/wk | Pros | Cons |
|---------|---------|-------------|--------------|------|------|
| react-archer | 4.4.0 | May 2024 (~2 yrs ago) | ~126k | Declarative, wraps any DOM elements, supports arrow styles | Not actively maintained; no new release in 2 years; no path-routing |
| react-xarrows | 2.0.2 | ~5 yrs ago | ~67k | Flexible custom SVG arrows | Maintainer explicitly deprecated it, recommending React Flow instead |
| React Flow (xyflow) | 12.x | Active (2025) | ~700k+ | Full-featured, TypeScript-first, handles custom edges and loopbacks natively | Significant bundle overhead (~150kB), brings its own state model and interaction paradigm — overkill for a read-only canvas |
| Bare DOM measurement + SVG | N/A | N/A | N/A | Zero overhead, full control, no dependency, handles loopback dashes trivially | More boilerplate; coordinate math owned by the implementer |

**Recommendation:** Bare SVG with ResizeObserver is the right call. The graph is small (max ~30 nodes across 4–6 columns), the layout is fixed (138px columns, 14px gap, 86px row heights — all known at render time), and both react-archer and react-xarrows are effectively unmaintained. React Flow brings a full node-drag interaction model that conflicts with the read-only canvas intent. The protoflow prototype's own approach — `position:absolute; inset:0; pointer-events:none` SVG overlay with manually computed path coordinates — is the correct model. Coordinates are derivable from column index and step index using the fixed sizing constants; a `useRef` on each step card plus `getBoundingClientRect()` gives exact coordinates when the layout changes. A single `useLayoutEffect` + `ResizeObserver` on the canvas container is all the measurement infrastructure needed.

Sources: [npm trends comparison](https://npmtrends.com/react-archer-vs-react-arrows-vs-react-diagrams-vs-react-xarrows-vs-vue-diagrams), [react-xarrows maintainer deprecation notice](https://github.com/Eliav2/react-xarrows), [react-archer releases](https://github.com/pierpo/react-archer/releases)

---

## Area B: requestAnimationFrame Token Animation in React 18 (Slice 3)

**Pattern question: `useState(t)` + RAF vs. imperative ref-based DOM mutation**

The CSS-Tricks authoritative article on RAF + React hooks recommends `setState(prev => ...)` with RAF — storing the animation clock `t` in React state so the circle's SVG `cx`/`cy` attributes re-render on each frame. React 18's automatic batching does NOT batch RAF callbacks (batching applies to event handlers and async transitions, not `requestAnimationFrame`), so each tick still triggers one render. For a single animated element (the 4px rust circle) at ~60fps, this is fine — the re-render is a single SVG attribute change and React's reconciler handles it efficiently.

The performance-critical alternative is imperative DOM mutation: hold a `ref` to the SVG `<circle>` element and mutate `circle.cx.baseVal.value` and `circle.cy.baseVal.value` directly inside the RAF callback, bypassing React entirely. This is measurably faster for 50+ simultaneous animated elements but adds complexity and breaks React's ownership model. For one element, the difference is not perceptible.

**Recommendation:** Use `useState(t)` + RAF with the `setState(prev => prev + delta)` functional updater pattern. Store the RAF ID and last timestamp in `useRef`. Clean up in `useEffect`'s return. This matches the protoflow prototype's approach and is the pattern the React docs implicitly endorse for simple animation clocks. If future profiling shows jank (unlikely for one element), the migration path to an imperative ref is straightforward. Framer Motion's `useTime` / `useAnimationFrame` are ecosystem alternatives but add a dependency for what is a 15-line custom hook.

Sources: [CSS-Tricks RAF + React Hooks](https://css-tricks.com/using-requestanimationframe-with-react-hooks/), [Syncfusion animation library comparison](https://www.syncfusion.com/blogs/post/react-animation-libraries-comparison)

---

## Area C: `backdrop-filter` Performance in Electron / Chromium (Slice 3)

There is a confirmed rendering regression with `backdrop-filter: blur()` introduced in Chromium 134 (Electron 35.0.0-beta). The regression manifests on macOS as frame-stacking artifacts where repeated open/close cycles cause the blurred region to progressively brighten. This was filed as [Electron #45854](https://github.com/electron/electron/issues/45854) and closed as a duplicate of #44720. The root cause was a Chromium change (issue #391907157) that was subsequently reverted upstream, meaning Chromium 135+ resolved it.

For the cyboflow use case (up to ~20-30 done-state cards each with a `backdrop-filter: blur(2px)` overlay at once): each element with `backdrop-filter` forces its own compositing layer. Layer creation cost is one-time; steady-state rendering cost is proportional to the blurred area, not the count of elements. 20-30 small card-sized blur regions (138×86px each) is well within Chromium's compositor budget on modern hardware.

**Mitigations to apply:**
1. Add `will-change: transform` (or `transform: translateZ(0)`) to each done-state card wrapper to promote it to its own GPU layer before the blur paint.
2. The Chromium 134 regression only affects Electron 35 betas. Cyboflow runs Electron 37.6.0 (Chromium 132+ per IDEA assumptions) — not affected.
3. Avoid nesting `backdrop-filter` elements — Chromium has a confirmed bug where child elements of a `backdrop-filter` parent cannot themselves have `backdrop-filter`. The frosted overlay must be a sibling layer, not a child of another backdrop-filtered element.

Sources: [Electron #45854](https://github.com/electron/electron/issues/45854), [Chromium nested backdrop-filter](https://havn.blog/2024/03/14/chromium-and-nested.html)

---

## Area D: Right Rail Layout with Fixed-Width Siblings (Slice 2)

**Current CyboflowRoot layout (verified from source):**

`CyboflowRoot` is `flex flex-col h-full`. Inside it, the main content area is `flex-1 overflow-auto p-4` containing either `RunBottomPane` or an empty-state CTA. The outer App shell wraps `CyboflowRoot` in `<div className="flex flex-col flex-1 overflow-hidden">`.

**Pattern for a 296px right rail inside CyboflowRoot's content area:**

Restructure the `flex-1 overflow-auto p-4` content div into a flex row: `flex flex-row flex-1 overflow-hidden`. Inside it, the left side (canvas + bottom pane vertical stack) gets `flex-1 overflow-hidden` and the right rail gets `w-[296px] shrink-0 flex-col overflow-y-auto border-l border-border-primary`. Standard Tailwind flexbox sidebar pattern.

Key gotchas confirmed:
- Remove `overflow-auto` from the outer wrapper when adding the rail — let each pane own its own scroll. Outer `overflow-auto` on a flex row can cause the rail to not scroll independently.
- The rail must be `shrink-0` to prevent flexbox from compressing it.
- The rail's tab content (`WorkflowProgressTimeline`) needs its own `overflow-y-auto h-full`.
- No CSS grid is needed — plain flexbox with `shrink-0` is idiomatic Tailwind.
- TASK-761/762 own `RunBottomPane.tsx` and read-only-reference `CyboflowRoot.tsx`. `CyboflowRoot.tsx` is NOT in their `files_owned` list. Right rail work in `CyboflowRoot.tsx` is safe but must be sequenced after those tasks land (they reference its existing structure).

Sources: [Tailwind fixed sidebar pattern](https://gist.github.com/BjornDCode/5cb836a6b23638d6d02f5cb6ed59a04a)

---

## Area E: Step-Transition Event System + tRPC Subscription Wiring (In-Repo Grounding — Slice 1)

**Verified pattern from `main/src/orchestrator/trpc/routers/events.ts`:**

The file exports a module-level `EventEmitter` (`approvalEvents`, `stuckEvents`) per event domain, with no constructor arguments. The subscription procedure wraps it using the `eventToAsyncIterable<T>()` helper:

```ts
// The canonical per-domain EventEmitter pattern (lines 43, 53):
export const approvalEvents = new EventEmitter();

// The async-generator subscription pattern (lines 181-192):
onApprovalCreated: protectedProcedure
  .subscription(async function* ({ signal }): AsyncGenerator<ApprovalCreatedEvent> {
    const abortSignal = signal ?? new AbortController().signal;
    const source = eventToAsyncIterable<ApprovalCreatedEvent>(
      approvalEvents,
      'created',
      abortSignal,
    );
    for await (const ev of source) {
      yield ev;
    }
  }),
```

The `eventToAsyncIterable` helper (lines 85–126) implements a queue-drain loop: it pushes emitted events into a local array and resolves a pending promise on each push, then yields from the queue in an `async function*`. The loop exits cleanly when `signal.aborted` fires. This is the tRPC v11 native async-generator subscription pattern.

**Wire shape for a `WorkflowStepTransitionEmitter`:**

Define a new `WorkflowStepTransitionEvent` type (e.g. `{ runId: string; stepId: string; status: 'running' | 'done' | 'pending'; timestamp: string }`) in `shared/types/workflows.ts`. Add `export const stepTransitionEvents = new EventEmitter()` in `events.ts`. The subscription procedure `onStepTransition` follows the identical async-generator pattern with `input: z.object({ runId: z.string() })` filtering events server-side (`if (ev.runId !== input.runId) continue`).

**Important:** The `onStreamEvent` procedure (lines 158–167) currently uses a `makePlaceholderAsyncIterator` that yields nothing — it is a stub awaiting the stream-parser-to-main epic. A new `onStepTransition` procedure should follow `onApprovalCreated`'s pattern (real `eventToAsyncIterable`), NOT the placeholder pattern.

**Source file:** `main/src/orchestrator/trpc/routers/events.ts`

---

## Area F: WorkflowDefinition Schema Design for Future Editability (Slice 1)

**Survey of comparable schema shapes:**

- **n8n**: Flat node graph (`nodes[]` + `connections{}` adjacency map). No concept of "phases" — topology fully freeform. Not a useful model for a phased pipeline with sequential steps.
- **Temporal**: Code-defined workflows (TypeScript functions + activities). No serializable schema for phases/steps. Not applicable.
- **ReactFlow workflow editor template**: `nodes: Node[]` + `edges: Edge[]` where each `Node` has `{ id, type, position, data }`. Generic enough but requires an additional convention layer for "which nodes are steps vs phases."
- **Protoflow's own data.js shape**: `phases: [{ id, label, color, steps: [{ id, name, agent, mcps, retries, optional?, human?, loopback?, desc }] }]`. Already the target shape per the IDEA's Slice 1 type additions.

**Verdict:** The protoflow phases→steps shape is idiomatic for a human-authored, editor-mutable pipeline. n8n and ReactFlow's flat node+edge graphs are more powerful for freeform DAGs but add complexity for a linear-with-loopbacks topology. Right call for v1. Key design constraints for future editability:

1. Step IDs must be stable strings (not array indices) — protoflow `id` field per step satisfies this.
2. Loopback edges represented as `loopback: string` (target step ID) in the step definition, not as a separate edge list — keeps the step as the unit of editability.
3. The `spec_json` TEXT column on `workflows` is the correct storage target for a serialized `WorkflowDefinition` once a user-editable flow replaces the hardcoded map. For v1 (hardcoded), `spec_json` stays `'{}'` and the definitions live in `shared/types/workflows.ts`.

**Critical finding on assumption 7:** The `workflowRegistry.getById()` SQL query (`workflowRegistry.ts:237`) is `SELECT id, project_id, name, workflow_path, permission_mode, created_at FROM workflows` — it explicitly omits `spec_json`. The `WorkflowRow` TypeScript type in `shared/types/workflows.ts` does not include a `spec_json` field. The tRPC `cyboflow.workflows.get` procedure returns a `WorkflowRow`, so `spec_json` is currently invisible to the frontend. Any future use of `spec_json` for carrying `WorkflowDefinition` JSON requires both a column addition to the SELECT query and a type addition to `WorkflowRow`.

Sources: [n8n workflow docs](https://docs.n8n.io/workflows/), [ReactFlow workflow editor template](https://reactflow.dev/ui/templates/workflow-editor)

---

## Answered Questions

- **Q: Is `spec_json` returned by `cyboflow.workflows.get`?**
  A: **No.** `workflowRegistry.getById()` explicitly SELECT-omits it. The TypeScript `WorkflowRow` type also lacks the field. Source: `main/src/orchestrator/workflowRegistry.ts` line 237.

- **Q: Does TASK-761/762 claim CyboflowRoot.tsx as files_owned?**
  A: **No.** `CyboflowRoot.tsx` is in TASK-761's `files_readonly` list, not `files_owned`. TASK-762 doesn't mention it. Only `RunBottomPane.tsx`, `RunChatView.tsx`, and `ChatInput.tsx` are owned. No conflict, but right-rail work in CyboflowRoot.tsx must be sequenced AFTER those tasks land. Source: `.soloflow/active/plans/per-run-chat-surface/TASK-761-plan.md` lines 8–11.

- **Q: Is the `onStreamEvent` subscription currently functional or a placeholder?**
  A: **Placeholder.** Uses `makePlaceholderAsyncIterator` that yields nothing. A new `onStepTransition` subscription must use `eventToAsyncIterable` backed by a real EventEmitter (follow `onApprovalCreated` pattern, not the placeholder). Source: `events.ts` lines 158–167 vs. 181–192.

---

## Confidence Updates

| Assumption | Original | Updated | Basis |
|---|---|---|---|
| `spec_json` in `workflows` table can store `WorkflowDefinition` JSON | high | high, but with a required fix | Column exists with `TEXT NOT NULL DEFAULT '{}'`; however, `getById()` and `listByProject()` SELECT-omit it. Adding `spec_json` to the SELECT and to `WorkflowRow` is a mandatory prerequisite for any frontend use. |
| `cyboflow.workflows.get` tRPC returns `spec_json` (assumption 7) | medium | **CORRECTED TO FALSE** | Grep of `workflowRegistry.ts` line 237 confirms explicit omission. Refiner must add a task to fix the SELECT and type. |
| TASK-761/762 do not conflict with this IDEA's layout decisions (assumption 8) | medium | **raised to high** | TASK-761 `files_owned` = `[RunChatView.tsx, RunChatView.test.tsx, RunBottomPane.tsx]`. TASK-762 `files_owned` = `[ChatInput.tsx, RunChatView.tsx, ChatInput.test.tsx]`. Neither claims `CyboflowRoot.tsx`. **Sequencing constraint:** right-rail work in `CyboflowRoot.tsx` must run AFTER TASK-761 and TASK-762 land, since they `files_readonly`-reference its existing structure. |
| `backdrop-filter: blur()` works in Electron 37.6.0 | high | **confirmed high, with caveats** | Chromium 134 regression (Electron 35 beta) does not affect Electron 37 (Chromium 132). Apply `will-change: transform` to done-state card wrappers. Avoid nesting backdrop-filter elements. |
| RAF token animation using `useState(t)` + RAF is appropriate for React 18 | (not stated) | confirmed appropriate | React 18 batching does not batch RAF callbacks; one render per tick for one SVG element is negligible. Imperative DOM ref is an available optimization if profiling shows jank. |

---

## Risks

1. **`spec_json` gap in WorkflowRow and SELECT query.** The `workflowRegistry.getById()` query and `WorkflowRow` type both omit `spec_json`. Any task that expects to write or read `WorkflowDefinition` JSON via the existing `cyboflow.workflows.get` tRPC procedure will silently get undefined. Mitigation: add `spec_json?: string` to `WorkflowRow`, add `spec_json` to both SELECT queries in `workflowRegistry.ts`. This is a prerequisite for any v2 DB-backed swap; v1 (hardcoded definitions in shared/types) does NOT need this fix.

2. **`onStreamEvent` is a non-functional placeholder.** The refiner must NOT reuse it for step-transition events — a new `onStepTransition` procedure with a real EventEmitter backend is required, following the `onApprovalCreated` pattern exactly.

3. **react-archer and react-xarrows are both effectively unmaintained** (2 years and 5 years since last release). Do not introduce either as a dependency. Bare SVG is the correct path.

4. **CyboflowRoot.tsx restructuring is layout-sensitive and adjacent to in-flight work.** The file is in TASK-761/762's `files_readonly` list, meaning they reference its existing structure. Layout changes (converting the `flex-1 overflow-auto p-4` content div to a flex row) must be sequenced AFTER TASK-761 and TASK-762 land, or explicitly coordinated.

5. **Backdrop-filter nesting constraint in Chromium.** If any future card state adds a second `backdrop-filter` layer on top of the done-state frosted card, Chromium will silently drop the inner filter. Keep the frosted overlay as a direct absolute-positioned child of the card, not nested inside another backdrop-filtered element.

---

## Sources

- [npm trends: react-archer vs react-xarrows](https://npmtrends.com/react-archer-vs-react-arrows-vs-react-diagrams-vs-react-xarrows-vs-vue-diagrams)
- [react-archer GitHub releases](https://github.com/pierpo/react-archer/releases)
- [react-xarrows GitHub (maintainer deprecation)](https://github.com/Eliav2/react-xarrows)
- [CSS-Tricks: RAF with React Hooks](https://css-tricks.com/using-requestanimationframe-with-react-hooks/)
- [Syncfusion: React animation library comparison](https://www.syncfusion.com/blogs/post/react-animation-libraries-comparison)
- [Electron #45854: backdrop-filter regression](https://github.com/electron/electron/issues/45854)
- [Chromium nested backdrop-filter](https://havn.blog/2024/03/14/chromium-and-nested.html)
- [Tailwind fixed sidebar gist](https://gist.github.com/BjornDCode/5cb836a6b23638d6d02f5cb6ed59a04a)
- [n8n workflow docs](https://docs.n8n.io/workflows/)
- [ReactFlow workflow editor template](https://reactflow.dev/ui/templates/workflow-editor)
