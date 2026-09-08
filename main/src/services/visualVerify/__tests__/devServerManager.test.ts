/**
 * DevServerManager (S2) unit tests.
 *
 * These exercise the REAL spawn/teardown orchestration against tiny FAKE dev
 * servers written as inline `node -e` scripts (NOT a real Vite/CRA server) so the
 * suite is fast + hermetic:
 *   - ${PORT}/$PORT interpolation in the start command (interpolatePort + a script
 *     that echoes process.argv).
 *   - the PORT env var is set in the spawned process.
 *   - readyWhen token detection on stdout resolves the spawn.
 *   - the optional build command runs to completion BEFORE start.
 *   - release() tears the spawned process tree down (the long-lived server exits).
 *   - an AbortSignal interrupts an in-flight (never-ready) spawn cleanly.
 *
 * The default (no readyWhen) HTTP-poll path is covered with an injected fake
 * httpProbe so no real socket is opened.
 */
import { describe, it, expect, vi } from 'vitest';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DevServerManager, interpolatePort } from '../devServerManager';
import type { DeliverableVerifyConfig } from '../../../../../shared/types/visualVerification';
import { isAlive, spawnDetachedGrandchildTree, waitUntil } from '../../../__test_fixtures__/processTree';

/**
 * Write the script body to a real file and reference it as `node "<path>"`.
 * The old fixture inline'd the body as `node -e '<body>'` — POSIX single
 * quoting, which cmd.exe (the Windows `shell: true` host) passes through
 * literally, so node evaluated a quote-wrapped body and died with a SyntaxError
 * before emitting any readyWhen token. A file needs no shell quoting anywhere.
 */
async function nodeScript(dir: string, name: string, body: string): Promise<string> {
  const file = join(dir, name);
  await writeFile(file, body, 'utf-8');
  return `node "${file}"`;
}

/**
 * rm with retries: on Windows the taskkill /T /F teardown of the spawned tree
 * completes asynchronously, so a dying process can still hold its cwd when the
 * finally-block cleanup runs. The retries absorb that race without masking a
 * real leak — a tree taskkill failed to kill still trips the final rm.
 */
async function rmDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

const FAST = { readyTimeoutMs: 3_000, teardownGraceMs: 200, readyPollIntervalMs: 50 };

function deliverable(over: Partial<DeliverableVerifyConfig>): DeliverableVerifyConfig {
  return { id: 'web', ...over };
}

describe('interpolatePort', () => {
  it('replaces ${PORT} and $PORT with the leased port', () => {
    expect(interpolatePort('serve --port ${PORT}', 5173)).toBe('serve --port 5173');
    expect(interpolatePort('serve --port $PORT', 5173)).toBe('serve --port 5173');
    expect(interpolatePort('a ${PORT} b $PORT c', 3000)).toBe('a 3000 b 3000 c');
  });
});

