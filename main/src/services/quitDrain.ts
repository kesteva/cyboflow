/**
 * Quit-drain sequencing.
 *
 * Electron's `before-quit` handler is SYNCHRONOUS in the only sense that
 * matters: returning a promise from it does not delay the quit. The single
 * lever that holds a quit open is `event.preventDefault()`. An `async`
 * `before-quit` listener therefore does not "drain on quit" at all — every
 * `await` after the first one runs in a race with Electron closing windows and
 * tearing the Node environment down.
 *
 * That race is not theoretical. It produced two live defects:
 *
 *   - CYBOFLOW-APP-12, a fatal abort inside our own browser process
 *     (`crash_source: app`) on the shutdown path — `ShutdownThreadsAndCleanUp`
 *     → `node::FreeEnvironment` → `Environment::CleanupHandles` → `uv_run` →
 *     `v8impl::ThreadSafeFunction::AsyncCb` → `__cxa_throw` → `std::__terminate`
 *     → `abort`. A native addon's napi ThreadSafeFunction callback fired into an
 *     environment that was already being disposed.
 *   - CYBOFLOW-APP-M, runs found still `running` on the next boot and
 *     reclassified `interrupted (app_restart, unresumable)` — the orchestrator
 *     stop that was supposed to settle them never finished before the process
 *     went away.
 *
 * The fix is the standard two-pass shape: preventDefault the first quit, run the
 * teardown to completion, then let the second quit through. This module owns the
 * part of that worth testing — running the teardown exactly once, surviving its
 * failure, and refusing to hold the quit open forever.
 */

/**
 * How long the teardown may run before the quit proceeds regardless.
 *
 * A wedged teardown must never leave a user unable to quit their app, so this is
 * a hard ceiling, not a suggestion. It is generous because the sequence legitimately
 * does slow work (killing remote OMP fleet workers, draining run queues, sweeping
 * detached prototype servers). Blowing through it re-opens the shutdown race for
 * that one quit — strictly better than the previous behaviour, which re-opened it
 * for EVERY quit.
 */
export const QUIT_DRAIN_TIMEOUT_MS = 10_000;

interface QuitDrainLogger {
  info?(message: string): void;
  warn?(message: string, error?: unknown): void;
}

/**
 * The logger the quit path should use: `console`, not the file Logger — the
 * teardown closes the Logger as its last step, and index.ts's console
 * overrides already route to it while it is open.
 */
export const consoleQuitDrainLogger: QuitDrainLogger = {
  info: (message) => console.log(message),
  warn: (message, error) => (error === undefined ? console.warn(message) : console.warn(message, error)),
};

/**
 * How long the process may take to actually exit AFTER `finish` has re-issued
 * the quit before `forceExit` is called.
 *
 * QUIT_DRAIN_TIMEOUT_MS bounds only our own teardown. Once the quit is
 * re-issued, Electron still has to run `will-quit` → `quit` → browser shutdown
 * → `node::FreeEnvironment`, and none of that is under our control. During the
 * #19 index.ts split a build was observed, for about forty minutes and 9/9
 * reproducibly, logging `will-quit` and then never exiting — a zombie the user
 * had to force-quit. It then stopped reproducing (20/20 clean, with and without
 * CPU load) and the mechanism was never identified. The watchdog is the
 * mechanism-independent backstop: whatever is wedged, the process ends.
 *
 * The budget sits above the @sentry/electron `will-quit` handler, which in a
 * packaged build preventDefaults the quit, flushes the session (bounded at 2s),
 * and then calls `app.exit()` itself — forcing the exit before that completes
 * would lose the session end for every quit.
 */
export const QUIT_EXIT_WATCHDOG_MS = 5_000;

/**
 * Run `drain` to completion (or to `timeoutMs`, whichever comes first), then call
 * `finish` exactly once.
 *
 * `finish` is called on every path — clean completion, a rejected drain, or the
 * timeout — because the alternative to quitting is an app the user cannot close.
 * A drain still pending at the timeout is deliberately NOT cancelled: there is no
 * safe way to abort a half-finished teardown, and the process is about to end.
 *
 * Never throws: a failure inside `drain` is logged and swallowed, exactly as the
 * inline teardown it replaces did.
 *
 * When `forceExit` is given, a one-shot watchdog is armed right after `finish`
 * (see QUIT_EXIT_WATCHDOG_MS): if the process is still alive `exitWatchdogMs`
 * later, `forceExit` is called. On a healthy quit the process is gone long
 * before then and the timer dies with it. Deliberately NOT unref'd, for the same
 * reason as the deadline below — in the wedged state it may be the only thing
 * that gets the process out.
 */
export async function runQuitDrain(opts: {
  drain: () => Promise<void>;
  finish: () => void;
  forceExit?: () => void;
  timeoutMs?: number;
  exitWatchdogMs?: number;
  logger?: QuitDrainLogger;
}): Promise<void> {
  const { drain, finish, forceExit, logger } = opts;
  const timeoutMs = opts.timeoutMs ?? QUIT_DRAIN_TIMEOUT_MS;
  const exitWatchdogMs = opts.exitWatchdogMs ?? QUIT_EXIT_WATCHDOG_MS;

  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;

  // NOT unref'd on purpose. If the teardown hangs on a promise that never
  // settles, this timer may be the only handle keeping the process alive long
  // enough to reach `finish` — unref'ing it would let the loop empty out and
  // hand us back the very race this exists to close.
  const deadline = new Promise<void>((resolve) => {
    timer = setTimeout(() => {
      timedOut = true;
      resolve();
    }, timeoutMs);
  });

  const running = (async () => {
    try {
      await drain();
    } catch (error) {
      logger?.warn?.('[QuitDrain] teardown failed; quitting anyway', error);
    }
  })();

  await Promise.race([running, deadline]);
  if (timer) clearTimeout(timer);

  if (timedOut) {
    logger?.warn?.(
      `[QuitDrain] teardown still running after ${timeoutMs}ms; quitting without waiting further`,
    );
  } else {
    logger?.info?.('[QuitDrain] teardown complete');
  }

  finish();

  if (forceExit) {
    setTimeout(() => {
      logger?.warn?.(
        `[QuitDrain] process still alive ${exitWatchdogMs}ms after the drained quit was re-issued; forcing exit`,
      );
      forceExit();
    }, exitWatchdogMs);
  }
}
