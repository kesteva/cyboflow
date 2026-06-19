---
id: TASK-797
idea: braindump
status: ready
created: 2026-05-28T00:00:00Z
source: compound-B2-SPRINT-043
files_owned:
  - main/src/services/panels/claude/claudeCodeManager.ts
files_readonly:
  - docs/CODE-PATTERNS.md
acceptance_criteria:
  - criterion: "Definitive answer on whether SDK PreToolUse hook takes unconditional precedence over settings-file allow-lists"
    verification: "docs/CODE-PATTERNS.md or a comment in claudeCodeManager.ts documents the finding"
  - criterion: "If bypass is possible, either a surgical settingSources option is used or the trade-off is explicitly accepted with documentation"
    verification: "grep -n 'settingSources' main/src/services/panels/claude/claudeCodeManager.ts shows a comment explaining the decision"
depends_on: []
estimated_complexity: small
---

# Investigate whether settingSources ['user', 'project'] may bypass ApprovalRouter

## Objective

TASK-785 changed settingSources from ['project'] to ['user', 'project'] to load user-level MCP servers and custom instructions. The deleted comment warned this could let user-level tool allow-lists auto-approve tools before PreToolUse fires, bypassing ApprovalRouter. Determine whether this bypass is real by checking Claude Agent SDK docs/behavior, and document the finding.

## Investigation Steps

1. Check Claude Agent SDK documentation for PreToolUse hook priority vs settings-file allow-lists.
2. If bypass is real: investigate whether settingSources supports selective loading (e.g. MCP config only, not permission rules).
3. Document the finding in claudeCodeManager.ts and/or CODE-PATTERNS.md.
