---
id: TASK-251
idea: IDEA-006
idea_id: IDEA-006
status: in-flight
created: "2026-05-11T00:00:00Z"
files_owned:
  - main/package.json
  - package.json
files_readonly:
  - .soloflow/active/ideas/IDEA-006.md
  - .soloflow/active/research/ROADMAP-001-research-ecosystem.md
  - .soloflow/active/research/ROADMAP-001-research-architecture.md
  - .soloflow/active/research/ROADMAP-001-research-risks.md
  - .soloflow/active/roadmaps/ROADMAP-001.md
acceptance_criteria:
  - criterion: "main/package.json declares trpc-electron@0.1.2, @trpc/server in a v11 range that includes PR #6161, @trpc/client matching @trpc/server major, superjson, p-queue, and zod (peer of trpc) as dependencies"
    verification: "grep -E '\"(trpc-electron|@trpc/server|@trpc/client|superjson|p-queue|zod)\"' main/package.json shows all 6 entries with the expected version pins"
  - criterion: Root package.json declares the same trpc-electron/@trpc/server/@trpc/client/superjson/p-queue/zod entries with matching versions so the Electron build picks them up at runtime
    verification: "diff <(node -e 'const m=require(\"./main/package.json\").dependencies;const r=require(\"./package.json\").dependencies;[\"trpc-electron\",\"@trpc/server\",\"@trpc/client\",\"superjson\",\"p-queue\",\"zod\"].forEach(k=>console.log(k,m[k]===r[k]?\"=\":\"MISMATCH\",m[k],r[k]))') /dev/null | grep -v '= ' shows no MISMATCH lines"
  - criterion: "Implementation Step 1 records the exact @trpc/server published version that contains PR #6161 (verified against the linked GitHub PR status before pinning); the pin in package.json is >= that version"
    verification: "Read package.json's @trpc/server pin and confirm against the version recorded in the plan's Implementation Step 1 output (e.g. PR #6161 merged in commit X, first released in @trpc/server@vY.Z.W per https://github.com/trpc/trpc/pull/6161 — paste version into the commit message)"
  - criterion: pnpm install runs cleanly with no peer-dep warnings for the newly added packages and no native rebuild errors
    verification: "Run pnpm install from repo root; exit 0 and the output does not contain 'WARN' lines mentioning trpc, p-queue, superjson, or zod"
  - criterion: TypeScript typechecks across the workspace after install with the new transitive types resolved
    verification: pnpm typecheck exits 0
depends_on: []
estimated_complexity: low
epic: orchestrator-and-trpc-router
test_strategy:
  needed: false
  justification: "Pure dependency-manifest change. Correctness is enforced by pnpm install + pnpm typecheck, not by new unit tests."
prerequisites:
  - check: "command -v pnpm >/dev/null"
    fix: "corepack enable && corepack prepare pnpm@10.11.1 --activate"
    description: Repo uses pnpm@10.11.1 (see packageManager field in package.json); without it install will refuse
    blocking: true
---
# Install tRPC v11 + trpc-electron + p-queue + superjson Dependencies

## Objective

Add the net-new typed-IPC, queue, and serialization libraries the orchestrator-and-trpc-router epic requires. These are not in Crystal's inherited package set. Pin `@trpc/server` to a v11 release that includes the PR #6161 subscription memory-leak fix; pin `trpc-electron` to `0.1.2` (the only v11-compatible Electron link, mat-sz fork). Both `main/package.json` and root `package.json` must carry the entries so electron-builder bundles the deps and the main process resolves them at runtime.

## Implementation Steps

