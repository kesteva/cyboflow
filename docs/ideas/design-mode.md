# Idea: Design Mode — in-app iterative design sessions

**Scope hint:** large (decomposes into epics). **Status:** rev 7 — **v0 + v0.5 IMPLEMENTED + live-smoked** on `zesty-owl-20260722` (merged to main; see "v0 implementation notes" at the end for the three deliberate deviations). Rev 7 records the **v1 isolation-spike verdict** (see "Isolation spike results") — the loopback-origin OOPIF design is confirmed and v1 implementation proceeds on it; the `WebContentsView` fallback is not needed.

## Problem

The current design workflow is: design in Claude Design on the web → export a handoff packet → download → re-import into cyboflow. It fails in three ways:

1. **No repo context.** Claude Design cannot read the app's code, so designs regularly drift from the app's actual design language.
2. **Reinvention of existing surfaces** (the persistent, worst failure). When mocking a change to an existing surface (e.g. the left rail), Claude Design produces something with similar functionality and on-brand styling that is nonetheless *functionally a different design* — a parallel-universe left rail rather than our left rail plus a delta.
3. **Clunky handoff.** The download/re-import packet is manual glue that loses fidelity and adds friction.

## Goals

- A **design session**: persistent agent chat + design canvas, iterated in-app, launched from the new-session screen.
- Designs grounded in the real repo on two axes: **brand fidelity** (a runnable style kit extracted from the project) and **baseline fidelity** (design-as-diff: existing surfaces are reproduced from their implementing code, then modified).
- **Zero-export handoff:** an approved design lands as an idea-bound prototype artifact plus a design-spec section folded into the idea body; planner/sprint runs can *discover and read both* downstream with no export/import step.
- Interaction surface deliberately scoped to **comments**, element-tagged in v1.

## Non-goals (this idea)

