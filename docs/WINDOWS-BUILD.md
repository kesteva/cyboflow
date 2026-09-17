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
  better-sqlite3 ABI ping-pong"). One thing to keep that way: better-sqlite3
  is deliberately NOT in `pnpm.onlyBuiltDependencies` (root `package.json`).
  The package sets `gypfile: false`, but pnpm 10.11 ignores that and — when
  the package is allow-listed — runs npm's implicit `node-gyp rebuild` at
  install, whose *configure* step needs a Visual Studio node-gyp recognises
  before `binding.gyp` ever gets to skip the compile. That is what made a
  plain `pnpm install` fail on a VS-less (or VS 2026) Windows host. Off the
  list, pnpm runs nothing for it on any platform and the bundled prebuild is
  used as-is; `electron-builder install-app-deps` still visits it through
  @electron/rebuild's own node-gyp 12, which does know VS 2026, and finds
  nothing to compile.
- **node-pty-prebuilt-multiarch 0.14.1** is N-API-stable too (one binary
  loads under both Node and Electron), but `@electron/rebuild` only
  recognizes a prebuild named `node.napi.node` inside
  `prebuilds/<platform>-<arch>/` — not the name the package's own install
  actually leaves behind, so absent that alias electron-rebuild falls
  through to `prebuild-install` (which has no Electron assets to fetch for
  0.14.1) and then to `node-gyp`, which cannot build a package that ships
  no `src/`. `scripts/apply-pty-napi-prebuilds.js` places that alias
  automatically, as the root `postinstall` (before the
  `install-app-deps` step, on every platform) — see "node-pty and
  `@electron/rebuild`" below.

So the whole install is just:

```bash
pnpm install
```

Then build and package:

```bash
pnpm build:win        # NSIS installer + unpacked build in dist-electron/
```

No Windows host at hand? `.github/workflows/windows.yml` (dispatch-only)
runs the same two things on a `windows-latest` runner: the full `pnpm
test:unit` chain — the only place the `skipIf(process.platform !== 'win32')`
tests ever execute in CI — and `pnpm build:win`, uploading the installer as
a workflow artifact (signed when the `AZURE_*` secrets are configured — see
"Code signing" below — unsigned otherwise). Trigger it with
`gh workflow run windows.yml --ref <branch> [-f variant=dev]`; the `variant`
input selects `build:win` (artifact `cyboflow-windows-x64-installer`) or
`build:win:dev` (`…-installer-dev`). This is also how releases build the
Windows installers — `docs/RELEASE-RUNBOOK.md` §3.

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

The second postinstall step, `scripts/install-app-deps.js`, wraps
`electron-builder install-app-deps` and **skips it on Windows**. Nothing
there needs an Electron rebuild (both native modules are N-API prebuilds),
and electron-builder 26's bundled `@electron/rebuild` 3.7 would still push
better-sqlite3 through node-gyp, whose configure step must find a Visual
Studio it recognises (2017–2022 with the C++ workload) before `binding.gyp`
gets to skip the compile — on a VS-less host, or one with VS 2026 such as
GitHub's `windows-latest`, that failed every install. This is the install-
time twin of the packaging plan's `npmRebuild: false`, and it honours the
same `CYBOFLOW_WIN_NPM_REBUILD=1` switch for a host that has a toolchain.

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
- **Updater**: polls `updates.cyboflow.com/<variant>/latest.yml` and verifies
  the downloaded installer's Authenticode publisher before running it — see
  `docs/UPDATES.md` → "Windows".

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
administrator and cannot disturb a machine-wide install of anything else.
Adding an `nsis` block is the change to make when any of that should differ;
leaving the block out is not the same as having chosen these values, which is
why they are written down here.

## Code signing (Azure Artifact Signing)

Windows signing goes through **Azure Artifact Signing** — the service Microsoft
shipped as "Trusted Signing"; the portal renamed it, but the resource provider
(`Microsoft.CodeSigning`), the endpoints (`*.codesigning.azure.net`) and the
PowerShell module (`TrustedSigning`) all kept the old names, so both spellings
turn up in tooling.

The resources (subscription `Azure subscription 1`, resource group
`cyboflow-signing`):

