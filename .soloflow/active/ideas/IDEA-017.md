---
id: IDEA-017
type: FEATURE
status: draft
created: 2026-05-18T19:55:00Z
source: user_braindump
roadmap_epic: "crystal-cuts-and-rebrand"
slices:
  - title: "Settle the cyboflow shell layout (review queue rail + project surface + run view)"
    description: "Pick the final geometry: review queue as always-visible left rail (per IDEA-009 and system design §5.7), with the existing Crystal-style project sidebar either kept as a second column, folded into the rail, or replaced by a flatter run-centric surface. Locks the answer to 'where does the review queue actually live in the window?' which IDEA-009 left as 'left rail or top tab'."
    value_statement: "Unblocks every downstream UI slice — review queue placement, project sidebar redesign, RunView positioning, sessions-cut sequencing all hang off this one decision."
  - title: "Define the sidebar information model post-Crystal"
    description: "Today the sidebar shows projects with Crystal 'sessions' as children. Decide what hierarchy replaces it: project > workflow runs as children (run-centric), project > workflows > runs (workflow-centric), flat run list, or something else. Drives DraggableProjectTreeView's data source and the queries against workflow_runs / projects."
    value_statement: "Pins down the persistence-to-UI mapping so the legacy SessionView can be cut without leaving the sidebar half-Crystal half-cyboflow."
  - title: "Retire the useLegacyCrystalView escape hatch + legacy SessionView"
    description: "Once the shell layout and sidebar model are settled, delete the useLegacyCrystalView state, the 'Legacy view' toggle button (App.tsx:397), and the SessionView render branch (App.tsx:408-435). Also retire downstream SessionView descendants that no longer have a mount point (panels, MessagesView, RichOutputView, etc.) per the @cyboflow-hidden audit."
    value_statement: "Closes the Crystal-cuts epic's longest-standing open thread; eliminates two-mental-model UX where users could land on either pane depending on a toggle they don't understand."
  - title: "Cut the legacy 'Create New Session' dialog and the play button"
    description: "Delete the session-creation dialog component plus its trigger (the play button on session-tree items in DraggableProjectTreeView). This is the user-flagged dialog that opened when they clicked the play button next to 'Test' in the project tree. Falls out naturally from the SessionView retirement once the sidebar model is settled."
    value_statement: "Removes the most visible misleading Crystal artifact — clicking play today opens Crystal's session-creation flow rather than cyboflow's Start Run."
  - title: "Decide the sessions / tool_panels / panels DB-table disposition"
    description: "Crystal's sessions, tool_panels, conversation_messages, panels, panel_settings tables aren't read by cyboflow's orchestrator path. Pick: (a) drop entirely via a reconcile-style migration; (b) keep as @cyboflow-hidden orphan tables for v2; (c) repurpose (e.g. workflow_runs reuses some columns). Affects backup size, schema surface for future contributors, and what 'cyboflow has no concept of sessions' means literally vs. just-in-the-UI."
    value_statement: "Resolves the schema-vs-product-model gap; keeps drift like the workflows-table reconcile (commits 6e849e9, a204216) from happening across the other inherited tables."
  - title: "Finalize CyboflowRoot's place in the new shell"
    description: "Today CyboflowRoot is the entire main area (WorkflowPicker aside + RunView main, swapped in via the legacy toggle). Decide whether (a) CyboflowRoot stays as the run-detail view inside the new shell, with WorkflowPicker breaking out into a top-of-main affordance or moving into the sidebar; (b) WorkflowPicker becomes a popover/modal off the project surface; (c) RunView absorbs the picker as an empty-state. Drives how 'Start Run' is reached after the layout shift."
    value_statement: "Closes the question of how a user actually triggers a workflow once the shell is settled — the current panel-pair layout is a workflow-runs-and-day3-gate prototype, not a final design."
