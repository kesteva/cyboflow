---
id: TASK-503
sprint: SPRINT-013
epic: stuck-detection-and-observability
status: done
summary: "Add useStuckNotifications hook with per-session suppression, gated by notifications.enabled config, mounted once from App.tsx; fires Run Stuck ⚠️ macOS notification on first stuck event per session."
executor_loops: 0
code_review_rounds: 0
visual_mobile: skipped_user_preference
visual_web: skipped_user_preference
---

# TASK-503 — First-stuck-per-session notification

Delivered:

- `frontend/src/hooks/useStuckNotifications.ts` — subscribes to `cyboflow.events.onStuckDetected`, holds suppression set in a `useRef<Set<string>>` keyed on `sessionId`, gates firing on `notifications.enabled`, fires `new Notification('Run Stuck ⚠️', ...)` with human-readable reason text. Suppression is intentionally in-memory only (no `localStorage`/`sessionStorage`) so a fresh app launch fires once per session.
- `frontend/src/hooks/__tests__/useStuckNotifications.test.ts` — 6 unit tests (first-fire, same-session suppression, different-session re-fire, remount reset, disabled-config gate, title/body format check).
- `frontend/src/App.tsx` — added single `useStuckNotifications()` call alongside the existing `useNotifications()` call.

Existing FIND-SPRINT-013-2 documents the forward-looking tRPC cast through `unknown` to a local `StuckEventsClient` interface (the `cyboflow.events.onStuckDetected` router type does not yet exist; TASK-254 will formalize it).

Verifier APPROVED; code-reviewer: CLEAN with category-level nits; test-writer: NO_TESTS_NEEDED.
