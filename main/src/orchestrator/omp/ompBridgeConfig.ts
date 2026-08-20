/**
 * Resolve the OMP bridge configuration for the privileged command adapter.
 *
 * The command path is deliberately fail-closed: unless every field resolves,
 * no adapter is built and the router returns `unavailable` (the Phase-2 stub
 * behaviour). A half-configured bridge must never silently authorize commands.
 *
 * Sources, in precedence order:
 * - `OMP_BRIDGE_URL` env, else the Prime bridge pointer file
 *   (`~/.prime/agent/omp-bridge.json`, field `url`) — loopback only, checked
 *   by parsed hostname rather than string prefix.
 * - `OMP_BRIDGE_TOKEN_FILE` env (a 0600 file holding the raw bearer token —
 *   the mode is ENFORCED, not assumed); a raw bearer is required because the
 *   token is a minted credential, not a recoverable value.
 * - `OMP_BRIDGE_SESSION_ID` env (the OMP session whose tool host exposes the
 *   `fleet_*` tools).
 *
 * Standalone-typecheck invariant: node:fs only, no electron/services imports.
 */
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

export interface OmpBridgeCommandConfig {
  readonly url: string;
  readonly token: string;
  readonly sessionId: string;
}

const DEFAULT_POINTER_PATH = join(homedir(), ".prime", "agent", "omp-bridge.json");

function readPointerUrl(pointerPath: string): string | undefined {
  let raw: string;
  try {
    raw = readFileSync(pointerPath, "utf8");
  } catch {
    return undefined;
  }
  try {
    const parsed = JSON.parse(raw) as { url?: unknown };
    return typeof parsed.url === "string" && parsed.url.length > 0 ? parsed.url : undefined;
  } catch {
    return undefined;
  }
}

function resolveUrl(): string | undefined {
  const fromEnv = process.env.OMP_BRIDGE_URL;
  if (fromEnv !== undefined && fromEnv.length > 0) return fromEnv;
  return readPointerUrl(DEFAULT_POINTER_PATH);
}

/** Hostnames that are genuinely this machine. */
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

/**
 * True only when `url` is plain HTTP to a loopback host.
 *
 * Parsed, never prefix-matched. `url.startsWith('http://127.0.0.1')` reads as a
 * loopback check but accepts `http://127.0.0.1.evil.example/` and
 * `http://localhost.attacker.tld/` — both registrable domains an attacker can
 * point anywhere — and this config carries a bearer token that the client sends
 * to whatever host comes back. Comparing the parsed hostname closes that: a
 * label appended to `127.0.0.1` makes a different hostname, not a prefix.
 *
 * The scheme stays http-only, matching the Prime bridge: a loopback listener
 * has no certificate to present, so an `https://127.0.0.1` pointer means
 * something is proxying and the token would leave this machine.
 */
function isLoopbackHttpUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:") return false;
  return LOOPBACK_HOSTS.has(parsed.hostname.toLowerCase());
}

/**
 * Read the bearer token, refusing a file any other account can read.
 *
 * The header has always described this as "a 0600 file holding the raw bearer
 * token" — this enforces it rather than trusting it. A group- or world-readable
 * credential is a misconfiguration we can detect for free, and reading it
 * anyway would hand the bridge's authority to every local account. Fail closed:
 * an unreadable, empty, or over-permissive file yields no adapter at all.
 */
function readTokenFile(tokenFile: string): string | undefined {
  if (!isAbsolute(tokenFile)) return undefined;
  let token: string;
  try {
    // Windows does not model POSIX permission bits, so the mode check is
    // meaningful only where they exist; the absolute-path and content checks
    // still apply everywhere.
    if (process.platform !== "win32") {
      const mode = statSync(tokenFile).mode & 0o077;
      if (mode !== 0) return undefined;
    }
    token = readFileSync(tokenFile, "utf8").trim();
  } catch {
    return undefined;
  }
  return token.length > 0 ? token : undefined;
}

/**
 * Resolve the bridge command config, or `undefined` when any required piece is
 * missing (or an env value is present but unusable). Callers treat `undefined`
 * as "no command adapter".
 */
export function resolveOmpBridgeCommandConfig(): OmpBridgeCommandConfig | undefined {
  const url = resolveUrl();
  if (url === undefined) return undefined;
  if (!isLoopbackHttpUrl(url)) return undefined;

  const tokenFile = process.env.OMP_BRIDGE_TOKEN_FILE;
  if (tokenFile === undefined || tokenFile.length === 0) return undefined;
  const token = readTokenFile(tokenFile);
  if (token === undefined) return undefined;

  const sessionId = process.env.OMP_BRIDGE_SESSION_ID;
  if (sessionId === undefined || sessionId.length === 0 || sessionId.length > 256 || sessionId.includes("/")) {
    return undefined;
  }

  return { url, token, sessionId };
}