1. **Verify the @trpc/server version containing PR #6161.** Visit https://github.com/trpc/trpc/pull/6161 in a browser; read the "merged into …" status line and the first release tag that contains the merge commit (the PR header surfaces this). If the PR shows merged but the release notes do not explicitly mention #6161, fall back to: pick the smallest @trpc/server v11.x release whose date is strictly after the PR's merge date per https://github.com/trpc/trpc/releases. Record the chosen version (e.g. `11.0.0-rc.X` or `11.0.Y`) in the commit message as `pin justification: @trpc/server@<version> includes PR #6161 (merged <date>)`. Use `>=<version> <12.0.0` as the package.json range so future patch releases are picked up but a major v12 is not.
2. **Edit `main/package.json` `dependencies`.** Add (alphabetically positioned):
   - `"@trpc/client": "<same range as @trpc/server>"`
   - `"@trpc/server": "<range from step 1>"`
   - `"p-queue": "^8.0.1"` (v8 is ESM-only — verify main/tsconfig.json supports ESM imports; if not, pin `"^7.4.1"` which still ships CJS; p-queue v7 is the last CJS line)
   - `"superjson": "^2.2.1"`
   - `"trpc-electron": "0.1.2"` (exact pin — fork is small, intentional)
   - `"zod": "^3.23.8"` (tRPC peer; if shared/types already imports zod elsewhere, match that version)
3. **Edit root `package.json` `dependencies`.** Add the same six entries with the same version ranges. The root list is what electron-builder reads when assembling `node_modules/**/*` into the asar; missing the root list means the packaged app will throw at first `require('trpc-electron')`.
4. **Run `pnpm install` from the repo root.** Confirm exit code 0 and no peer-dep WARN lines for the six new packages.
5. **Run `pnpm typecheck` from the repo root.** Confirm exit code 0; this verifies `@types` resolution for the new packages.
6. **Re-verify with a grep gate.** Run `grep -E '"(trpc-electron|@trpc/server|@trpc/client|superjson|p-queue|zod)"' main/package.json package.json` and confirm both files show all six entries — this is the same check encoded in the first acceptance criterion.

## Acceptance Criteria

All four AC entries above must hold. The grep gate, the diff gate, the chosen-version note in the commit message, the clean `pnpm install`, and the clean `pnpm typecheck` are the five passes.

## Test Strategy

No new tests. The success signal is `pnpm install` + `pnpm typecheck` exit 0. Tasks downstream (Orchestrator class, tRPC router) will exercise the libraries.

## Hardest Decision

**Which `@trpc/server` version range to pin.** PR #6161 is the documented fix for issue #6156 (memory leak in v11 subscriptions). The PR's first-included release tag is the floor. Pin too tight (e.g. exact version) and routine patch updates produce noise; pin too loose (`^11.0.0`) and an unpatched RC could be resolved on first install if no lockfile exists. Choice: `">=<verified-version> <12.0.0"` plus the lockfile (pnpm-lock.yaml) as the secondary guarantee.

## Rejected Alternatives

- **`jsonnull/electron-trpc`.** The original upstream. PR #194 (v11 support) has been open since July 2025 unmerged. Rejected because it is effectively unmaintained for v11. Would reconsider if PR #194 lands and a v0.8+ release ships before this task closes.
- **Manual `ipcMain.handle`-based typed wrapper (no tRPC at all).** Would avoid both the leak risk and the small-fork risk. Rejected because the epic's value is the typed-RPC contract and the `httpLink` swap path for team-tier extraction; rolling our own would forfeit both. Would reconsider only if `trpc-electron@0.1.2` proves unworkable during TASK-254.
- **p-queue v8 vs v7.** v8 is ESM-only. v7 still ships CJS. The main process is CJS (`"type": "commonjs"` in main/package.json). Pinning v8 would require either `import()` dynamic imports or a tsconfig/module change. Choosing v7.4.1 keeps the build simple; v8 adoption is a separate refactor when the main process migrates to ESM.

## Lowest Confidence Area

The exact @trpc/server release that first ships PR #6161. The web search did not surface a clean changelog entry. Step 1 prescribes the verification path (PR page → release tag) but if the PR description does not name the release tag, the fallback is the date-bisect against the releases page. If neither yields a confident answer, **ESCALATE TO HUMAN** and confirm by writing a tiny memory-stress smoke test against the candidate version (the issue #6156 repro is ~30 lines).
