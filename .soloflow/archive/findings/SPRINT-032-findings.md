---
sprint: SPRINT-032
pending_count: 3
last_updated: "2026-05-22T20:37:33.649Z"
---
# Findings Queue

## FIND-SPRINT-032-1
- **source:** TASK-693 (code-reviewer)
- **type:** cleanup
- **severity:** low
- **status:** open
- **location:** frontend/src/hooks/useEnsureClaudePanel.ts:73
- **description:** The `useCallback` deps are `[session?.id, addPanel, setActivePanelInStore, logTag]` with a trailing `// eslint-disable-line react-hooks/exhaustive-deps`. The sibling `useAddTerminalPanel.ts:53` uses `[session, addPanel, setActivePanelInStore, onAfterActivate, logTag]` (whole session object, no eslint-disable) and passes lint cleanly. Functionally both are correct because the callback only reads `session.id` and Zustand actions are stable references, but the disable here is gratuitous — it diverges from the sibling-hook precedent the rest of this file mirrors and tells the linter to stop checking a rule that would actually pass if the deps were written as `[session, ...]`.
- **suggested_action:** Change deps to `[session, addPanel, setActivePanelInStore, logTag]` and drop the eslint-disable comment, matching `useAddTerminalPanel.ts`.
- **resolved_by:** 

## FIND-SPRINT-032-2
- **source:** SPRINT-032 (sprint-code-reviewer)
- **type:** improvement
- **severity:** medium
- **status:** open
- **location:** main/src/services/panels/claude/claudeCodeManager.ts:343
- **description:** claudeCodeManager.runSdkQuery emits each SDK event into the EventRouter via a raw cast that bypasses TypedEventNarrowing.narrow(), while the parallel renderer-side path in main/src/orchestrator/runEventBridge.ts:209 uses narrowing.narrow(p.data) to produce a validated ClaudeStreamEvent before calling router.emitForRun. After TASK-729 grew the streamEventSchema delta union (signature_delta/thinking_delta + signature/thinking carriers), the gap is now load-bearing: any new SDK content_block_delta variant that the Zod schema does not yet accept will land in raw_events (via RawEventsSink, which subscribes to the router) without being normalized to __unknown__ — exactly the failure mode TASK-729 was filed to prevent. The router output is also typed ClaudeStreamEvent, so future consumers will TS-trust a shape that was never validated.
- **suggested_action:** Inject a TypedEventNarrowing into ClaudeCodeManager (constructor or via the EventRouter-owning service) and call narrowing.narrow(event) inside the for-await loop in runSdkQuery before router.emitForRun. The narrow() call is fail-soft (returns an unknown-variant on Zod failure) so it cannot break the SDK loop, and it consolidates the two emit paths onto a single validated boundary. Once converged, remove the `as unknown as ClaudeStreamEvent` cast and the JSDoc note at lines 338-341 that justifies it.
- **resolved_by:** 


Evidence:
  main/src/services/panels/claude/claudeCodeManager.ts:343
    router.emitForRun(runId, event as unknown as ClaudeStreamEvent);
  main/src/orchestrator/runEventBridge.ts:209
    typed = narrowing.narrow(p.data);
    ...
    router.emitForRun(runId, typed);

Suspected tasks: TASK-729

## FIND-SPRINT-032-3
- **source:** SPRINT-032 (sprint-code-reviewer)
- **type:** improvement
- **severity:** medium
- **status:** open
- **location:** frontend/src/components/cyboflow/CyboflowRoot.tsx:38-114
- **description:** TASK-693 added ~90 lines of panel-surface infrastructure to CyboflowRoot that near-perfectly duplicate ProjectView.tsx:31-160 + 256-277 — same main-repo session resolution state, same loadPanelsForSession effect, same panel:created event subscription, same handlePanelSelect/handlePanelClose memos, same sessionPanels/currentActivePanel useMemos, same usePanelStore destructure. The Add-Terminal / Add-Claude callbacks were correctly extracted into shared hooks (useAddTerminalPanel, useEnsureClaudePanel) but the surrounding session+panel wiring was not. Per-task reviewer could not see this because it spans two files owned by the same task — only at sprint scope is the divergence risk visible: ProjectViews handlePanelClose has a dashboard-fallback branch (line 144) and a permanent-panel guard (line 133) that CyboflowRoot intentionally omits, so the next change to the close semantics will need to be made twice and the implementations will drift further apart.

Evidence:
  CyboflowRoot.tsx:42  const { panels, activePanels, setPanels, setActivePanel: setActivePanelInStore, addPanel, removePanel } = usePanelStore();
  ProjectView.tsx:36-43 const { panels, activePanels, setPanels, setActivePanel: setActivePanelInStore, addPanel, removePanel } = usePanelStore();
  CyboflowRoot.tsx:67-73 + ProjectView.tsx:46-105  loadPanelsForSession then setPanels
  CyboflowRoot.tsx:75-83 + ProjectView.tsx:256-277  onPanelCreated subscription
  CyboflowRoot.tsx:85-93 + ProjectView.tsx:108-116  sessionPanels + currentActivePanel memos
  CyboflowRoot.tsx:95-114 + ProjectView.tsx:119-160  handlePanelSelect + handlePanelClose

Suspected tasks: TASK-693
- **suggested_action:** Extract the duplicated wiring into a shared hook usePanelSurface(projectId, { autoCreatePermanentPanels: boolean }) -> { mainRepoSession, sessionPanels, currentActivePanel, handlePanelSelect, handlePanelClose, handleAddTerminal, ensureClaudePanel }. The autoCreatePermanentPanels flag toggles ProjectViews dashboard/setup-tasks creation + permanence guard on; CyboflowRoot passes false. Both call sites then become a single useHook + a JSX render, eliminating the drift surface. File as Phase-3 follow-on for the standalone-terminal-panels epic.
- **resolved_by:** 
