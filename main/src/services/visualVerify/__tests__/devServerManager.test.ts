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
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DevServerManager, interpolatePort } from '../devServerManager';
import type { DeliverableVerifyConfig } from '../../../../../shared/types/visualVerification';

/** node -e wrapper so a shell command is a self-contained throwaway server. */
function nodeScript(body: string): string {
  // Single-quote-safe: the body must not contain single quotes (ours don't).
  return `node -e '${body}'`;
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
      const start = nodeScript(
        `const fs=require("fs");` +
          `fs.writeFileSync(process.env.OUTFILE, JSON.stringify({argv:process.argv.slice(1),port:process.env.PORT}));` +
          `console.log("SERVER READY");` +
          `setInterval(()=>{},1000);`,
      );
      // A literal ${PORT} placeholder appended as a positional arg → interpolatePort
      // must turn it into 5173 (asserted via the recorded argv below). Passed bare
      // (not behind --port) so `node -e 'script' 5173` makes 5173 a script argv, not
      // an unrecognized node CLI flag.
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
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('resolves the spawn once the readyWhen token appears on stdout', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cvv-dev-'));
    try {
      // Emit the token only after a short delay, proving readiness WAITS for it.
      const start = nodeScript(
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
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('runs the build command to completion BEFORE start', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cvv-dev-'));
    try {
      const marker = join(dir, 'built.txt');
      // build writes a marker file + exits 0.
      const build = nodeScript(
        `require("fs").writeFileSync(process.argv[1],"ok")`,
      );
      // start asserts the marker EXISTS (build ran first), echoes ready, stays up.
      const start = nodeScript(
        `if(!require("fs").existsSync(process.argv[1]))process.exit(7);` +
          `console.log("UP");setInterval(()=>{},1000);`,
      );
      const mgr = new DevServerManager(FAST);
      const handle = await mgr.spawn({
        config: deliverable({
          build: `${build} ${marker}`,
          start: `${start} ${marker}`,
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
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('rejects (without spawning start) when the build command fails', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cvv-dev-'));
    try {
      const build = nodeScript(`process.exit(2)`);
      const start = nodeScript(`console.log("UP");setInterval(()=>{},1000);`);
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
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('release() tears the dev-server process tree down', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cvv-dev-'));
    try {
      const start = nodeScript(`console.log("UP");setInterval(()=>{},1000);`);
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
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('an already-aborted signal interrupts the spawn before start', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cvv-dev-'));
    try {
      const start = nodeScript(`console.log("UP");setInterval(()=>{},1000);`);
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
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('an AbortSignal interrupts an in-flight (never-ready) spawn cleanly', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cvv-dev-'));
    try {
      // A server that NEVER emits the readyWhen token — readiness would hang until
      // the deadline; aborting mid-flight must reject promptly + tear it down.
      const start = nodeScript(`setInterval(()=>{},1000);`);
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
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('uses the injected httpProbe for the default (no readyWhen) readiness path', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cvv-dev-'));
    try {
      const start = nodeScript(`setInterval(()=>{},1000);`);
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
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('honors an explicit url (with ${PORT}) over the default localhost baseUrl', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cvv-dev-'));
    try {
      const start = nodeScript(`console.log("UP");setInterval(()=>{},1000);`);
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
      await rm(dir, { recursive: true, force: true });
    }
  });
});