| Resource | Value |
|---|---|
| Signing account | `cyboflowsigning` (East US, Basic SKU) |
| Endpoint | `https://eus.codesigning.azure.net/` |
| Certificate profile | `cyboflow-public-trust` (Public Trust) |
| Identity validation | Individual, `Raimundo Esteva`, expires **2027-09-10** |
| Certificate subject | `CN=Raimundo Esteva, O=Raimundo Esteva, L=San Luis Obispo, S=ca, C=US` |

`publisherName` in the build config must equal the certificate's CN
**exactly** — electron-builder passes it through to `Invoke-TrustedSigning`,
and a mismatch fails at sign time.

**The certificates are short-lived by design.** A profile's current
certificate expires in days, not years; every signature is RFC3161 timestamped
(`http://timestamp.acs.microsoft.com`) so it stays valid long after the cert
that produced it expired. There is no certificate to renew, install, or
protect. The two things that DO expire on a calendar: the identity validation
(annually) and the service principal's client secret.

### How it is wired

`scripts/configure-build.js` injects `win.azureSignOptions` into the generated
electron-builder config only when the Microsoft Entra ID credentials are
present. It is injected rather than declared in `package.json` because
**the key's mere presence selects the signer**: electron-builder instantiates
`WindowsSignAzureManager` whenever `azureSignOptions != null` and then hard-fails
if the credentials are incomplete. A declared-but-uncredentialed key would break
every local Windows build and the CI installer smoke, so the uncredentialed path
must omit it entirely (`scripts/configure-build.test.js` Cases G/G2/G3 pin all
three outcomes).

Partial credentials **hard-fail the build** rather than falling through to an
unsigned installer — a release that looks like it succeeded and ships unsigned
is the worse failure.

The four non-secret values live in `WIN_AZURE_SIGN_DEFAULTS` in that script
(each is readable from any signed binary we ship) and can be overridden per
build with `CYBOFLOW_AZURE_PUBLISHER_NAME`, `CYBOFLOW_AZURE_ENDPOINT`,
`CYBOFLOW_AZURE_ACCOUNT`, `CYBOFLOW_AZURE_PROFILE`.

### Credentials

electron-builder reads these itself, via the Azure Identity
`EnvironmentCredential` contract — they never pass through our config:

| Variable | Required |
|---|---|
| `AZURE_TENANT_ID` | always |
| `AZURE_CLIENT_ID` | always |
| `AZURE_CLIENT_SECRET` | one of these three |
| `AZURE_CLIENT_CERTIFICATE_PATH` | " |
| `AZURE_USERNAME` + `AZURE_PASSWORD` | " |

The service principal needs the **Artifact Signing Certificate Profile Signer**
role, scoped to the certificate profile (not the whole account).

### Signing only runs on a Windows host

`app-builder-lib`'s `winPackager.ts` resolves its VM as
`process.platform === "win32" ? new VmManager() : getWindowsVm(...)`, so signing
from macOS requires a provisioned Parallels/VirtualBox Windows VM. In practice
signing happens on the `windows-latest` runner in
`.github/workflows/windows.yml`. On first run electron-builder installs the
`TrustedSigning` PowerShell module (`Install-Module -Name TrustedSigning
-MinimumVersion 0.5.0 -Scope CurrentUser`), which adds ~30s to the job.

### SmartScreen

A Public Trust certificate removes the "unknown publisher" block, but
SmartScreen reputation accrues per-publisher over download volume — early
signed builds can still draw a warning. That is expected and resolves with
usage, not with configuration.

## Known degradations and follow-ups

- **Native-screen attestation** (proving which window was captured) has no
  Windows implementation; it fails loudly. Real-screen *screenshots* do
  work (PowerShell capture, always full-screen — per-app scoping comes from
  peekaboo, the macOS-only screen-capture helper the verifier uses there). Native-screen verification is scheduler-gated
  to hosts with a capability probe.
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
  `bundle-preload.mjs` + `bundle-mcp-server.mjs` + `bundle-verify-driver.mjs` after `tsc`, and a partial
  or cross-OS incremental build that skips them breaks the packaged app (an
  unbundled sandboxed preload cannot load; the unbundled MCP server cannot
  resolve its siblings from `app.asar.unpacked`). Run both bundle scripts
  after every `main` build, on the build host (the driver one too — an unbundled
  driverCli.js dies on its first sibling require the same way).
