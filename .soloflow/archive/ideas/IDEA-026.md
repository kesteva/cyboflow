---
id: IDEA-026
type: FEATURE
status: answered
created: 2026-05-26T14:30:00Z
epics:
  - workflow-progress-visualization
  - workflow-phase-model
slices:
  - title: "Workflow Phase/Step Model + Step-Transition Events"
    description: "Extend shared/types/workflows.ts with WorkflowDefinition / WorkflowPhase / WorkflowStep / WorkflowStepState types. Hardcode 5 starter workflow definitions (inspired by but not literally bound to soloflow-dev's planner/sprint/compound/prune/soloflow scripts) as a static map keyed by SoloFlowWorkflowName. Schema must support a future workflow editor (protoflow Direction-A modal) — i.e. WorkflowDefinition is a first-class data structure, not a YAML reference. Add a current_step_id column to workflow_runs (new migration). Instrument cyboflow's workflow runner / orchestrator to emit explicit step-transition events that update current_step_id. Expose via tRPC: cyboflow.runs.getPhaseState(runId) → { definition, currentStepId, stepStates[] }, and a subscription that pushes step-transition deltas."
    value_statement: "Unblocks both visualization panes with cyboflow-owned step semantics, and positions the codebase for the protoflow Direction-A workflow editor. Without first-class step-transition events, both panes would have nothing real to show and a future editor would have nothing to edit."
  - title: "Right Rail Shell + Workflow Progress Timeline"
    description: "Introduce a new 296px-fixed right rail to CyboflowRoot's layout with three tabs: Workflow Progress / File Explorer / Diff. File Explorer and Diff tabs ship as placeholders for this IDEA. The Workflow Progress tab implements protoflow §4a: one section per phase (color swatch + name + step count), steps as timeline items with 2px left border keyed to state (green=done, rust=running, muted=pending), 8px bullet, step name + agent name + right-aligned uppercase status, and below each non-pending step a list of log lines with mono prefixes (▸ ✎ · ✓ ●) and 42px tabular elapsed timestamp column. Pulse animation on the running step's bullet. Uses existing cyboflow Tailwind tokens (paper-cream restyle is a separate IDEA)."
    value_statement: "Gives users immediate, at-a-glance visibility into where a running workflow is in its lifecycle — which phase is active, which step is running, what happened in each completed step. The right rail itself becomes the surface for File Explorer and Diff later."
  - title: "Active Workflow Canvas (top half of run view)"
    description: "Build the horizontal phase-column canvas from protoflow §3a, stacked at ~46% top of CyboflowRoot's content area above RunBottomPane. Column-per-phase layout (138px columns, 14px gap, 86px row height), step cards with 1.4px black borders, head bar in phase color, body with step name + agent + retry count, foot with state dot + uppercase status. Three core states: pending muted, running with 2px rust outline (uses cyboflow's status-running token), done with frosted-glass overlay (backdrop-filter: blur(2px)) + green check circle. Human variant: amber border + striped head + person-glyph badge. OPTIONAL chip variant. SVG edge layer: solid 1.4px black same/cross-phase edges, dashed 1.2px rust loopback edges. Animated 4px rust circle token traveling along the current edge via requestAnimationFrame. Uses existing cyboflow Tailwind tokens."
    value_statement: "Provides the spatial, graph-view of the full workflow — users see the complete pipeline at a glance, not just the sequential feed. The animated token makes 'what is the agent doing right now' viscerally clear. Together with Slice 2, this delivers the full protoflow workflow-visualization differentiator."
