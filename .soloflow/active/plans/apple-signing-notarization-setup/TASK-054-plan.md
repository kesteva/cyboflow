---
id: TASK-054
idea: IDEA-002
status: in-flight
created: "2026-05-11T00:00:00Z"
files_owned:
  - build/afterSign.js
files_readonly:
  - package.json
  - scripts/configure-build.js
  - .github/workflows/build.yml
  - .soloflow/active/ideas/IDEA-002.md
  - .soloflow/active/research/ROADMAP-001-research-risks.md
acceptance_criteria:
  - criterion: "`build/afterSign.js` retains JAR-stripping behavior (deleting JARs under @anthropic-ai/claude-code/vendor/) — this is functional and orthogonal to notarization"
    verification: "`grep -n 'JAR\\|\\.jar' build/afterSign.js` returns at least one match within a function that performs `fs.unlinkSync`"
  - criterion: "`build/afterSign.js` does NOT attempt to invoke `xcrun notarytool` itself — notarization is delegated to electron-builder's built-in notarize hook (which calls @electron/notarize internally when build.mac.notarize is set)"
    verification: "`grep -n 'notarytool\\|@electron/notarize\\|notarize(' build/afterSign.js` returns no matches"
  - criterion: "`build/afterSign.js` logs the intent clearly: 'AfterSign: notarization is handled by electron-builder's built-in hook; this script only performs post-sign cleanup'"
    verification: "`grep -n 'notarization is handled by electron-builder' build/afterSign.js` returns a match"
  - criterion: "The legacy 'No signing credentials found' early-log path is preserved (still useful for debugging dev builds), but it no longer claims responsibility for skipping notarization"
    verification: "`grep -n 'No signing credentials' build/afterSign.js` returns a match, AND the surrounding log line does not mention 'notariz' (case-insensitive)"
  - criterion: afterSign.js exits cleanly (returns/awaits with no thrown error) on a non-mac platform (Linux/Windows CI runners that also load this hook)
    verification: "Run `node -e \"const f=require('./build/afterSign.js').default; f({appOutDir:'/tmp', packager:{platform:{name:'linux'}, appInfo:{productName:'X'}}}).then(()=>process.exit(0)).catch(()=>process.exit(1))\"` exits 0"
depends_on:
  - TASK-053
estimated_complexity: low
epic: apple-signing-notarization-setup
test_strategy:
  needed: true
  justification: "afterSign.js runs at packaging time inside electron-builder; we cannot exercise it in a normal unit test, but we can write a Node-driven smoke test that invokes the exported function with a synthetic context and asserts the JAR-removal + early-exit branches behave correctly."
  targets:
    - behavior: afterSign returns early on non-mac platforms without throwing
      test_file: build/afterSign.test.js
      type: integration
    - behavior: afterSign removes JAR files under a fake vendor directory when given a mac context
      test_file: build/afterSign.test.js
      type: integration
---
# Refit afterSign.js: keep JAR strip, delegate notarization to electron-builder

## Objective

IDEA-002 slice 4 says "Replace afterSign.js with a notarytool call". The cleaner v1 path — and the one consistent with electron-builder v26's modern hook surface — is to **delegate notarization to electron-builder's built-in `notarize` config** (already enabled by TASK-053) and **keep `afterSign.js` scoped to its real responsibility: JAR stripping**. This task refits the file's documentation and log lines to match the new responsibility split, adds a smoke-test, and explicitly leaves notarytool out of the script. The slice's intent — "automated notarization on every signed build" — is achieved by `build.mac.notarize` in `package.json`, not by an `xcrun notarytool submit` shell-out in `afterSign.js`.

## Implementation Steps

1. **Read the current `build/afterSign.js`** (69 lines). It already does the right JAR-strip work; the cosmetic issues are: (a) the credential-check block at the top (lines 13–16) is currently a no-op log, (b) there is no log line clarifying that notarization is handled elsewhere, and (c) the file has no executable test.

2. **Rewrite `build/afterSign.js`** with the following structure (preserve every JAR-removal line of behavior):
   - Top-of-file JSDoc comment naming the responsibility: "Post-sign cleanup. Strips JAR files from @anthropic-ai/claude-code/vendor/. Notarization is performed by electron-builder's built-in @electron/notarize hook when build.mac.notarize is enabled in package.json — this script does NOT invoke notarytool."
   - Early-return on non-mac (already present at lines 8–10) — keep as-is.
   - Replace the misleading credential check (current lines 13–16) with a one-line `console.log('AfterSign: notarization is handled by electron-builder built-in hook; this script only performs post-sign cleanup');` to make the responsibility split visible in build logs.
   - Preserve the rest of the function verbatim (path search, recursive JAR strip).

