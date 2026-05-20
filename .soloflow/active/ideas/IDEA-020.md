---
id: IDEA-020
type: FEATURE
status: draft
created: 2026-05-20T22:35:00Z
source: user_discovery_during_sdk_migration_smokes
slices:
  - title: "Dedicated entry point to start an SDK Claude session"
    description: "Add a discoverable UI affordance — a '+ Claude' button in the panel tab bar mirroring the existing '+ Terminal' button, plus a keyboard shortcut analogous to useAddTerminalShortcut — that calls panelApi.createPanel({ sessionId: mainRepoSessionId, type: 'claude' }) directly. Today the only path to a new Claude panel is clicking Pull or Push in the project header (ProjectView.tsx:323/339), which invokes ensureClaudePanel() at ProjectView.tsx:159 as a side effect of a git operation. There is no equivalent of '+ Terminal' for Claude panels."
    value_statement: "Users can start an ad-hoc Claude Agent SDK conversation for arbitrary coding tasks without committing to one of the 5 structured SoloFlow workflows (sprint, planner, prune, compound, soloflow) and without triggering a git side-effect. Closes a discoverability gap surfaced during SPRINT-026 smoke testing — the test step 'create a new Claude panel' had no obvious UI mapping."
open_questions:
  - question: "Where does the '+ Claude' button live? Panel tab bar (next to '+ Terminal'), project header toolbar, or app-wide top bar?"
    candidates:
      - "Panel tab bar — mirrors '+ Terminal', minimal surface change, panel scoped to current session"
      - "Project header toolbar — promotes the affordance, costs horizontal space in the toolbar"
      - "App-wide top bar — implies cross-project Claude session; needs extra session-binding decision"
  - question: "Keyboard shortcut — pick one or skip for the minimal cut?"
    candidates:
      - "Cmd/Ctrl+Shift+C — symmetric with the existing '+ Terminal' shortcut hook (useAddTerminalShortcut)"
      - "No shortcut yet — wait until placement settles via IDEA-017"
  - question: "Should the new Claude panel route through the existing structured Claude panel UI (legacy/inherited from Crystal), the cyboflow RunView SDK-event renderer (new in SPRINT-026), or a hybrid?"
    candidates:
      - "Existing structured Claude panel — proven, ships now, inherits Crystal UI debt"
      - "RunView-style SDK event log + bottom-attached input box — consistent with workflow run output, requires composing a new view"
      - "Defer — keep using the existing Claude panel until IDEA-017's shell-layout decisions settle, then re-skin"
  - question: "What happens when a Claude panel already exists for the current session — same as Pull/Push (activate the existing one), or always create a new one?"
    candidates:
      - "Activate existing if present — matches current ensureClaudePanel() behavior, single-Claude-panel invariant per session"
      - "Always create new — supports multiple concurrent ad-hoc sessions; requires panel-list UI to disambiguate"
assumptions:
  - "The Claude Agent SDK substrate (delivered in IDEA-014 / SPRINT-026) is the runtime. No new orchestrator or session-creation backend work is needed — the plumbing at panelApi.createPanel({ type: 'claude' }) is already reachable."
  - "A project (and therefore mainRepoSessionId) is selected first — same precondition as the current Pull/Push path."
  - "This idea is scoped narrower than IDEA-017 (cyboflow shell layout). Final placement may need to coordinate with IDEA-017's resolution, but a tactical '+ Claude' button in the existing panel tab bar can ship independently as a minimal stopgap that survives any later shell redesign."
research_recommendation: not_needed
research_rationale: "Pure UI affordance gap. The capability already exists in the codebase (ensureClaudePanel at ProjectView.tsx:159). Decision space is placement, shortcut, and panel-already-exists semantics — all design-resolution, not external-research-bound. A /soloflow:planner pass over the open_questions[] is enough to ground this."
---

# Dedicated entry point to start an SDK Claude session

## Context

Surfaced 2026-05-20 during SPRINT-026 (Claude Agent SDK migration) manual smoke testing. Smoke 1 (AC#13, `docs/sdk-migration-smoke-results.md`) instructs the tester to "create a new Claude panel". The cyboflow UI exposes no standalone affordance for this — the only path is to click Pull or Push in the project header, each of which calls `ensureClaudePanel()` at `frontend/src/components/ProjectView.tsx:159` as a side effect of a git operation.

By contrast, terminal panels have both a `+ Terminal` button in the panel tab bar AND a dedicated keyboard shortcut (`useAddTerminalShortcut`). Claude panels have neither.

The underlying API call already works:
```ts
panelApi.createPanel({ sessionId: mainRepoSessionId, type: 'claude' })
```
This idea is purely about exposing it via a discoverable UI control.

## Raw Input

> User: "Going through the smokes in order, how am I supposed to start a new Claude panel?"
> User: "file it as a separate idea that users should be able to start a new SDK session without running a workflow"

## Grounding

Not yet grounded — run `/soloflow:planner IDEA-020` to refine.

**Sequencing:** Can ship independently as a minimal "+ Claude" button mirroring "+ Terminal". Coordinates with IDEA-017 (cyboflow shell layout) on final placement, but doesn't block on it. Most natural pickup point is the next sprint that touches frontend layout.

## Slices

See frontmatter.
