---
id: TASK-556
idea: IDEA-012
idea_id: IDEA-012
status: in-flight
created: "2026-05-11T00:00:00Z"
files_owned:
  - README.md
  - docs/PROVENANCE.md
files_readonly:
  - LICENSE
  - docs/crystal-legacy/LICENSE-COMPATIBILITY.md
acceptance_criteria:
  - criterion: "README.md no longer contains the Nimbalyst deprecation banner or any 'Crystal Is Now Nimbalyst' headline."
    verification: "grep -in 'Crystal Is Now Nimbalyst' README.md returns no matches; grep -in 'nimbalyst.com' README.md returns no matches outside of the explicit 'do not merge from Nimbalyst' rule line."
  - criterion: "README.md contains a clear top-level introduction to Cyboflow: a one-paragraph product summary mentioning 'cross-workflow review queue', 'Claude Code', 'macOS', 'SoloFlow workflows'."
    verification: "grep -in 'cross-workflow review queue' README.md returns one match; grep -in 'Claude Code' README.md returns at least one match; grep -in 'SoloFlow workflows' README.md returns one match."
  - criterion: "README.md pins the exact Crystal HEAD commit hash this fork started from, formatted as a 40-character hex SHA in a clearly labeled 'Provenance' or 'Forked from' section."
    verification: "grep -nE '7a5ee42[0-9a-f]+|[0-9a-f]{40}' README.md returns at least one match in a section heading or sentence referencing 'Crystal' and 'fork'. The commit hash matches `git log --all --pretty=format:%H | grep <hash>` (i.e., it is a real commit in this repo's history). Cyboflow forked at commit 7a5ee42 per git log."
  - criterion: "README.md explicitly documents the license posture: 'Cyboflow is licensed under the MIT License' AND 'Do not merge from Nimbalyst' rule with a one-line rationale about AGPL contamination risk."
    verification: "grep -in 'MIT License' README.md returns at least one match. grep -in 'do not merge from Nimbalyst' README.md returns one match (case-insensitive). grep -in 'AGPL' README.md returns one match."
  - criterion: "A docs/PROVENANCE.md file exists with: the Crystal upstream URL, the fork commit hash, the fork date, and a copy of the 'do not merge from Nimbalyst' rule with rationale."
    verification: "test -f docs/PROVENANCE.md; grep -nE '[0-9a-f]{40}' docs/PROVENANCE.md returns at least one match; grep -in 'stravu/crystal' docs/PROVENANCE.md returns one match; grep -in 'do not merge from Nimbalyst' docs/PROVENANCE.md returns one match."
  - criterion: "README.md contains a 'Quick Start' or 'Installation' section pointing to the v1.0.0 signed DMG from the GitHub release page (or, if no release exists at write time, a placeholder labeled '<v1.0.0 release link — populated at release time>')."
    verification: "grep -in 'Quick Start\\|Installation' README.md returns one match in a heading."
depends_on: []
estimated_complexity: low
epic: first-run-onboarding-and-self-host-acceptance
test_strategy:
  needed: false
  justification: Documentation file. The AC verifications (greps and file presence) are sufficient — no behavior to unit-test.
---
# README and License Provenance — Crystal Commit Tag and MIT/Do-Not-Merge-From-Nimbalyst Rule

## Objective

Replace the inherited Nimbalyst deprecation README with a Cyboflow-native README. Pin the exact Crystal HEAD commit hash this repository forked from so future maintainers can audit the upstream lineage. Document the license posture explicitly: Cyboflow is pure MIT (inherited from Crystal pre-Nimbalyst-rename), and there is an explicit "do not merge from Nimbalyst" rule because the rename coincided with a license shift (Nimbalyst is not MIT-compatible — AGPL contamination risk). This is a one-shot housekeeping task closing the provenance gap before v1.0.0 ships.

## Implementation Steps

1. Resolve the fork commit hash: the project's initial commit is `7a5ee427a5ee427a5ee42 7a5ee42 fork stravu/crystal at HEAD as cyboflow baseline` per the git status snapshot. Run `git log --reverse --pretty=format:'%H %s' | head -5` to confirm the exact 40-char SHA at fork time. The user-supplied snapshot shows `7a5ee42` as the abbreviated hash for the fork-baseline commit — use the full SHA in the README. (Step 1 of Implementation is this resolution; the executor must capture the full SHA before drafting.)