open_questions:
  - question: "Where does the Workflow Progress timeline live in the layout?"
    context: "Cyboflow today has no right rail — App.tsx shows ReviewQueueView | Sidebar | CyboflowRoot as a flat horizontal row (docs/ARCHITECTURE.md). RunBottomPane (TASK-756, just shipped) gives the bottom pane three tabs: Chat / Terminal / Data Stream. A fourth layout option is possible: replace Data Stream with a tab that hosts both the stream and the timeline side-by-side."
    candidates:
      - "(a) Introduce a new right rail (296px fixed, per protoflow spec) with three tabs: Workflow Progress / File Explorer / Diff"
      - "(b) Add Workflow Progress as a 4th tab in RunBottomPane alongside Chat / Terminal / Data Stream"
      - "(c) Replace the Data Stream tab in RunBottomPane with a split view: stream on left, timeline on right"
      - "(d) Embed the timeline as a collapsible side-panel inside CyboflowRoot, toggled from the header"
    answer: "(a) Introduce a new right rail (296px fixed) with three tabs: Workflow Progress / File Explorer / Diff. File Explorer and Diff tabs ship as placeholders for this IDEA; the Workflow Progress tab is what gets implemented here."
  - question: "Where does the Active Workflow canvas live in the layout?"
    context: "CyboflowRoot currently has a thin header row + main content area (flex-1 overflow-auto) that shows RunBottomPane when a run is active. The protoflow design stacks the canvas above the terminal at ~46% height. Introducing the canvas means deciding whether the existing RunBottomPane content (Chat/Terminal/Data Stream) moves, shrinks, or is replaced."
    candidates:
      - "(a) Replace the main content area entirely with the canvas when a run is active; move RunBottomPane below it in a two-section split (canvas top ~46%, bottom pane rest)"
      - "(b) Add the canvas as a separate top-level view selectable from the CyboflowRoot header (tab or toggle), leaving RunBottomPane as the other view"
      - "(c) Show the canvas inside the Active Workflow Canvas section of a new right rail (option (a) from the timeline question) and keep RunBottomPane as-is"
    answer: "(a) Stack canvas (~46% top) above RunBottomPane within the CyboflowRoot content area. Faithful to protoflow §3 center-column layout."
  - question: "What is the source for per-step state derivation?"
    context: "WorkflowRunRow.status is a flat 8-value enum (queued/starting/running/awaiting_review/stuck/completed/failed/canceled) — it has no concept of which phase or step is active. The raw_events table holds SDK-level events (system/assistant/user/result/stream_event). Step-level state (which step is running, which are done) requires either richer signals or a mapping layer."
    candidates:
      - "(a) Parse hook events already in the stream: system/hook_started and system/hook_response events name the hook_name (e.g. 'PreToolUse') — map known hook names to step transitions"
      - "(b) Instrument the SoloFlow YAML workflow scripts to emit explicit step-transition events via the Cyboflow MCP server's tool surface, and surface these as a new event_type in raw_events"
      - "(c) Heuristic mapping: track the last N tool-use events and infer the current step from which tools are being called (e.g. Bash tool in execute step, Write tool in refine step)"
      - "(d) Add a currentStepId field to workflow_runs (new migration) written by main-process logic when step transitions are detected"
    answer: "Build our own first-class step-transition event system. SoloFlow scripts/agents from the soloflow-dev plugin are reference inspiration only — we do NOT need to piggyback on their hook events or reuse their YAML scripts verbatim. Approach: instrument cyboflow's workflow runner to emit explicit step-transition events (option b-flavored, but in cyboflow's own orchestrator surface, not via the soloflow-dev plugin), and add a current_step_id column to workflow_runs (option d) written from those events. This positions us for the protoflow Direction-A workflow editor, where flows are editable definitions not fixed scripts — so step-transition signaling must be a first-class concept owned by cyboflow."
  - question: "Where is the WorkflowDefinition (phases/steps) schema stored and loaded from?"
    context: "WorkflowRow.workflow_path points to a YAML file on disk (the SoloFlow workflow script). The five workflow names are in shared/types/workflows.ts:66 as SOLOFLOW_WORKFLOW_NAMES. A phase/step definition must be available at render time so the canvas and timeline know the full shape of the pipeline before any step runs."
    candidates:
      - "(a) Parse the WorkflowDefinition from the YAML at workflow_path at run-start and store as spec_json in the workflows table (spec_json column already exists in 006_cyboflow_schema.sql but is currently '{}'); expose via cyboflow.workflows.get tRPC"
      - "(b) Hardcode the five SoloFlow workflow definitions as a static map in shared/types/workflows.ts keyed by SoloFlowWorkflowName; no YAML parsing needed for v1"
      - "(c) Add a new workflow_definitions table populated by a new file-based migration that stores the phase/step JSON; workflow_runs FK-links to it"
    answer: "(b) Hardcode the five workflow definitions as a static map in shared/types/workflows.ts for v1 — these can be cyboflow-shaped reinterpretations of the SoloFlow ideas, not literal transcriptions of soloflow-dev YAML. Schema design must accommodate future user-editable workflows (Direction A editor) — i.e. WorkflowDefinition is a data structure, not a YAML reference. Migration to spec_json column or a workflow_definitions table is a v2 swap once the editor lands."
  - question: "Visual fidelity scope: protoflow palette globally, scoped to new panes only, or adapted to existing tokens?"
    context: "Cyboflow's Tailwind config (frontend/tailwind.config.js) uses semantic CSS variable tokens (--color-bg-primary, --color-text-primary, etc.) tied to a dark/neutral theme. Protoflow specifies a paper-cream palette (#f5f1e8 page bg, #1a1815 ink, #c96442 rust accent). Applying globally changes every surface; scoping requires a data-attribute or wrapper class boundary."
    candidates:
      - "(a) Faithful protoflow paper-cream palette scoped to the two new panes only (CSS class wrapper, e.g. .protoflow-surface, with the protoflow tokens as locally-scoped vars)"
      - "(b) Adapt protoflow structural design to existing cyboflow Tailwind tokens — use bg-bg-primary/text-text-primary/status-success/etc. for all states, sacrificing paper-cream warmth"
      - "(c) Faithful paper-cream palette applied globally — replaces the app's dark theme for all surfaces"
    answer: "(b) Use existing cyboflow Tailwind tokens for both new panes. A separate IDEA will be filed for a global restyle to the protoflow paper-cream palette. This decouples the workflow-progress feature from a full visual reskin; the visualization slice can ship within the current theme and inherit the restyle later. Slice 4 (Protoflow Design Tokens) is therefore DROPPED from this IDEA."
  - question: "Animated token and frosted-glass overlay: include in initial scope or defer?"
    context: "The protoflow design specifies a 4px rust circle traveling via requestAnimationFrame along the active edge (canvas), and a frosted-glass + green-check overlay on completed step cards. Both are visual polish items. The canvas is functional without them (states still readable). Including them in the initial build adds ~1–2 days of UI work."
    candidates:
      - "(a) Defer both — implement canvas with static state rendering first; add animation and overlay as a follow-on polish slice"
      - "(b) Include frosted-glass overlay for done state (it's load-bearing per the README) but defer the animated token"
      - "(c) Include both in the initial canvas build — they are specified as high-fidelity requirements in docs/protoflow-design/README.md"
    answer: "(c) Include both in the initial canvas build. The animated token and frosted-glass overlay are explicitly load-bearing per docs/protoflow-design/README.md; deferring would gut the design's visual semantics."