describe('DevServerManager', () => {
  it('interpolates ${PORT} in the start command and sets the PORT env var', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cvv-dev-'));
    try {
      const out = join(dir, 'out.txt');
      // The server records its argv (proves ${PORT} interpolation) + PORT env
      // (proves the env var is set), writes a readyWhen token, then stays alive.
      const start = await nodeScript(
        dir,
        'start.js',
        `const fs=require("fs");` +
          `fs.writeFileSync(process.env.OUTFILE, JSON.stringify({argv:process.argv.slice(1),port:process.env.PORT}));` +
          `console.log("SERVER READY");` +
          `setInterval(()=>{},1000);`,
      );
      // A literal ${PORT} placeholder appended as a positional arg → interpolatePort
      // must turn it into 5173 (asserted via the recorded argv below).
      const startWithPort = `${start} \${PORT}`;
      const mgr = new DevServerManager(FAST);
      const signal = new AbortController().signal;
      // OUTFILE travels through the env merge in spawn(); set it on this process
      // env so the child inherits it (DevServerManager spreads process.env).
      process.env.OUTFILE = out;
      const handle = await mgr.spawn({
        config: deliverable({ start: startWithPort, readyWhen: 'SERVER READY' }),
        port: 5173,
        cwd: dir,
        signal,
      });
      try {
        const recorded = JSON.parse(await readFile(out, 'utf-8')) as {
          argv: string[];
          port: string;
        };
        // The trailing ${PORT} was interpolated to 5173 and passed as an arg.
        expect(recorded.argv).toContain('5173');
        // PORT env var set to the leased port.
        expect(recorded.port).toBe('5173');
        expect(handle.baseUrl).toBe('http://localhost:5173');
      } finally {
        await handle.release();
        delete process.env.OUTFILE;
      }
    } finally {
      await rmDir(dir);
    }
  });

  it('resolves the spawn once the readyWhen token appears on stdout', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cvv-dev-'));
    try {
      // Emit the token only after a short delay, proving readiness WAITS for it.
      const start = await nodeScript(
        dir,
        'start.js',
        `setTimeout(()=>console.log("LISTENING ON PORT"),100);setInterval(()=>{},1000);`,
      );
      const mgr = new DevServerManager(FAST);
      const t0 = Date.now();
      const handle = await mgr.spawn({
        config: deliverable({ start, readyWhen: 'LISTENING ON PORT' }),
        port: 4173,
        cwd: dir,
        signal: new AbortController().signal,
      });
      try {
        expect(Date.now() - t0).toBeGreaterThanOrEqual(90);
        expect(handle.baseUrl).toBe('http://localhost:4173');
      } finally {
        await handle.release();
      }
    } finally {
      await rmDir(dir);
    }
  });

  it('runs the build command to completion BEFORE start', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cvv-dev-'));
    try {
      const marker = join(dir, 'built.txt');
      // build writes a marker file + exits 0. With the body in a file
      // (`node build.js <marker>`) the first CLI arg lands at argv[2] — the
      // inline `-e` form had it at argv[1].
      const build = await nodeScript(dir, 'build.js', `require("fs").writeFileSync(process.argv[2],"ok")`);
      // start asserts the marker EXISTS (build ran first), echoes ready, stays up.
      const start = await nodeScript(
        dir,
        'start.js',
        `if(!require("fs").existsSync(process.argv[2]))process.exit(7);` +
          `console.log("UP");setInterval(()=>{},1000);`,
      );
      const mgr = new DevServerManager(FAST);
      const handle = await mgr.spawn({
        config: deliverable({
          build: `${build} "${marker}"`,
          start: `${start} "${marker}"`,
          readyWhen: 'UP',
        }),
        port: 3000,
        cwd: dir,
        signal: new AbortController().signal,
      });
      try {
        // The marker exists → build ran before start (start would have exit 7 else,
        // surfacing as a rejected spawn rather than this resolved handle).
        expect(await readFile(marker, 'utf-8')).toBe('ok');
      } finally {
        await handle.release();
      }
    } finally {
      await rmDir(dir);
    }
  });

  it('rejects (without spawning start) when the build command fails', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cvv-dev-'));
    try {
      const build = await nodeScript(dir, 'build.js', `process.exit(2)`);
      const start = await nodeScript(dir, 'start.js', `console.log("UP");setInterval(()=>{},1000);`);
      const mgr = new DevServerManager(FAST);
      await expect(
        mgr.spawn({
          config: deliverable({ build, start, readyWhen: 'UP' }),
          port: 3000,
          cwd: dir,
          signal: new AbortController().signal,
        }),
      ).rejects.toThrow(/build failed/i);
    } finally {
      await rmDir(dir);
    }
  });

  it('release() tears the dev-server process tree down', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cvv-dev-'));
    try {
      const start = await nodeScript(dir, 'start.js', `console.log("UP");setInterval(()=>{},1000);`);
      const mgr = new DevServerManager(FAST);
      const handle = await mgr.spawn({
        config: deliverable({ start, readyWhen: 'UP' }),
        port: 8080,
        cwd: dir,
        signal: new AbortController().signal,
      });
      // The long-lived server is up; release() must SIGTERM/SIGKILL the tree. We
      // assert release resolves (the grace+kill completes) without hanging.
      await expect(handle.release()).resolves.toBeUndefined();
      // Idempotent: a second release is a no-op.
      await expect(handle.release()).resolves.toBeUndefined();
    } finally {
      await rmDir(dir);
    }
  });

  it('an already-aborted signal interrupts the spawn before start', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cvv-dev-'));
    try {
      const start = await nodeScript(dir, 'start.js', `console.log("UP");setInterval(()=>{},1000);`);
      const mgr = new DevServerManager(FAST);
      const ac = new AbortController();
      ac.abort();
      await expect(
        mgr.spawn({
          config: deliverable({ start, readyWhen: 'UP' }),
          port: 8080,
          cwd: dir,
          signal: ac.signal,
        }),
      ).rejects.toThrow(/aborted/i);
    } finally {
      await rmDir(dir);
    }
  });

  it('an AbortSignal interrupts an in-flight (never-ready) spawn cleanly', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cvv-dev-'));
    try {
      // A server that NEVER emits the readyWhen token — readiness would hang until
      // the deadline; aborting mid-flight must reject promptly + tear it down.
      const start = await nodeScript(dir, 'start.js', `setInterval(()=>{},1000);`);
      const mgr = new DevServerManager({ ...FAST, readyTimeoutMs: 10_000 });
      const ac = new AbortController();
      const p = mgr.spawn({
        config: deliverable({ start, readyWhen: 'NEVER_APPEARS' }),
        port: 8080,
        cwd: dir,
        signal: ac.signal,
      });
      setTimeout(() => ac.abort(), 150);
      await expect(p).rejects.toThrow(/aborted/i);
    } finally {
      await rmDir(dir);
    }
  });

  it('uses the injected httpProbe for the default (no readyWhen) readiness path', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cvv-dev-'));
    try {
      const start = await nodeScript(dir, 'start.js', `setInterval(()=>{},1000);`);
      let probeCalls = 0;
      const httpProbe = vi.fn(async () => {
        probeCalls += 1;
        return probeCalls >= 2; // answers on the second poll
      });
      const mgr = new DevServerManager({ ...FAST, httpProbe });
      const handle = await mgr.spawn({
        config: deliverable({ start }), // NO readyWhen → HTTP poll path
        port: 5173,
        cwd: dir,
        signal: new AbortController().signal,
      });
      try {
        expect(httpProbe).toHaveBeenCalled();
        expect(handle.baseUrl).toBe('http://localhost:5173');
      } finally {
        await handle.release();
      }
    } finally {
      await rmDir(dir);
    }
  });

  it('honors an explicit url (with ${PORT}) over the default localhost baseUrl', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cvv-dev-'));
    try {
      const start = await nodeScript(dir, 'start.js', `console.log("UP");setInterval(()=>{},1000);`);
      const mgr = new DevServerManager(FAST);
      const handle = await mgr.spawn({
        config: deliverable({ start, readyWhen: 'UP', url: 'http://127.0.0.1:${PORT}/sub' }),
        port: 4321,
        cwd: dir,
        signal: new AbortController().signal,
      });
      try {
        expect(handle.baseUrl).toBe('http://127.0.0.1:4321/sub');
      } finally {
        await handle.release();
      }
    } finally {
      await rmDir(dir);
    }
  });
});