3. **Write `build/afterSign.test.js`** as a Node smoke-test (no test framework). Two cases:
   - **Case A: non-mac context.** Construct `ctx = { appOutDir: '/tmp', packager: { platform: { name: 'linux' }, appInfo: { productName: 'X' } } }`. Call `require('./afterSign').default(ctx)`. Assert the returned Promise resolves without error and without removing any files.
   - **Case B: mac context with a fake vendor tree.** Create a tempdir layout: `<tmp>/X.app/Contents/Resources/app.asar.unpacked/node_modules/@anthropic-ai/claude-code/vendor/foo.jar` and `vendor/sub/bar.jar`. Call the function with `appOutDir = <tmp>` and `packager.platform.name = 'mac'`. After the call, assert both JAR files are gone (`fs.existsSync` returns false). Clean up the tempdir in a `finally`.

4. **Wire the test into the pre-flight check list** (do not auto-run it in `pnpm test` — the file is plain JS, not Playwright). Add a one-line `node build/afterSign.test.js` to TASK-055's Implementation Steps so the smoke-test runs before the first real signed build. (This dependency is captured in TASK-055's `depends_on`.)

5. **Run `pnpm lint`** to confirm the rewritten file passes any project-wide JS lint rules. (The current file uses `require` / `exports.default` — keep the same CJS style; electron-builder calls afterSign hooks as CJS.)

## Acceptance Criteria

- JAR-strip behavior is preserved (the recursive `fs.unlinkSync` of `.jar` files under `@anthropic-ai/claude-code/vendor/`).
- No `notarytool`, `@electron/notarize`, or notarize-function invocation appears in `build/afterSign.js`.
- A clear log line announces the responsibility split.
- The non-mac early-return path still exits cleanly.
- A new `build/afterSign.test.js` smoke-test exercises both branches and passes when run as `node build/afterSign.test.js`.

## Test Strategy

`build/afterSign.test.js` is a plain Node script (no framework) that imports `build/afterSign.js` and exercises the two main branches. It uses Node's `fs.mkdtempSync` for an isolated temp tree and cleans up in a `finally`. Run as `node build/afterSign.test.js` — exit 0 on success, exit 1 on any assertion failure. This is sufficient because afterSign.js is < 80 lines of plain logic; a heavyweight test framework is overkill.

## Hardest Decision

**Whether to write a custom `xcrun notarytool submit` shell-out in `afterSign.js` (as IDEA-002 slice 4 literally says) or delegate to electron-builder's built-in notarize.** Chose **delegate** because:

1. electron-builder v26 has stable built-in support for notarytool — it calls `@electron/notarize` internally and handles staple, exit codes, and error surfacing.
2. `scripts/configure-build.js` (lines 47–65) already toggles `build.mac.notarize` based on env vars; writing a duplicate path in `afterSign.js` would create two sources of truth for "should we notarize?" and they could disagree.
3. The slice text describes the *outcome* ("automated notarization on every signed build") and the implementation choice between custom shell-out and electron-builder hook is an implementation detail. The hook is the lower-friction path.

If electron-builder's notarize hook turns out to be unreliable (e.g., a version regression surfaces during TASK-055), the fallback is to add the `xcrun notarytool submit` shell-out to `afterSign.js` — but that decision should be evidence-driven, not pre-emptive.

## Rejected Alternatives

- **Write `xcrun notarytool submit --keychain-profile AC_PASSWORD <dmg-path>` inside afterSign.js.** Rejected — two sources of truth for notarization, no benefit. Reconsider if the built-in hook fails in TASK-055.
- **Move JAR-strip into a separate `beforeSign` hook and leave `afterSign` empty.** Rejected — JARs must be stripped *after* signing because they are sometimes signed and the strip must occur before notarization. The current ordering is correct.
- **Use `electron-builder-notarize` npm package.** Rejected — it's a thin wrapper around `@electron/notarize` and adds a dependency for no functional gain over electron-builder v26's built-in notarize support.

## Lowest Confidence Area

**The interaction between `signIgnore` (which excludes JARs from being signed at all — see `package.json` line 121) and the post-sign JAR strip.** Both mechanisms target the same files. If `signIgnore` works correctly, the JAR-strip step is removing files that were already excluded from signing. The JAR-strip may be vestigial Crystal hygiene. For v1, keep it — removing it could fail notarization if stapled JAR metadata leaks through. Revisit in v2 once a baseline signed/notarized build is known good.
