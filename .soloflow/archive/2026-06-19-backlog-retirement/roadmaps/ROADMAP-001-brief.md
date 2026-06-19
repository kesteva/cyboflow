# Roadmap Brief — Cyboflow MVP

This brief was assembled by `/soloflow:roadmap`'s clarification phase before a session restart was required to load shadow agents. Pass this file (with `--skip-clarify`) to resume roadmap generation cleanly.

## Raw Input

`docs/cyboflow_system_design.md` (the canonical 295-line product spec — researchers must read it directly for full context: vision, stack, fork rationale, primitives, day-1 disciplines, risks, scope cuts).

## Clarification Transcript

- Q: The design doc targets a 2-week MVP. What working cadence should the roadmap assume inside those 2 weeks?
  A: Full-time, ~8h/day (10 working days, ~80 productive hours).
- Q: The doc describes what the review queue *does*, but not what makes it "shippable". What's the bar that makes you say "v1 MVP is done, ship it"?
  A: Self-hosting with a 1-day threshold — "I use Cyboflow for at least 1 full working day without falling back to Crystal/CLI". (User picked option 2 with a relaxed threshold.)
- Q: Ready to generate the roadmap?
  A: Generate roadmap.

## Synthesis

### Vision

Cyboflow is a macOS desktop app that orchestrates Claude Code as a multi-agent workflow runner. Users pick one of five pre-set SoloFlow workflows (soloflow, planner, sprint, compound, prune), the app spawns Claude Code in an isolated git worktree per run, parses Claude's structured stream-json output, and surfaces tool-use approvals in a workspace-scoped **cross-workflow review queue**. The review queue — a single pane aggregating pending approvals across all running workflows — is the product differentiator. The thesis: the scarce resource is *human attention*, not agent time. Everything else (PTY management, worktree lifecycle, packaging) is substrate.

### Target Users

v1 user: a solo developer running multiple parallel SoloFlow workflows on their own repos. Wedge: workspace-scoped review concentration combined with native integration to existing SoloFlow markdown workflows. Explicitly *not* targeting teams, multi-user, cloud agents, or non-SoloFlow workflows in v1.

### Constraints

- **Platform.** macOS only (universal binary, signed + notarized DMG). No Linux or Windows in v1.
- **Timeline.** 2-week wall-clock target to MVP. Full-time, ~8h/day → ~80 productive hours over 10 working days.
- **Team.** Solo developer, TypeScript-fluent, working primarily through Claude Code.
- **Backend.** None. No team-tier, no auth, no SSO, no multi-user. Orchestrator is self-contained inside Electron main process but structured for future extraction.
- **Codebase posture.** Forked from `stravu/crystal` at HEAD (MIT-licensed, deprecated in favor of Nimbalyst but stable). Crystal provides 6 of the 8 required primitives in production-tested form. License posture: pure MIT; do NOT merge upstream from Nimbalyst (AGPL contamination risk).

### Success Metrics

**MVP-done bar (the gate to ship):** Self-host Cyboflow for at least 1 full working day without falling back to Crystal/CLI. This forces real-world coverage of memory leaks, mutex hangs, queue UX, dock-badge desync, zombie processes, and notification fatigue — bugs that only emerge after hours of sustained use.

**Day-3 mitigation gate (the gate to keep going on the fork path):** Two runs in different workflows must each be pausable on the queue, and the user must be able to approve them in any order. If by day 3 the per-panel architecture is fighting this — e.g. the queue view requires touching 20+ files — Crystal's leverage has evaporated and a greenfield reset becomes worth considering.

Implicit secondary criteria (from §5.7 failure modes):
- Pause actually blocks Claude (synchronous socket bridge, not post-hoc event inspection).
- Approval timeout (60 min default) replies on the socket with deny, not silent expiration.
- Approval / run-failure race handled under per-run mutex.
- Cross-run deadlock (>5min awaiting review where the reviewer is itself paused) detected and flagged `stuck`.

### Technical Preferences

**Stack (locked):**
- Electron (LTS, pinned via fork)
- `@homebridge/node-pty-prebuilt-multiarch` (pre-built binaries; avoids universal-binary build problems)
- `better-sqlite3` (synchronous, transactional, WAL mode)
- `@xterm/xterm` + `@xterm/addon-fit` + `@xterm/addon-webgl` for embedded terminal where needed
- React + React DOM
- `zustand` for renderer state (one slice per domain; no Redux)
- `electron-trpc` + `@trpc/server` + `@trpc/client` (v11) for typed renderer↔orchestrator RPC
- `superjson` as tRPC transformer (Date/BigInt fidelity)
- `zod` for runtime validation at the parser boundary only
- `@modelcontextprotocol/sdk` for the outbound SoloFlow MCP server
- `p-queue` for per-run mutation serialization and concurrency limits
- `tailwindcss` for styling
- `vite` for renderer bundling
- `electron-builder` for packaging and signing

