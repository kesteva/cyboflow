---
sprint: SPRINT-005
pending_count: 1
last_updated: "2026-05-13T19:30:00Z"
---

# Findings Queue

## FIND-SPRINT-005-1
- **source:** TASK-151 (code-reviewer)
- **type:** cleanup
- **severity:** low
- **status:** open
- **location:** main/src/database/migrations/
- **description:** With the new file-based migration runner from TASK-151, every app boot now emits ~18 `console.warn` lines for legacy non-prefixed `.sql` files (`add_archived_field.sql`, `add_build_commands.sql`, `add_claude_session_id.sql`, etc.) that live in `main/src/database/migrations/` as historical documentation but are never executed (they predate the inline-migration era and have no corresponding hook). The warns are spec'd by the plan (AC #2 says "files without a matching numeric prefix are skipped (logged at WARN)") and the runner behaves correctly, but the resulting log noise is permanent and risks masking legitimate warnings about typos in real future cyboflow migrations.
- **suggested_action:** Either (a) move the 18 legacy non-prefixed `.sql` files into `main/src/database/migrations/legacy/` (a subdir the runner does not scan), or (b) demote the per-file warn to a single aggregated `console.debug` ("Skipped N non-numeric migration files: …") at the end of the directory scan. Option (a) is cleaner and matches the `@cyboflow-hidden` convention's intent (preserve but quarantine). Verify `copy:assets` still ships these files (or stop shipping them) before merging the move.
- **resolved_by:**
