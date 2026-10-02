import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { createHash } from 'node:crypto';
/**
 * Content-Security-Policy for the PACKAGED renderer.
 *
 * The packaged app loads `frontend/dist/index.html` over `file://`, so there is
 * no response header to attach a policy to — a `<meta http-equiv>` baked into
 * the BUILT html is the only mechanism. It is injected at build time rather
 * than written into `index.html` by hand so that dev is completely untouched:
 * Vite's HMR client and react-refresh preamble are inline scripts injected per
 * request, which no static hash list could ever cover.
 *
 * `script-src` carries HASHES of the two inline theme scripts in index.html
 * instead of `'unsafe-inline'`. That is the directive that matters: this whole
 * policy exists so that markup injected into the renderer (a session name, a
 * rendered diff, agent-authored markdown) cannot execute and reach the IPC
 * bridge. `'unsafe-inline'` would give that back, and adding hashes makes
 * browsers ignore any `'unsafe-inline'` in the same directive anyway.
 *
 * Per-directive notes:
 *   script-src   'self' + inline hashes only. NO 'unsafe-eval' — nothing in the
 *                bundle was found to need it — and no remote script host: a CDN
 *                entry would be a standing RCE surface for a renderer with IPC
 *                powers.
 *   style-src    'unsafe-inline' is required: xterm and react-remark both
 *                inject <style> elements at runtime. Accepted for v1.
 *   font-src     @fontsource woff2 ship in the bundle ('self'); `data:` covers
 *                any inlined font.
 *   img-src      artifact screenshots arrive over IPC as base64 `data:` URLs
 *                (see electron.d.ts artifacts:*), and log/file exports build
 *                `blob:` object URLs.
 *   frame-src    the artifact canvases: a design-prototype OOPIF on
 *                `http://127.0.0.1:<leased port>` and a live-canvas embed on
 *                `http://localhost:<port>`, both on ports assigned at runtime.
 *                `about:srcdoc` static-mockup frames are not governed by
 *                frame-src (they inherit the embedder's policy).
 *   connect-src  the renderer makes NO direct network calls — Sentry runs
 *                through @sentry/electron/renderer (IPC to main) and Aptabase
 *                is main-process only.
 *   object-src / base-uri  hard 'none': no plugin content, and no <base> tag
 *                hijack of the relative asset paths this `base: './'` build uses.
 *
 * Deliberately ABSENT: `frame-ancestors`, `report-uri` and `sandbox` are ignored
 * when delivered via <meta>, so listing them would only produce console noise.
 */
function buildCsp(inlineScriptHashes) {
    const hashes = inlineScriptHashes.map((h) => `'${h}'`).join(' ');
    return [
        `default-src 'self'`,
        `script-src 'self' ${hashes}`.replace(/\s+/g, ' '),
        `style-src 'self' 'unsafe-inline'`,
        `font-src 'self' data:`,
        `img-src 'self' data: blob:`,
        `media-src 'self' data: blob:`,
        `connect-src 'self' data: blob:`,
        `worker-src 'self' blob:`,
        `child-src 'self' blob:`,
        `frame-src 'self' blob: http://localhost:* http://127.0.0.1:*`,
        `object-src 'none'`,
        `base-uri 'none'`,
        `form-action 'none'`,
    ].join('; ');
}
/**
 * Inject the CSP `<meta>` as the first element of `<head>` (it must precede any
 * content it governs) with `script-src` hashes computed from the inline scripts
 * actually present in the emitted html. Build-only — `apply: 'build'` keeps the
 * dev server, its HMR websocket and the react-refresh preamble untouched.
 * `enforce: 'post'` runs it after Vite has injected its own bundle tags, so the
 * hash set reflects the final document.
 */
function cspPlugin() {
    return {
        name: 'cyboflow-csp',
        apply: 'build',
        enforce: 'post',
        transformIndexHtml(html) {
            const inlineScript = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g;
            const hashes = [];
            for (const match of html.matchAll(inlineScript)) {
                const body = match[1];
                if (!body)
                    continue;
                hashes.push(`sha256-${createHash('sha256').update(body, 'utf8').digest('base64')}`);
            }
            const meta = `<meta http-equiv="Content-Security-Policy" content="${buildCsp(hashes)}">`;
            // Placed AFTER <meta charset> when there is one: the charset declaration
            // has to land within the document's first 1024 bytes, and this policy is
            // ~700 of them. Otherwise first thing in <head> — the policy must precede
            // any content it governs.
            const charset = /<meta[^>]*\bcharset=[^>]*>/i;
            if (charset.test(html)) {
                return html.replace(charset, (m) => `${m}\n    ${meta}`);
            }
            // A build whose <head> we cannot find must FAIL rather than silently ship
            // an unprotected renderer.
            if (!/<head[^>]*>/i.test(html)) {
                throw new Error('[cyboflow-csp] no <head> in index.html — cannot inject Content-Security-Policy');
            }
            return html.replace(/(<head[^>]*>)/i, `$1\n    ${meta}`);
        },
    };
}
export default defineConfig({
    plugins: [react(), cspPlugin()],
    server: {
        // Overridable so a verification instance can lease its own renderer port
        // (CYBOFLOW_VITE_PORT) alongside a scoped CDP port + CYBOFLOW_DIR data
        // dir, giving it full isolation from the developer's own `pnpm dev`
        // instance — see docs/proposals/verification-setup-flow.md §5.4 "Dogfood
        // prerequisite". Default matches the historical hardcoded port exactly.
        port: Number(process.env.CYBOFLOW_VITE_PORT ?? 4521),
        // Keep strict: the whole point of leasing a port for a verify run is to
        // honor it exactly, never silently fall back to a different one.
        strictPort: true
    },
    base: './',
    build: {
        // Ensure assets are copied and paths are relative
        assetsDir: 'assets',
        // Copy public files to dist
        copyPublicDir: true
    },
    // NOTE: test config lives in vitest.config.ts (which vitest prefers over this
    // file). Keeping a `test` block here breaks `tsc -b` in build:frontend because
    // vite@6's UserConfig has no `test` key and the vitest@2 augmentation targets a
    // duplicate vite@5 install — see vitest.config.ts for the canonical settings.
});