**Explicitly not using:** Bull/Redis (Crystal's `CLAUDE.md` mentions it but production uses in-process `SimpleQueue` — do not wire up Redis), Drizzle/Prisma (hand-rolled SQL is faster for MVP), Codex/OpenAI integration, auto-update for v1.

**Architectural principles (locked, see §4):**
- Orchestrator/UI separation; orchestrator module has no Electron imports.
- DB is a service, not a file — renderer never writes SQLite directly.
- MCP server is a separate stdio subprocess from day 1.
- Typed events at the parser boundary, trusted types inside.
- Append-only `raw_events` audit log; normalized projections derived from it.
- Per-run `p-queue({concurrency: 1})` for all mutations.
- Pause must be enforced via synchronous `--permission-prompt-tool` socket bridge, never post-hoc event inspection.

### Scope Boundary

**Explicitly out of v1 (from §8):**
Auto-update via `electron-updater`. Codex / OpenAI integration. Linux or Windows builds. AI-driven worktree naming (replaced with deterministic `cyboflow/<workflow>/<runId8>`). Crystal's rebase/squash UI (*hide entry points, keep code*). Multi-panel-per-session UI surfaces (*delete UI; underlying data model can keep the panel abstraction temporarily*). Cross-machine sync. Cloud agents. Custom DAG editor. Workflow versioning. Multi-user. Authentication. SSO. Team review queues. Edit-plan and request-changes flows (Approve/Reject only in v1). Cost estimation from historical data (static or omitted). Streaming partial JSON for tool inputs (parse on `content_block_stop` only).

**Crystal cuts (from §3 — the decision rule the planner must apply):** *Delete things whose presence would mislead* (wrong product story, wrong implementation paths). *Hide things whose presence is harmless but adds noise.* Specifically delete: Codex/OpenAI paths, Bull/Redis references in CLAUDE.md, Linux/Windows-specific paths, `WorktreeNameGenerator` (replace with deterministic scheme), multi-panel-per-session UI surfaces. Hide (keep code): rebase/squash UI.

### Phasing Priorities

**Hard milestones (the user's explicit targets):**
- **Milestone 1 — Orchestrator running, end of week 1 (day 5).** Pick one workflow, run it in a worktree, stream Claude's stream-json output into a custom UI.
- **Milestone 2 — Review queue working, end of week 2 (day 10).** Cross-workflow approval queue, decisions round-trip back to Claude, MVP-done bar achievable.

**Day-1 disciplines (from §6 — must land in the first epic):**
- Freeze the typed `ClaudeStreamEvent` 7-variant discriminated union schema (`shared/types/claudeStream.ts`).
- Move Crystal's `ClaudeMessageTransformer` from renderer to main on day 1 (refactor into `main/src/services/streamParser.ts`, emit typed events).
- Structure the orchestrator as if it's a separate process — single entry point, tRPC router as its only public surface, no Electron imports inside the orchestrator module.

**The two load-bearing-from-scratch primitives (§5.2 stream extraction and §5.7 review queue) drive the critical path.** The other six primitives lift from Crystal with minimal changes. Sequencing should front-load schema + parser refactor, then orchestrator structure, then the queue UI + ApprovalRouter, then the MCP server.

### Risk Tolerance

**Conservative on:** architectural separation (orchestrator / UI / MCP split day 1 to preserve team-tier extraction path), parser-boundary type discipline (Zod `.passthrough()` + unknown variant default; never crash on unrecognized events).

**Aggressive on:** Crystal scope cuts (delete entire Codex backend, all Linux/Windows paths, AI naming, multi-panel UI surfaces). The user is willing to delete substantial working code to keep the codebase coherent with the v1 product story.

**Day-3 mitigation gate signals willingness to pivot:** if Crystal's substrate fights the differentiator (queue UI requires touching 20+ files by day 3), greenfield reset is on the table. The user prefers to discover this early via the gate, not after week 1.

**Inherited risks the planner must account for (from §7):**
- Stream-json schema drift (Anthropic ships without SemVer).
- Claude Code `result` event missing (issue #1920) — use `(child exited) AND (stdout EOF) AND (parser drained)` + 30s watchdog, never `result` alone.
- Approval expires while held — handler must reply on socket with deny, not silent timeout.
- Universal-binary native module mismatch (`@electron/rebuild`, asarUnpack, lipo verification).
- Crystal substrate fighting the differentiator → day-3 gate.
- Crystal is deprecated → no upstream improvements after fork.
- Notification fatigue → v1 collapse-repeated-approvals card.
- Backend extraction debt → preserved as option, not free; budget ~1 week for v2 team-tier rewrite.

---

## Notes for the resuming roadmap session

This brief was produced after Step 1 of `/soloflow:roadmap`. Pass it with `--skip-clarify` to skip clarification and proceed directly to research dimension fan-out and roadmap generation.

The roadmap-generator should:
- Allocate ROADMAP-001 (no prior roadmaps).
- Slice the work into phases that map to the two milestones. Expect ~6-10 epics total at ~1-2 day chunks (full-time cadence).
- Front-load day-1 disciplines (typed schema + parser refactor + orchestrator structure) into the first epic.
- Treat the day-3 gate as an explicit milestone within Phase 1.
- Treat the 1-day self-host bar as the final Phase 2 acceptance epic.
