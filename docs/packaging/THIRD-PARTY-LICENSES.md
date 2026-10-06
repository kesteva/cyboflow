# Third-party licenses

What the packaged Cyboflow app bundles, and under which terms. Cyboflow's own code is
MIT-licensed (see [/LICENSE](/LICENSE)); fork lineage is in [`../PROVENANCE.md`](../PROVENANCE.md).

## Bundled components not under an OSS license

- **`@anthropic-ai/claude-agent-sdk` and its platform `claude` binary**
  (`@anthropic-ai/claude-agent-sdk-<platform>-<arch>`, unpacked from the asar via
  `asarUnpack`). The SDK package declares `SEE LICENSE IN README.md` and the binary package
  `SEE LICENSE IN LICENSE.md`; both point at Anthropic's legal agreements, not an
  OSS license. This is the in-process Claude Code runtime Cyboflow drives.

## Bundled components under OSS licenses

- **`@openai/codex`** (pinned in `package.json`; native binaries unpacked from the asar):
  Apache-2.0 per its `package.json`.
- **`playwright`**: Apache-2.0 per its `package.json`.
- **Optional `@steipete/peekaboo-mcp`**: MIT per its `package.json`.
- **Other npm dependencies**, including Electron, `better-sqlite3`, and
  `@homebridge/node-pty-prebuilt-multiarch`: MIT or comparable OSS licenses declared in
  each package's own `package.json`. The dependency lists are `dependencies` /
  `optionalDependencies` in the root `package.json` and the renderer bundle's inputs in
  `frontend/package.json`.

## Notices

No third-party NOTICES / attribution file is generated or shipped today. Crystal's
`generate-notices` tooling was removed when it was found orphaned, and nothing replaced it.
Each bundled package carries its own license text inside `node_modules`, which electron-builder
copies into the app.
