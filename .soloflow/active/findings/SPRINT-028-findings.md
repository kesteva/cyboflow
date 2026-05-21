---
sprint: SPRINT-028
pending_count: 0
last_updated: null
---

# Findings Queue

- SPRINT-028 started with missing infra: playwright, peekaboo; tests deferred. Sprint-initiator infra_check reports "shadow agents stale" but Step 0.45 shadow-agents.js --mode check returned drifted:false (recorded_version 0.11.0 across all four). Probe disagreement looks like a SoloFlow inconsistency between scripts/sprint/initiator infra probe and scripts/init/shadow-agents.js drift check — worth investigating during /compound (FIND-SPRINT-028-1).