2. Rewrite `README.md` from scratch. Suggested structure:
   ```
   # Cyboflow

   Cyboflow is a macOS desktop app that concentrates tool-use approvals from parallel
   Claude Code SoloFlow workflows into a single keyboard-driven cross-workflow review
   queue.

   ## What it does

   <2-3 paragraphs — pulled from ROADMAP-001 brief vision section, paraphrased>

   ## Quick Start

   <Download Cyboflow-1.0.0-macOS-universal.dmg from the GitHub Releases page.
   Drag the app to /Applications. On first launch, add a project (any git repo)
   and pick a SoloFlow workflow.>

   ## Provenance

   Cyboflow is a fork of [stravu/crystal](https://github.com/stravu/crystal)
   pinned at commit `<full 40-char SHA>`. Crystal provides 6 of Cyboflow's 8 required
   primitives (PTY, worktrees, SQLite, packaging, permission bridge, zombie detection)
   in production-tested form. Cyboflow adds the cross-workflow review queue, the
   typed stream parser, and the CyboflowMcpServer outbound bridge.

   See [docs/PROVENANCE.md](docs/PROVENANCE.md) for the full lineage.

   ## License

   Cyboflow is licensed under the MIT License (see [LICENSE](LICENSE)). This
   inherits Crystal's pre-Nimbalyst-rename MIT posture.

   ### Do not merge from Nimbalyst

   Crystal was renamed to Nimbalyst in early 2026. The rename coincided with a
   license/scope shift; Nimbalyst is a different product on a different license
   footing and merging changes from the Nimbalyst codebase risks AGPL or other
   non-MIT contamination of this codebase. **Do not** apply patches, cherry-picks,
   or merges from the Nimbalyst repository (https://github.com/Nimbalyst/nimbalyst).
   If a bug surfaces in Cyboflow that was independently fixed in Nimbalyst,
   reproduce the fix from first principles or from Cyboflow-side analysis.

   ## Development

   See [CLAUDE.md](CLAUDE.md) for the codebase tour and [.soloflow/](.soloflow/)
   for the active roadmap, ideas, and plans.
   ```

3. Create `docs/PROVENANCE.md`:
   ```
   # Cyboflow Provenance

   ## Fork

   - Upstream: https://github.com/stravu/crystal
   - Fork commit: <full 40-char SHA>
   - Fork date: <commit date of the 7a5ee42 commit>
   - Cyboflow first commit message: "chore: fork stravu/crystal at HEAD as cyboflow baseline"

   ## License

   Cyboflow is MIT-licensed, inheriting Crystal's pre-Nimbalyst MIT posture.
   See [/LICENSE](/LICENSE) for the canonical text. License compatibility notes
   for inherited dependencies are tracked in [/docs/crystal-legacy/LICENSE-COMPATIBILITY.md](/docs/crystal-legacy/LICENSE-COMPATIBILITY.md).

   ## Do not merge from Nimbalyst

   Crystal was deprecated in February 2026 and replaced by Nimbalyst. Nimbalyst is
   a separate product on a separate license footing; merging changes from
   Nimbalyst into Cyboflow risks license contamination (AGPL or other non-MIT
   constraints). The rule is absolute: do not cherry-pick, rebase, or apply
   patches from https://github.com/Nimbalyst/nimbalyst into this repository.
   If a fix is needed that Nimbalyst happens to have implemented, reproduce the
   fix from first principles on the Cyboflow side.

   ## Author

   <author info>

   ## Verifying the fork point

   git log <fork-commit-sha> --pretty=fuller
   ```

4. Do not modify `LICENSE` (already MIT, inherited from Crystal). Do not modify `docs/crystal-legacy/LICENSE-COMPATIBILITY.md` — it documents inherited-dep compatibility and is correct as-is.

5. After writing both files, run `grep -in 'Crystal Is Now Nimbalyst\|nimbalyst-logo' README.md` — must return 0 matches (the deprecation banner is fully gone).

## Acceptance Criteria

See frontmatter. The Crystal HEAD commit hash, the MIT statement, and the do-not-merge-from-Nimbalyst rule are all mandatory.

## Test Strategy

No tests. Documentation file. The greps in the AC are the verification.

## Hardest Decision

Whether to put the "do not merge from Nimbalyst" rule in README or only in PROVENANCE.md. Picked: BOTH places. Rationale: the README is what GitHub renders on the repo's front page — a maintainer skimming a future PR titled "Backport fix X from Nimbalyst" needs to bounce off the rule at the README level, not deep in a docs subfolder. PROVENANCE.md duplicates the rule for the dedicated provenance audit case. Slight redundancy is the right cost.

## Rejected Alternatives

- Inline a CONTRIBUTING.md with the rule. Rejected — adds a third file. README + PROVENANCE.md is sufficient surface area; if a contributor flow later needs more structure, CONTRIBUTING.md can be added then.
- Embed the rule as a code comment in the build config. Rejected — the rule is about humans choosing whether to merge upstream, not about runtime behavior.

## Lowest Confidence Area

Whether AGPL is actually the license Nimbalyst shifted to versus a different non-MIT license. The risks research and IDEA file both phrase the rule as "AGPL contamination risk" without primary-source verification. If, on inspection, Nimbalyst is actually MIT-or-Apache-compatible, the rule remains correct (the deeper reason is "different product, different lineage, do not blend") but the rationale wording should soften from "AGPL contamination risk" to "license-and-scope-divergence risk". The executor should optionally spot-check the Nimbalyst repo license at write time; if AGPL is confirmed, keep the wording verbatim.