- **Real-app-environment tier** (rendering the project's actual components; dev-server orchestration; scratch-playground→promote). Deferred to a separate v2+ idea — it is process-supervisor scope: the app has no managed dev-server lifecycle today (the project run script is a fire-and-stop logs-panel process; `TerminalPanelManager` teardown is a bare `pty.kill()`; the verify port pool is capture-scoped).
- **Non-Claude / non-SDK design sessions.** Design sessions are pinned to the Claude SDK substrate in v0/v1 (see Architecture — this is a security boundary, not a preference). Interactive-PTY or Codex-driven design sessions would require a cross-substrate MCP scope contract that does not exist; deferred until one does.
- **Automated screenshot grounding** as agent input (deferred; a manual side-by-side using existing verify capture is fine).
- **Design-system curation UI.** Style-kit generation happens inline in the session (agent checks, generates if missing); a dedicated curation flow is separate scope.
- **Planner design-review entry point** (follow-on; entry is the new-session screen only for now).
- **Direct user edits / arbitrary interaction surfaces** beyond comments.
- **Full-screen as a perf mechanism.** Verified unnecessary and ineffective: background canvases unmount on tab switch, the stream subscription is a singleton for the active run only, the left rail is event-driven (150ms debounce, memoized rows, no polling — git-status polling is disabled), and `display:none`/overlays don't stop JS anyway. *(The focus-mode UX this bullet anticipated is now scoped as the v0.5 fullscreen design surface — a UX-identity feature, still not a perf one.)*

## UX walkthrough

1. **Entry.** The new-session screen offers **Design** alongside Workflow and Quick (the wizard's `WizardSelection` union is already 3-way; this adds a 4th arm).
2. **Setup.** Pick project → link an idea (**required**; pick an existing idea or auto-mint a stub idea inline so idealess exploration isn't blocked) → choose starting fidelity: **lo-fi concept** (static) or **hi-fi interactive** (v1). Tier can be promoted mid-session.
3. **Session.** Chat on one side; a canvas tab rendering the current prototype in the center pane. Iterate via chat turns; the agent regenerates the prototype and re-reports the artifact (same-atype re-report enriches in place). The agent also maintains a durable **design-spec draft** (see Architecture) that Approve later consumes.
4. **Comment mode (v1).** An explicit toggle. Entering comment mode **freezes the live prototype**: the current *rendered DOM* is captured (so state the prototype's JS built is preserved — you comment on what you see), sanitized of all active content, and re-rendered in a static comment frame where the app-owned inspector is the only script that can execute (CSP-enforced, not just sanitizer-enforced). Hover highlights the element under the cursor — deepest semantic element by default, with a devtools-style breadcrumb to walk up the ancestor stack (button ‹ toolbar ‹ header ‹ page). Click anchors a draft comment. Comments batch: draft → send → one revision turn → addressed, over a crash-safe delivery pipeline (see Architecture). The full ancestor stack is stored in the anchor regardless of the level picked.
5. **Handoff.** An **Approve design** action — a single host-owned command consuming the durable design-spec draft, executed as a recoverable state machine — snapshots the prototype bound to the linked idea and folds a `## Design spec` section into the idea body (replace-not-stack). The session can then end or continue iterating (a re-approve replaces the bound design).

## Grounding contract (the core differentiators)

1. **Style kit — brand fidelity (creation consent-gated as of v0.5; repo-wide discovery).** At session start the agent looks for an existing design system — a **runnable style kit**: extracted design-token CSS (custom properties, font stack, light+dark palettes, spacing scale) plus a component sample sheet with real markup and class recipes lifted from actual components. It checks `.cyboflow/design/` first, then **searches the rest of the repo** (a `design/` or `docs/design-system/` directory, token/theme CSS, a style guide, a component library — e.g. cyboflow's own design system lives outside `.cyboflow/`); anything found is used **from where it lives**, never duplicated into `.cyboflow/design/`. Only when no design system exists anywhere does the agent ask — never generating one unprompted — in the first clarify round, with four options: **Create one now (tracked)** (committed with the repo; picking it triggers a follow-up question for **where it should live**, with concrete locations fitted to the repo layout), **Create one now (untracked)** (`.cyboflow/design/` + `.gitignore` entry, local-only), **Add a task to the backlog** (the design scope's narrowed `cyboflow_create_task` mints a follow-up task; the session then proceeds ad hoc), or **Skip for now** (no kit; the designer still works, grounding each prototype's styling ad hoc from the real sources). Prototypes inline the kit verbatim when one exists. Executable CSS, not prose — an agent copying a working stylesheet matches the app; an agent reading a markdown description drifts.
2. **Baseline grounding — design-as-diff (mandatory for existing surfaces).** When the design targets an existing surface, the agent MUST locate and read the components that implement it and emit a required **`### Baseline`** subsection in the design spec enumerating the files read and the behaviors reproduced, then state the delta being designed. Gate-checkable by a human (a spec for an existing surface with no Baseline section is a visible defect) and doubles as the implementation file-list for the sprint that builds it.
3. **Opportunistic DOM snapshot.** If the user happens to have the target app running, the agent may snapshot the rendered DOM of the real surface (agent-side CDP/Playwright one-liner against the user-started dev server) and use that as the baseline instance — already-compiled HTML with real class lists and real data, no JSX translation. No app-side dev-server orchestration.
4. **Honest ceiling.** The agent hand-translates JSX → static HTML: reliable for most surfaces; approximate for deeply stateful widgets (xterm, virtualized lists, drag-and-drop), where matching the look is sufficient and behavior is the deferred real-app tier's job. Source-vs-runtime divergence (feature flags, runtime-conditional UI) is exactly what the DOM-snapshot rung compensates for.

## Scope and phasing

### v0 — static tier (~1–1.5 sprints)

- Design session kind (wizard arm → quick-session plumbing, SDK-substrate-pinned).
- Required idea link with integrity contract (existing idea or auto-minted stub; see Architecture).
- `design.md` first-turn prompt carrying the full grounding contract (style kit + baseline + snapshot rungs).
- Canvas = existing static `ui-prototype` artifact path unchanged (bare-sandbox iframe, injected CSP).
- **In-session feedback = chat turns only.** (The folded idea body still gets the full existing doc-comment/highlight machinery *at the next planner gate* — that path already works today and needs nothing from v0. In-session doc comments are NOT claimed: the existing send path requires a parked run with a pending blocking gate, which a design session never satisfies.)
- Handoff = the durable **design-spec draft** + the host-owned **Approve** state machine + the idea-bound read path that makes both discoverable by later planner/sprint runs.

### v0.5 — fullscreen design surface (~1 sprint)

Post-v0-testing direction: design mode gets its **own fullscreen takeover surface** — a deliberate UI-pattern divergence that gives the mode an identity distinct from normal sessions. Ships against the **static** prototype; the v1 interactive backend later boots behind the same entry seam with no UX change.

- **Layout:** left rail becomes the **chat panel** (the session's existing Claude panel rendered in a rail-width column); the center pane is a **stage** with three states — *clarify* (pending question gates rendered as cards center-stage), *working* (a clear working animation while the agent designs), *prototype* (the rendered prototype, presented when the artifact lands/updates). Approve control + freshness line live in the surface's top bar.
- **Auto-start + clarify-first:** entering design mode and picking an idea immediately sends a canonical kickoff first turn — as the first panel input right after panel creation, not through `createQuick`'s prompt field (ignored for the SDK path) — so there's no more idle-until-typed state. `design.md` gains a clarify-first instruction: the agent's first pass asks the user clarifying questions about the idea (question gates → center stage); once it judges it has enough input it starts designing (working state), then presents.
- **Entry (two doors):** the quick-start wizard's Design card, and an **"Enter design mode" CTA on the ui-prototype artifact screen** (render gate identical to the Approve control: server-stamped `sourceRef` + `sessionId`). Entering activates the fullscreen takeover and launches the prototype backend — in v0.5 that renders the static prototype through the same seam that will boot the isolated interactive frame in v1. **Re-entry stub (live-smoke fix):** session creation immediately mints a bytes-less ui-prototype artifact row (server-stamped, `payloadJson: null`) so the artifact tab + CTA exist from second zero — the fullscreen flag is in-memory-only, and a renderer reload before the agent's first report would otherwise leave no re-entry door. The agent's first real report enriches this same row; the surface treats a bytes-less stub as "no prototype yet" (never "unreadable").
- **Exit (top-left button):** leaves the takeover; the session **continues as a normal session** with the agent working in the background (already true today — design sessions are ordinary quick sessions). Re-entry: sidebar → session → prototype artifact → the CTA. Fullscreen state is not restored across app restart — re-entry is always explicit.
- **Dependency:** center-stage question cards ride the quick-session question-gate render/answer plumbing fixed on `lively-valley-20260723` (unpushed at rev 6 time) — that branch must merge first.

### v1 — interactive tier (~3 sprints)

- New **`interactive-prototype`** artifact type: JS-enabled canvas in a **process-isolated, independently destroyable** frame, introduced together with a **canonical artifact-policy registry** (see Architecture) so loader/blessing/snapshot guards can't silently miss the new type.
- **Element-tagged comments**: comment-mode live-DOM freeze + sanitizer + nonce-CSP inspector frame, element anchors, a new design-feedback send path with a **crash-safe acknowledged outbox** (both feedback tables widened), batch → revision turn.
- In-session tier promotion (lo-fi → hi-fi of the same design).
- Style-kit persistence/refresh polish.

### v2+ — separate ideas

Real-app tier (playground harness → promote-to-branch), design-system curation flow, planner design-review entry, automated visual style-diff judging, non-web stacks, non-SDK substrate support.

## Architecture design

**Session plumbing — SDK-pinned, fail-closed.** Add `{kind:'design'}` to `WizardSelection` (`SessionStartWizard.tsx` — already a 3-way union) with a 4th `handleStart` arm routing into the quick-session path (`createQuickSessionCore`, `sessions.is_quick=1`) — no new session-type schema. **Design sessions resolve to the Claude SDK substrate unconditionally** — never interactive-PTY, never Codex — because the MCP scope mechanism (`mcpScope` on `ClaudeSpawnOptions` → `composeMcpServers` → `cyboflowMcpServer` env gate) exists only on the SDK path; `InteractiveClaudeManager` and Codex runtimes have no scope contract, and a design session spawned there would silently receive the full run-scoped toolset. If the SDK substrate or a Claude target is unavailable, session creation **fails with a clear error** (fail-closed) rather than falling back. The new `mcpScope:'design'` value exposes a minimal toolset (get the linked idea, update the design-spec draft, report artifact, ack feedback batches, plus a **narrowed `cyboflow_create_task`** — task-type/category pinned server-side to `task`/`chore`, minimal args — backing the style-kit consent gate's "Add a task to the backlog" option; no sprint/board/backlog-wide tools otherwise), and scope enforcement is tested by **direct tool invocation being rejected** for out-of-scope tools — not merely their omission from ListTools. First-turn prompt from `orchestrator/workflows/design.md`.

**Idea link — integrity contract.** Additive migration `sessions.design_idea_id` (plain `ALTER TABLE ADD COLUMN`; SQLite FK enforcement is not retrofitted — integrity is enforced at the write chokepoints): (a) creation validates the idea exists, belongs to the session's project, and is not decomposed; (b) **every** design-scoped MCP operation re-validates project ownership and target liveness (cross-project ids rejected); (c) if the idea is deleted or decomposed mid-session, design-scoped writes fail soft with a user-visible "link broken — relink or end session" state (parity with the existing decomposed-idea influence guard); (d) stub minting is ordered *after* worktree+session creation succeeds and links in the same write; a launch failure after mint compensates by archiving the stub (a stranded stub is flagged, never silently kept). Tests cover launch failure, concurrent idea deletion, cross-project ids, and create retries.

**Canvas v0.** Reuse the static `ui-prototype` pipeline exactly as-is (content-blessed file write → `LiveCanvasEmbed` `sandbox=""` srcdoc + injected `ARTIFACT_PROTOTYPE_CSP`).

**Fullscreen design surface (v0.5).** A renderer-level takeover, not a window/route change: a `DesignModeSurface` overlay keyed by `activeDesignSessionId` in a small frontend store; entering sets it, the top-left Exit clears it, and it is never persisted (no restore across app restart). While active, the normal app layout beneath is unmounted-or-hidden such that only one chat view and one canvas subscribe per session (the stream subscription is a singleton for the active run — two live mounts would double-subscribe). The left rail hosts the session's existing Claude chat panel component at rail width; the center stage renders by precedence: **pending question gate → working animation → prototype → intro/empty**, where *pending gate* reuses the quick-session question-gate card + answer path, *working* derives from the session's running/generating state, and *prototype* is the existing static `ui-prototype` render behind a `DesignStageCanvas` seam — the single place v1 later swaps in the isolated interactive frame. The Approve control + freshness line move into the surface top bar (same component, same tRPC calls). **Auto-start:** the wizard's design arm sends a canonical kickoff prompt client-side as the session's first panel input immediately after panel creation — NOT through `createQuick`'s prompt field, which is ignored entirely for the SDK path (`createQuickSessionCore` hardcodes `prompt: ''`) — using the same dispatch the chat composer uses, so it renders as a real, visible user turn (restart-safe, no synthetic-turn machinery). `design.md` gains the clarify-first contract (ask clarifying questions when the idea is thin; the agent judges when it has enough input and proceeds). **Second entry door:** an "Enter design mode" CTA in the ui-prototype `ArtifactHeader`, gated exactly like the Approve control (`sourceRef !== null && sessionId !== null`), which sets `activeDesignSessionId` for that artifact's session.

**Canvas v1 — `interactive-prototype` atype + artifact-policy registry.** The new atype is introduced by way of a **canonical per-atype policy registry** (single source of truth consumed by report validation, payload blessing, IPC HTML loading, CSP selection, byte requirements, snapshot lookup, and rendering) — generalizing the lesson that made `VALID_ATYPES` derived. This is required, not optional: today `LoadArtifactHtmlAtype`/`coerceAtype` accept only `ui-prototype`/`generic`, blessing is per-atype, and `requiredBytePaths` treats unknown atypes as byte-free — added naively, an interactive artifact could bypass canonical-file validation, fail to load, or "successfully" commit with zero HTML bytes and then lose the only copy when the DB row is deleted. A **report→commit→row-delete→reload durability test** proves the HTML survives with the interactive CSP intact. Remaining touch-set as previously mapped: migration widening the `artifacts.atype` CHECK (rebuild recipe of migration 073); `shared/types/artifacts.ts` union + render-mode/color/glyph maps + payload type; MCP tool enum + `validAtypes`; `ArtifactTabRenderer` case (compiler-forced); frame sandbox `allow-scripts` (**no** `allow-same-origin`) and a new interactive CSP — `script-src 'unsafe-inline'` with `default-src 'none'` egress blocking retained.

**Process isolation — the interactive frame must be independently destroyable.** Capability containment (sandbox + CSP + navigation guard) does not protect *availability*: a srcdoc iframe is not guaranteed its own renderer process, so an accidental or adversarial busy-loop/memory-bomb in prototype JS could freeze the host UI while every network/navigation test still passes. The interactive canvas therefore renders in a **disposable, independently destroyable renderer boundary**. Primary design: serve the blessed prototype HTML from the token-gated loopback static server (reusing the `StaticServerManager` pattern — ephemeral OS-assigned port, path-containment-hardened) so the frame is **genuinely cross-origin → its own OOPIF renderer process**; the main process watchdogs the frame's process (via `WebFrameMain`/process metrics), kills it on sustained CPU-hang or memory-runaway, and the canvas shows a "prototype terminated — regenerate or reload" state instead of a wedged app. If a spike shows OOPIF watchdog control is insufficient, fall back to a dedicated `WebContentsView` (explicit crash events + `destroy()`), decided before v1 implementation starts. **Acceptance includes a busy-loop prototype being terminated without wedging the host UI.** The navigation-guard contract below applies to this frame class regardless of mechanism (it is keyed to the artifact frame identity, not to `about:srcdoc`).

**Server lifecycle — bound to design-mode entry/exit (v1).** The v0.5 static canvas has **no server at all** (disk → hardened IPC read → `srcDoc` iframe), so there is nothing to spin up or reap today. When the v1 loopback server lands, its lifecycle is **owned by the design-mode surface**: spun up on design-mode entry, reaped on design-mode exit — never an ambient long-lived server the UI merely hopes is still there. Rationale (user, live testing): prior prototype dev-servers were finicky and got reaped unpredictably, so any UI that *counts on* an ambient server breaks randomly; a surface-scoped lifecycle makes availability deterministic, and re-entry simply respawns it from the on-disk blessed bytes. The canvas must still handle "server gone" fail-soft (show a respawn affordance, never a wedged frame).

**Frame navigation — no external open for scripted frames.** The existing `artifactFrameGuard` blocks `about:srcdoc` navigation but then offers `https?://` targets to `shell.openExternal` — for a script-enabled frame that behavior converts `window.location = 'https://…'` into OS-browser egress (URL-encoded exfiltration, browser spam) even though the frame stays confined. Script-enabled artifact frames therefore get their own guard class keyed to an explicit **artifact-frame identity** (registered frame → guard class, covering both srcdoc and loopback-origin frames): **all programmatic navigation is blocked outright with no external open**. External links inside a prototype surface only through a trusted parent-side affordance (the parent renders the link chrome; opening requires a real user gesture on app-owned UI). Tests assert `shell.openExternal` is never invoked for scripted-frame navigation attempts.

**Comment mode — live-DOM freeze + sanitizer + nonce-CSP (belt and suspenders).** Two invariants, each independently enforced:

1. *Faithful freeze.* Entering comment mode captures a **serialization of the live rendered DOM** from the interactive frame (a capture request the injected serializer answers) — not a re-render of the source HTML — so DOM and state created by prototype JS are preserved and the user comments on what they actually see. The serialization is produced inside the untrusted frame and is therefore treated as untrusted *content* (it cannot execute — see 2); prototype JS tampering with its own serialization is self-sabotage of design content, not a boundary breach.
2. *Sole-writer channel, CSP-enforced.* The captured serialization is **sanitized parent-side** (strip `<script>`, all `on*` handler attributes, `javascript:`/`vbscript:` URLs, `<object>`/`<embed>`/nested frames, SVG script/handler vectors, **and all navigation-capable content: `<meta http-equiv="refresh">`, `<base>`, `<form>` actions/`formaction` attributes**) and re-rendered in a **static comment frame whose CSP is `default-src 'none'; style-src 'unsafe-inline'; img-src data:; script-src 'nonce-<R>'; form-action 'none'; base-uri 'none'`** where only the app-owned inspector script carries the nonce. Under a nonce-only `script-src`, inline event handlers and `javascript:` URLs cannot execute *even if the sanitizer misses a vector* — the CSP is the enforcement, the sanitizer is defense in depth. Script execution is not the only escape, though: **CSP does not govern document navigation**, so the comment frame is additionally **registered with the artifact-frame navigation guard** (same class as scripted frames: all navigation blocked, no external open) — a captured `<a href>`, form submit, or meta refresh cannot move the frame or reach the OS browser. The inspector is thus the frame's only possible writer; the parent additionally validates message schema, caps payload size, and rate-limits. Inspector output is treated as UI input (element stacks for anchoring), never as a security decision.
3. *Tests:* payloads using handler attributes (`onclick`, `onerror`), `javascript:` URLs, and SVG handlers must not execute in the comment frame; **meta-refresh, form-submission, and plain-link navigation attempts must not navigate the frame or invoke `shell.openExternal`**; a prototype that builds DOM at runtime must show that DOM in the freeze.

Anchor contract unchanged: generator stamps stable `data-design-id` attributes (prompt contract in `design.md`); the ID is the anchor key; the stored ancestor stack is the relocation fallback and human/agent-readable context.

**Design-spec draft — the authoritative Approve input.** Approve needs defined content to fold; the prototype artifact is HTML, not prose, and having the agent write the idea body *before* Approve would restore the rejected two-write choreography (and invalidate the expected version). So the design session owns a **durable, versioned design-spec draft**: a design-scoped MCP tool (`cyboflow_design_update_draft`) writes the current spec markdown into a session-bound draft row with a monotonic `draft_revision`, each revision **bound to the prototype artifact revision it describes**. Because artifacts enrich in place (mutable current bytes), the binding is enforced with a CAS, not trusted: **Approve rejects unless the artifact's current revision equals the selected draft's bound revision** — a draft written against prototype p5 cannot be approved after the prototype has advanced to p6; the user is prompted to refresh the draft (or re-select) instead of silently folding r5 prose over p6 bytes. The chat UI shows draft freshness (draft revision vs latest prototype revision) so the user approves knowingly.

**Approve — intent-first recoverable state machine.** Approve takes `(sessionId, draftRevision, expectedIdeaVersion)` and executes:

- **Step 0 — before any side effect:** validate the draft↔prototype CAS (current artifact revision == draft's bound revision, else reject as stale-draft), then persist a **handoff-intent row** (idempotency key, draft revision, prototype artifact revision, expected idea version, state=`intent`). All subsequent transitions update this row; recovery always starts from it.
- **Step 1:** snapshot the prototype bound to the idea (filesystem publication atomic: temp + rename) → state=`snapshotted`.
- **Step 2:** CAS the idea body — replace the `## Design spec` section via an app-owned replacement function (extending the paired-fence grammar beyond its hard-coded arch-design target) **in the same SQLite transaction as the state transition** to `folded`, so the version bump and the record that it happened are atomic. A stale `expectedIdeaVersion` rejects into a user-visible re-read state (the intent row is marked `superseded`, never silently retried past a concurrent edit).
- **Step 3:** publish to the approved-design read model + state=`complete`.
- **Recovery:** boot (and re-invocation with the same idempotency key) resumes from the recorded state — a crash after the fold cannot strand the operation, because the fold and its state transition committed together; a crash before it replays cleanly against the still-valid expected version. Crash tests at every transition boundary, plus the concurrent-edit case.

**Idea-bound artifact + read path (v0 — this is the zero-export promise).** Artifacts today are keyed and read by `(runId, atype)`; nothing lets a later run find a prototype by idea, and `cyboflow_report_artifact` accepts no `source_ref`. v0 therefore adds: the report handler stamps `source_ref` **server-side** from the session's validated `design_idea_id` (never agent-supplied); an **approved-design read model** (idea → current approved prototype, replace-on-re-approve semantics, superseded snapshots retained); and consumption wiring — planner/sprint gate surfaces show the bound prototype beside the idea, and the flows' prompts/tools can resolve it (e.g. surfaced via `cyboflow_get_task` for the linked idea). Without this the artifact half of the handoff is undiscoverable and only the body fold survives.

**Design feedback v1 — acknowledged durable outbox.** The existing feedback send path cannot be reused (`sendFeedbackHandler` requires a parked run with a pending blocking gate; migration 077 CHECK-constrains `atype` on **both** `feedback_comments` and `feedback_batches`). v1 adds a migration widening **both** tables (+ `FeedbackAtype` guards, element-anchor variant in `anchor_json`) and a **design-feedback delivery pipeline whose every transition is durable and attributable**:

- States: `draft → queued → dispatching → dispatched → applied | failed | blocked`, with a unique **delivery-attempt id** per dispatch.
- **Lifecycle guards at every transition, not just send:** queue, dispatch, and recovery each re-validate session-alive + idea-link-valid + prototype-artifact-present. A guard failure moves the batch to a user-visible **`blocked`** state (with the reason: link broken, session closed, prototype missing) instead of dispatching a turn that has no valid destination — and recovery never re-delivers a `blocked` batch. Tests exercise idea deletion/decomposition between each pair of transitions.
- **The dispatch boundary is pre-persisted, because SDK acceptance and a DB write cannot commit atomically:** the attempt row (stable idempotency key = batch id + attempt id) transitions to `dispatching` *before* the SDK call; `dispatching → dispatched` records SDK acceptance after it returns. A crash between SDK acceptance and the status write leaves the row `dispatching` — recovery treats `dispatching` as **possibly-delivered** and never blindly re-dispatches it as if fresh.
- **Duplicates are made harmless host-side, not by instruction:** the revision turn's prompt carries the batch + attempt ids, and the design-scoped ack/report tools must echo them; the host applies a **one-result CAS per batch** — the first ack wins and later acks/reports for the same batch are acknowledged-and-discarded. Recovery of a `dispatching`/`dispatched`-without-ack batch re-delivers under the **same batch id** (new attempt id), so even if two turns both apply the feedback, only one result transitions the batch and the prototype re-report is convergent (same-atype enrich-in-place). Agent-side "skip if already addressed" phrasing remains as an optimization, not the mechanism.
- `dispatched → applied` requires the **explicit agent acknowledgement** naming batch id, attempt id, and the resulting prototype artifact revision — correlating feedback to the exact revision that addressed it. `applied` is terminal. Nothing silently reverts sent feedback to drafts.
- Tests restart the app before dispatch, **between SDK acceptance and the `dispatched` write**, during regeneration, and after artifact report but before ack — each must recover without lost feedback or a double-applied revision escaping the one-result CAS.

The detached `revisionWorker` generalization stays out of scope until the planner design-review entry (parked-gate context) exists.

## Acceptance criteria

**v0**

- New-session screen offers Design; starting one creates a worktree-backed, **SDK-substrate** quick-session variant with a validated `design_idea_id` (picker or auto-minted stub); creation fails closed with a clear error when the SDK substrate/Claude target is unavailable.
- Out-of-scope MCP tools are **rejected on direct invocation** from a design session (tested), not merely unlisted.
- Session agent produces a static prototype that inlines the project style kit; for an existing-surface design the folded spec contains a `### Baseline` section enumerating the implementing files; a missing Baseline section on an existing-surface design is gate-visible.
- The design-spec draft is durable and versioned; Approve consumes a named draft revision and executes the intent-first state machine: crash tests at every transition boundary pass (including crash between body fold and completion — recovery converges), stale idea versions reject into the re-read state, and the fold + its state transition are atomic.
- **Stale-draft CAS:** advancing the prototype after a draft is written and then approving that older draft is rejected (test), prompting a draft refresh — an approved handoff never pairs one revision's prose with another revision's bytes.
- A subsequent planner/sprint run can **discover and read** both the folded spec and the bound prototype with no export step (read-model + gate-surface test).
- Idea-link integrity: cross-project ids rejected; deletion/decomposition mid-session fails soft into the relink state; stub-mint launch failure leaves no silently-stranded stub.
- `pnpm test:unit` green; the `__quick__` two-way seams (`transitions.ts`, `variantResolver.ts`, `experimentStore.ts`, `interactiveClaudeManager.ts`) behave correctly for design sessions (rotation skipped, revival policy unchanged).

**v0.5**

- Starting a design session from the wizard lands directly in the fullscreen surface with the agent already working (kickoff turn sent); no idle empty-chat state.
- A thin idea produces a clarify-first pass: question gates render center-stage and answering them resumes the agent (quick-session gate plumbing — requires the `lively-valley-20260723` fixes merged).
- Stage precedence holds: pending gate beats working beats prototype; the working animation shows whenever the agent is generating with no pending gate; the prototype presents when the artifact lands/updates.
- Exit returns to the normal app with the session live and continuing in the background; the "Enter design mode" CTA on the session's ui-prototype artifact re-enters the same surface (gated on server-stamped `sourceRef` + `sessionId`).
- Only one chat/canvas subscription exists per session while the surface is active (no double-subscribe from the underlying layout); fullscreen state does not survive app restart.
- Approve + freshness work from the surface top bar identically to the canvas header (same component and tRPC path).

**v1**

- Interactive prototype executes JS with **no network egress** (CSP test) and **no navigation escape**: programmatic navigation is blocked without external open, and `shell.openExternal` is asserted uncalled for scripted-frame navigation.
- **Availability:** a deliberate busy-loop/memory-bomb prototype is terminated by the watchdog without wedging the host UI (test), and the canvas surfaces the terminated state.
- Artifact-policy registry: the interactive atype round-trips report → commit → DB-row delete → reload with HTML bytes intact and the interactive CSP applied (durability test); an atype missing from the registry fails loudly at report time.
- Comment mode: the freeze captures live JS-built DOM (test); handler-attribute / `javascript:` URL / SVG-handler payloads do not execute in the comment frame (nonce-CSP tests); meta-refresh, form-submission, and link-click attempts neither navigate the frame nor invoke `shell.openExternal` (navigation-guard tests); the inspector is the sole nonce-carrying script; parent validates schema/size/rate.
- Feedback outbox: both tables accept the new atype; lifecycle guards hold at queue/dispatch/recovery (idea deletion or decomposition between any two transitions lands the batch in the visible `blocked` state, never a destination-less turn); every crash-window restart test (before dispatch, **between SDK acceptance and the `dispatched` write**, during regeneration, after report before ack) recovers without lost feedback, and the host-side one-result CAS prevents any double-applied revision from transitioning a batch twice; `applied` always correlates batch + attempt ids to a prototype artifact revision.
- Tier promotion converts a lo-fi session to hi-fi without losing the idea link or comment history.

## Risks and landmines

- **Migration contention:** the design-mode migration landed as **082** after a rebase renumber (main took 078–081); any sibling branch minting 082 renumbers. The artifacts-CHECK test DBs must seed any new atype.
- **Security:** the v1 canvas executes agent-generated JS. Containment = minimal sandbox + egress-blocking CSP + scripted-frame navigation block (no external open) + single-writer comment frame (nonce CSP) + **process isolation with watchdog termination** — each with an explicit test, and the whole set reviewed as a unit before ship.
- **Isolation-mechanism spike:** ~~loopback-origin OOPIF vs dedicated `WebContentsView` must be decided by a time-boxed spike (busy-loop kill test) before v1 implementation~~ **RESOLVED (rev 7): OOPIF confirmed — see "Isolation spike results" below.**
- **Substrate pin as product constraint:** design sessions are Claude-SDK-only; users who prefer interactive/Codex sessions don't get design mode until a cross-substrate scope contract exists. Deliberate trade (security boundary first).
- **Quick-session policy inheritance:** design sessions ride `is_quick=1`, so they inherit quick-session behaviors — notably boot-resume excludes `__quick__` from `--resume` revival, meaning a design session does not auto-resume after app restart. Acceptable for v0 (same as quick sessions today; the outbox recovery covers v1 in-flight feedback); revisit if design sessions become long-lived.
- **Anchor rot:** without `data-design-id` discipline the element anchors orphan on every regeneration; the prompt contract plus ancestor-stack relocation is the mitigation, and the write-tests lane should cover relocation.
- **Style-kit staleness:** a committed kit can drift from the app; the session-start check should compare kit mtime/hash against the token source files and offer a refresh.

## Open questions

- Approve action placement: canvas-header button vs chat command (leaning canvas button with a confirm).
- One prototype per session (aligned with one-artifact-per-atype-per-run) vs multiple named prototypes — v0 assumes one, iterated in place.
- Stub-idea auto-mint defaults: which stage/priority does the stub land in, and should it be flagged as design-originated for later planner pickup?
- Whether the approved-design read model lives on the artifacts table (`source_ref` + status column) or a small dedicated table — decide at implementation with the registry design. *(Resolved in v0: dedicated `approved_designs` table — see implementation notes.)*

## Isolation spike results (rev 7, 2026-07-24)

Time-boxed spike run against Electron **37.6.0** with cyboflow's exact production
`webPreferences` (`contextIsolation: true`, `nodeIntegration: false`,
`sandbox: false`): a host page on one loopback port embedding an
`<iframe sandbox="allow-scripts">` pointed at a second loopback port, whose
document runs a 60s hard busy loop. Findings:

1. **OOPIF confirmed.** The cross-origin loopback frame gets its **own renderer
   OS process** (distinct `osProcessId` from the host frame), even with the
   opaque-origin `sandbox="allow-scripts"` attribute and the window-level
   `sandbox: false`. No extra Chromium switches needed.
2. **Availability holds.** The host page stayed fully responsive during the
   frame's busy loop — `executeJavaScript` heartbeats answered in 0–1ms and the
   host's rAF counter kept advancing throughout.
3. **Kill is clean.** `process.kill(framePid, 'SIGKILL')` from the main process
   terminates the frame without any effect on the host window; heartbeats and
   rAF continue. Re-setting the iframe `src` afterwards respawns a **fresh
   process** (new pid) — the "regenerate or reload" affordance is exactly one
   src reassignment.
4. **CPU detection works, with two caveats the watchdog must encode.**
   `app.getAppMetrics()` per-process `percentCPUUsage` is **delta-based** — the
   first sample always reads 0, so the watchdog primes once and acts only on
   subsequent samples; and the value is machine-normalized (a pegged core read
   ~10% on the 10-core spike host), so the threshold is "sustained ≈ one core"
   relative to `os.cpus().length`, not a fixed percentage. Memory runaway rides
   the same channel (`memory.workingSetSize`).
5. **No crash event fires for an OOPIF process death.** Neither
   `webContents 'render-process-gone'` nor `app 'child-process-gone'` was
   emitted when the frame's process was SIGKILLed (verified over multi-second
   windows). Death detection is therefore **poll-based**: the pid disappears
   from `getAppMetrics()` and the frame's `WebFrameMain` throws
   ("Render frame was disposed") on property access — watchdog code must wrap
   every `framesInSubtree` access in a disposal guard. Since the watchdog is
   the killer in the designed flow, it always knows its own kills; polling
   covers spontaneous deaths (e.g. OS OOM kills).

**Verdict: primary design stands** — token-gated loopback static server (spun on
design-mode entry, reaped on exit) + cross-origin iframe → dedicated OOPIF
renderer + main-process metrics-polling watchdog with SIGKILL termination. The
`WebContentsView` fallback is dropped from scope.

## v0 implementation notes (rev 5)

v0 shipped on `zesty-owl-20260722` (migration **082** — originally minted as 078, renumbered on the post-merge rebase; commits `9e2dd928`…`9af69f49`). The architecture above was implemented as specified, with the following concretizations and three deliberate deviations:

**Concretizations.**
- **Schema (migration 082):** `sessions.design_idea_id` (plain nullable ADD COLUMN, no FK); `artifacts.revision INTEGER NOT NULL DEFAULT 1` (the draft↔prototype CAS material — bumped by `ArtifactRouter.runCreate`'s enrich branch only when a field actually changed); `design_spec_drafts` (UNIQUE(session_id, draft_revision), bound artifact id+revision nullable pre-prototype); `design_handoffs` (state CHECK `intent→snapshotted→folded→complete | superseded | failed`); `approved_designs` (dedicated read-model table; current = `superseded_at IS NULL`; re-approve supersedes the prior row in the same transaction as the insert). No FKs anywhere — the read model must survive run/artifact cascade-deletes; `snapshot_path` holds the durable bytes under `<data dir>/design-snapshots/`.
- **Prompt injection:** SDK quick sessions have no first-turn briefing seam, so `design.md` rides `ClaudeSpawnOptions.systemPromptAppend`, derived from `sessions.design_idea_id` at the `spawnClaudeCode` chokepoint (every turn, restart-safe, warm-fingerprint-stable) — not a synthetic first user turn.
- **Fold atomicity:** `TaskChangeRouter.applyChange` cannot join an ambient transaction, so Approve Step 2 uses the sanctioned co-write-exception pattern (`design/entityBodyFold.ts`, mirroring `reviewItemListing.ts`): CAS + guarded UPDATE + shape-identical `entity_events` row (`kind='design-spec-folded'`) inside one `db.transaction()` with the handoff state transition; the idea-changed event is emitted after commit.
- **Approve idempotency:** no deterministic idempotency key — a non-terminal `design_handoffs` row for `(session_id, draft_revision)` is resumed; `complete` returns already-complete; `superseded`/`failed` mint a fresh row. Boot recovery (`recoverDesignHandoffs`) drives non-terminal rows through the same step functions.
- **Zero-export read path:** `cyboflow_report_artifact` stamps `source_ref` server-side from the session's validated `design_idea_id`; `cyboflow_get_task` for an idea includes `approved_design { approved_at, draft_revision, prototype_revision, snapshot_path }` with a resolved absolute snapshot path.

**Deviations from the spec text.**
1. **Stub mint is picker-side, not backend.** The idea-link picker reuses `IdeaPickerModal`, whose existing "new idea" tab mints the stub through the normal `tasks.create` chokepoint *before* session creation. The backend mint-after-session + archive-compensation machinery was dropped: the integrity invariant ("a stranded stub is flagged, never silently kept") is preserved differently — a launch failure leaves an ordinary, board-visible idea created by an explicit user action, which can be re-linked on retry. One uniform validation path for picked and minted ideas.
2. **No fidelity control in the v0 wizard.** v0 is static-only, so the lo-fi/hi-fi choice would have exactly one enabled option; the control arrives with v1's interactive tier.
3. **Gate-surface prototype visual deferred.** The folded `## Design spec` is already gate-visible (gate surfaces render the idea body), and the prototype is flow-discoverable via `cyboflow_get_task`; an inline visual embed of the approved prototype in the approve-ideas/planner gate surfaces is a small follow-up, not in v0.

**Live-smoke findings (v0, dev instance).** The full path was smoked end-to-end: wizard → idea gate → SDK-pinned session → one real design turn (3-tool scope confirmed, no run-scoped tools) → prototype + bound draft → Approve → atomic fold + snapshot + read model. One blocking bug found and fixed: the design report path stamped `source_ref` but not `session_id` on the artifact, so the canvas Approve control's render gate (`sourceRef && sessionId`) never fired — `handleReportArtifact` now stamps both from the run's session (server-side, regression-tested). One spec-text correction: quick-ness in the current build is carried by the `__quick__` sentinel workflow linkage (`workflow_runs.workflow_id`), not by `sessions.is_quick=1` (that column is 0 for every quick session in practice) — the "rides `is_quick=1`" phrasing above should be read as "rides the quick-session plumbing"; all `__quick__` seam behavior was verified to apply to design sessions regardless.
