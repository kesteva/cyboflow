/**
 * webNonceMarker — the HARNESS-INJECTED identity marker for web deliverables
 * (runbook-optional-verification.md §A1.2 follow-up).
 *
 * THE GAP IT FILLS. A web request's `dom-marker` / `http-endpoint` channels only
 * verify when the deliverable RENDERS this request's nonce, and an ordinary app
 * never reads `VERIFY_ATTEST_NONCE` (bundlers only forward prefixed vars to the
 * browser anyway). So a runbook-less web project could reach `passed` only on the
 * serve binding, and a learned web runbook could record nothing stronger.
 *
 * WHAT IT DOES. Every verification runs in a throwaway snapshot worktree, so the
 * harness can stamp the marker into THAT copy's entry HTML before the agent
 * starts — the developer's repo never sees it. The page served from the leased
 * port then carries
 * `<meta name="cyboflow-verify-nonce" content=… data-verify-nonce=…>`, which the
 * existing `dom-marker` probe reads (its `data-verify-nonce` attribute) with no
 * probe change.
 *
 * WHAT IT PROVES. The page in the driver's browser was built from THIS
 * snapshot's files — not a stale server, the developer's own dev server, or a
 * serve command that fronts some other directory. It rides ON TOP of the serve
 * binding, never instead of it: the agent can read the injected file, so the
 * marker alone is no more agent-proof than the nonce in its env.
 *
 * WHERE IT APPLIES. Only projects whose dev server serves an entry HTML file from
 * the repo, at the snapshot root: Vite / plain static (`index.html`), CRA
 * (`public/index.html`), Angular (`src/index.html`), SvelteKit (`src/app.html`).
 * Server-rendered frameworks (Next, Remix, Nuxt, …) have no such file, and a
 * monorepo package below the root is not searched. Anything ambiguous — no
 * candidate, more than one, no single `<head>` — is a SKIP with a reason, and
 * the request falls back to the serve binding exactly as before.
 *
 * Pure except for the injected fs seam, so the detection rules are unit-tested
 * without a disk.
 */
import { join } from 'node:path';
import type { AttestationSpec } from '../../../../shared/types/visualVerification';

/** The selector the harness's `dom-marker` probe asks for when it injected the marker. */
export const HARNESS_NONCE_MARKER_SELECTOR = 'meta[name="cyboflow-verify-nonce"]';

/** The attestation spec a harness-injected marker is attested through. */
export const HARNESS_NONCE_MARKER_SPEC: AttestationSpec = {
  kind: 'dom-marker',
  selector: HARNESS_NONCE_MARKER_SELECTOR,
};

/** True when `spec` is the harness's own marker channel (a learned web runbook records exactly this). */
export function isHarnessNonceMarkerSpec(spec: AttestationSpec | undefined | null): boolean {
  return spec?.kind === 'dom-marker' && spec.selector === HARNESS_NONCE_MARKER_SELECTOR;
}

/** Entry-HTML locations, relative to the snapshot root, one per supported layout. */
export const ENTRY_HTML_CANDIDATES = ['index.html', 'public/index.html', 'src/index.html', 'src/app.html'] as const;

/**
 * Dependencies that mark a SERVER-RENDERED app: its HTML is produced by server
 * code, so a stray `index.html` in the tree (a leftover, a docs page) is not what
 * the dev server answers with, and marking it would only mislead.
 */
const SERVER_RENDERED_DEPENDENCIES = [
  'next',
  'nuxt',
  '@remix-run/dev',
  '@remix-run/react',
  '@react-router/dev',
  'astro',
  'gatsby',
] as const;

export interface NonceMarkerFs {
  /** Text of a REGULAR file (never a symlink), `null` when absent, not a regular file, or unreadable. */
  readRegularFile: (absPath: string) => Promise<string | null>;
  writeFile: (absPath: string, content: string) => Promise<void>;
}

export type NonceMarkerInjection =
  | {
      injected: true;
      /** Snapshot-relative path of the marked entry HTML (the mutation check exempts exactly this file). */
      relPath: string;
      /** The file's full content after injection — the mutation check compares against it. */
      content: string;
    }
  | { injected: false; reason: string };

/** `<head>` or `<head …attrs>`, not `<header>`. */
const HEAD_OPEN_TAG = /<head(?=[\s>])[^>]*>/gi;

/** Does the snapshot's package.json declare a server-rendered framework? */
function serverRenderedFramework(packageJsonRaw: string | null): string | null {
  if (packageJsonRaw === null) return null;
  let pkg: unknown;
  try {
    pkg = JSON.parse(packageJsonRaw);
  } catch {
    return null;
  }
  if (pkg === null || typeof pkg !== 'object') return null;
  const record = pkg as Record<string, unknown>;
  for (const field of ['dependencies', 'devDependencies']) {
    const deps = record[field];
    if (deps === null || typeof deps !== 'object') continue;
    const found = SERVER_RENDERED_DEPENDENCIES.find((name) => Object.hasOwn(deps, name));
    if (found !== undefined) return found;
  }
  return null;
}

/** The marker element, attribute-safe by construction (a UUID nonce). */
function markerTag(nonce: string): string {
  return `<meta name="cyboflow-verify-nonce" content="${nonce}" data-verify-nonce="${nonce}">`;
}

/**
 * Stamp this request's nonce into the snapshot's single entry HTML file.
 * Never throws: every refusal — and any fs failure — is `injected: false` with a
 * reason, because a missing marker only costs the request the stronger channel.
 */
export async function injectNonceMarker(args: {
  snapshotRoot: string;
  nonce: string;
  fs: NonceMarkerFs;
}): Promise<NonceMarkerInjection> {
  const { snapshotRoot, nonce, fs } = args;
  if (!/^[A-Za-z0-9-]+$/.test(nonce)) return { injected: false, reason: 'the nonce is not attribute-safe' };
  try {
    const framework = serverRenderedFramework(await fs.readRegularFile(join(snapshotRoot, 'package.json')));
    if (framework !== null) {
      return {
        injected: false,
        reason: `package.json declares "${framework}", a server-rendered framework with no entry HTML file to mark`,
      };
    }
    const found: Array<{ relPath: string; text: string }> = [];
    for (const relPath of ENTRY_HTML_CANDIDATES) {
      const text = await fs.readRegularFile(join(snapshotRoot, relPath));
      if (text !== null) found.push({ relPath, text });
    }
    if (found.length === 0) {
      return { injected: false, reason: `no entry HTML file at the snapshot root (${ENTRY_HTML_CANDIDATES.join(', ')})` };
    }
    if (found.length > 1) {
      return {
        injected: false,
        reason: `more than one entry HTML candidate (${found.map((f) => f.relPath).join(', ')}), so which one is served is ambiguous`,
      };
    }
    const [{ relPath, text }] = found;
    const heads = text.match(HEAD_OPEN_TAG) ?? [];
    if (heads.length !== 1) {
      return { injected: false, reason: `${relPath} has ${heads.length} <head> tags, expected exactly one` };
    }
    const at = text.search(HEAD_OPEN_TAG) + heads[0].length;
    const content = `${text.slice(0, at)}\n    ${markerTag(nonce)}${text.slice(at)}`;
    await fs.writeFile(join(snapshotRoot, relPath), content);
    return { injected: true, relPath, content };
  } catch (err) {
    return { injected: false, reason: `injection failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}
