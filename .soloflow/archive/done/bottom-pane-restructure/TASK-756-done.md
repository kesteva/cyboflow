---
id: TASK-756
sprint: SPRINT-039
epic: bottom-pane-restructure
status: done
summary: "Added RunBottomPane three-tab shell (Chat / Terminal / Data Stream) and swapped CyboflowRoot to mount it instead of RunView directly; Data Stream defaults and renders existing RunView verbatim."
executor_loops: 0
code_review_rounds: 0
visual_mobile: not_applicable
visual_web: skipped_unable
---

# TASK-756 — RunBottomPane three-tab shell

## Outcome

`frontend/src/components/cyboflow/RunBottomPane.tsx` (new) exports a `RunBottomPane` React component with three tabs (Chat, Terminal, Data Stream). Data Stream is the default and mounts `<RunView />` verbatim. Terminal and Chat are inline-JSX placeholders; `RunChatView.tsx` is intentionally NOT created (deferred to TASK-761). `CyboflowRoot.tsx` swapped its `<RunView />` mount for `<RunBottomPane />`; the `RunView` import was removed.

Tab state is local React `useState<TabId>('data-stream')`; `cyboflowStore` is unchanged. `LocalTabBar` is a ~30-line private sub-component using existing Tailwind design tokens with WAI-ARIA tablist/tab/aria-selected semantics.

## Verification

- Acceptance criteria 1–9: all met (verifier APPROVED_WITH_DEFERRED).
- Unit tests: 43/43 pass — RunBottomPane.test.tsx (5/5 new), CyboflowRoot.test.tsx (12/12 unchanged), RunView.test.tsx (26/26 unchanged regression).
- Typecheck and lint: both exit 0.
- Visual web: skipped_unable (renderer cannot bootstrap standalone in this repo — documented Electron-preload requirement).
- Visual macOS: skipped_unable (Peekaboo MCP Accessibility grant missing — recurring TCC gap; queued under `visual_macos_unavailable`).

## Notes

- Stale comment at `CyboflowRoot.tsx:6` still references "RunView" — low severity, intentionally not edited here (out of AC verification regex scope). Worth a sweep in any later task touching that file.
- FIND-SPRINT-039-1 was logged by the verifier proposing a `docs/VISUAL-VERIFICATION-SETUP.md` improvement around the Peekaboo Accessibility grant requirement.

## Commit

- `ff229e6` — feat(TASK-756): add RunBottomPane three-tab shell (Data Stream / Terminal stub / Chat placeholder)
