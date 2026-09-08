/**
 * Subprocess lifecycle tests for the BUILT cyboflowMcpServer.
 *
 * WHY THESE SPAWN A REAL PROCESS. cyboflowMcpServer.ts calls `main()` at module
 * scope and installs its shutdown handlers at module scope too (deliberately —
 * see the "Shutdown + spawner-death detection" block), so it cannot be imported
 * in-process: importing it would connect a transport, call process.exit, and take
 * the vitest worker with it. The only honest way to test "does this process die
 * when its spawner does" is to run the real artifact and watch it die.
 *
 * These tests therefore exercise
 * main/dist/main/src/orchestrator/mcpServer/cyboflowMcpServer.js — the bundled
 * file that is actually spawned in production — and skip loudly when it has not
 * been built (`pnpm build:main` from the repo root).
 *
 * Every spawn needs a live orchestrator socket: the server exits(1) immediately
 * without CYBOFLOW_RUN_ID + CYBOFLOW_ORCH_SOCKET, and a refused connection ends
 * it via its own `socket.on('close')` shutdown. So beforeAll stands up a real
 * net.createServer() on the platform's orchestrator endpoint — a temp unix
 * socket, or a named pipe on Windows (orchSocketEndpoint) — that accepts and
 * holds connections; the accepted-connection count is then usable as proof a
 * spawn actually booted, which keeps the "still alive" assertions from passing
 * vacuously.
 *
 * CYBOFLOW_MCP_PARENT_WATCHDOG_MS (a documented test seam on parentWatchdog) is
 * set on every spawn so the ppid poll runs in hundreds of milliseconds instead of
 * its 60 s production interval.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { spawn, execFileSync, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { orchSocketEndpoint } from '../orchSocketEndpoint';
import { isAlive } from '../../../__test_fixtures__/processTree';

// main/src/orchestrator/mcpServer/__tests__ -> main/
const MAIN_DIR = path.resolve(__dirname, '..', '..', '..', '..');
const SERVER_PATH = path.join(
  MAIN_DIR,
  'dist',
  'main',
  'src',
  'orchestrator',
  'mcpServer',
  'cyboflowMcpServer.js',
);

const SERVER_BUILT = fs.existsSync(SERVER_PATH);

// In CI a missing bundle must be a HARD FAILURE, never a skip. These three tests
// are the only regression guard for the orphaned-MCP-process bug, and `test:unit`
// does not build — so if the workflow's `build:main` step is ever dropped, a
// silent skip would remove that guard entirely while CI stayed green. That is the
// same "verification channel that verifies nothing" failure the fix under test
// exists to close, so it is refused here rather than tolerated. A module-scope
// throw fails collection of this file, which is loud and unmissable.
if (!SERVER_BUILT && process.env.CI) {
  throw new Error(
    `[cyboflowMcpServer.lifecycle] ${SERVER_PATH} is not built, so the ` +
      `spawner-death regression tests cannot run. CI must run \`pnpm build:main\` ` +
      `before \`pnpm test:unit\` (see .github/workflows/quality.yml). Refusing to ` +
      `skip silently in CI.`,
  );
}

if (!SERVER_BUILT) {
  // Local dev: skipping is reasonable (not every contributor has built main), but
  // say so audibly. console.* is mocked to a no-op by src/test/setup.ts, so write
  // to stderr directly.
  process.stderr.write(
    `\n[cyboflowMcpServer.lifecycle] SKIPPING: ${SERVER_PATH} not built.\n` +
      `  Run \`pnpm build:main\` from the repo root to enable these tests.\n\n`,
  );
}

const describeIfBuilt = SERVER_BUILT ? describe : describe.skip;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface ExitResult {
  code: number | null;
  signal: NodeJS.Signals | null;
}

function onExit(child: ChildProcess): Promise<ExitResult> {
  return new Promise((resolve) => {
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
}

/** Reject rather than hang forever when a process refuses to die. */
async function withDeadline<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms waiting for ${what}`)), ms);
  });
  try {
    return await Promise.race([p, deadline]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Poll `predicate` until it holds, or throw once `timeoutMs` elapses. Preferred
 * over a fixed sleep anywhere a real process has to reach a state: a fixed budget
 * that a loaded CI runner overshoots fails in a way that reads as "the fix is
 * broken" rather than "the machine was slow".
 */
async function waitFor(
  predicate: () => boolean,
  timeoutMs: number,
  what: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(25);
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}`);
}

