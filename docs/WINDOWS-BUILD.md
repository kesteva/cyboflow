# Windows build of cyboflow

How to build cyboflow for Windows, and the platform decisions behind the
Windows support. macOS build behavior is unchanged by everything described
here; each platform-specific change lives behind a platform check or in a
Windows-only file.

## Prerequisites

- Windows 10/11 x64 with node ≥ 22.14 and pnpm (the `packageManager` pin).
- **No Visual Studio / MSVC required.** Both native modules ship prebuilt
  Windows binaries; nothing compiles from source.

## Building

A plain `pnpm install` works on Windows now — the two-native-module dance
this doc used to prescribe (against Electron 37 / better-sqlite3 12.x) is
gone:

- **better-sqlite3 13.x** is N-API and ships its `prebuilds/<platform>-<arch>.node`
  files bundled INSIDE the npm package itself — nothing is fetched or
  compiled at install time, on any platform. Its `binding.gyp` skips the
  native build outright whenever a prebuild is present, so Windows gets
  `prebuilds/win32-x64.node` for free. There is no `prebuild-install` step
  to run and no host/Electron artifact to swap: the ONE file loads under
  both host Node (`NODE_MODULE_VERSION` 127) and Electron 44
  (`NODE_MODULE_VERSION` 149), so `node scripts/ensure-sqlite-abi.mjs
  electron` is a cheap no-op against it (see docs/ARCHITECTURE.md → "The
  better-sqlite3 ABI ping-pong").
- **node-pty-prebuilt-multiarch 0.14.1** is N-API-stable too (one binary
  loads under both Node and Electron), but `@electron/rebuild` only
  recognizes a prebuild named `node.napi.node` inside
  `prebuilds/<platform>-<arch>/` — not the name the package's own install
  actually leaves behind, so absent that alias electron-rebuild falls
  through to `prebuild-install` (which has no Electron assets to fetch for
  0.14.1) and then to `node-gyp`, which cannot build a package that ships
  no `src/`. `scripts/apply-pty-napi-prebuilds.js` places that alias
  automatically, as the root `postinstall` (before `electron-builder
  install-app-deps`, on every platform) — see "node-pty and
  `@electron/rebuild`" below.

So the whole install is just:

```bash
pnpm install
```

Then build and package:

```bash
pnpm build:win        # NSIS installer + unpacked build in dist-electron/
```

`build:win` runs `node scripts/ensure-sqlite-abi.mjs electron` first (a
no-op against the prebuild in the normal case), then the packaging preflight
(`configure-build.js`) re-probes the installed better-sqlite3 artifact under
the Electron ABI and fails the build if it somehow does not load — a safety
net for a corrupted install or a future non-N-API addon, not something a
normal install trips.

## Native module versions

| Module | Version | Why |
|---|---|---|
| better-sqlite3 | 13.0.3 | N-API since v13 (the Electron 44 upgrade); ships ALL platform prebuilds bundled in the package, including both `prebuilds/win32-x64.node` and `prebuilds/win32-arm64.node` — packaging stays x64-only for now (see "Known degradations" below) |
| node-pty-prebuilt-multiarch | 0.14.1 | ships a win32-x64 node-ABI build that is N-API-stable and loads under Electron 44 (0.12.x stopped near `electron-v110`) |

better-sqlite3 is load-probed twice per build — pre-packaging
(`configure-build.js` → `ensure-sqlite-abi.mjs --check electron`, a no-op
against the v13 prebuild in the normal case) and post-packaging (the
Windows `afterSign` arm, which probes `prebuilds/win32-<arch>.node`
directly since there is no `build/Release/better_sqlite3.node` any more).
node-pty's Electron loading was verified once by hand (its build is
N-API-stable) and is not re-probed per build.

### node-pty and `@electron/rebuild`

