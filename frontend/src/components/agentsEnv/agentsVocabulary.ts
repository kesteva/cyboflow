/** Vendor display vocabulary for the Agents & Environments surfaces. */
import {
  vendorAppName as sharedVendorAppName,
  type ConnectorKind,
  type PersistentAgentVendor,
  type PersistentAgentsErrorCode,
  type BridgeTransport,
} from '../../../../shared/types/persistentAgents';

export interface VendorMeta {
  label: string;
  short: string;
  /** One-character avatar glyph; '' means "first letter of the agent's name". */
  glyph: string;
  /** What the vendor's app is called in recovery copy. */
  appName: string;
  description: string;
  defaultTransport: BridgeTransport | null;
  defaultName: string;
}

export const VENDOR_ORDER: readonly PersistentAgentVendor[] = ['anthropic-cma', 'openai-dots', 'meta-muse', 'other'];

export const VENDOR_META: Record<PersistentAgentVendor, VendorMeta> = {
  'anthropic-cma': {
    label: 'Claude Managed Agents',
    short: 'Claude',
    glyph: 'A',
    appName: 'the Claude Console',
    description: 'Long-running Claude agents hosted by Anthropic. cyboflow talks to them through the API.',
    defaultTransport: null,
    defaultName: '',
  },
  'openai-dots': {
    label: 'OpenAI dots',
    short: 'dots',
    glyph: 'd',
    appName: 'ChatGPT',
    description:
      'Always-on ChatGPT agents. They have no API, so a ChatGPT custom connector calls the cyboflow Bridge.',
    defaultTransport: 'relay-mcp',
    defaultName: 'My dot',
  },
  'meta-muse': {
    label: 'Meta Muse',
    short: 'Muse',
    glyph: 'M',
    appName: 'Muse',
    description:
      "Meta's personal agent. No API or connector support, so it follows saved instructions to reach the Bridge. Best effort.",
    defaultTransport: 'relay-http',
    defaultName: 'Muse',
  },
  other: {
    label: 'Other agent (no API)',
    short: 'Agent',
    glyph: '',
    appName: "the agent's app",
    description: 'Any agent that can call a URL or use an MCP connector reaches cyboflow through the Bridge.',
    defaultTransport: 'relay-mcp',
    defaultName: '',
  },
};

/** `${short} · API|Bridge`. */
export function kindChipLabel(vendor: PersistentAgentVendor, kind: ConnectorKind): string {
  return `${VENDOR_META[vendor].short} · ${kind === 'native' ? 'API' : 'Bridge'}`;
}

/** Re-export so health copy and dialog copy name the same app. */
export const vendorAppName: (vendor: PersistentAgentVendor) => string = sharedVendorAppName;

// ---- Failure copy ----------------------------------------------------------------------

export interface FailureLike {
  error: PersistentAgentsErrorCode;
  message: string;
  field?: 'displayName' | 'handle' | 'label' | 'secret' | 'text';
}

export interface FailureCopy {
  copy: string;
  /** Which form field the copy belongs under (displayName / handle); otherwise it is a banner. */
  field: 'displayName' | 'handle' | null;
  /** The failure means this computer is not (or no longer) signed in to cyboflow cloud. */
  needsSignIn: boolean;
  /** The failure means the cloud sign-in is still locked: ask main to unlock it. */
  cloudLocked: boolean;
  /** A plain "Try again" is a sensible next step. */
  retryable: boolean;
}

const FIXED_COPY: Partial<Record<PersistentAgentsErrorCode, string>> = {
  feature_disabled: 'Agents & Environments is turned off.',
  not_found: 'This agent or connection no longer exists.',
  too_large: 'Messages can be at most 64 KB.',
  handle_taken: 'Another agent already uses this handle.',
  no_connection: "This agent isn't connected.",
  connection_revoked: "This agent's connection was revoked. Use Reconnect to keep messaging in this thread.",
  agent_archived: 'This agent was archived.',
  control_not_supported: "This agent can't be stopped from cyboflow.",
  pairing_not_supported: "This connection doesn't use a pairing code.",
  cloud_locked: 'Unlocking your cyboflow cloud sign-in. Try again in a moment.',
  not_entitled: "The cyboflow Bridge is in private beta and isn't enabled for this account yet.",
  rate_limited: 'Too many requests to the Bridge. Wait a minute and try again.',
  service_unavailable: "Couldn't reach the cyboflow Bridge. Check your connection and try again.",
  connection_limit: 'This account already has 20 Bridge connections. Disconnect one you no longer use first.',
  connection_gone: 'This connection no longer exists on the Bridge. Close this and connect again.',
  auth_rejected: 'The API key was rejected. Rotate it in Settings → Integrations.',
  secrets_unavailable: "This computer's keychain isn't available, so cyboflow can't store this safely.",
  credential_undecryptable: "The stored key can't be read on this computer. Re-enter it.",
};

/** Codes whose copy is the server/connector message verbatim. */
const VERBATIM: ReadonlySet<PersistentAgentsErrorCode> = new Set<PersistentAgentsErrorCode>([
  'swap_in_progress',
  'no_swap_in_progress',
  'connector_unavailable',
  'connector_disabled',
  'other_account',
  'upgrade_required',
  'conflict',
]);

/** Map a persistentAgents failure (or a renderer-local one) to its user-facing copy. */
export function failureCopy(f: FailureLike): FailureCopy {
  const base = { field: null, needsSignIn: false, cloudLocked: false, retryable: false } as const;
  const nonEmpty = f.message.trim() !== '' ? f.message : null;
  switch (f.error) {
    case 'not_signed_in':
    case 'device_revoked':
      return { ...base, copy: nonEmpty ?? 'Sign in to cyboflow cloud to continue.', needsSignIn: true };
    case 'cloud_locked':
      return { ...base, copy: FIXED_COPY.cloud_locked ?? '', cloudLocked: true };
    case 'invalid_input': {
      const field = f.field === 'displayName' || f.field === 'handle' ? f.field : null;
      return { ...base, copy: nonEmpty ?? 'That input is not valid.', field };
    }
    case 'handle_taken':
      return { ...base, copy: FIXED_COPY.handle_taken ?? '', field: 'handle' };
    case 'service_unavailable':
      return { ...base, copy: FIXED_COPY.service_unavailable ?? '', retryable: true };
    case 'unknown':
      return { ...base, copy: nonEmpty ?? 'Something went wrong. Try again.', retryable: true };
    default:
      if (VERBATIM.has(f.error)) return { ...base, copy: nonEmpty ?? 'Something went wrong. Try again.' };
      return { ...base, copy: FIXED_COPY[f.error] ?? nonEmpty ?? 'Something went wrong. Try again.' };
  }
}