// ---------------------------------------------------------------------------
// win32 tree teardown (runs only on Windows hosts — the platform where the
// negative-pid group kill is a no-op and the taskkill arm is load-bearing)
// ---------------------------------------------------------------------------

describe('DevServerManager — win32 tree teardown', () => {
  it.skipIf(process.platform !== 'win32')(
    'signalTree reaps a real parent+grandchild tree via taskkill /T /F',
    async () => {
      const { spawn } = await import('node:child_process');
      const mgr = new DevServerManager(FAST);
      // A REAL node child that spawns its own long-lived detached grandchild.
      const child = spawnDetachedGrandchildTree();
      const pid = child.pid;
      expect(pid).toBeTypeOf('number');

      // Positive control via the shared process table: the grandchild exists.
      const { collectDescendantPids } = await import('../../processTable');
      const { listPidPpidTableSync } = await import('../../../utils/platformProcess');
      let grandkids: number[] = [];
      for (let i = 0; i < 15 && grandkids.length === 0; i++) {
        await new Promise((r) => setTimeout(r, 200));
        grandkids = collectDescendantPids(pid as number, listPidPpidTableSync());
      }
      expect(grandkids.length).toBeGreaterThanOrEqual(1);

      (mgr as unknown as {
        signalTree: (child: { pid?: number }, sig: NodeJS.Signals) => void;
      }).signalTree(child, 'SIGTERM');

      const allDead = await waitUntil(
        () => !isAlive(pid as number) && grandkids.every((g) => !isAlive(g)),
        8000,
      );
      expect(allDead).toBe(true);
    },
    30000,
  );
});