node-pty's prebuilt binaries are N-API-stable — the same binary loads in
Node and Electron — but `@electron/rebuild` only recognizes them under the
name `node.napi.node`, which the package does not ship, and otherwise
rebuilds from source. `scripts/apply-pty-napi-prebuilds.js` (root
postinstall, running before `electron-builder install-app-deps`, on every
platform) copies the package's installed binary to that name so
electron-rebuild skips the source build on every host — Windows included,
so a plain `pnpm install` no longer needs `--ignore-scripts` to avoid it.

## Packaging decisions

- **`npmRebuild: false` on Windows.** The prebuilt `.node` files are
  packaged as-is; a rebuild would require MSVC and would clobber the
  verified prebuilds. `CYBOFLOW_WIN_NPM_REBUILD=1` restores the rebuild
  step for hosts with a toolchain.
- **Lean packaging.** A Windows installer bundles only the win32 agent
  binaries (`claude.exe`, `codex.exe`) AND only its own
  `better-sqlite3/prebuilds/win32-<arch>.node`; the darwin/linux agent
  packages and the seven non-target better-sqlite3 prebuilds (~2 MB each)
  are excluded (`scripts/configure-build.js` → `getWinPackagingPlan`),
  mirroring how the macOS installer excludes everything else.
- **Installer size floor.** The produced `.exe` is held to a 50 MB floor
  (NSIS compresses harder than a DMG; the bar is still far above any
  stub). The unpacked build is also verified post-packaging
  (`build/afterSign.js` runs a Windows arm: PE machine check on
  `Cyboflow.exe`, a load probe of the packaged better-sqlite3 addon —
  `prebuilds/win32-<arch>.node` in the normal v13 case, or the legacy
  `build/Release/better_sqlite3.node` — under the packaged Electron, and a
  size floor on `win-unpacked`).
- **First run downloads electron-builder's NSIS/winCodeSign tooling.** On
  hosts without Windows Developer Mode, the winCodeSign archive's two
  darwin symlinks fail to extract and NSIS builds loop on the error; see
  the workaround in the "Troubleshooting" section below.

## Platform decisions (runtime)

- **MCP IPC over a named pipe.** Windows cannot bind Unix sockets
  (`EACCES`); the orch endpoint — the IPC address the MCP subprocesses use
  to reach the orchestrator in the main process — becomes
  `\\.\pipe\cyboflow-<user>-<hash>-orch` (first 8 hex of a SHA-256 digest
  over the per-instance socket path, so parallel app variants cannot
  cross-talk). Node's `net` module treats pipe paths transparently, so
  server and clients are unchanged.
- **PowerShell is the default shell** (`pwsh` if installed, else the
  system `powershell.exe`, then cmd.exe). Run/build commands are
  constructed per platform (`ShellDetector.buildCommandString`): POSIX
  joins `export K=v` and the command lines with `&&`; PowerShell has
  neither `export` nor `&&`, so it assigns via `$env:K = 'v'` and follows
  EVERY command line (not just the last) with an explicit
  `if (-not $?) { if ($LASTEXITCODE) { exit $LASTEXITCODE } else { exit 1 } }`
  guard — so a failing step still stops the script and reports its own
  exit code, the way `&&` does on POSIX.
- **Process teardown uses `taskkill /T`.** Windows has no process groups;
  `taskkill /PID <pid> /T /F` kills the whole tree and is the Windows arm
  of every teardown path (run scripts, terminals, PTY CLIs, agent-server
  clients, the verify driver). Process enumeration uses one PowerShell
  `Win32_Process` query rendered as `ps`-compatible text lines, so the
  `ps`-parsing sweeps work with their parsers unchanged.
- **Agent-server spawns are not `detached` on Windows.** `DETACHED_PROCESS`
  leaves codex.exe console-less, which makes it allocate its own *visible*
  console — with the "Let Windows decide" default-terminal setting that is
  a black window flash. Windows teardown uses `taskkill /T`, which does
  not need the detached process group; POSIX keeps `detached` + group
  kills.
- **Every child-process spawn hides its console** (`windowsHide: true`).
  Without it, a packaged GUI app opens a visible console window per spawn;
  with the Windows-Terminal default-terminal setting, each one renders as
  a dark terminal flash.
