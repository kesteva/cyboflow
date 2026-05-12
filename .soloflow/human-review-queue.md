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
  action: "Export APPLE_ID, APPLE_TEAM_ID, APPLE_APP_SPECIFIC_PASSWORD, CSC_LINK, CSC_KEY_PASSWORD env vars and ensure TASK-053 has flipped package.json to signed posture; then re-run /soloflow:sprint TASK-055"
  blocked_checks:
    - "prerequisite: five signing env vars exported"
    - "prerequisite: package.json hardenedRuntime+notarize enabled (TASK-053)"
  level: ground_truth
  severity: high

- task: TASK-056
  type: action_required
  bucket: actions
  action: "Run TASK-055 first to produce the signed DMG; this task acceptance-tests the DMG. Re-run /soloflow:sprint TASK-056 after TASK-055 lands."
  blocked_checks:
    - "prerequisite: signed DMG artifact (TASK-055 output)"
  level: ground_truth
  severity: high

## Testing

_No items._

## Deferred Visual

_No items._
