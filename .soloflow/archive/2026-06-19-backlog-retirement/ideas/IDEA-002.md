---
id: IDEA-002
type: FEATURE
status: draft
created: 2026-05-11T00:00:00Z
roadmap: ROADMAP-001
roadmap_phase: "Phase 1 — Orchestrator Foundation"
roadmap_epic: "apple-signing-notarization-setup"
slices:
  - title: "Apple Developer Program enrollment and Developer ID cert"
    description: "Enroll in / verify Apple Developer Program membership ($99/yr). Create Developer ID Application certificate via Xcode or Apple Developer portal. 24-48h identity verification lag."
    value_statement: "Unblocks the entire signing/notarization pipeline; prereq for everything else in the epic"
  - title: "Flip hardenedRuntime and notarize flags"
    description: "Change electron-builder config in package.json: hardenedRuntime: true, notarize: true. Currently both are false (Crystal's dev shortcut)."
    value_statement: "Enables the notarization pipeline to even attempt to run"
  - title: "Author entitlements.mac.plist"
    description: "Create build/entitlements.mac.plist with: com.apple.security.cs.allow-jit (Electron JIT), com.apple.security.network.client (API calls), com.apple.security.files.user-selected.read-write (project dirs), com.apple.security.cs.allow-unsigned-executable-memory (node-pty subprocess)."
    value_statement: "Hardened runtime + node-pty compatibility without runtime crashes"
  - title: "Replace afterSign.js with notarytool call"
    description: "Current afterSign.js only strips JAR files. Replace with xcrun notarytool submit using keychain-stored credentials (xcrun notarytool store-credentials AC_PASSWORD). altool is decommissioned."
    value_statement: "Automated notarization on every signed build"
  - title: "First signed universal DMG end-to-end verification"
    description: "Produce signed + notarized universal DMG. Verify with lipo -info on bundled .node binaries (better-sqlite3, node-pty). Test on clean macOS user account that Gatekeeper accepts without warning."
    value_statement: "Proves the signing pipeline works before week 2 deadline; eliminates packaging-cliff risk"
open_questions:
  - "Does the Apple Developer Program membership already exist? If not, +24-48h to schedule."
assumptions:
  - "Hardened runtime + node-pty subprocess spawn works with the allow-unsigned-executable-memory entitlement (research-supported but not yet tested in Cyboflow)."
research_recommendation: not_needed
research_rationale: "Risks research dimensioned the time costs (5-30min notarization round-trip, debug iteration cost). The known pitfalls are documented and the entitlements needed are well-understood."
---

# Apple Signing and Notarization Setup

## Raw Input

Generated from ROADMAP-001, Phase "Phase 1 — Orchestrator Foundation", Epic "apple-signing-notarization-setup".

## Grounding

See roadmap research reports:
- .soloflow/active/research/ROADMAP-001-research-ecosystem.md
- .soloflow/active/research/ROADMAP-001-research-user-needs.md
- .soloflow/active/research/ROADMAP-001-research-architecture.md
- .soloflow/active/research/ROADMAP-001-research-risks.md

Risks research (§2) detailed: current `package.json` ships `hardenedRuntime: false, notarize: false` (Crystal's dev shortcut). Apple Developer enrollment is 24-48h. Notarization is 5-30 min per submission. altool is dead, notarytool required.

## Slices

See frontmatter `slices` field. The five slices reflect: (1) Apple enrollment + cert, (2) config flag flips, (3) entitlements file, (4) afterSign hook replacement, (5) end-to-end signed DMG verification.

## Open Questions

- Apple Developer Program membership status — needs confirmation. If not enrolled, +24-48h before first signed build attempt.

## Assumptions

- node-pty subprocess spawn works under hardened runtime with `allow-unsigned-executable-memory` entitlement. Research-supported but Cyboflow-specific verification still required.
