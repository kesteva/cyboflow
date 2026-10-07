/** Pure helpers for the Agents & Environments surfaces. */
import { parseTimestamp } from '../../utils/timestampUtils';
import { viewableHref } from '../../utils/openWebLink';
import {
  PERSISTENT_AGENT_HANDLE_RE,
  PERSISTENT_AGENT_MAX_DISPLAY_NAME,
} from '../../../../shared/types/persistentAgents';

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS_RE = /[\u0000-\u001f\u007f]/;

const CLOCK_FORMAT = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const DAY_FORMAT = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });

/** "17:44" on the same local calendar day as `now`, else "Sep 28 17:44". "" for invalid input. */
export function formatClock(iso: string, now: Date = new Date()): string {
  const d = parseTimestamp(iso);
  if (Number.isNaN(d.getTime())) return '';
  const clock = CLOCK_FORMAT.format(d);
  const sameDay =
    d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
  return sameDay ? clock : `${DAY_FORMAT.format(d)} ${clock}`;
}

/**
 * Display parts for an UNTRUSTED link. `href` is non-null only for http(s); the domain comes from the parsed
 * URL (punycode for IDN, deliberately: it defeats homograph lookalikes).
 */
export function linkParts(raw: string): { href: string | null; domain: string; display: string } {
  const href = viewableHref(raw);
  if (href === null) return { href: null, domain: 'unsupported link', display: raw.slice(0, 80) };
  let domain = '';
  try {
    domain = new URL(href).hostname;
  } catch {
    return { href: null, domain: 'unsupported link', display: raw.slice(0, 80) };
  }
  return { href, domain, display: raw.length > 80 ? `${raw.slice(0, 77)}…` : raw };
}

/** max(0, expiresAt - nowMs); NaN-safe (an unparseable expiry reads as already expired). */
export function pairingRemainingMs(expiresAtIso: string, nowMs: number): number {
  const t = parseTimestamp(expiresAtIso).getTime();
  if (Number.isNaN(t)) return 0;
  return Math.max(0, t - nowMs);
}

/** "9:41", "0:05", "0:00". */
export function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function utf8ByteLength(s: string): number {
  return new TextEncoder().encode(s).length;
}

/** Lowercase ASCII slug for the cf/<handle>/ branch prefix: at most 32 chars, never empty. */
export function slugifyHandle(displayName: string): string {
  const slug = displayName
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)
    .replace(/-+$/g, '');
  return slug === '' ? 'agent' : slug;
}

export function isValidHandle(h: string): boolean {
  return PERSISTENT_AGENT_HANDLE_RE.test(h);
}

/** Error copy, or null when the (trimmed) name is acceptable. */
export function validateDisplayName(name: string): string | null {
  const t = name.trim();
  if (t === '') return 'Give the agent a name.';
  if (t.length > PERSISTENT_AGENT_MAX_DISPLAY_NAME) {
    return `Keep the name under ${PERSISTENT_AGENT_MAX_DISPLAY_NAME} characters.`;
  }
  if (CONTROL_CHARS_RE.test(t)) return "The name can't contain control characters.";
  return null;
}
