import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { ClaudeCredentialDetection } from '../../../shared/types/onboarding';

/**
 * Claude Code LOGIN probe (onboarding step 1).
 *
 * This detects whether the user is signed into Claude Code — NOT whether the
 * `claude` binary is installed (that is claudeCodeTest.ts). The default SDK
 * substrate bundles its own binary, so a fresh install's only genuine
 * requirement is the login; see shared/types/onboarding.ts for the contract and
 * the main-side state mapping.
 *
 * Signals are checked in strict priority order, FIRST HIT WINS. The probe is
 * SECURITY-SENSITIVE: it must never read, capture, log, or return a token or
 * secret value — only presence (and, where a signal exposes one cheaply, a
 * human account label). Every fs / exec / parse failure degrades to the next
 * signal (or found:false); the function NEVER throws and NEVER rejects.
 */

const KEYCHAIN_SERVICE = 'Claude Code-credentials';
const KEYCHAIN_TIMEOUT_MS = 3_000;

const notFound: ClaudeCredentialDetection = { found: false, source: null, account: null };

/**
 * macOS Keychain probe. Uses `security find-generic-password` and reads the
 * EXIT CODE only — the secret itself is never requested (no `-w`) and stdout /
 * stderr are discarded, so no credential material can leak into memory or logs.
 * Exit 0 = an entry for the service exists. Non-darwin platforms skip.
 */
function probeKeychain(): Promise<boolean> {
  if (os.platform() !== 'darwin') return Promise.resolve(false);
  return new Promise<boolean>((resolve) => {
    try {
      const child = execFile(
        '/usr/bin/security',
        ['find-generic-password', '-s', KEYCHAIN_SERVICE],
        { timeout: KEYCHAIN_TIMEOUT_MS },
        (error) => {
          // No stdout/stderr inspected — only the presence/absence of an error
          // (non-zero exit, timeout, or spawn failure) decides the result.
          resolve(!error);
        },
      );
      // Belt-and-suspenders: if the process object is unusable, fail closed.
      child.on('error', () => resolve(false));
    } catch {
      resolve(false);
    }
  });
}

/** True when a regular file exists at `p` and has non-zero size. */
function fileHasContent(p: string): boolean {
  try {
    const stat = fs.statSync(p);
    return stat.isFile() && stat.size > 0;
  } catch {
    return false;
  }
}

/**
 * Parse ~/.claude.json and look for a Claude-login marker: an `oauthAccount`
 * object and/or a top-level `userID`. Returns the account label
 * (oauthAccount.emailAddress, falling back to displayName) when present. Only
 * these non-secret label fields are ever read out of the file.
 */
function probeClaudeConfig(homeDir: string): ClaudeCredentialDetection | null {
  const configPath = path.join(homeDir, '.claude.json');
  let parsed: unknown;
  try {
    const raw = fs.readFileSync(configPath, 'utf8');
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const record = parsed as Record<string, unknown>;
  const oauthAccount =
    typeof record.oauthAccount === 'object' && record.oauthAccount !== null
      ? (record.oauthAccount as Record<string, unknown>)
      : null;
  const hasLoginMarker = oauthAccount !== null || 'userID' in record;
  if (!hasLoginMarker) return null;

  const label =
    (oauthAccount && typeof oauthAccount.emailAddress === 'string' && oauthAccount.emailAddress) ||
    (oauthAccount && typeof oauthAccount.displayName === 'string' && oauthAccount.displayName) ||
    null;
  return { found: true, source: 'claudeConfig', account: label };
}

/** Env-var fallback: an API key / auth token exported into the environment. */
function probeEnv(): boolean {
  return Boolean(
    (process.env.ANTHROPIC_API_KEY && process.env.ANTHROPIC_API_KEY.trim()) ||
      (process.env.ANTHROPIC_AUTH_TOKEN && process.env.ANTHROPIC_AUTH_TOKEN.trim()),
  );
}

/**
 * Detect Claude Code login state. Priority: macOS Keychain → ~/.claude/
 * .credentials.json → ~/.claude.json login marker → env var. Never throws.
 *
 * `source` is first-hit-wins, but keychain/credentialsFile hits still borrow
 * the human account LABEL from ~/.claude.json when it has one — those two
 * signals prove presence without exposing any display name themselves.
 */
export async function detectClaudeCredentials(): Promise<ClaudeCredentialDetection> {
  try {
    const homeDir = os.homedir();

    if (await probeKeychain()) {
      return { found: true, source: 'keychain', account: probeClaudeConfig(homeDir)?.account ?? null };
    }

    if (fileHasContent(path.join(homeDir, '.claude', '.credentials.json'))) {
      return { found: true, source: 'credentialsFile', account: probeClaudeConfig(homeDir)?.account ?? null };
    }

    const fromConfig = probeClaudeConfig(homeDir);
    if (fromConfig) return fromConfig;

    if (probeEnv()) {
      return { found: true, source: 'env', account: null };
    }

    return { ...notFound };
  } catch {
    // Defensive: any unexpected failure (e.g. os.homedir throwing) degrades to
    // "not found" rather than surfacing to the IPC caller.
    return { ...notFound };
  }
}
