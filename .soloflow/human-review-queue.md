---
pending_count: 2
buckets:
  decisions: 0
  actions: 2
  testing: 0
  deferred_visual: 0
items: []
---
# Human Review Queue

## Decisions

_No items._

## Actions

- task: TASK-055
  type: action_required
  bucket: actions
  action: "Export APPLE_ID, APPLE_TEAM_ID, APPLE_APP_SPECIFIC_PASSWORD, CSC_LINK, CSC_KEY_PASSWORD into the shell where /soloflow:sprint will run, then re-invoke /soloflow:sprint TASK-055. AC_PASSWORD keychain profile is already installed — these are the build-time env vars electron-builder reads via scripts/configure-build.js:18-25. See docs/signing/APPLE_DEVELOPER_SETUP.md (TASK-051) for the export incantation."
  blocked_checks:
    - "prerequisite: APPLE_ID/APPLE_TEAM_ID/APPLE_APP_SPECIFIC_PASSWORD/CSC_LINK/CSC_KEY_PASSWORD exported in shell"
  level: ground_truth
  severity: high

- task: TASK-056
  type: action_required
  bucket: actions
  action: "Run TASK-055 first to produce the signed DMG, then re-invoke /soloflow:sprint TASK-056."
  blocked_checks:
    - "prerequisite: signed DMG artifact (TASK-055 output)"
  level: ground_truth
  severity: high

## Testing

_No items._

## Deferred Visual

_No items._
