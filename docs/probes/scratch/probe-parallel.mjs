// @ts-nocheck
/**
 * IDEA-013 Probe H (TASK-805) — BUSINESS-RISK GATE. THROWAWAY, not wired into the build.
 *
 * Spawns N parallel PTY-driven INTERACTIVE `claude` sessions (no -p) against the CURRENTLY
 * LOGGED-IN plan, sends one benign prompt to each, and records whether they all complete or
 * hit rate-limit / usage-limit / throttle responses. This mirrors how InteractiveClaudeManager
 * will drive `claude`, so it is the most representative concurrency test.
 *
 * Usage:   node docs/probes/scratch/probe-parallel.mjs [N=4]
 *
 * node-pty ABI note: @homebridge/node-pty-prebuilt-multiarch is built for the Electron ABI.
 * If you hit NODE_MODULE_VERSION, run `pnpm rebuild @homebridge/node-pty-prebuilt-multiarch`
 * for host node first (mirror of the better-sqlite3 note in CLAUDE.md).
 *
 * tmux FALLBACK (zero node deps) if the above is painful:
 *   for i in 1 2 3 4; do tmux new-session -d -s "claude$i" "claude"; done
 *   # then `tmux attach -t claude1` etc., send the prompt, and watch each for rate-limit text.
 *
 * THIS PROBE CONSUMES REAL SUBSCRIPTION ALLOWANCE. Read support.claude.com/articles/15036540
 * (blesses interactive terminal/IDE use; SILENT on automated/parallel/headless driving) and
 * get an explicit USER go/no-go before relying on the result.
 */
import process from 'node:process';

const N = Number.parseInt(process.argv[2] || '4', 10) || 4;
const PROMPT = 'List the files in the current directory, then say DONE_PROBE_MARKER on its own line.';
const PER_SESSION_TIMEOUT_MS = 120_000;
const QUIESCENCE_MS = 6_000; // no output for this long after first output => treat as turn finished
const RATE_LIMIT_RE = /(rate.?limit|usage limit|too many requests|quota|reached your .* limit|429|overloaded|capacity)/i;

const loadPty = async () => {
  try {
    return await import('@homebridge/node-pty-prebuilt-multiarch');
  } catch (err) {
    console.error('Could not load node-pty. Run `pnpm rebuild @homebridge/node-pty-prebuilt-multiarch`');
    console.error('for host node, or use the tmux fallback in this file header.\n', String(err));
    process.exit(1);
  }
};

const runSession = (pty, idx) => new Promise((resolve) => {
  const result = {
    idx, started: Date.now(), firstOutputMs: null, finishedMs: null,
    sawRateLimit: false, sawDoneMarker: false, exitCode: null, timedOut: false, bytes: 0,
  };
  let buf = '';
  let quiesceTimer = null;

  const term = pty.spawn('claude', [], {
    name: 'xterm-color', cols: 100, rows: 30, cwd: process.cwd(), env: process.env,
  });

  const finish = (reason) => {
    if (result.finishedMs) return;
    result.finishedMs = Date.now() - result.started;
    result.finishReason = reason;
    try { term.kill(); } catch { /* ignore */ }
    resolve(result);
  };

  const hardTimer = setTimeout(() => { result.timedOut = true; finish('timeout'); }, PER_SESSION_TIMEOUT_MS);

  term.onData((data) => {
    if (result.firstOutputMs === null) result.firstOutputMs = Date.now() - result.started;
    result.bytes += data.length;
    buf += data;
    if (RATE_LIMIT_RE.test(data)) result.sawRateLimit = true;
    if (buf.includes('DONE_PROBE_MARKER')) { result.sawDoneMarker = true; clearTimeout(hardTimer); finish('done-marker'); return; }
    // Reset a quiescence timer: if output stops for QUIESCENCE_MS after we've seen some, call it.
    if (quiesceTimer) clearTimeout(quiesceTimer);
    quiesceTimer = setTimeout(() => { clearTimeout(hardTimer); finish('quiescence'); }, QUIESCENCE_MS);
  });

  term.onExit(({ exitCode }) => { result.exitCode = exitCode; clearTimeout(hardTimer); finish('exit'); });

  // Send the prompt shortly after spawn so the REPL is ready.
  setTimeout(() => { try { term.write(PROMPT + '\r'); } catch { /* ignore */ } }, 1500);
});

const main = async () => {
  const pty = await loadPty();
  console.log(`Probe H: launching ${N} parallel interactive \`claude\` sessions against the current plan...`);
  console.log(`(consumes real allowance; per-session timeout ${PER_SESSION_TIMEOUT_MS / 1000}s)\n`);

  const results = await Promise.all(Array.from({ length: N }, (_, i) => runSession(pty, i + 1)));

  console.log('\n=== RESULTS ===');
  console.log('idx | firstOut(ms) | finished(ms) | reason       | rateLimit | doneMarker | exit | bytes');
  for (const r of results) {
    console.log(
      `${String(r.idx).padStart(3)} | ${String(r.firstOutputMs ?? '-').padStart(12)} | ` +
      `${String(r.finishedMs ?? '-').padStart(12)} | ${String(r.finishReason ?? '-').padEnd(12)} | ` +
      `${String(r.sawRateLimit).padStart(9)} | ${String(r.sawDoneMarker).padStart(10)} | ` +
      `${String(r.exitCode ?? '-').padStart(4)} | ${r.bytes}`,
    );
  }
  const limited = results.filter((r) => r.sawRateLimit).length;
  const completed = results.filter((r) => r.sawDoneMarker).length;
  console.log(`\nSUMMARY: ${completed}/${N} reached the DONE marker; ${limited}/${N} saw rate/usage-limit text.`);
  console.log('VERDICT for findings (Probe H): record whether all N completed or any hit rate-limit/throttle/');
  console.log('concurrency caps + any usage-limit responses, cite support.claude.com/articles/15036540, and');
  console.log('capture an EXPLICIT dated USER go/no-go sign-off (or a recorded ship-as-UNCONFIRMED decision).');
};

main().catch((err) => { console.error(String(err)); process.exit(1); });
