---
id: TASK-583
idea: SPRINT-006-compound
status: deferred
blocked_reason: "Tightens socket file permissions (0o600). Under the SDK substrate, the socket file is created at startup but not used; tightening its perms has no live security benefit. Defer until IDEA-013 lands and the socket is back on the hot path. Unblock when IDEA-013 starts planning."
source_sprint: SPRINT-006
created: "2026-05-14T00:00:00Z"
files_owned:
  - main/src/services/cyboflowPermissionIpcServer.ts
  - main/src/services/__tests__/cyboflowPermissionIpcServerPermissions.test.ts
  - docs/cyboflow_system_design.md
files_readonly:
  - main/src/utils/crystalDirectory.ts
  - .soloflow/active/findings/SPRINT-006-findings.md
  - .soloflow/active/compound/SPRINT-006-proposal.md
  - .soloflow/active/plans/approval-router-and-permission-fix/EPIC-approval-router-and-permission-fix.md
acceptance_criteria:
  - criterion: Socket directory creation uses mode 0o700
    verification: "grep -nE 'mkdirSync\\([^)]+,\\s*\\{[^}]*mode:\\s*0o700' main/src/services/cyboflowPermissionIpcServer.ts returns at least 1 match"
  - criterion: "Socket file is chmod'd to 0o600 after server.listen() succeeds, before the start() promise resolves"
    verification: "grep -nE 'chmodSync\\(this\\.socketPath,\\s*0o600\\)' main/src/services/cyboflowPermissionIpcServer.ts returns at least 1 match; the call appears inside the `server.listen(this.socketPath, () => { ... })` callback, before `resolve()`"
  - criterion: "If the socket directory already exists and has more-permissive mode than 0o700, the constructor either re-chmods it to 0o700 or logs a warning. (Pre-existing dirs from prior runs may have default mode.)"
    verification: "grep -nE 'chmodSync\\([^)]+,\\s*0o700\\)' main/src/services/cyboflowPermissionIpcServer.ts returns at least 1 match; OR a console.warn in the constructor mentions directory permissions"
  - criterion: "Unit test asserts: after `start()` resolves, `fs.statSync(getSocketPath()).mode & 0o777 === 0o600` for the socket file and `fs.statSync(socketDir).mode & 0o777 === 0o700` for the directory"
    verification: "test -f main/src/services/__tests__/cyboflowPermissionIpcServerPermissions.test.ts AND grep -cE '0o600|0o700' main/src/services/__tests__/cyboflowPermissionIpcServerPermissions.test.ts returns at least 4 AND pnpm --filter main test cyboflowPermissionIpcServerPermissions exits 0"
  - criterion: "docs/cyboflow_system_design.md permission-bridge section documents the trusted-boundary contract: the Unix socket is `chmod 0600`, dir `chmod 0700`, and the security model assumes a same-UID trust boundary (no defense against other processes running as the same user)"
    verification: "grep -nE 'chmod 0600|chmod 0700|trusted boundary|same.UID|same.user' docs/cyboflow_system_design.md returns at least 2 matches in proximity to the permission-bridge section"
  - criterion: Main process typecheck passes
    verification: pnpm --filter main typecheck exits 0
  - criterion: Main process lint passes
    verification: pnpm --filter main lint exits 0
depends_on: []
estimated_complexity: low
epic: approval-router-and-permission-fix
test_strategy:
  needed: true
  justification: "Permission bits are observable via fs.stat; one unit test exercises the chmod path on a real temp socket file. Without this test, a future refactor could remove the chmod calls without surface signal."
  targets:
    - behavior: "After CyboflowPermissionIpcServer.start() resolves, the socket file mode masked with 0o777 equals 0o600"
      test_file: main/src/services/__tests__/cyboflowPermissionIpcServerPermissions.test.ts
      type: unit
    - behavior: "After construction, the socket directory mode masked with 0o777 equals 0o700"
      test_file: main/src/services/__tests__/cyboflowPermissionIpcServerPermissions.test.ts
      type: unit
---
# Chmod unix socket to 0o600 and socket directory to 0o700 after server.listen()

## Objective

`~/.cyboflow/sockets/cyboflow-permissions-<pid>.sock` is currently created with the default `umask`-derived mode (typically 0o755 on macOS — readable/writable by owner, readable/listable by group/other). The parent directory (`fs.mkdirSync(socketDir, { recursive: true })` at `cyboflowPermissionIpcServer.ts:23`) inherits the same default. Any process running under the same local UID can `connect(2)` to the socket and write a `permission-request` payload, which (post-TASK-302) flows into DB writes via `ApprovalRouter`.

Cyboflow's threat model is **same-UID trust** (an attacker who already controls the user account is out of scope), but defense-in-depth says the socket should still be `chmod 0600` and the dir `chmod 0700` so that less-privileged processes on a multi-user macOS box (or a misconfigured shared dev environment) cannot trivially poke the bridge. This is consistent with `~/.ssh/auth_sock` conventions.

## Implementation Steps