open_questions:
  - question: "Review queue position — IDEA-009 said 'left rail or top tab'. Pick one. Left rail wins on glanceability (matches Superhuman/claude-control pattern, sustains dock-badge story) but costs ~280px of horizontal width that the Crystal project sidebar currently owns. Top tab cheaper on width but breaks the always-visible primacy IDEA-009 demands."
    candidates:
      - "Left rail, primary — project sidebar becomes second column or folds into it"
      - "Left rail, primary — project sidebar removed; project switching via review queue context or top-bar selector"
      - "Top tab — accepts that 'primary surface' is interpreted as 'one click away' not 'visible at all times'"
  - question: "Sidebar information model post-Crystal. What does the project tree show?"
    candidates:
      - "Project > workflow runs (newest first) — run-centric, mirrors the run as the unit of work"
      - "Project > workflows > runs — workflow-centric, makes workflow-as-template explicit"
      - "Flat: just projects, runs surface in main area only — minimal sidebar"
      - "Eliminate the project sidebar entirely; review queue rail is the only nav"
  - question: "Sessions / tool_panels / panels / conversation_messages table disposition. Drop, @cyboflow-hidden-preserve, or repurpose?"
    candidates:
      - "Drop via reconcile-style migration once UI is cut — clean, irreversible"
      - "@cyboflow-hidden-preserve as orphan tables for v2 reuse — defers the decision"
      - "Repurpose conversation_messages into workflow_runs message log — couples the two; high cost, ambiguous payoff"
  - question: "Does CyboflowRoot survive as a component, or does it dissolve into the new shell?"
    candidates:
      - "Survives as RunView's mount point (drop the WorkflowPicker aside; picker moves elsewhere)"
      - "Dissolves — RunView becomes a top-level route; WorkflowPicker becomes a popover off the project view"
      - "Survives unchanged but re-skinned for the new shell"
  - question: "Does this idea include the Discord popup and any other one-shot Crystal modals (Welcome, etc.), or are those left as their own ideas (IDEA-016 for Discord)?"
    candidates:
      - "Out of scope — separate ideas handle individual modal removals (IDEA-016 for Discord)"
      - "In scope — fold one-off modal cuts into the shell migration since they share the launch flow"
assumptions:
  - "IDEA-009's 'review queue is the primary UI surface' decision is locked. This idea inherits it and resolves the geometry/placement, not the existence."
  - "The system design's §5.7 (review queue) is the design source of truth for the queue itself. This idea adds a §5.0 ('Shell Architecture') equivalent that the design doc currently lacks."
  - "Workflow runs (workflow_runs table) is the unit displayed in the sidebar, replacing Crystal's 'sessions' as the user-visible work item. Validated against the orchestrator data model in docs/cyboflow_system_design.md §5.3."
  - "The cyboflow flow is functionally end-to-end (real event publishing, approval router wired, stuck detection) BEFORE this idea's tasks execute. Cutting the legacy view earlier strands users with no working Claude-execution path."
research_recommendation: not_needed
research_rationale: "User-needs and architecture research were both done at ROADMAP-001 level and they grounded IDEA-009's review-queue decisions. The remaining work here is design resolution (picking among defined candidates) and code-side surface mapping, not new research. The shell-architecture decisions ARE non-trivial but they should be made by the user (or via a /soloflow:planner pass that surfaces the open_questions[]) rather than via external research."
---

# Cyboflow Shell Architecture and Crystal-Shell Retirement

## Context

The cyboflow UI today is a stitched mix of two paradigms: the inherited Crystal shell (`Sidebar` + `SessionView` + the panel system) and the new cyboflow surfaces (`CyboflowRoot` with `WorkflowPicker` + `RunView`). They coexist via the `useLegacyCrystalView` toggle in `App.tsx:390-435`, which is itself a transitional escape hatch.

No existing IDEA captures the overall shell migration. IDEA-001 (crystal-cuts-and-rebrand) covered specific cuts (Codex backend, Bull, multi-panel surfaces inside a session, etc.) but never the broader shell paradigm. IDEA-009 (review-queue-ui) specifies the review queue as the primary UI surface but explicitly leaves placement open ("left rail or top tab"). The system design doc has §5.7 for the review queue but no equivalent section for the overall window layout.

