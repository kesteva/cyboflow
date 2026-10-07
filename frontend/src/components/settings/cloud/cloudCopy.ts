/** User-facing copy for cyboflow cloud failures. Fixed strings only: server text never reaches the UI. */
import type { CloudLastError, CloudSignInFailureCode } from '../../../../../shared/types/cloudAccountWire';

const SIGN_IN_FAILURE_COPY: Record<CloudSignInFailureCode, string> = {
  cancelled: 'Sign-in was cancelled.',
  timed_out: "Sign-in timed out. Start again when you're ready.",
  browser_open_failed:
    "cyboflow couldn't open your browser. Check that a default browser is set, then try again.",
  loopback_failed: "cyboflow couldn't start the local sign-in listener. Try again.",
  invalid_callback: 'The browser returned an unexpected response. Start signing in again from here.',
  browser_error: 'The browser returned an unexpected response. Start signing in again from here.',
  invalid_code: 'The sign-in link expired or was already used. Start again.',
  bad_request: 'Something went wrong while registering this computer. Try again.',
  bad_response: 'Something went wrong while registering this computer. Try again.',
  unexpected: 'Something went wrong while registering this computer. Try again.',
  ref_code_taken: 'That ref code was just taken by another computer. Sign in again and choose another code.',
  upgrade_required: 'Update cyboflow to sign in.',
  rate_limited: 'Too many sign-in attempts. Wait a minute and try again.',
  service_unavailable: 'cyboflow cloud is unavailable right now. Try again in a few minutes.',
  network: "Couldn't reach cyboflow cloud. Check your connection and try again.",
  secrets_unavailable: "Your OS keychain isn't available, so the sign-in can't be stored securely.",
  not_available: 'Turn on Agents & Environments to use cyboflow cloud.',
};

export function signInFailureCopy(code: CloudSignInFailureCode): string {
  return SIGN_IN_FAILURE_COPY[code] ?? 'Something went wrong while signing in. Try again.';
}

export function cloudErrorCopy(err: CloudLastError): string {
  switch (err.kind) {
    case 'network':
      return "Couldn't reach cyboflow cloud. Check your connection and try again.";
    case 'auth':
      return "cyboflow cloud didn't accept this computer's sign-in.";
    case 'revoked':
      return 'This computer was signed out of cyboflow cloud.';
    case 'not_entitled':
      return "The cyboflow Bridge is in private beta and isn't enabled for this account yet.";
    case 'upgrade_required':
      return 'Update cyboflow to keep using cyboflow cloud.';
    case 'retryable':
      return 'cyboflow cloud is unavailable right now. Try again in a few minutes.';
    case 'terminal':
    default:
      return 'Something went wrong talking to cyboflow cloud.';
  }
}

export function platformLabel(platform: string | null): string {
  if (platform === null || platform === '') return 'Unknown platform';
  switch (platform) {
    case 'darwin':
      return 'macOS';
    case 'win32':
      return 'Windows';
    case 'linux':
      return 'Linux';
    default:
      return platform.slice(0, 24);
  }
}

/** "in 9 minutes" / "in less than a minute" / "soon": for a deadline that is (normally) in the future. */
export function formatExpiry(iso: string, now: Date = new Date()): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return 'soon';
  const ms = t - now.getTime();
  if (ms <= 0) return 'soon';
  const minutes = Math.ceil(ms / 60_000);
  if (minutes <= 1) return 'in less than a minute';
  return `in ${minutes} minutes`;
}