1. **Edit `main/src/services/cyboflowPermissionIpcServer.ts`** — update the `mkdirSync` call inside the constructor (currently line 23):

   ```ts
   if (!fs.existsSync(socketDir)) {
     fs.mkdirSync(socketDir, { recursive: true, mode: 0o700 });
   } else {
     // If the dir already exists from a prior run, re-tighten its mode in case it was
     // created with a more-permissive default. Best-effort — log and continue on failure.
     try {
       fs.chmodSync(socketDir, 0o700);
     } catch (error) {
       console.warn(`[Permission IPC] Could not tighten socket directory mode to 0o700: ${error}`);
     }
   }
   ```

2. **In the same file, update the `server.listen(...)` callback inside `start()`** (currently lines 111-114) to chmod the socket file as soon as it exists:

   ```ts
   this.server.listen(this.socketPath, () => {
     try {
       fs.chmodSync(this.socketPath, 0o600);
     } catch (error) {
       console.error(`[Permission IPC] Failed to chmod socket file to 0o600: ${error}`);
       reject(error);
       return;
     }
     resolve();
   });
   ```

   The chmod failure rejects the start promise — better to fail loudly than silently ship an over-permissive socket.

3. **Create `main/src/services/__tests__/cyboflowPermissionIpcServerPermissions.test.ts`** — new file. Strategy:
   - Use `setCrystalDirectory(path.join(os.tmpdir(), `cyboflow-test-${randomUUID()}`))` from `main/src/utils/crystalDirectory.ts` to redirect the socket dir.
   - Construct `CyboflowPermissionIpcServer`, call `.start()`.
   - Assert `fs.statSync(server.getSocketPath()).mode & 0o777 === 0o600`.
   - Assert `fs.statSync(path.dirname(server.getSocketPath())).mode & 0o777 === 0o700`.
   - Tear down via `await server.stop()` and `fs.rmSync(tmpDir, { recursive: true, force: true })`.

   Important: on macOS, the *socket* file's `umask` interaction is well-defined and `chmodSync` works reliably. The dir test is slightly fragile if the parent dir was created on a filesystem that does not honor mode bits (FAT/exFAT on a USB stick) — guard with a `if (process.platform === 'darwin' || process.platform === 'linux')` skip if necessary.

4. **Edit `docs/cyboflow_system_design.md`** — find the permission-bridge section (likely near the §5 "Permission flow" content based on the design doc structure) and add a paragraph documenting the trusted-boundary contract:

   ```
   ### Permission bridge: trust boundary

   The permission IPC socket at `~/.cyboflow/sockets/cyboflow-permissions-<pid>.sock` is
   `chmod 0600` and lives in a `chmod 0700` parent directory. The bridge subprocess
   connects as the same UID as the main process; no cross-user trust is assumed.

   This is defense-in-depth — the threat model assumes an attacker controlling the user
   account is out of scope. The chmod is a guardrail against (a) unintended connections
   from sibling processes spawned by tools like VS Code's terminal under different
   nice levels, and (b) accidental world-readable file modes in misconfigured shared
   dev environments.
   ```

   If the existing doc has a different sectioning convention, integrate the paragraph wherever the bridge is first introduced; do not create a new top-level section.

5. **Run the verification chain**:
   ```
   pnpm --filter main typecheck
   pnpm --filter main lint
   pnpm --filter main test cyboflowPermissionIpcServerPermissions
   pnpm --filter main test
   ```

## Acceptance Criteria

See frontmatter. Seven criteria.

## Test Strategy

See frontmatter `test_strategy`. Two test cases (socket mode, dir mode) in a new test file. The test must redirect the socket dir via `setCrystalDirectory` to a temp dir so the real `~/.cyboflow/sockets/` is not polluted.

## Hardest Decision

**Should the chmod failure on `start()` reject (loud-fail) or just warn?** Chosen: **reject**. The socket existing without the expected mode is a security regression; better to fail boot and force someone to look than to ship a quietly more-permissive socket. The trade-off is that on a hypothetical filesystem that doesn't support chmod (FAT/exFAT, unlikely on macOS for `~/`), the app would fail to start — but the socket path is by default `~/.cyboflow/sockets/`, which is on the user's home filesystem (HFS+ or APFS), which always supports chmod.

## Rejected Alternatives

- **Use `umask(0o077)` before `mkdirSync`/`listen` and reset after.** Rejected: process-wide `umask` is racy in a multi-threaded Node app (worker_threads, etc.) and `mode:` parameter is the idiomatic Node API. Explicit `chmod` after `listen` is also necessary because `net.Server.listen` does not honor a mode-on-create parameter on macOS (the socket inode mode is created using the process umask).
- **Set `process.umask(0o077)` in `app.whenReady()`.** Rejected: changes the umask for every subsequent file Cyboflow creates (logs, DB, MCP configs), with unpredictable knock-on effects. Targeted `chmod` is safer.
- **Skip the directory chmod and only fix the socket file.** Rejected: a permissive directory mode allows enumeration of the socket path on a multi-user box. Both layers matter.

## Lowest Confidence Area

The "re-tighten existing dir mode" branch (step 1). If a user has manually opened `~/.cyboflow/sockets/` to a more-permissive mode for some reason (e.g. shared the dir between two user accounts), this task will silently undo their decision. The trade-off is acceptable because (a) the dir is internal to Cyboflow and not documented as user-modifiable, and (b) the warn-and-continue is logged. If this becomes a real complaint, the future fix is a `--insecure-socket-dir` flag.
