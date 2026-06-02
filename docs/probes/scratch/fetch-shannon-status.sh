#!/usr/bin/env bash
# IDEA-013 Probe D (TASK-805) — re-check Shannon's bidirectional permission-gating bridge status.
# THROWAWAY. Confirms Q1 (roll-our-own vs adopt Shannon). Needs network.
set -uo pipefail

REPO="dexhorthy/shannon"
BRANCH="${SHANNON_BRANCH:-main}"
BASE="https://raw.githubusercontent.com/${REPO}/${BRANCH}"

echo "== Shannon status probe (${REPO}@${BRANCH}) =="
echo "Looking for: bidirectional permission-gating bridge -> Planned vs Implemented; Bun/tmux runtime deps."
echo

fetch() {
  local path="$1"
  echo "--- ${path} ---"
  if curl -fsSL "${BASE}/${path}" 2>/dev/null | \
     grep -niE 'bridge|permission|bun|tmux|planned|implemented|in progress|stdio|oRPC|unix socket' ; then
    :
  else
    echo "(no matching lines, or file not found at ${BASE}/${path})"
  fi
  echo
}

fetch "GOAL_PROGRESS.md"
fetch "README.md"
fetch "docs/GOAL_PROGRESS.md"

cat <<'EOF'
Manual fallback if the paths above moved:
  open https://github.com/dexhorthy/shannon  (read GOAL_PROGRESS.md / README / recent commits)
Record in ../IDEA-013-probe-findings.md (Probe D):
  - bidirectional bridge: Planned | Implemented (cite file + line/date)
  - runtime deps still Bun + tmux? (yes/no)
  - @dexh/shannon-agent-sdk: Node/Electron build available? (yes/no)
  => Q1 resolution (expected: ROLL-OUR-OWN behind the swappable TranscriptSource seam).
EOF
