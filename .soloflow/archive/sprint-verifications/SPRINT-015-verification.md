---
sprint: SPRINT-015
visual_mobile: skipped_user_preference
visual_web: skipped_unable
visual_macos: skipped_user_preference
visual_mobile_note: "verification.visual_mobile=false"
visual_web_note: "Playwright MCP cannot drive Electron renderer (chromium-only); renderer cannot bootstrap standalone at http://localhost:4521. Queued as config_gap."
visual_macos_note: "verification.visual_macos=false"
regressions_count: 0
flows_tested: 0
flows_deferred: 0
---

## Visual Verification

### Platform classifications
- visual_mobile: skipped_user_preference — config disabled
- visual_web: skipped_unable — Playwright MCP only drives Chromium; the cyboflow Electron renderer at http://localhost:4521 cannot bootstrap standalone (depends on preload-injected electronTRPC per CLAUDE.md). Dev server was not running at verification time, and the playwright_target.kind=electron path is not addressable from MCP-driven Playwright. Queued as `visual_web_electron_unreachable` config_gap (severity: low) for the operator to either disable visual_web for this repo or add a CDP-attach launcher.
- visual_macos: skipped_user_preference — config disabled

### Sprint-changed UI surface (no flows exercised)
TASK-630 cascaded `IPCResponse<T=any>` → `<T=unknown>` through 22 UI files. Changes are type-narrowing only; no runtime/visual behavior change is expected, and the project type-checks under the new contract. UI files touched in the cascade:
- frontend/src/components/DiscordPopup.tsx
- frontend/src/components/DraggableProjectTreeView.tsx
- frontend/src/components/ProjectDashboard.tsx
- frontend/src/components/ProjectTreeView.tsx
- frontend/src/components/ProjectView.tsx
- frontend/src/components/PromptHistory.tsx, PromptHistoryModal.tsx
- frontend/src/components/StravuConnection.tsx, StravuFileSearch.tsx, StravuStatusIndicator.tsx
- frontend/src/components/cyboflow/WorkflowPicker.tsx
- frontend/src/components/panels/ai/MessagesView.tsx, RichOutputView.tsx
- frontend/src/components/panels/claude/PromptNavigation.tsx, SessionStats.tsx
- frontend/src/components/panels/diff/CombinedDiffView.tsx
- frontend/src/hooks/useClaudePanel.ts, useSessionView.ts
- frontend/src/utils/api.ts, cyboflowApi.ts
- frontend/src/types/electron.d.ts, config.ts

### Regressions
None observable via visual verification (channel unavailable). Integration suite covers these cascades via the new type-contract regression tests added in TASK-630 plus the broader typecheck/lint/unit gate.
