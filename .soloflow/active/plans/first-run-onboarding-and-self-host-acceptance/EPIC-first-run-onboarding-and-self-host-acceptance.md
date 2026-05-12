---
epic: first-run-onboarding-and-self-host-acceptance
created: 2026-05-11T00:00:00Z
status: active
originating_ideas: [IDEA-012]
---

# First-Run Onboarding and Self-Host Acceptance

## Objective

Polish first-run user experience, execute the 1-day self-host acceptance bar (the explicit MVP-done gate), and produce the signed and notarized v1.0.0 DMG. This is the final acceptance epic of Cyboflow's MVP: a successful epic-close means the product is shippable and the user has used it for at least one full working day without falling back to Crystal or raw Claude CLI.

## Scope

- In scope:
  - One-shot dismissable first-run onboarding card inside the review queue explaining what pauses Claude and the j/k/y/n keyboard model
  - Auto-write `.cyboflow/worktrees/` to a project's `.gitignore` at project creation (no manual setup step)
  - MCP server health surfaced as a green/yellow/red dot in a persistent app status bar, with click-to-open diagnostics
  - The 1-day self-host acceptance run itself: a manual full-working-day test using Cyboflow exclusively, logged as `SELF-HOST-LOG.md` with every fallback triaged as fix-same-day or defer-to-ROADMAP-002
  - Version bump to 1.0.0; sign + notarize + staple the universal DMG; verify on a clean macOS user account; capture evidence in `DMG-VERIFICATION.md`
  - Rewrite README.md as Cyboflow-native, pin the Crystal HEAD fork commit hash, document the pure-MIT license posture and the explicit "do not merge from Nimbalyst" rule (with a backing `docs/PROVENANCE.md`)

- Out of scope:
  - Any new product feature outside the four enumerated polish items (onboarding card, .gitignore writer, MCP indicator, status bar)
  - Code changes to the MCP subprocess or its emission channel (owned by epic `cyboflow-mcp-server`)
  - Code changes to the signing/notarization pipeline itself (owned by epic `apple-signing-notarization-setup`)
  - Auto-update via electron-updater (explicit v1 cut)
  - Same-day re-runs of the self-host if a fix-same-day occurs — that triggers a re-run on a separate day, not a continuation
  - Documentation of inherited Crystal subsystems beyond the provenance pointer

## Success Signal

The user runs Cyboflow as their only Claude Code invocation surface for one full working day, the SELF-HOST-LOG.md verdict is PASS or PASS-WITH-DEFERS, the signed DMG installs cleanly on a fresh macOS user account without Gatekeeper warnings, and the README now welcomes Cyboflow users (not Nimbalyst migrants) with a clearly pinned Crystal commit hash and an explicit do-not-merge-from-Nimbalyst rule. v1.0.0 is shippable.
