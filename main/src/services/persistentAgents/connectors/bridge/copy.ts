/** User-facing copy the Bridge connector owns (availability messages, connect conflicts). */
export const BRIDGE_COPY = {
  disabled: 'The Bridge is turned off on this computer.',
  signed_out: 'Sign in to cyboflow cloud to use the Bridge.',
  locked: 'Waiting for the cyboflow cloud sign-in to unlock.',
  secrets_unavailable: "This computer's keychain isn't available, so the Bridge is paused.",
  undecryptable: "cyboflow can't read its saved sign-in on this computer. Try again or sign in again.",
  needs_sign_in: 'This computer was signed out of cyboflow cloud. Sign in again; your threads are kept.',
  needs_update: 'Update cyboflow to keep agent messages flowing',
  not_entitled: 'The Bridge is not enabled for this account yet.',
  offline: 'Bridge offline · retrying',
  rate_limited: 'Bridge busy · retrying shortly',
  relay_unavailable: 'cyboflow cloud is unavailable · retrying',
  other_account: 'Created while signed in to a different cyboflow cloud account.',
  invalid_remote: "This connection's saved details can't be read. Disconnect it and connect again.",
  connection_limit: 'This account already has 20 Bridge connections. Disconnect one you no longer use first.',
} as const;

export type BridgeCopyKey = keyof typeof BRIDGE_COPY;

export function isBridgeCopyKey(key: string): key is BridgeCopyKey {
  return Object.prototype.hasOwnProperty.call(BRIDGE_COPY, key);
}

/** Gap note text (n = upper bound of expired messages). */
export function gapNoteText(n: number): string {
  if (n === 1) {
    return 'A message from this agent expired on the cyboflow Bridge before this computer collected it.';
  }
  return `Up to ${n} messages from this agent expired on the cyboflow Bridge before this computer collected them.`;
}