- **CLI probes survive npm `.cmd` shims.** Node ≥18.20 refuses to spawn
  `.cmd` files without a shell; version probes prefer a sibling native
  `.exe` and otherwise route through `cmd.exe /d /s /c` with verbatim
  quoting.
- **Git is discovered**, not assumed: PATH first, then the standard
  Windows install locations, then `where git` — a "Git Bash only" install
  works from a Start-Menu launch.
- **Hook commands run through `node`** (`node "<script>"`) — a bare `.js`
  path under cmd.exe resolves via file association, which may not be node.
- **Updater**: no Windows update feed exists, so the auto-updater reports
  "not supported" instead of erroring on every check.

## Installer configuration

`package.json` `build.win` names the NSIS target and nothing else, so the
installer takes electron-builder's defaults. Read from
`app-builder-lib/scheme.json` at the pinned version, those are:

| Option | Default | What it means here |
|---|---|---|
| `oneClick` | `true` | No wizard. The installer runs and finishes on its own. |
| `perMachine` | `false` | Installs per user, under `%LOCALAPPDATA%`. No admin prompt in the normal case. |
| `allowElevation` | `true` | An elevation prompt is still allowed if one turns out to be needed. |
| `allowToChangeInstallationDirectory` | `false` | Follows from `oneClick`; the user is not offered a path. |
| `createDesktopShortcut` | `true` | |
| `createStartMenuShortcut` | `true` | |
| `runAfterFinish` | `true` | |

This is deliberate for a first port: a per-user, one-click install needs no
administrator and cannot disturb a machine-wide install of anything else. The
build is also unsigned, so there is no `publisherName` to declare — SmartScreen
will warn on first run until a code-signing certificate exists. Adding an
`nsis` block is the change to make when any of that should differ; leaving the
block out is not the same as having chosen these values, which is why they are
written down here.

## Known degradations and follow-ups

- **Native-screen attestation** (proving which window was captured) has no
  Windows implementation; it fails loudly. Real-screen *screenshots* do
  work (PowerShell capture, always full-screen — per-app scoping comes from
  peekaboo, the macOS-only screen-capture helper the verifier uses there). Native-screen verification is scheduler-gated
  to hosts with a capability probe.
- **No Windows update feed** (see updater above).
- **x64 only**; ARM64 needs its own packaging path and prebuild
  verification.

## Troubleshooting

- **NSIS build loops on winCodeSign extraction**: the winCodeSign archive
  contains darwin symlinks that need admin/Developer Mode. Pre-extract it
  once into the final cache directory:
  `7za x %LOCALAPPDATA%\electron-builder\Cache\winCodeSign\winCodeSign-2.6.0.7z -owinCodeSign-2.6.0`
  (the two darwin symlink errors are harmless; the Windows tools extract
  fine).
- **`NODE_MODULE_VERSION` mismatch at app boot**: the packaged artifact is
  on the wrong ABI — run
  `node scripts/ensure-sqlite-abi.mjs electron` and rebuild. Always run
  that script with *Windows* node; running it from WSL node wedges the
  swap lock.
- **Diagnosing console-window flashes**: a console window exists only when
  its process has a nonzero MainWindowHandle — `CREATE_NO_WINDOW`
  children still get a windowless conhost, so process presence alone
  proves nothing. Poll
  `Get-Process conhost,cmd,powershell,OpenConsole | ? { $_.MainWindowHandle -ne 0 }`
  and resolve the reported parent PID to find the offending spawn site.

- **White screen at launch + MCP subprocess "Cannot find module"**: the
  packaged app contains RAW tsc output — `build:main` normally runs
  `bundle-preload.mjs` + `bundle-mcp-server.mjs` after `tsc`, and a partial
  or cross-OS incremental build that skips them breaks the packaged app (an
  unbundled sandboxed preload cannot load; the unbundled MCP server cannot
  resolve its siblings from `app.asar.unpacked`). Run both bundle scripts
  after every `main` build, on the build host.