assumptions:
  - assumption: "RunBottomPane's three-tab shell (TASK-756) is merged and the bottom pane is the currently-shipped surface when a run is active."
    confidence: high
    validation: "frontend/src/components/cyboflow/RunBottomPane.tsx exists with Chat/Terminal/Data Stream tabs. Confirmed by reading the file."
  - assumption: "The five SoloFlow workflow names (soloflow, planner, sprint, compound, prune) are stable and sufficient for a v1 hardcoded definition approach."
    confidence: high
    validation: "shared/types/workflows.ts:66 — SOLOFLOW_WORKFLOW_NAMES is a const tuple of those five values."
  - assumption: "The raw_events table's system/hook_started and hook_response event types carry enough information to infer step transitions without additional instrumentation."
    confidence: low
    validation: "Inspect actual hook_name values emitted by the Agent SDK during a live SoloFlow run (read cyboflow-backend-debug.log after a run, or grep raw_events payload_json for hook_started rows)."
  - assumption: "The existing WorkflowRow.workflow_path points to a readable YAML file that has a structure parse-able into phases/steps, or alternatively the hardcoded approach bypasses this entirely."
    confidence: medium
    validation: "Run a workflow, read the workflow_path from the workflows table, inspect the YAML file structure. Alternatively, confirm the hardcoded-definition approach with the user."
  - assumption: "CyboflowRoot's layout (header + flex-1 content area + optional panel surface) can accommodate an additional canvas pane without breaking the ReviewQueueView | Sidebar | CyboflowRoot shell geometry."
    confidence: high
    validation: "frontend/src/App.tsx layout — the CyboflowRoot occupies a flex-1 column that fills remaining horizontal space. Adding internal rows within it is straightforward."
  - assumption: "The protoflow design tokens (paper-cream palette, JetBrains Mono) can be scoped to a CSS wrapper class without conflicting with the existing --color-* CSS variable namespace."
    confidence: high
    validation: "frontend/tailwind.config.js — all existing tokens use the --color- prefix. Protoflow tokens can use --pf- or --protoflow- prefix to avoid collision."
  - assumption: "The cyboflow.workflows.get tRPC procedure (already live per ARCHITECTURE.md) returns the spec_json field, which can carry WorkflowDefinition JSON once populated."
    confidence: medium
    validation: "Read main/src/orchestrator/trpc/routers/workflows.ts to verify spec_json is included in the get response shape."
  - assumption: "The per-run-chat-surface epic (TASK-761/762, currently in-flight) does not conflict with introducing a new tab or right-rail placement for the Workflow Progress timeline."
    confidence: medium
    validation: "Read .soloflow/active/plans/per-run-chat-surface/TASK-761-plan.md and TASK-762-plan.md for their files_owned list; confirm no overlap with layout areas this IDEA targets."
