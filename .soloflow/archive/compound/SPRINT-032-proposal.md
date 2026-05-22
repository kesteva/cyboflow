---
sprints: [SPRINT-032]
span_label: SPRINT-032
created: 2026-05-22T00:00:00.000Z
counters_start:
  ideas: 24
summary:
  cleanups: 1
  backlog_tasks: 2
  claude_md: 0
  soloflow_improvements: 0
---

# Compound Proposal — SPRINT-032

## A. Clean-up items (execute now)

### A1. Drop eslint-disable in useEnsureClaudePanel deps array and use whole `session` object
- **Summary:** Replace `[session?.id, ...]` + eslint-disable-line in `useEnsureClaudePanel.ts:73` with `[session, ...]` matching the sibling `useAddTerminalPanel` hook, making lint happy without suppressing it.
- **Source-Sprint:** SPRINT-032
- **Rationale:** The eslint-disable comment suppresses a rule that would actually pass with the corrected deps (`session` is a stable React state value; only `session.id` is read inside the callback, so using the whole object is the safe superset). The sibling hook `useAddTerminalPanel.ts:53` uses `[session, addPanel, setActivePanelInStore, onAfterActivate, logTag]` and passes lint cleanly. This divergence was flagged by the code-reviewer in TASK-693 (FIND-SPRINT-032-1) and left for compound. It is a one-line edit with trivial blast radius.
- **Blast radius:** `frontend/src/hooks/useEnsureClaudePanel.ts` (1 line changed). Risk: trivial — the callback only reads `session.id`; switching the dep from `session?.id` to `session` never increases re-runs (the session object reference is stable across the renders that matter).
- **Source:** FIND-SPRINT-032-1 — surfaced by TASK-693 code-reviewer; confirmed by reading `useEnsureClaudePanel.ts:73` and `useAddTerminalPanel.ts:53`.
- **Proposed change:**
  ```diff
  --- a/frontend/src/hooks/useEnsureClaudePanel.ts
  +++ b/frontend/src/hooks/useEnsureClaudePanel.ts
  @@ -70,5 +70,5 @@
       setActivePanelInStore(session.id, newPanel.id);
       // NOTE: panelApi.setActivePanel is intentionally NOT called here.
       // The original ProjectView.ensureClaudePanel relied on the panel:created
       // event for backend activation. This hook preserves that contract so the
       // ProjectView migration (step 8) is behavior-equivalent.
  -  }, [session?.id, addPanel, setActivePanelInStore, logTag]); // eslint-disable-line react-hooks/exhaustive-deps
  +  }, [session, addPanel, setActivePanelInStore, logTag]);
  ```

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** high
- **Reasoning:** Confirmed at `frontend/src/hooks/useAddTerminalPanel.ts:53` — sibling hook uses `[session, addPanel, setActivePanelInStore, onAfterActivate, logTag]` with no eslint-disable, so the precedent is real and the change drops a suppression without behavioral risk in a 1-line isolated hook edit.

---

## B. Backlog tasks (refine into execution-ready plans)

