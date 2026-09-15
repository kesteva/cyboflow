/**
 * cyboflow-download-counter — counts installer downloads, then redirects to R2.
 *
 * Why a redirect instead of serving the file: the Worker is touched exactly once,
 * when a download STARTS. Every byte-range request and every resume goes to the
 * redirect target and never reaches this code, so one row here is one download —
 * not one row per 206. Range inflation is what makes the raw edge-analytics counts
 * untrustworthy (5 "downloads" totalling 331 MB against a 300 MB file), and this
 * shape eliminates it structurally rather than trying to dedupe it back out.
 *
 * It also keeps a bug's blast radius small. A broken 302 is obvious and harmless;
 * a Worker streaming 305 MB that mishandles Range hands someone a truncated DMG
 * that fails signature verification on their Mac — which reads as "the app is
 * broken", not "the CDN is broken". Not a failure worth owning on the install path
 * for the sake of a counter.
 *
 * Because the transfer still lands on updates.cyboflow.com, the Tier 0 snapshot
 * pipeline keeps observing it. That is deliberate: two independent measurements
 * (clean starts here, actual bytes there) that catch each other drifting.
 *
 * Downloader identity matches the Tier 0 scheme EXACTLY — same secret, same monthly
 * derivation, same truncation — so ids are directly comparable between the two
 * systems. Changing either side's derivation silently breaks that join.
 *
 *   monthlySalt  = sha256(DOWNLOAD_STATS_SALT + ':' + YYYY-MM)
 *   downloaderId = sha256(monthlySalt + ':' + ip)  first 16 hex chars
 */

export interface Env {
  DB: D1Database;
  /** Same secret as the Tier 0 snapshot job. Set with `wrangler secret put`. */
  DOWNLOAD_STATS_SALT: string;
}

/** Where the bytes actually come from. Never taken from user input. */
const ORIGIN = 'https://updates.cyboflow.com';

/**
 * Strict allowlist. This is the open-redirect guard: only a feed prefix plus a
 * plain .dmg or .exe basename is redirectable, so no traversal, no query
 * passthrough, and no way to steer the Location header at an arbitrary host.
 * .exe joined in 0.4.0, the first Windows release — the site links
 * Cyboflow-latest-Windows-x64.exe through this redirector like the DMGs.
 */
const ARTIFACT_RE = /^\/(stable|dev)\/[A-Za-z0-9._-]+\.(dmg|exe)$/;

/**
 * Obvious cloud/hosting networks. A starter heuristic, NOT a filter — the flag is
 * stored so the definition can be revised against history later, the same way the
 * Tier 0 snapshots keep `botLikely` rather than dropping rows.
 */
const DATACENTER_ASNS = new Set([
  16509, 14618, // AWS
  15169, 396982, // Google
  8075, // Microsoft/Azure
  14061, // DigitalOcean
  16276, // OVH
  24940, // Hetzner
  63949, // Akamai/Linode
  132203, 45090, // Tencent
  45102, 37963, // Alibaba
]);

function toHex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function sha256Hex(input: string): Promise<string> {
  return toHex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input)));
}

/**
 * Salt rotates monthly by derivation, so there is no salt to store or rotate — the
 * month in the input does it. Within a month the id is stable (unique downloaders
 * are countable); across months it changes and the link is gone.
 */
async function downloaderId(secret: string, period: string, ip: string): Promise<string> {
  const monthlySalt = await sha256Hex(`${secret}:${period}`);
  return (await sha256Hex(`${monthlySalt}:${ip}`)).slice(0, 16);
}

function archOf(path: string): string {
  if (path.includes('arm64')) return 'arm64';
  if (path.includes('x64')) return 'x64';
  return 'unknown';
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response('Method not allowed', { status: 405 });
    }
    if (!ARTIFACT_RE.test(path)) {
      return new Response('Not found', { status: 404 });
    }

    const location = `${ORIGIN}${path}`;
    const redirect = new Response(null, {
      status: 302,
      headers: {
        Location: location,
        // Critical: an edge-cached redirect would serve later downloads without ever
        // invoking this Worker, so they would go uncounted. Must revalidate every time.
        'Cache-Control': 'no-store, max-age=0',
      },
    });

    // A HEAD is a probe, not a download — redirect it but never count it.
    if (request.method === 'HEAD') return redirect;

    // Analytics must never be able to break a download: everything below is
    // best-effort, runs after the response is handed back, and swallows its own
    // failures. A dead D1 costs a row, not an install.
    ctx.waitUntil(
      (async () => {
        try {
          const cf = request.cf;
          const ip = request.headers.get('CF-Connecting-IP') || '';
          if (!ip) return; // Nothing identity-shaped to record; skip rather than store a blank.

          const now = new Date();
          const ts = now.toISOString();
          const day = ts.slice(0, 10);
          const period = ts.slice(0, 7);
          const asn = typeof cf?.asn === 'number' ? cf.asn : null;

          await env.DB.prepare(
            `INSERT INTO downloads
               (ts, day, path, variant, arch, downloader_id, salt_period,
                country, asn, as_org, ua, datacenter, referer)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
            .bind(
              ts,
              day,
              path,
              path.startsWith('/dev/') ? 'dev' : 'stable',
              archOf(path),
              await downloaderId(env.DOWNLOAD_STATS_SALT, period, ip),
              period,
              (cf?.country as string) ?? null,
              asn,
              (cf?.asOrganization as string) ?? null,
              request.headers.get('User-Agent'),
              asn !== null && DATACENTER_ASNS.has(asn) ? 1 : 0,
              request.headers.get('Referer'),
            )
            .run();
        } catch (err) {
          // Deliberately swallowed — the user already has their redirect.
          console.error('download-counter: failed to record', err);
        }
      })(),
    );

    return redirect;
  },
};