This idea fills that gap. It's the umbrella under which:
- The review queue gets a concrete window position
- The project sidebar gets a concrete information model
- The legacy `SessionView` + `useLegacyCrystalView` escape hatch can be cleanly retired
- The user-flagged "Create New Session" dialog (Crystal's session-creation flow) falls out as a deletion
- The orphaned `sessions` / `tool_panels` / `panels` / `conversation_messages` DB tables get a disposition

## Raw Input

User asked during manual app testing on 2026-05-18:
1. "What can I actually test here?" — exposed that the cyboflow side-panes (`CyboflowRoot`) are functional but the broader shell hasn't been migrated.
2. "Should I be seeing this start run experience?" referring to the legacy Crystal "Create New Session" dialog — exposed that legacy session-creation is still wired with no plan to cut it.
3. "Is there an idea that actually captures the migration to the cyboflow UI design pattern including the side panes and workflow view?" — directly motivated this idea after confirming none existed.

## Grounding

Concrete surface area inventory (verified via grep on 2026-05-18):

**Current cyboflow shell entry points**
- `frontend/src/App.tsx:380-435` — top-level layout: `<Sidebar>` (Crystal-era project tree, MCP health dot, settings, version footer) + main area that conditionally renders either `<CyboflowRoot projectId={activeProjectId} />` or the legacy `<SessionView />` based on the `useLegacyCrystalView` toggle.
- `frontend/src/components/cyboflow/CyboflowRoot.tsx` — two-pane: `<aside w-80>` with `<WorkflowPicker>` and `<main flex-1>` with `<RunView>`. Built incrementally during the `workflow-runs-and-day3-gate` epic, not from a unifying design.
- `frontend/src/components/Sidebar.tsx` — Crystal-era sidebar. Contains the project tree (`DraggableProjectTreeView`), MCP health dot, settings button, version footer.

**Legacy surfaces to retire**
- `frontend/src/App.tsx:61,63,397,408-435` — `useLegacyCrystalView` state, toggle button, render branch.
- `frontend/src/components/SessionView.tsx` and descendants (panels, `MessagesView`, `RichOutputView`, `CombinedDiffView`, `PromptNavigation`, `SessionStats`).
- The "Create New Session" dialog (user-flagged) and the play button in `DraggableProjectTreeView` that triggers it.

**Missing surfaces (per IDEA-009)**
- `frontend/src/components/cyboflow/ReviewQueueView.tsx` — does not exist yet. IDEA-009 owns its slice-level design; this idea owns where it lands in the shell.
- `frontend/src/stores/reviewQueueSlice.ts` (or equivalent Zustand slice) — does not exist yet.

**DB tables to dispose**
- `sessions`, `tool_panels`, `panels`, `panel_settings`, `conversation_messages` — Crystal-era; not read by the orchestrator path. Disposition decision is one of this idea's slices.

## Slices

See `slices[]` in frontmatter. Six slices: (1) shell layout decision, (2) sidebar information model, (3) `useLegacyCrystalView` + `SessionView` retirement, (4) "Create New Session" dialog + play button cut, (5) DB-table disposition, (6) `CyboflowRoot`'s final shape.

## Open Questions

See `open_questions[]` in frontmatter. Five resolution-by-decision questions: review queue position, sidebar info model, DB-table disposition, `CyboflowRoot` survival, one-off-modal scope. The candidates for each are pre-enumerated — the planner pass just needs the user to pick.

## Assumptions

See `assumptions[]` in frontmatter. The load-bearing one: **execute this idea only after the cyboflow flow is end-to-end functional** (real event publishing from the SDK pipeline, approval router IPC wired, stuck detection). Cutting the legacy view before that strands users with no working Claude-execution path. This is the same gating logic that's kept the legacy SessionView alive through SPRINT-016.

## Pre-work / Research needed

None. User-needs and architecture research already exist at ROADMAP-001 level (`.soloflow/active/research/ROADMAP-001-*.md`). The remaining work is design resolution, which the planner pass surfaces.

## Sequencing

**Strict prerequisites**:
- `review-queue-ui` epic — must land first (review queue is the load-bearing surface that determines the shell's geometry; you can't decide where the rail goes if the rail doesn't exist yet).
- `approval-router-and-permission-fix` epic — `cyboflow:approveRun` must be wired so the review queue actually receives pending approvals.
- `orchestrator-and-trpc-router` epic — real per-event publishing from the SDK pipeline, not just the synthetic `run_started` placeholder.

**Natural successors**:
- IDEA-012's onboarding slices land cleanly on top of the resolved shell (instead of decorating the transitional one).
- IDEA-016 (Discord popup removal) becomes either a sub-cut here or stays as a standalone removal — see open_question 5.

**Phasing within this idea**:
1. Slices 1 + 2 + 6 (shell layout + sidebar info model + CyboflowRoot shape) — design resolution, can be a single planner pass that produces 1-3 task plans.
2. Slice 4 (Create New Session dialog cut) — small, falls out of 1+2.
3. Slice 3 (`useLegacyCrystalView` + `SessionView` retirement) — larger cut, depends on 1+2 being implemented and verified.
4. Slice 5 (DB-table disposition) — last; once the UI no longer reads the legacy tables, dropping/orphaning them is a low-risk reconcile migration similar to the workflows-table reconcile already shipped.