### B1. Route claudeCodeManager SDK events through TypedEventNarrowing before emitting to the EventRouter
- **Summary:** `claudeCodeManager.ts:343` raw-casts SDK events to `ClaudeStreamEvent` bypassing `TypedEventNarrowing.narrow()`, while the parallel `runEventBridge.ts:209` path properly validates — converge both emit paths onto a single validated boundary.
- **Source-Sprint:** SPRINT-032
- **Source:** FIND-SPRINT-032-2 — surfaced by sprint-code-reviewer; cued explicitly by TASK-729 done report §Out-of-scope follow-up; confirmed by reading `claudeCodeManager.ts:330-346` and `runEventBridge.ts:206-216`.
- **Problem:** `claudeCodeManager.runSdkQuery` (line 343) emits each SDK event via:
  ```
  router.emitForRun(runId, event as unknown as ClaudeStreamEvent);
  ```
  The double-cast bypasses `TypedEventNarrowing.narrow()` entirely. The parallel path in `runEventBridge.ts:209` calls `narrowing.narrow(p.data)` and gets a validated, normalized `ClaudeStreamEvent` before passing it to the router.

  After TASK-729 extended the delta union (`signature_delta`, `thinking_delta` + carrier fields), this gap is load-bearing: any future `content_block_delta` variant that the Zod schema does not yet accept will silently flow through `claudeCodeManager`'s path as an unvalidated cast, land in `RawEventsSink` as if it were a known type, and be trusted by all downstream consumers with the wrong TS type. The `runEventBridge` path would correctly produce an `__unknown__` variant; the SDK path would not. The JSDoc comment at lines 338-341 acknowledges this ("both share the same wire-format shape for the types that EventRouter / RawEventsSink consume") but that is the current invariant, not a permanent guarantee — and the comment will not update itself when new SDK variants ship.
- **Proposed direction:** Inject a `TypedEventNarrowing` instance into `ClaudeCodeManager` (constructor argument, following the same pattern as `EventRouter` injection) and call `narrowing.narrow(event)` inside the `for await` loop in `runSdkQuery` before the `router.emitForRun` call. `narrow()` is fail-soft — it returns an `__unknown__` variant on Zod failure, so it cannot break the SDK loop. Once both paths go through `narrow()`, remove the `as unknown as ClaudeStreamEvent` cast at line 343 and delete the JSDoc note at lines 338-341 that was written to justify the cast. The resulting type becomes `ClaudeStreamEvent` coming out of `narrow()` without any cast, which is what the router's declared return type already claims. Ensure the `ClaudeCodeManager` constructor site (whichever service owns the EventRouter for SDK sessions) is updated to supply the `TypedEventNarrowing` instance — it is likely already available at that scope since `runEventBridge` already holds a reference to the same narrowing instance.
- **Scope:** small — the change is mechanically straightforward (add constructor param, thread through, swap cast for call, delete JSDoc). The main risk is auditing that the call site already has a `TypedEventNarrowing` instance to supply; if not, it needs one constructed there.

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** high
- **Reasoning:** Verified at `main/src/services/panels/claude/claudeCodeManager.ts:343` (raw `as unknown as ClaudeStreamEvent` cast) and `main/src/orchestrator/runEventBridge.ts:209` (proper `narrowing.narrow(p.data)`); TASK-729 done report §Out-of-scope follow-up explicitly cued this, the `ClaudeCodeManager` constructor at line 119 has a clean injection point, and `narrow()`'s fail-soft `__unknown__` fallback makes the change risk-bounded for a load-bearing type-safety boundary on `raw_events` ingest.

---

### B2. Extract `usePanelSurface` hook to eliminate session+panel wiring duplication between CyboflowRoot and ProjectView
- **Summary:** `CyboflowRoot.tsx:38-114` and `ProjectView.tsx:31-160 + 256-277` contain ~90 lines of near-identical session-resolution and panel-store wiring that will diverge further with every future close-semantics or panel-lifecycle change.
- **Source-Sprint:** SPRINT-032
- **Source:** FIND-SPRINT-032-3 — surfaced by sprint-code-reviewer; confirmed by reading `CyboflowRoot.tsx:38-114` and `ProjectView.tsx:31-160 + 256-277`.
- **Problem:** TASK-693 correctly extracted the add-panel callbacks into shared hooks (`useAddTerminalPanel`, `useEnsureClaudePanel`) but the surrounding session+panel wiring was not abstracted. Both files now independently maintain:
  - `useState` for `mainRepoSessionId` + `mainRepoSession` + a `useEffect` to resolve them via `getOrCreateMainRepoSession`
  - A second `useEffect` calling `panelApi.loadPanelsForSession` then `setPanels`
  - A `useEffect` subscribing to `window.electronAPI.events.onPanelCreated`
  - `useMemo` for `sessionPanels` and `currentActivePanel`
  - `useCallback` for `handlePanelSelect` and `handlePanelClose`

  The implementations already diverge in meaningful ways: `ProjectView.handlePanelClose` (lines 128-160) has a permanence guard that blocks closing `dashboard`/`setup-tasks` panels and a dashboard-fallback branch; `CyboflowRoot.handlePanelClose` (lines 101-114) has neither because CyboflowRoot does not create permanent panels. This single intentional difference is now invisible — the next developer changing close semantics must manually find both implementations and decide per-file. Each new panel lifecycle hook (e.g., a `panel:updated` subscription, a drag-to-reorder handler) will need to land in both files independently.

  The divergence risk was flagged by the sprint-code-reviewer as invisible at per-task scope (both files were touched by TASK-693, but the reviewer only saw one at a time) — it only becomes visible at sprint scope.

