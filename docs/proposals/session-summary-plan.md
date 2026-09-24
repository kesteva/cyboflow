# Implementation plan: idle-gated quick-session summaries (rolling summary + append-only history)

Status: **IMPLEMENTED**, with live follow-ups through 2026-08-26 — see §10 ("RESOLVED
2026-08-26": Codex/OMP quick sessions now covered on the SDK substrate).
Scope: Claude-runtime quick sessions only (v1). Author session: curious-stream-20260723.

Review log:
- v1 → Codex adversarial review: needs-attention, 7 findings (5 high). All folded
  into v2; per-finding dispositions in §11.

## 1. Problem and UX

Reopening a quick session after time away means re-deriving what the session was
about from the raw transcript. Fix: the quick-session canvas
(`frontend/src/components/cyboflow/QuickSessionCanvas.tsx`) grows two pieces of
derived text, updated by a cheap Haiku call:

- **Rolling summary** — 1–2 sentences, always current, rendered inside the
  existing 300px SESSION node below the cost row.
- **Append-only history** — one past-tense sentence per *sitting* (a burst of
  activity ending in an idle lull), rendered as an expandable card below the
  SESSION node.

A **sitting** is a maximal run of conversation activity with no internal gap
longer than the idle threshold (5 min). Normally the idle trigger fires once
per sitting; when sittings are missed (app quit, failures, feature disabled),
catch-up re-derives their boundaries from message timestamps (§2.4) so history
granularity survives.

## 2. Design invariants (the gating stack)

The over-call protection is layered; the content watermark — not the timer —
is the load-bearing gate.

### 2.1 Edge-triggered arm

A per-session `setTimeout` (5 min, `SESSION_SUMMARY_IDLE_MS = 5 * 60_000`) is
armed only by a turn-end event. Never scan-on-boot, never poll. Substrate
seams (both carry `sessionId`):

- SDK: `claudeCodeManager` per-logical-turn `'exit'` emission inside
  `finishTurn()` (`main/src/services/panels/claude/claudeCodeManager.ts:2165`).
- PTY: the Stop-hook chain's `'turn-end'` re-emitted on
  `SubstrateDispatchFacade` (`main/src/services/substrateDispatchFacade.ts:226-238`).

### 2.2 Debounce reset — including the PTY relay seam

The pending timer is cleared at every logical turn START:

- SDK: `'spawned'` (`emitTurnStart`, `claudeCodeManager.ts:1545-1563`) fires
  per logical turn, warm or cold.
- PTY: **`'spawned'` fires only at REPL creation; subsequent composer turns go
  through `relayUserTurn` and emit no start event** (Codex finding #1). The
  clear therefore also hooks the input seam: the panel-send path in
  `main/src/ipc/session.ts` (`sessions:input` handler and the
  continue/relay path into `interactiveClaudeManager`) calls
  `scheduler.noteTurnStart(sessionId)` before dispatching the user turn. This
  covers both substrates' user-initiated turns uniformly; the SDK `'spawned'`
  clear is then belt-and-braces.

Note: on the SDK substrate `'exit'` means "turn ended", NOT "went idle" — the
debounce is the idle discriminator.

### 2.3 Fire-time state gates (mid-turn and blocked-gate protection)

Because a stale timer can survive wiring gaps and the PTY Stop hook fires
`turn-end` even while an AskUserQuestion gate is open, firing re-checks live
state via closures injected at wiring time (§5):

- **Turn in flight** → drop the timer without summarizing (the in-flight
  turn's own turn-end re-arms). Probe: the substrate managers' turn-in-flight
  state (the `isPanelTurnInFlight`-style check, which is distinct from
  warm-idle `isPanelRunning`).
- **Pending question/approval gate for the session** → drop the timer (a
  blocked gate is not a completed sitting; answering resumes the turn, whose
  turn-end re-arms). Probe sources: the same blocked-set inputs the
  `sessions:list-quick` seam already assembles (`QuestionRouter`,
  `ApprovalRouter`, `interactiveCliManager.getAwaitingInputRunIds()` —
  `main/src/ipc/session.ts:2478-2495`).
- **Race guard**: `sessions.updated_at` is the activity clock (bumped only by
  spawn/exit-class writes; presentation writes must not bump it —
  `main/src/database/database.ts:3055-3056`,
  `main/src/database/__tests__/sessionUpdatedAtSemantics.test.ts`). If it
  moved after the arm timestamp, re-arm instead of firing.

### 2.4 Content watermark + sitting segmentation

`session_summaries.last_turn_id` stores the highest `conversation_messages.id`
already summarized. At fire time read
`WHERE session_id = ? AND id > ? ORDER BY id ASC` (the `getSessionTokenUsage`
lastId pattern, `main/src/database/database.ts:3632-3664` — AUTOINCREMENT
`id`, never `timestamp`, is the monotonic key). Empty delta → silent no-op.

The delta is then segmented into **sittings** by a pure function
`segmentIntoSittings(messages, gapMs = SESSION_SUMMARY_IDLE_MS)`: a new
segment starts wherever consecutive messages are separated by more than
`gapMs`. This re-derives missed sitting boundaries with **no extra
persistence** (Codex finding #3):

- One history sentence is requested per segment that contains ≥1 assistant
  message, **capped at 3 sentences per call** (older segments beyond the cap
  are merged into the first sentence, and the merge is noted in that
  sentence).
- **Watermark advance stops at the end of the last segment containing an
  assistant message.** A trailing user-only segment (abandoned or not-yet-
  answered prompt) stays above the watermark and is summarized in the next
  delta together with its eventual response — it is neither dropped nor
  misreported as completed work.
- Materiality floor: if no segment contains an assistant message, no-op,
  watermark unchanged.

### 2.5 Serialization

In-memory `inFlight: Set<sessionId>` + a global concurrency cap of 1 (simple
promise-chain queue). Refires during an in-flight call no-op.

### 2.6 Failure policy + retry cooldown

On error/timeout/malformed output: watermark unchanged, and the attempt is
recorded in-memory as `{ attemptedWatermark, lastAttemptAt }`. **Any trigger
(idle or lazy) targeting the same watermark within
`SESSION_SUMMARY_RETRY_COOLDOWN_MS = 10 * 60_000` is skipped** — this is what
prevents the renderer's 30s summary poll from becoming a hot retry loop via
lazy catch-up (Codex finding #2). A new turn edge (which changes the target
watermark) bypasses the cooldown. Per-session `consecutiveFailures ≥ 3` →
suspended until app restart.

### 2.7 Lazy catch-up

The `sessions:get-summary` IPC read, when it observes
`MAX(conversation_messages.id) > last_turn_id`, kicks a fire-and-forget
`maybeSummarizeNow(sessionId, 'lazy-catchup')` that bypasses the 5-min timer
but respects EVERY other gate (§2.3 state gates, §2.4 watermark/materiality,
§2.5 serialization, §2.6 cooldown, §2.8 eligibility). Reads never block on it
and never mutate state themselves; repeated stale reads cannot re-trigger
within the cooldown. This plugs the "quit the app within 5 minutes of the
last turn" hole: the summary refreshes the moment the session is next viewed.

### 2.8 Eligibility (checked at fire time, so settings changes take effect on
pending timers)

- Env kill switch `CYBOFLOW_DISABLE_SESSION_SUMMARY=1` (mirror of
  `CYBOFLOW_DISABLE_WARM_SDK`).
- Config toggle `sessionSummaryEnabled` (§6).
- Session exists, not archived, quick per the sentinel predicate
  `chat_run_id IS NOT NULL` (`main/src/orchestrator/quickSessionListing.ts:40-51`
  — NOT the dead `is_quick` column, `0` for every session since migration 012).
- **Claude-runtime sessions only (v1)** — SUPERSEDED 2026-08-26, see §10. The
  gate is now `isSessionSummarySupported({ agentProvider, substrate })`
  (`shared/types/sessionSummary.ts`): every SDK lane qualifies whatever its
  provider, and only a Codex/OMP PTY session is excluded. The v1 concern
  (Codex finding #4 — an unobserved turn lifecycle) was addressed by
  subscribing those managers' turn events rather than by excluding them.

Rejected alternatives (for the record): summarize-per-turn (calls scale with
turns; history becomes per-turn noise); periodic all-session scan (the retired
`IdleSessionDetector` shape — boot storms; see
`main/src/orchestrator/Orchestrator.ts:67-78`); lazy-only (stale flash on
open; weaker history granularity); persisted per-sitting boundary rows
(equivalent outcome to §2.4's derived segmentation, at the cost of a second
write path — derivation from timestamps needs no new state and is
restart-safe by construction).

## 3. The model call

One call produces the rolling summary plus 1–3 history sentences. New file
`main/src/orchestrator/sessionSummary/sessionSummaryQuery.ts`, cloning the
one-shot pattern of `main/src/orchestrator/eval/evalJudgeQuery.ts` /
`main/src/orchestrator/programmatic/monitorQuery.ts`:

- **All environment-coupled inputs are injected** (Codex finding #5): the
  module exports `makeSessionSummarizer(deps: { sdkQueryLoader, modelId,
  claudeExecutablePath })` and contains NO imports from `services/*`
  (orchestrator layering rule). At the `index.ts` wiring site (services layer,
  where cross-layer glue lives):
  `modelId: resolveModelAlias('haiku')` → pins the concrete
  `claude-haiku-4-5` (`MODEL_ALIAS_TO_ID`,
  `main/src/services/panels/claude/modelContext.ts:46-53` — the alias table is
  applied only when the resolver is called; a bare `'haiku'` string passed to
  the SDK would NOT resolve through it), and
  `claudeExecutablePath: resolveClaudeExecutablePath()`.
  A unit test asserts the exact model id reaching the SDK options.
- `sdkQueryLoader` = `loadSdkQuery` from `main/src/utils/lazyAgentSdk.ts`;
  single string prompt; **no tools, no cwd**; `maxTurns: 1`.
- Hard deadline 60s via the `makeDeadline()` AbortController pattern
  (`evalJudgeQuery.ts:78-103`). Single attempt per fire (§2.6 owns retry).
- Input: previous rolling summary + the delta transcript with explicit
  sitting-segment markers (§2.4), formatted as `USER:` / `ASSISTANT:` blocks,
  clipped by a pure `clipDeltaForPrompt()`: cap ~48,000 chars total; user
  messages kept (each capped 2,000 chars); assistant messages head 1,500 +
  tail 500 chars; when still over, drop oldest assistant bodies first,
  keeping the final assistant message.
- Output contract: a single JSON object
  `{"summary": "<1-2 sentences, present-tense state of the session>",
    "history_sentences": ["<one past-tense sentence per sitting segment,
    oldest first, 1..3 items>"]}`.
  Parse: strip optional code fences → `JSON.parse` → validate shape.
  Malformed → failure (no watermark advance, §2.6 cooldown applies).
- **Cost surfacing** (closes an existing observability gap — none of the
  one-shot query paths record cost today): read `total_cost_usd` from the SDK
  `result` message → accumulate `session_summaries.cost_usd_total`, increment
  `calls_count`.

Explicit non-choices: do NOT route through `AgentThreadService` /
`ClaudeCodeManager.spawnCliProcess` (a real session turn on the warm
machinery; would bump the activity clock); do NOT use raw `@anthropic-ai/sdk`
(declared but unused in `main/src`; new auth path). The summarizer never
touches the session's warm SDK process.

Implementer verification step: confirm the shape of
`conversation_messages.content` for `assistant` rows (plain text vs
JSON-encoded) at the write sites (`main/src/services/sessionManager.ts:609-928`)
and normalize in the transcript formatter; also confirm the assistant row is
committed BEFORE the turn-end event fires on both substrates (composition
test, §8).

## 4. Persistence (migration 083)

Separate tables, not `sessions` columns — summary writes must never bump
`sessions.updated_at` (activity clock), and cascade-delete stays clean.
Target number: **083** (was 082 pre-rebase; design-mode v0 claimed 082 on main) — `080_agent_thread_last_turn.sql` is this branch's
ceiling, but 081 is already claimed by the in-flight final-gate auto-handover
branch (misty-birch, merging as of 2026-07-23). Renumber-on-land applies;
re-check `main/src/database/migrations/` ceiling at implementation time.
Runtime FK enforcement was verified during review, so `ON DELETE CASCADE` is
live (migration-file rule regardless: FK pragma toggles stay outside the
per-file transaction, `docs/CODE-PATTERNS.md`).

`main/src/database/migrations/083_session_summaries.sql`:

```sql
CREATE TABLE IF NOT EXISTS session_summaries (
  session_id     TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  summary        TEXT NOT NULL DEFAULT '',
  last_turn_id   INTEGER NOT NULL DEFAULT 0,
  calls_count    INTEGER NOT NULL DEFAULT 0,
  cost_usd_total REAL NOT NULL DEFAULT 0,
  updated_at     DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS session_summary_entries (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  entry      TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_session_summary_entries_session
  ON session_summary_entries(session_id, id);

-- conversation_messages currently has only single-column indexes
-- (schema.sql:40-41); the watermark read needs (session_id, id).
CREATE INDEX IF NOT EXISTS idx_conversation_messages_session_id_id
  ON conversation_messages(session_id, id);
```

New `main/src/database/database.ts` methods (+ row types in
`main/src/database/models.ts`):
`getSessionSummary(sessionId)`, `upsertSessionSummary({sessionId, summary,
lastTurnId, costUsdDelta})` (single UPSERT that also bumps `calls_count`/
`cost_usd_total`/`updated_at`), `appendSessionSummaryEntries(sessionId,
entries[])` (multi-row, one transaction with the upsert),
`listSessionSummaryEntries(sessionId)`,
`getConversationMessagesAfter(sessionId, afterId)`.

## 5. Scheduler

New file `main/src/orchestrator/sessionSummary/sessionSummaryScheduler.ts` —
**pure module with injected deps** (db handle, `isEnabled()` closure,
summarize function, `isTurnInFlight(sessionId)` probe, `hasOpenGate(sessionId)`
probe, clock), respecting the orchestrator layering rule (no `services/*`
imports — same discipline as `quickSessionListing.ts:13-16`). Shape imitates
`main/src/orchestrator/terminalEvalSubscriber.ts` (event-driven, idempotence
via DB check, fire-and-forget) plus a `Map<string, NodeJS.Timeout>` debounce
registry (the warm-idle-timer / `gitStatusManager.ts:43` shape).

Public surface:
- `noteTurnEnd(sessionId)` — arm/re-arm the 5-min timer; record arm timestamp.
- `noteTurnStart(sessionId)` — clear pending timer.
- `maybeSummarizeNow(sessionId, reason: 'idle' | 'lazy-catchup')` — run the
  full gate stack (§2) and, if it survives, the call + persist. Reason only
  affects logging.
- `dispose()` — clear all timers (app shutdown).

Wiring in `main/src/index.ts` (where cross-layer glue already lives, e.g. the
`onInteractiveTurnEnd` callback threading at `index.ts:1860-1871` and the
`terminalEvalSubscriber` hookup at `index.ts:1761-1785`):
- `claudeCodeManager.on('exit', ({sessionId}) => scheduler.noteTurnEnd(sessionId))`
- `claudeCodeManager.on('spawned', ({sessionId}) => scheduler.noteTurnStart(sessionId))`
- facade `'turn-end'` → `noteTurnEnd`.
- The PTY/relay input seam (§2.2) → `noteTurnStart` — threaded to the
  `sessions:input` / continue path in `main/src/ipc/session.ts`.
- Probes: turn-in-flight from the substrate managers; open-gate from
  `QuestionRouter`/`ApprovalRouter`/`interactiveCliManager` pending state
  (the `sessions:list-quick` blocked-set sources).
- Summarizer deps per §3 (resolved model id, executable path, sdk loader).

No file under `main/src/services/panels/claude/` is modified (external
subscription only), so the Tier-3 `pnpm test:integration` gate is not mandated
by the AC rule — `pnpm test:unit` is the gate. (If implementation ends up
touching that directory after all, the itest suite becomes mandatory.)

Persist step on success (single transaction): `upsertSessionSummary` with
`lastTurnId` per §2.4 + `appendSessionSummaryEntries`. The persist re-checks
session existence inside the transaction.

## 6. Settings toggle (Assistant tab)

Config plumbing mirrors `assistantEnabled` end-to-end (absent ⇒ **enabled**;
the toggle is the kill switch, checked at fire time). Parity surfaces on BOTH
sides (Codex finding #6):

1. `main/src/types/config.ts` — `sessionSummaryEnabled?: boolean` on
   `AppConfig` (near the assistant block, ~line 48-75) AND on
   `UpdateConfigRequest` (~line 207-216), with the standard mirrored comments.
2. **`frontend/src/types/config.ts`** — the renderer's own `AppConfig` mirror
   gains the same field (this file is what `Settings.tsx` reads; omitting it
   is the silent-drop class CLAUDE.md warns about).
3. `main/src/services/configManager.ts` — getter next to
   `isAssistantEnabled()` (~line 280):
   `isSessionSummaryEnabled(): boolean { return this.config.sessionSummaryEnabled !== false; }`
   — NOT seeded into constructor defaults (same convention as the other
   assistant globals, so existing users default on).
4. `frontend/src/components/Settings.tsx` — Assistant tab
   (`activeTab === 'assistant'`, line 1055): new `SettingsSection` titled
   "Session summaries" inside the existing `CollapsibleCard` (after the
   Context Retention section, ~line 1154+):
   - `Switch id="session-summary-enabled" label="Summarize idle sessions"`,
     state `sessionSummaryEnabled` (default `true`), loaded via
     `data.sessionSummaryEnabled !== false` in the config-load effect
     (~line 184-188) and included in the save payload (~line 247-259).
   - Helper copy: "After a Claude quick session sits idle for 5 minutes, a
     small Haiku call updates its summary and history on the session canvas.
     Fractions of a cent per sitting; off means no calls and the canvas hides
     the summary."
   - NOT wrapped in the `!assistantEnabled` disable-overlay — independent of
     the assistant rail; it merely lives on this tab.
5. Server-side enforcement: scheduler + lazy catch-up consult
   `configManager.isSessionSummaryEnabled()`; the `sessions:get-summary`
   response carries `enabled` so the frontend hides the UI without a separate
   config fetch.

Related cleanup (separate chore commit, optional): the dead
`IdleSessionReviewConfig` (`main/src/types/config.ts:13-34`,
`configManager.getIdleSessionReviewConfig()` with zero callers) and the stale
Settings copy describing the retired idle-session review mint
(`Settings.tsx:1030-1044`) — either delete or fold into the new setting.
Not required for this feature.

## 7. IPC + frontend

- Payload type promoted to shared per the IPC parity rules:
  `shared/types/sessionSummary.ts` —
  `interface SessionSummaryPayload { enabled: boolean; summary: string | null;
   updatedAt: string | null; entries: Array<{ id: number; entry: string;
   createdAt: string }>; }` — imported by BOTH `main/src/ipc/session.ts` and
  the frontend (never a local mirror; `IPCResponse<SessionSummaryPayload>`
  with explicit `T`).
- `main/src/ipc/session.ts`: `ipcMain.handle('sessions:get-summary', ...)` —
  validates its input with the file's `validateInput` convention, reads
  summary + entries, and performs the lazy catch-up kick (§2.7).
- `main/src/preload.ts` (~line 234-236 block): `getSummary(sessionId)`
  binding, typed as `Promise<IPCResponse<SessionSummaryPayload>>` — not the
  preload's generic untyped response shape.
- **`frontend/src/types/electron.d.ts`**: the `window.electronAPI.sessions`
  declaration gains `getSummary` with the same explicit payload type
  (Codex finding #6 — this file is a live mirror surface).
- `frontend/src/utils/api.ts` (~line 116-128 block): typed wrapper.
- `frontend/src/hooks/useSessionSummary.ts`: fetch on mount + 30s poll while
  visible, paused on `document.hidden` — mirror of
  `frontend/src/hooks/useSessionMetrics.ts:207-235`'s visibility handling.
  (Reads are pure; §2.6's cooldown makes stale-read-triggered catch-up
  bounded regardless of poll cadence.)
- `frontend/src/components/cyboflow/QuickSessionCanvas.tsx` (superseded by a
  later TASK-144 mandate — summary and history moved OUT of the session node
  into their own node in the resting-layout chain, expanded by default; the
  bullets below describe the CURRENT shape, not the original one):
  - The SESSION node (`data-testid="quick-session-node"`) carries only stats
    + the token/cost breakdown; it does not render the summary itself.
  - Summary + history live in a sibling **Summary & History** node
    (`QuickSessionSummaryHistoryNode`, `data-testid="quick-session-summary-history"`)
    joined to the session node — and, in turn, to the add-workflow node — by
    the same dashed `QuickSessionEdge` used elsewhere in the chain (no
    `flex-direction: column` wrapper). The node itself is gated on
    `hasSummary || hasHistory` and hidden entirely (with its leading edge)
    until one of them has content.
  - Summary well: top-border-free, left-accent block with a `SUMMARY` eyebrow;
    `data-testid="quick-session-summary"`. Render nothing until a summary
    exists or `enabled` is false.
  - History: disclosure lifted verbatim from the `▸/▾ + count` pattern
    (`ArtifactTabRenderer.tsx:1050-1150`, `FeedbackDocPanel.tsx:480-510`),
    **expanded by default** (TASK-144, reversing this section's original
    "collapsed = `▸ History (N)`"): expanded = chronological list (oldest
    first) with date labels, capped height + scroll; a hairline divider
    separates it from the summary well only when both are present.
    `data-testid="quick-session-history-toggle"` / `"-list"`.

## 8. Tests (AC gate: `pnpm test:unit`)

Unit:
- `main/src/database/__tests__/sessionSummaries.test.ts` — CRUD + UPSERT
  accumulation + cascade behavior + `getConversationMessagesAfter` ordering
  by `id`.
- `segmentIntoSittings` — gap splitting, single segment, cap-and-merge at 3,
  trailing user-only segment identification, watermark-stop computation.
- `clipDeltaForPrompt` — caps, final-assistant-message retention, determinism.
- `.../__tests__/sessionSummaryQuery.test.ts` (vi.mock of lazyAgentSdk):
  happy-path JSON; fenced JSON; malformed → error; deadline abort; cost
  extraction; **exact resolved model id (`claude-haiku-4-5`) asserted on the
  SDK options**.
- Scheduler unit tests (fake timers, fake db, fake summarize fn): arm→fire at
  5 min; clear on turn-start; empty-delta no-op; user-only-delta no-op with
  unchanged watermark; inFlight dedupe; global cap 1; retry cooldown skips
  same-watermark triggers; new-turn edge bypasses cooldown; 3-failure
  suspension; race-guard re-arm; disabled-config no-op with pending timer;
  non-quick / archived / Codex-runtime session no-op; watermark advances only
  past the last assistant-bearing segment; cost/calls accumulation.

Composition-level (Codex finding #7 — real EventEmitters + real wiring, fake
SDK/db underneath; scheduler methods are NOT called by hand):
- PTY relay turn: input-seam clear prevents a stale timer from firing during
  a long turn started via `relayUserTurn` (no `'spawned'`).
- Stop-hook `turn-end` with an open AskUserQuestion gate → armed timer fires →
  open-gate probe skips; answering the gate → turn resumes → real turn-end →
  re-arm → summarize once.
- SDK ordering: `'exit'` observed only after the assistant
  `conversation_messages` row is committed (or the test documents and covers
  the actual ordering if it differs).
- Process death without a clean result → no summarize call mid-teardown.
- Repeated `sessions:get-summary` reads after one failed attempt → exactly
  one call per cooldown window.
- Restart with multiple missed sittings → one catch-up call, multiple history
  sentences (capped), correct watermark.
- Settings round-trip: `sessionSummaryEnabled` through config get/set → both
  `AppConfig` mirrors. (Note: Settings.tsx frontend tests have known
  pre-existing failures on main — verify against that baseline.)
- `QuickSessionCanvas` frontend tests: summary block renders with data;
  hidden when `enabled: false` or no summary; history toggle expands and
  lists entries.

## 9. Commit plan (atomic, in order)

1. `feat: migration 082 session summaries + db CRUD` (migration, models.ts,
   database.ts, db tests)
2. `feat: one-shot haiku session summary query` (sessionSummaryQuery.ts,
   segmentIntoSittings, clipDeltaForPrompt, tests)
3. `feat: idle-debounced session summary scheduler` (scheduler, index.ts +
   input-seam wiring, unit + composition tests)
4. `feat: sessions:get-summary IPC + lazy catch-up` (shared type, ipc,
   preload, electron.d.ts, api.ts)
5. `feat: session-summary toggle in Assistant settings` (main + frontend
   config types, configManager.ts, Settings.tsx, round-trip test)
6. `feat: summary card + expandable history on quick-session canvas`
   (QuickSessionCanvas.tsx, useSessionSummary.ts, frontend tests)

## 10. Edge cases and open decisions

- **Codex-runtime quick sessions**: excluded in v1 (§2.8); RESOLVED 2026-08-26 —
  now covered on the SDK substrate. `codexSdkManager`/`ompSdkManager` emit the
  same per-turn `'exit'`/`'spawned'` pair as `claudeCodeManager` and are all
  subscribed by `wireSessionSummaryScheduler`; the eligibility gate became the
  shared `isSessionSummarySupported` predicate over provider x SUBSTRATE
  (`shared/types/sessionSummary.ts`), which the board row's `summarySupported`
  flag reads too. Sending a Codex/OMP transcript to the Haiku summarizer was
  accepted deliberately. Still excluded: Codex/OMP **PTY** sessions, which write
  no conversation rows and whose REPLs have no transcript the (Claude-CLI-only)
  `ptyTranscriptIngest` can read.
- **Dynamic-workflow takeover turns**: verify whether Workflow-tool turns land
  in `conversation_messages` for the chat panel; if not, those sittings
  produce no delta and are correctly skipped.
- **Multi-panel sessions**: summarize session-scoped (all panels'
  `conversation_messages`) — v1-correct for quick sessions (single chat panel
  in practice).
- **History granularity under catch-up**: bounded folding — up to 3 sentences
  per call; more than 3 missed sittings merge the oldest. Documented behavior,
  not a silent collapse.
- **History growth**: unbounded but tiny (one row per sitting). No cap in v1.
- **Default ON** (absent ⇒ enabled) — deliberate; flipping the default is a
  one-line getter change. Flag for review.
- **Quick-only scope** — flow runs have workflow structure, step reports, and
  run summaries already; extending later = relaxing §2.8.
- **No re-summarize button, no push subscription, no backfill** in v1 (a
  pre-feature session summarizes from watermark 0 — its full clipped,
  segmented transcript — on its first post-upgrade trigger; intended
  cold-start behavior).

## 11. Codex review dispositions (v1 → v2)

1. **PTY relay turns lack a start event / question-gate turn-ends** (high) →
   §2.2 input-seam clear + §2.3 fire-time turn-in-flight and open-gate probes.
2. **30s poll → hot retry loop** (high) → §2.6 attempted-watermark cooldown;
   reads never mutate; composition test pins one call per cooldown window.
3. **Watermark folds missed sittings / leaks abandoned prompts** (high) →
   §2.4 timestamp-gap segmentation (no new persistence), per-segment history
   sentences (cap 3), watermark stops at last assistant-bearing segment.
4. **Eligibility includes unobserved Codex runtimes** (high) → §2.8
   Claude-runtime gate; Codex extension is a flagged decision (§10).
5. **Haiku alias not auto-resolved + layering violation** (high) → §3 deps
   injection from `index.ts`; concrete model id pinned via
   `resolveModelAlias('haiku')` at the wiring site; test asserts it.
6. **Config/IPC parity surfaces missing** (medium) → §6/§7 add
   `frontend/src/types/config.ts`, `frontend/src/types/electron.d.ts`, typed
   preload, `validateInput`.
7. **Fake-scheduler tests can't catch lifecycle bugs** (medium) → §8
   composition-level suite over real event wiring.
