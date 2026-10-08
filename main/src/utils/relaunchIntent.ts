/**
 * A user-requested restart that runs the normal quit drain (`app:relaunch` with `graceful`).
 *
 * `app.relaunch()` cannot be taken back, so it is armed only at the points where the process really exits.
 * A quit the user cancels (the archive-in-progress "Wait") clears the request instead, so a later ordinary
 * quit does not restart the app.
 */
let requested = false;

export function requestRelaunchOnQuit(): void {
  requested = true;
}

export function cancelRelaunchOnQuit(): void {
  requested = false;
}

/** Call right before the process exits: arms the relaunch at most once. */
export function armRelaunchIfRequested(relaunch: () => void): void {
  if (!requested) return;
  requested = false;
  relaunch();
}
