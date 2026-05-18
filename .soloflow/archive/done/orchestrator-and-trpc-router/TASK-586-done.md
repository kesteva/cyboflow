---
id: TASK-586
sprint: SPRINT-017
epic: orchestrator-and-trpc-router
status: done
summary: "Dropped unused eventBus from OrchestratorDeps; per-producer EventEmitter pattern documented in ARCHITECTURE.md"
executor_loops: 0
code_review_rounds: 0
visual_mobile: skipped_user_preference
visual_web: skipped_user_preference
---

Removed the placeholder eventBus field from OrchestratorDeps. Renamed StuckDetectorDeps.eventBus → emitter to satisfy the repo-wide sweep AC, with all 11 test fixtures updated. main/src/index.ts and Orchestrator.test.ts no longer thread the bus through; ARCHITECTURE.md §Orchestrator now lists the three remaining deps (db, logger, runQueues) and explains the per-producer emitter design with reference to SPRINT-006 findings.
