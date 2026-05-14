---
sprint: SPRINT-006
pending_count: 1
last_updated: "2026-05-13T19:05:00Z"
---

# Findings Queue

## FIND-SPRINT-006-1
- **source:** TASK-251 (code-reviewer)
- **type:** bug
- **severity:** low
- **status:** open
- **location:** package.json:54-70 (root `dependencies`) vs main/package.json:18-35
- **description:** `electron-store@^11.0.0` is declared in `main/package.json` but not in the root `package.json`. The TASK-251 plan's own rationale (Implementation Step 3) states "The root list is what electron-builder reads when assembling `node_modules/**/*` into the asar; missing the root list means the packaged app will throw at first `require('trpc-electron')`". By that same rationale, packaged builds may also be missing `electron-store` at runtime in the main process. This pre-dates TASK-251 (not introduced by this commit) but was surfaced while reviewing the parity logic just added for trpc-electron/p-queue/superjson.
- **suggested_action:** Verify in a packaged build whether `require('electron-store')` resolves; if it does, document why (electron-builder's `npmRebuild`/`buildDependenciesFromSource` interaction may already pull workspace deps), and either remove the parity-claim from future task plans or add electron-store to root for consistency. If it doesn't resolve, add `"electron-store": "^11.0.0"` to root dependencies.
- **resolved_by:**
