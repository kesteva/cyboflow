/**
 * The default device name shown on the sign-in confirm page and the account's Devices page.
 */
import os from 'node:os';

const MAX_NAME = 100;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;
// eslint-disable-next-line no-control-regex
const HAS_CONTROL = /[\u0000-\u001f\u007f]/;

function platformLabel(platform: string): string {
  switch (platform) {
    case 'darwin': return 'macOS';
    case 'win32': return 'Windows';
    case 'linux': return 'Linux';
    default: return platform;
  }
}

/**
 * hostname with everything from the first '.' dropped, control characters stripped, whitespace collapsed,
 * trimmed and capped at 100 chars; empty falls back to `cyboflow on <platform>`.
 */
export function defaultDeviceName(hostname: string = os.hostname(), platform: string = process.platform): string {
  const dot = hostname.indexOf('.');
  const short = dot === -1 ? hostname : hostname.slice(0, dot);
  const cleaned = short.replace(CONTROL_CHARS, '').replace(/\s+/g, ' ').trim().slice(0, MAX_NAME).trim();
  return cleaned === '' ? `cyboflow on ${platformLabel(platform)}` : cleaned;
}

/** 1..100 chars, no control characters, not blank. */
export function isValidDeviceName(name: string): boolean {
  return name.length >= 1 && name.length <= MAX_NAME && !HAS_CONTROL.test(name) && name.trim() !== '';
}