research_recommendation: not_needed
research_rationale: "The canonical design reference lives in-repo at docs/protoflow-design/README.md and the working JSX prototypes are at docs/protoflow-design/dashboard.jsx and direction-a.jsx; all visual tokens, layout specs, and interaction semantics are fully documented there. Open questions are design decisions (layout placement, state derivation strategy) that belong at the human checkpoint, not resolvable by external research."
---

# Workflow Progress Visualization — Active Canvas + Timeline Feed

## Raw Input

> [Image #1: SPRINT-014 view showing horizontal phase columns (PLA / REF / EXE / SPR / COM) with step cards stacked vertically — cards show role (executor, verifier, code, human, compounder), retry counts (×3, ×1, ×0), and states (RUNNING, PENDING, DONE with green check overlay). Human checkpoint cards have a person glyph badge in the corner. One card is marked "OPTIONAL".]
>
> [Image #2: Right-rail "WORKFLOW PROGRESS" tab (with sibling "FILE EXPLORER" / "DIFF" tabs visible). Vertical phase sections — PLAN / REFINE / EXECUTE — each with steps. Steps show status (DONE / RUNNING / PENDING), agent name (idea-extractor, researcher, human, task-refiner, executor, etc.), and below each non-pending step a list of log lines with a tabular elapsed timestamp and a short message describing what's happening.]
>
> "add the workflow progress panes from the original protoflow design"

## Grounding

### Design Reference (canonical)

**`docs/protoflow-design/README.md`** — Full spec for both surfaces. Section §3a defines the Active Workflow canvas (horizontal phase columns, 138px step cards, 3 states, SVG edges, animated token, human/optional variants). Section §4a defines the Workflow Progress timeline (vertical per-phase feed, 2px left border keyed to state, step log lines with mono prefixes and 42px tabular timestamp column). Section "Design tokens" specifies the complete paper-cream palette and JetBrains Mono type ramp. Fidelity level is explicitly "high-fidelity."

**`docs/protoflow-design/dashboard.jsx`** — Working JSX prototype implementing the full shell. The `.D-flow`, `.D-step`, `.D-step-head`, `.D-step-body`, `.D-step-foot`, `.D-step.pending`, `.D-step.running`, `.D-step.done` CSS classes are the reference for exact visual treatment of step states. The `D-pulse` keyframe is defined here (1.4s, opacity 1→0.4→1, scale 1→0.8→1). The `.D-svg` overlay pattern (position:absolute; inset:0; pointer-events:none) is the edge-drawing contract.

**`docs/protoflow-design/direction-a.jsx`** — Blueprint editor reference. Secondary reference for step card structure in a larger format (178px width, keyed metadata rows). Not the primary target for this IDEA but informs the data shape for step definitions.

### Current Layout

**`frontend/src/App.tsx`** — Three-column shell: `ReviewQueueView` (left) | `Sidebar` (center-left) | `CyboflowRoot` (flex-1, right). No right rail exists today. The `CyboflowRoot` column is a flex column: thin header row + `flex-1` content area (RunBottomPane when a run is active, empty-state CTA otherwise) + optional panel surface.

**`frontend/src/components/cyboflow/CyboflowRoot.tsx`** — Active layout host. The `flex-1 overflow-auto p-4` div is the main content area where RunBottomPane currently mounts. This is the insertion point for the canvas pane.

**`frontend/src/components/cyboflow/RunBottomPane.tsx`** — Shipped three-tab shell (Chat / Terminal / Data Stream). `Data Stream` is the default tab and hosts `RunView`. This component is the bottom-pane surface to which the Workflow Progress timeline could be added as a 4th tab.

### Data Model

**`shared/types/workflows.ts`** — `WorkflowRow` carries `workflow_path: string | null` and `spec_json` is available in the DB (`006_cyboflow_schema.sql` line 6: `spec_json TEXT NOT NULL DEFAULT '{}'`) but not currently reflected in the TypeScript type. `WorkflowRunRow.status` is a flat 8-value enum with no phase/step decomposition. `SOLOFLOW_WORKFLOW_NAMES` at line 66 lists the five workflow names: `soloflow`, `planner`, `sprint`, `compound`, `prune`.

**`main/src/database/migrations/006_cyboflow_schema.sql`** — `raw_events` table stores `event_type` and `payload_json` per run. `workflow_runs` has no `current_step_id` column today. `spec_json` column on `workflows` exists but is always `'{}'`.

### Stream Events

**`shared/types/claudeStream.ts`** — Wire-format types for the Agent SDK stream: `system` (with subtypes `init`, `compact_boundary`, `hook_started`, `hook_response`), `assistant`, `user`, `result`, `stream_event`. The `hook_started` subtype carries `hook_name` and `hook_event` fields — the only existing higher-level signal about what the agent is doing structurally.

**`main/src/services/streamParser/`** — Pipeline: `rawEventsSink.ts` → `typedEventNarrowing.ts` → `eventRouter.ts` → `messageProjection.ts`. This is the existing path that transforms raw SDK bytes into typed events. Step-state derivation would either plug in here or read from `raw_events` at query time.

**`main/src/orchestrator/trpc/routers/events.ts`** — The `cyboflow.events.onStreamEvent` subscription procedure currently uses a placeholder `StreamEvent` shape (`{ runId, type, payload: unknown }`). Step-transition events could be surfaced through this subscription.

### Existing Design Tokens

**`frontend/tailwind.config.js`** — Semantic CSS variable tokens: `--color-bg-primary`, `--color-text-primary`, `--color-border-primary`, `--color-interactive-primary`, `--color-status-success`, etc. No `rust`, `paper-cream`, or protoflow-specific tokens exist today. All current tokens use the `--color-` prefix; new protoflow tokens can use a distinct prefix (e.g. `--pf-`) to avoid collision.

### In-Flight Work (potential conflicts)

**`.soloflow/active/plans/per-run-chat-surface/`** — TASK-761 and TASK-762 are actively building `RunChatView` and the ask-user-question roundtrip. These touch `RunBottomPane.tsx`, `cyboflowStore.ts`, and the Chat tab placeholder. Any layout restructuring of `RunBottomPane` in this IDEA must not conflict with those tasks' `files_owned`.

## Slices

### Slice 1: Workflow Phase/Step Model + Step-Transition Events

Define a first-class phase/step data model owned by cyboflow (not the soloflow-dev plugin), instrument the workflow runner to emit explicit step-transition events, and expose per-step state to the frontend. This unblocks both visualization panes and positions the codebase for the protoflow Direction-A workflow editor.

**Type additions** in `shared/types/workflows.ts`:
- `WorkflowPhase { id, label, color, steps: WorkflowStep[] }`
- `WorkflowStep { id, name, agent, mcps, retries, optional?, human?, loopback?, desc }`
- `WorkflowDefinition { id: SoloFlowWorkflowName; phases: WorkflowPhase[] }`
- `WorkflowStepState { stepId, status: 'pending' | 'running' | 'done' }`

**Workflow definitions**: Hardcode five starter `WorkflowDefinition` records in `shared/types/workflows.ts` keyed by `SoloFlowWorkflowName`. These are cyboflow-shaped reinterpretations of the planner/sprint/compound/prune/soloflow ideas — NOT literal transcriptions of the soloflow-dev YAML. Schema is a data structure, not a YAML reference, so a future editor can mutate it.

**Schema migration**: New migration adds `current_step_id TEXT` to `workflow_runs`.

**Runner instrumentation**: cyboflow's run orchestration emits explicit step-transition events at run start, on each step boundary, and on workflow end. Each transition writes `current_step_id` and surfaces a typed event (e.g. `workflow_step_transition`) into the existing event stream.

**tRPC exposure**: 
- `cyboflow.runs.getPhaseState(runId)` → `{ definition: WorkflowDefinition; currentStepId: string | null; stepStates: WorkflowStepState[] }`
- `cyboflow.runs.onStepTransition({ runId })` subscription for live deltas

**Design constraint:** The schema must accommodate user-edited workflows (protoflow Direction A modal). Avoid coupling step IDs to filesystem paths or hardcoded agent process names.

### Slice 2: Right Rail Shell + Workflow Progress Timeline

Introduce a new 296px right rail to `CyboflowRoot`'s layout — the first time cyboflow has a right rail. Three tabs: Workflow Progress / File Explorer / Diff. File Explorer and Diff are placeholders shipped in this IDEA so the tab shell is complete; their content is left for future IDEAs.

**Components**: 
- `frontend/src/components/cyboflow/RunRightRail.tsx` — tab shell (fixed 296px width)
- `frontend/src/components/cyboflow/WorkflowProgressTimeline.tsx` — Workflow Progress tab content

**Workflow Progress structure**:
- One section per phase. Phase header: 8×8 color swatch + bold phase name (11px) + step count right-aligned.
- Steps rendered as timeline items: 2px left border keyed to state (uses cyboflow `status-success`/`status-running`/`border-primary` tokens), 8px circle bullet on left edge, step name (11.5px bold), right-aligned uppercase status (`✓ DONE` / `● RUNNING` / `PENDING`), agent name (10px muted).
- Below each non-pending step: log lines with mono prefixes (`▸` tool, `✎` edit, `·` note, `✓` done, `●` running), 42px tabular elapsed timestamp column, message text.
- Pulse animation on the running step's left bullet (`@keyframes pulse` with 1.4s, opacity 1→0.4→1, scale 1→0.8→1).

**Data source**: `WorkflowDefinition` + `WorkflowStepState[]` from Slice 1 (via `getPhaseState` + `onStepTransition` subscription). Log lines projected from `raw_events` filtered to the step's time window.

**Styling**: Uses existing cyboflow Tailwind tokens. The protoflow paper-cream palette restyle is a separate IDEA.

### Slice 3: Active Workflow Canvas (top half of run view)

Build the horizontal phase-column canvas from protoflow §3a, stacked at ~46% top of the CyboflowRoot content area, above RunBottomPane.

**Component**: `frontend/src/components/cyboflow/WorkflowCanvas.tsx`

**Layout**:
- Meta row at top: workflow + run label, elapsed time, token count, running pill with pulsing dot.
- Phase columns: 138px wide, 14px gap. Each column has an uppercase band label (9px, phase color) and stacks step cards vertically (86px row height, 28px top offset).

**Step cards** (138px wide, 1.4px border):
- Head bar: phase color bg, white uppercase 9px text (phase abbrev), right-aligned two-digit step index.
- Body: step name (10.5px weight 600, max 2 lines), sub-meta row (agent short-name, retry count).
- Foot: dashed top border, status dot + uppercase state.

**State variants** (using cyboflow tokens):
- Pending: muted bg, muted border, ~55% opacity head bar.
- Running: 2px running outline (cyboflow `status-running` token), outline-offset 2px.
- Done: frosted-glass overlay (`backdrop-filter: blur(2px)`) + 30px green check circle (`status-success` token). LOAD-BEARING per protoflow README.
- Human variant: amber border, barber-pole striped head, 22px person-glyph badge top-right.
- Optional variant: `OPTIONAL` chip in head bar.

**SVG edge layer** (`position:absolute; inset:0; pointer-events:none`):
- Solid 1.4px vertical edges within phases.
- Solid 1.4px horizontal edges between phases.
- Dashed 1.2px loopback edges (e.g. verify→implement, `stroke-dasharray: 4 3`).

**Animated token** (LOAD-BEARING):
- 4px rust circle traveling along current edge.
- `requestAnimationFrame` ticker advancing `t` at 0.18/sec mod 1.
- Linear interpolation between step centers; no easing.

**Data source**: `WorkflowDefinition` + `WorkflowStepState[]` from Slice 1.

## Open Questions

### Q1: Workflow Progress timeline placement

Where does the timeline live in the current layout? The app has no right rail today. Options range from introducing one (faithful to protoflow) to adding a tab inside the existing RunBottomPane. The active sprint `per-run-chat-surface` (TASK-761/762) is filling in the Chat tab of RunBottomPane, so any tab-addition approach must be coordinated with that epic.

See candidates in frontmatter.

### Q2: Active Workflow canvas placement

The canvas is the more visually demanding surface. The protoflow design puts it at ~46% of the center column height above the terminal. Cyboflow's current center column is entirely occupied by RunBottomPane when a run is active. Adding the canvas requires a layout decision about stacking vs. replacement vs. new view.

See candidates in frontmatter.

### Q3: Step state derivation source

This is the highest-risk open question. The flat `WorkflowRunRow.status` has no step-level granularity. The Agent SDK stream contains `system/hook_started` and `system/hook_response` events that name hooks by their type (e.g. `PreToolUse`), but it is not confirmed whether these events fire at step boundaries in SoloFlow workflows or only at individual tool calls. Option (b) — instrumenting the SoloFlow YAML scripts — requires changes outside the cyboflow repo. Option (d) — a new `current_step_id` column — is the most explicit but requires knowing who writes it (a heuristic in main, or explicit instrumentation).

See candidates in frontmatter. The user should run a test workflow and inspect `cyboflow-backend-debug.log` to see what hook events actually fire before this decision is finalized.

### Q4: WorkflowDefinition schema location

The YAML files at `workflow_path` are the SoloFlow workflow scripts; their structure may not map cleanly to the phase/step shape. The hardcoded approach (option b) is the fastest path for v1 and avoids YAML parsing complexity. The `spec_json` column already exists in the DB and is unused — it's the natural home for a parsed definition if option (a) is chosen.

See candidates in frontmatter.

### Q5: Visual fidelity scope

The existing dark/neutral Tailwind token system covers all current surfaces. The protoflow paper-cream palette is warm and light — the opposite of the current dark theme. Scoping the palette to the two new panes (option a) is the lowest-risk approach and matches the protoflow README's "convert tokens to your design-system variables" guidance while also noting "do preserve the visual rhythm."

See candidates in frontmatter.

### Q6: Animated token and frosted-glass overlay

These are specified as high-fidelity requirements in `docs/protoflow-design/README.md` ("Do preserve the workflow visualization semantics...frosted-glass + green check for completed steps...animated token on the active edge"). However, they add implementation complexity: the frosted-glass overlay requires `backdrop-filter` support (confirmed in Electron/Chromium), and the RAF animation requires a continuously ticking clock in a React component. Both are feasible but add scope.

See candidates in frontmatter.

## Assumptions

1. **RunBottomPane three-tab shell is merged** (TASK-756 in `.soloflow/active/plans/bottom-pane-restructure/TASK-756-plan.md`). Confirmed: `frontend/src/components/cyboflow/RunBottomPane.tsx` exists with the three-tab structure. **Confidence: high.**

2. **The five SoloFlow workflow names are stable for v1 hardcoded definitions.** `shared/types/workflows.ts:66` — `SOLOFLOW_WORKFLOW_NAMES = ['soloflow', 'planner', 'sprint', 'compound', 'prune']`. **Confidence: high.**

3. **hook_started/hook_response events carry meaningful step-boundary signals.** Low confidence — needs empirical validation against a real run log. The `system/hook_started` subtype is confirmed in `shared/types/claudeStream.ts` and visible in `RunView.tsx`, but whether hook names map to SoloFlow step boundaries is unverified. **Confidence: low. Validation: run a SoloFlow workflow and read `cyboflow-backend-debug.log` for hook event payloads.**

4. **CyboflowRoot's flex-1 content area can host a vertical stack (canvas + bottom pane) without breaking the outer ReviewQueueView | Sidebar | CyboflowRoot shell.** The outer shell is a simple flex row in `App.tsx`; the CyboflowRoot column is already `flex flex-col`. Internal re-stacking is straightforward. **Confidence: high.**

5. **`backdrop-filter: blur()` works in Electron 37.6.0's bundled Chromium for the frosted-glass overlay.** Electron 37 ships Chromium 132+; `backdrop-filter` is fully supported. **Confidence: high.**

6. **The `--color-*` Tailwind CSS variable namespace does not conflict with a `--pf-*` protoflow token namespace.** Confirmed by reading `frontend/tailwind.config.js` — all existing tokens use `--color-` prefix. **Confidence: high.**

7. **`spec_json` in the `workflows` table (from migration 006) can store a `WorkflowDefinition` JSON blob once populated.** The column is `TEXT NOT NULL DEFAULT '{}'` — suitable for JSON. Currently unused. **Confidence: high. Validation: `grep spec_json main/src/orchestrator/trpc/routers/workflows.ts` to confirm it is or is not already in the tRPC response shape.**

8. **TASK-761 and TASK-762 (per-run-chat-surface) do not claim layout files outside RunBottomPane's Chat tab, leaving room for this IDEA's layout decisions.** Confidence: medium. Validation: read the `files_owned` list in TASK-761-plan.md and TASK-762-plan.md.
