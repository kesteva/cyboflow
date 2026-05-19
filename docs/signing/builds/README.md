# Signing Build Records

Each signed release of Cyboflow gets its own subdirectory under `docs/signing/builds/<version>/`. These directories are append-only audit records: every submission ID, SHA256, timestamp, and test result captured here is evidence — do not edit a completed record to correct or suppress past findings.

---

## Directory Convention

```
docs/signing/builds/
  _template/
    BUILD_LOG_TEMPLATE.md         ← copy this for each new build
    GATEKEEPER_TEST_TEMPLATE.md   ← copy this for each new build
  <version>/
    FIRST_SIGNED_BUILD_LOG.md     ← filled-in build log for this release
    GATEKEEPER_ACCEPTANCE_TEST.md ← filled-in Gatekeeper test record
  0.3.5/                          ← first signed release
    FIRST_SIGNED_BUILD_LOG.md
    GATEKEEPER_ACCEPTANCE_TEST.md
```

The `<version>` string matches `package.json` → `version` (e.g. `0.3.6`, `1.0.0`).

---

## How to Record a New Signed Build

1. Copy both template files into a new version directory:
   ```bash
   mkdir -p docs/signing/builds/<version>
   cp docs/signing/builds/_template/BUILD_LOG_TEMPLATE.md \
      docs/signing/builds/<version>/FIRST_SIGNED_BUILD_LOG.md
   cp docs/signing/builds/_template/GATEKEEPER_TEST_TEMPLATE.md \
      docs/signing/builds/<version>/GATEKEEPER_ACCEPTANCE_TEST.md
   ```

2. Fill in every `<TODO: ...>` placeholder in `FIRST_SIGNED_BUILD_LOG.md` as you run the build. Record submission IDs and SHA256 hashes immediately — do not reconstruct from memory after the fact.

3. After the build completes, run the clean-account Gatekeeper test and fill in `GATEKEEPER_ACCEPTANCE_TEST.md`.

4. Commit both files together:
   ```bash
   git add docs/signing/builds/<version>/
   git commit -m "docs: record signed build and Gatekeeper test for <version>"
   ```

See `docs/signing/APPLE_DEVELOPER_SETUP.md` § "Recording a Signed Build" for the workflow and § "Known Build Pitfalls" for runbook material.

---

## Required Files Per Build

Each `builds/<version>/` directory must contain:

| File | Contents |
|------|----------|
| `FIRST_SIGNED_BUILD_LOG.md` | Build summary, timeline, configure-build.js output, notarization submission records, codesign verification, spctl assessment, stapler validation, lipo outputs |
| `GATEKEEPER_ACCEPTANCE_TEST.md` | Artifact under test, test environment, 10-step procedure results, CLI verification outputs verbatim |

---

## Never-Overwrite Rule

Completed `builds/<version>/` directories are append-only audit records. If a regression is discovered after the fact or the build is re-run for any reason, create a new directory (e.g. `builds/0.3.5-rebuild/`) rather than editing the original. This preserves the complete timeline of what was signed and when.
