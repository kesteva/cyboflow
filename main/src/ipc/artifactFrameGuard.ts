/**
 * artifactFrameGuard — confine a static-mockup `ui-prototype`/`generic` artifact
 * frame to its own document (IDEA-039 / Approach C security).
 *
 * A static mockup renders via `<iframe srcDoc sandbox="">` (url `about:srcdoc`).
 * The bare sandbox disables scripts and the injected CSP `<meta>` blocks
 * subresource fetches, but NEITHER stops a USER-initiated link navigation: a
 * prototype's `<a href="https://attacker/beacon">` click would navigate the
 * frame itself and issue a network request the CSP no longer governs. The main
 * process therefore intercepts `will-frame-navigate` and blocks any navigation of
 * an `about:srcdoc` frame to a non-`about:` URL.
 *
 * Scope is deliberately narrow (only `about:srcdoc` sub-frames): the app's own
 * main frame and the LEGACY localhost dev-server prototype iframe (a real
 * cross-origin app at `http://localhost:…`, which legitimately navigates itself)
 * are left untouched.
 */

/**
 * Whether a `will-frame-navigate` should be BLOCKED. Pure so it can be unit
 * tested without Electron.
 *
 * @param frameUrl    the current url of the frame being navigated (`details.frame?.url`)
 * @param targetUrl   the url it wants to navigate to (`details.url`)
 * @param isMainFrame whether the navigating frame is the top frame (`details.isMainFrame`)
 */
export function shouldBlockArtifactFrameNavigation(
  frameUrl: string,
  targetUrl: string,
  isMainFrame: boolean,
): boolean {
  // Never confine the app's own top frame.
  if (isMainFrame) return false;
  // Only static-mockup srcdoc frames — a localhost dev-server frame (http(s)) or
  // any other sub-frame is left alone.
  if (!frameUrl.startsWith('about:srcdoc')) return false;
  // Allow the initial `about:srcdoc` load and `about:blank` — block everything
  // else (http(s), data:, file:, custom schemes) so nothing leaves the frame.
  if (targetUrl.startsWith('about:')) return false;
  return true;
}

/** Whether a blocked target should instead be offered to the OS browser. */
export function isExternallyOpenable(targetUrl: string): boolean {
  return /^https?:\/\//i.test(targetUrl);
}