- **Proposed direction:** Extract a `usePanelSurface(projectId: string | null, options: { autoCreatePermanentPanels: boolean })` hook in `frontend/src/hooks/usePanelSurface.ts`. The hook should encapsulate: main-repo session resolution state and effects, `loadPanelsForSession` effect, `panel:created` subscription, `sessionPanels` and `currentActivePanel` memos, and `handlePanelSelect` / `handlePanelClose` callbacks. The `autoCreatePermanentPanels` flag gates the dashboard/setup-tasks auto-creation logic and the permanence guard in `handlePanelClose` (true for `ProjectView`, false for `CyboflowRoot`). The hook's return shape should be `{ mainRepoSession, sessionPanels, currentActivePanel, handlePanelSelect, handlePanelClose }` — consumers then compose `handleAddTerminal` and `ensureClaudePanel` via the existing hooks as today. File as a Phase-3 follow-on for the `standalone-terminal-panels` epic (per FIND-SPRINT-032-3 suggested_action). Both call sites must end up consuming the hook — do not leave `ProjectView` on the old inline path.
- **Scope:** medium — the extraction is mechanical but `ProjectView`'s `loadPanelsForSession` effect is more complex (auto-creates dashboard/setup-tasks, determines initial active panel via `getActivePanel`), so the `autoCreatePermanentPanels=true` branch inside the hook needs careful porting. Unit tests for `usePanelSurface` should cover both flag values.

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** medium
- **Reasoning:** Duplication confirmed across `frontend/src/components/cyboflow/CyboflowRoot.tsx:42-114` and `frontend/src/components/ProjectView.tsx:31-160 + 207-277` (same `usePanelStore` destructure, same `loadPanelsForSession` effect, same `onPanelCreated` subscription, same `handlePanelSelect`/`handlePanelClose` shape) with one already-divergent permanence guard at `ProjectView.tsx:133` that `CyboflowRoot.tsx:101-114` intentionally omits, so the drift surface is real, not hypothetical; the proposed single hook with one boolean flag is proportional to the ~90-line duplication.
- **Counterfactual:** If `SessionView.tsx:77,125` (which also calls `loadPanelsForSession` + `onPanelCreated`) had been a near-clone too, the proposed two-call-site hook signature would be too narrow and verdict would flip to DONT_IMPLEMENT pending broader design — but SessionView's wiring is for `activeSession.id` not the main-repo flow, so the hook's `getOrCreateMainRepoSession`-keyed shape correctly excludes it.

---

## C. CLAUDE.md / CODE-PATTERNS.md improvements (apply now)

_No items._

---

## Reconciled Findings (informational)

No stale-open findings were claimed resolved by any done report — all three findings (`FIND-SPRINT-032-1`, `FIND-SPRINT-032-2`, `FIND-SPRINT-032-3`) had empty `resolved_by` fields and were not referenced in any `**Findings resolved:**` line in either done report. Triage proceeded normally.
