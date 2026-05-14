---
sprint: SPRINT-008
pending_count: 0
last_updated: null
---

# Findings Queue

- override: gating-prereqs
  task: TASK-595
  reason: "Prereq probes at sprint-init are checking files that TASK-587/590/591/592/593 will produce within this sprint; TASK-595 depends_on TASK-591 + TASK-594 (DAG enforces ordering), and TASK-595's own plan step 1 re-runs the prereq checks at executor time. Gating now would defeat the sprint's terminal smoke step."
  applied_at: $(date -u +%Y-%m-%dT%H:%M:%SZ)
