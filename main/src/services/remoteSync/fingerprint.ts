/**
 * Project fingerprints (desktop doc, "Joining a second machine"; ruling D3).
 *
 * Two machines find the same remote project by a fingerprint of the repo's
 * `origin` URL plus the project's subpath inside the repo. The fingerprint is
 * sent to the sync service, so it never carries URL credentials: a URL is
 * reduced to `host/path` before anything else reads it, and a URL this module
 * cannot parse yields no fingerprint at all rather than the raw string.
 *
 *   https://user:tok@GitHub.com:443/o/r.git  ┐
 *   ssh://git@github.com/o/r                 ├─ github.com/o/r
 *   git@github.com:o/r.git                   ┘
 *   + subpath `packages/app/`                 → github.com/o/r#packages/app
 *
 * A canonical form longer than the service's 128-character limit is sent as
 * `sha256:<hex>`. A project with no usable remote gets `local:<uuid>`, minted
 * when it is first linked; it never matches, and joins only by explicit pick.
 */
import { createHash, randomUUID } from 'node:crypto';

/** The sync service's limit on `projects.fingerprint`. */
export const MAX_FINGERPRINT_LENGTH = 128;

/** Run git in `cwd`; resolves stdout, rejects on a non-zero exit. */
export type GitRunner = (cwd: string, args: string[]) => Promise<string>;

export interface ProjectFingerprint {
  /** `host/path[#subpath]`, credentials stripped; what the UI shows. */
  canonical: string;
  /** What is sent to the service and compared: `canonical`, or its sha256 when too long. */
  wire: string;
}

/**
 * Reduce a git remote URL to `host/path`: no scheme, user, password, port,
 * query, fragment, trailing slash or `.git`; host lowercased. Returns null for
 * a local path or anything unparseable. Never returns credentials.
 */
export function normalizeRemoteUrl(raw: string): string | null {
  const url = raw.trim();
  if (!url) return null;
  let host: string;
  let path: string;
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(url);
  if (scheme) {
    const proto = scheme[1].toLowerCase();
    if (proto === 'file') return null;
    const rest = url.slice(scheme[0].length);
    const slash = rest.indexOf('/');
    const authority = slash === -1 ? rest : rest.slice(0, slash);
    path = slash === -1 ? '' : rest.slice(slash + 1);
    host = authority.slice(authority.lastIndexOf('@') + 1);
    // Bracketed IPv6 keeps its colons; otherwise a colon starts the port.
    host = host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : host.split(':')[0];
  } else {
    // scp-like `[user@]host:path`. A colon after a slash is a local path
    // (`./a:b`), and a single-letter "host" is a Windows drive (`C:\repo`).
    const m = /^(?:[^@/\\]+@)?([^:/\\]+):(?!\/\/)(.*)$/.exec(url);
    if (!m || m[1].length === 1) return null;
    host = m[1];
    path = m[2];
  }
  host = host.toLowerCase();
  path = path.split(/[?#]/)[0];
  const segments = path.split('/').filter((s) => s !== '' && s !== '.');
  if (segments.length > 0) segments[segments.length - 1] = segments[segments.length - 1].replace(/\.git$/i, '');
  const cleanPath = segments.filter((s) => s !== '').join('/');
  if (!host || !/^[a-z0-9.[\]:_-]+$/.test(host) || !cleanPath) return null;
  // An `@` left in the path means the userinfo was malformed (an unencoded `/`
  // in a password): refuse rather than risk sending part of it.
  if (cleanPath.includes('@')) return null;
  return `${host}/${cleanPath}`;
}

/** `host/path` plus `#subpath` when the project is not at the repo root. */
export function canonicalFingerprint(normalizedRemote: string, subpath: string): string {
  const sub = subpath.trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  return sub ? `${normalizedRemote}#${sub}` : normalizedRemote;
}

/** The form sent to the service: the canonical one, or `sha256:<hex>` when it is too long. */
export function wireFingerprint(canonical: string): string {
  if (canonical.length <= MAX_FINGERPRINT_LENGTH) return canonical;
  return `sha256:${createHash('sha256').update(canonical, 'utf8').digest('hex')}`;
}

/** A fresh fingerprint for a project with no usable remote. */
export function localFingerprint(): string {
  return `local:${randomUUID()}`;
}

export function isLocalFingerprint(fingerprint: string | null | undefined): boolean {
  return typeof fingerprint === 'string' && fingerprint.startsWith('local:');
}

/**
 * Fingerprint the project at `projectPath` from its `origin` remote and its
 * subpath. Null when it has no usable remote (not a git repo, no origin, a
 * local-path origin): the caller mints a `local:` one when linking.
 */
export async function fingerprintProject(projectPath: string, git: GitRunner): Promise<ProjectFingerprint | null> {
  let remote: string;
  let prefix: string;
  try {
    remote = await git(projectPath, ['remote', 'get-url', 'origin']);
    prefix = await git(projectPath, ['rev-parse', '--show-prefix']);
  } catch {
    return null;
  }
  const normalized = normalizeRemoteUrl(remote);
  if (!normalized) return null;
  const canonical = canonicalFingerprint(normalized, prefix);
  return { canonical, wire: wireFingerprint(canonical) };
}