/**
 * The parent pid of `pid` as the kernel reports it, or null when the process is
 * gone. `ps` rather than anything in-process because the target of the orphan
 * test is NOT our child — once its spawner exits we have no handle on it at all.
 */
function ppidOf(pid: number): number | null {
  try {
    const out = execFileSync('ps', ['-o', 'ppid=', '-p', String(pid)], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (!out) return null;
    const parsed = Number(out);
    return Number.isFinite(parsed) ? parsed : null;
  } catch {
    // ps exits non-zero when the pid does not exist.
    return null;
  }
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

describeIfBuilt('cyboflowMcpServer subprocess lifecycle', () => {
  let tmpDir: string;
  let socketPath: string;
  let orchServer: net.Server;
  let acceptedConnections = 0;
  const heldSockets = new Set<net.Socket>();

  /** Everything spawned by a test, killed in afterEach whatever happened. */
  const spawnedPids = new Set<number>();

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cybo-mcp-life-'));
    // Windows cannot bind a Unix socket (EACCES); the production endpoint seam
    // returns a named pipe there. The test only needs a live server for the
    // subprocess to dial — the endpoint itself is OrchSocketEndpoint's contract.
    socketPath = orchSocketEndpoint(path.join(tmpDir, 'orch.sock'));

    orchServer = net.createServer((sock) => {
      acceptedConnections += 1;
      heldSockets.add(sock);
      // The server only ever sends request/reply traffic; we answer nothing and
      // simply hold the connection open so its 'close' shutdown never fires.
      sock.on('error', () => undefined);
      sock.on('close', () => heldSockets.delete(sock));
    });

    await new Promise<void>((resolve, reject) => {
      orchServer.once('error', reject);
      orchServer.listen(socketPath, resolve);
    });
  });

  afterAll(async () => {
    for (const sock of heldSockets) sock.destroy();
    heldSockets.clear();
    await new Promise<void>((resolve) => orchServer.close(() => resolve()));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  afterEach(() => {
    for (const pid of spawnedPids) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // Already gone — the normal case.
      }
    }
    spawnedPids.clear();
  });

  function serverEnv(watchdogMs: number): NodeJS.ProcessEnv {
    return {
      ...process.env,
      CYBOFLOW_RUN_ID: 'lifecycle-test-run',
      CYBOFLOW_ORCH_SOCKET: socketPath,
      CYBOFLOW_MCP_PARENT_WATCHDOG_MS: String(watchdogMs),
    };
  }

  function spawnServer(watchdogMs: number): ChildProcess {
    const child = spawn(process.execPath, [SERVER_PATH], {
      env: serverEnv(watchdogMs),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    if (child.pid) spawnedPids.add(child.pid);
    return child;
  }

  // -------------------------------------------------------------------------

  it(
    'exits 0 on stdin EOF (the fast path)',
    async () => {
      const before = acceptedConnections;
      const child = spawnServer(1_000);
      const exited = onExit(child);

      // main() waits 100ms for the IPC socket, then connects the stdio
      // transport — which is what puts stdin in flowing mode and makes 'end'
      // observable at all. POLL for that rather than sleeping a fixed span: a
      // loaded CI runner can miss any fixed budget, and the failure would look
      // like the fix being broken rather than the machine being slow.
      await waitFor(
        () => acceptedConnections > before,
        5_000,
        'the server to connect to the orchestrator socket',
      );
      // The transport connects a fixed 100ms after that; give it a moment so
      // stdin is genuinely flowing before EOF is delivered.
      await sleep(300);
      expect(child.exitCode).toBeNull();

      child.stdin?.end();

      const { code } = await withDeadline(exited, 5_000, 'exit after stdin EOF');
      expect(code).toBe(0);
    },
    20_000,
  );

  it(
    'STAYS ALIVE while stdin is open and the spawner is alive',
    async () => {
      // The regression guard for the whole change: an over-eager shutdown path
      // (a watchdog that mis-reads ppid, an 'end'/'close' listener that fires
      // on a healthy paused stdin) kills a server a live `claude` session is
      // still using. That is a worse bug than the orphan it replaces.
      const watchdogMs = 200;
      const before = acceptedConnections;
      const child = spawnServer(watchdogMs);

      let exit: ExitResult | null = null;
      void onExit(child).then((r) => {
        exit = r;
      });

      await sleep(watchdogMs * 12);

      expect(acceptedConnections).toBeGreaterThan(before); // it really booted
      expect(exit).toBeNull();
      expect(child.exitCode).toBeNull();
      expect(child.pid !== undefined && isAlive(child.pid)).toBe(true);
    },
    20_000,
  );

  // POSIX-only, deliberately. Windows never reparents an orphan to pid 1 —
  // measured out-of-band: a detached process whose spawner has exited still
  // reports that spawner's pid as process.ppid — so the ppid===1 signal this
  // watchdog is built on cannot fire there (parentWatchdog.ts's rationale is
  // Darwin's unconditional reparent-to-launchd). The fifo recipe below is also
  // POSIX-only (no mkfifo). The still-alive test above covers the surviving
  // no-false-kill guarantee on Windows.
  it.skipIf(process.platform === 'win32')(
    'exits when its spawner dies, with stdin still open (the ppid watchdog)',
    async () => {
      // THE TRAP THIS TEST IS BUILT AROUND. If the server's stdin ever reaches
      // EOF, the stdin fast path takes the credit and this proves nothing about
      // the watchdog. Node destroys a child's parent-side stdio pipes when that
      // child exits, so simply routing stdin through an intermediate process
      // silently produces EOF the moment the intermediate goes away.
      //
      // The recipe that avoids it: a fifo, held open O_RDWR by THIS process (a
      // fifo with a live writer never signals EOF, and O_RDWR never blocks on
      // open). An intermediate node process opens the fifo 'r', spawns the
      // server with that fd as stdin, prints the pid, and exits — leaving a
      // server whose stdin is open, whose orchestrator socket is up, and whose
      // only remaining death signal is ppid === 1.
      // Sized for CI HEADROOM, not for speed. The two waits below (finding the
      // orphan, then the attribution window) must both complete comfortably
      // before the first watchdog tick, or a slow runner turns a passing test
      // into a spurious failure: observe at ~2s + sleep 1s would cross a 2.5s
      // interval. With 6s the worst case is ~3s, leaving 3s of slack.
      const watchdogMs = 6_000;
      // How long the orphan must survive BEFORE the watchdog is due, to show
      // that no other shutdown path is doing the killing. Every competing path
      // (stdin EOF, stdin close, orchestrator socket close) fires within
      // milliseconds of the event that triggers it, so an orphan still alive
      // a full second after losing its spawner can only be waiting on the poll.
      // Measured out-of-band: with the 60 s default this orphan is still alive
      // at ppid=1 after 12 s; with a 1.5 s override it dies at ~1.8 s.
      const attributionWindowMs = 1_000;
      // Cap the hunt for the orphan independently of the watchdog interval —
      // it is normally found in a few hundred ms, and bounding it here is what
      // keeps (observe + attribute) < watchdogMs as the interval grows.
      const orphanObserveBudgetMs = 2_000;
      const fifoPath = path.join(tmpDir, 'stdin.fifo');
      fs.rmSync(fifoPath, { force: true });
      execFileSync('mkfifo', [fifoPath]);

      const intermediatePath = path.join(tmpDir, 'orphan-parent.cjs');
      fs.writeFileSync(
        intermediatePath,
        [
          "const fs = require('fs');",
          "const { spawn } = require('child_process');",
          'const [fifoPath, serverPath] = process.argv.slice(2);',
          "const stdinFd = fs.openSync(fifoPath, 'r');",
          'const child = spawn(process.execPath, [serverPath], {',
          "  stdio: [stdinFd, 'ignore', 'ignore'],",
          '  env: process.env,',
          '  detached: true,',
          '});',
          'child.unref();',
          "process.stdout.write(JSON.stringify({ pid: child.pid }) + '\\n');",
          '// uv_spawn already ran synchronously, so the server exists; leaving',
          '// now is what reparents it to launchd.',
          'process.exit(0);',
          '',
        ].join('\n'),
        'utf8',
      );

      // Our writer end. Held for the whole test so the fifo never EOFs.
      const writerFd = fs.openSync(fifoPath, fs.constants.O_RDWR);

      let serverPid: number | undefined;
      try {
        const intermediate = spawn(
          process.execPath,
          [intermediatePath, fifoPath, SERVER_PATH],
          { env: serverEnv(watchdogMs), stdio: ['ignore', 'pipe', 'pipe'] },
        );
        if (intermediate.pid) spawnedPids.add(intermediate.pid);

        let stdout = '';
        intermediate.stdout?.on('data', (chunk: Buffer) => {
          stdout += chunk.toString('utf8');
        });
        const intermediateExit = await withDeadline(
          onExit(intermediate),
          10_000,
          'intermediate spawner to exit',
        );
        expect(intermediateExit.code).toBe(0);

        const parsed = JSON.parse(stdout.trim()) as { pid?: number };
        serverPid = parsed.pid;
        expect(typeof serverPid).toBe('number');
        if (serverPid === undefined) throw new Error('intermediate reported no pid');
        spawnedPids.add(serverPid);

        // PRECONDITION, NOT DECORATION. Without proving we saw the server ALIVE
        // and ALREADY REPARENTED (ppid === 1), "it is gone" is vacuously true —
        // a server that died at boot for an unrelated reason would pass. Fail
        // loudly if the orphan state is never observed.
        let observedOrphanAlive = false;
        const orphanDeadline = Date.now() + orphanObserveBudgetMs;
        while (Date.now() < orphanDeadline) {
          const ppid = ppidOf(serverPid);
          if (ppid === 1) {
            observedOrphanAlive = true;
            break;
          }
          if (ppid === null) break; // already gone — never observed as an orphan
          await sleep(25);
        }
        expect(
          observedOrphanAlive,
          'never observed the server ALIVE with ppid===1; the orphan state this ' +
            'test asserts on was never reached, so a passing "it exited" assertion ' +
            'would prove nothing',
        ).toBe(true);

        // ATTRIBUTION. The orphan survives well past the point where any
        // faster shutdown path would have fired, so the exit asserted below is
        // the watchdog's doing rather than an incidental stdin/socket EOF that
        // this setup failed to rule out.
        await sleep(attributionWindowMs);
        expect(
          isAlive(serverPid),
          `orphan died within ${attributionWindowMs}ms of losing its spawner, well ` +
            `before the ${watchdogMs}ms watchdog was due — some OTHER shutdown path ` +
            `killed it, so this test is not exercising the ppid watchdog`,
        ).toBe(true);

        // Now the actual claim: the watchdog notices and the process goes away.
        const exitDeadline = Date.now() + watchdogMs * 6;
        let gone = false;
        while (Date.now() < exitDeadline) {
          if (!isAlive(serverPid)) {
            gone = true;
            break;
          }
          await sleep(50);
        }
        expect(
          gone,
          `orphaned server pid ${serverPid} was still alive ${watchdogMs * 6}ms after ` +
            `losing its spawner (watchdog interval ${watchdogMs}ms)`,
        ).toBe(true);
      } finally {
        fs.closeSync(writerFd);
        fs.rmSync(fifoPath, { force: true });
        fs.rmSync(intermediatePath, { force: true });
      }
    },
    30_000,
  );
});
