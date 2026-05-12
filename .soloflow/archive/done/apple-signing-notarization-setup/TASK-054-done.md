---
id: TASK-054
sprint: SPRINT-002
epic: apple-signing-notarization-setup
status: done
summary: "Refit build/afterSign.js to delegate notarization to electron-builder's built-in @electron/notarize hook (TASK-053's package.json flip enables it). Preserved JAR-strip logic and non-mac early return; replaced misleading credential-check log with explicit responsibility-split log line. Added build/afterSign.test.js plain-Node smoke test covering both branches."
executor_loops: 0
code_review_rounds: 0
visual_mobile: skipped_user_preference
visual_web: skipped_user_preference
---

# TASK-054 — Done

`build/afterSign.js` was previously a misleading 69-line script that logged a credential check but did nothing meaningful for notarization. It is now scoped strictly to its real responsibility: post-sign JAR cleanup under `@anthropic-ai/claude-code/vendor/`. Notarization is owned by electron-builder's built-in `@electron/notarize` integration (enabled by TASK-053's `build.mac.notarize` config). The new top-of-file JSDoc and the explicit log line `AfterSign: notarization is handled by electron-builder built-in hook; this script only performs post-sign cleanup` make the responsibility split visible in build output.

`build/afterSign.test.js` is a plain-Node smoke test (no framework) with two cases:
- Case A: non-mac context resolves without throwing and without removing files.
- Case B: mac context with synthetic vendor tree containing `foo.jar` and `sub/bar.jar` — both removed after invocation.
Uses `fs.mkdtempSync` for isolation; cleans up in `finally`. Run as `node build/afterSign.test.js` — exit 0 on success.

The test file is intentionally NOT auto-run by `pnpm test` (which is Playwright-only). Per plan step 4, TASK-055's Implementation Steps will call `node build/afterSign.test.js` as a pre-flight before the first signed build.

All 5 acceptance_criteria pass: JAR-strip preserved (8 grep matches, fs.unlinkSync at line 71), no notarytool/@electron/notarize/notarize() calls, clarity log present, "No signing credentials" log preserved without notariz mention, non-mac early return exits 0.

Commit: 82dfed4 feat(TASK-054): refit afterSign.js with clarity log and add smoke test
