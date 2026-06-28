/**
 * PlaywrightBackend — Rung 1 of the layered visual-verification capability ladder
 * (see docs/visual-verification-design.md §5 + §L2). It drives a real headless
 * browser via the `playwright` LIBRARY (NOT the playwright MCP server — that single
 * shared profile cannot serve N concurrent lanes) in a FRESH BrowserContext per
 * capture, so each request is fully isolated. It is the interactive-web + responsive
 * fallback the matrix routes to when capturePage cannot click (it is absent from the
 * interactive chain by construction) or renders blank.
 *
 * This file lives under main/src/services/* and MAY use the 'playwright' package +
 * node:child_process (via the installer) — but it loads the package LAZILY (a
 * type-only import here + `await import('playwright')` in the default browserFactory)
 * so a devDependency pruned during packaging soft-fails (ok:false) instead of
 * crashing the boot path. It is the concrete, browser-backed half injected into the
 * (electron-free, child-process-free) scheduler as a VerificationBackend. The
 * scheduler never imports this; index.ts wires it in.
 *
 * Responsibilities (S3):
 *  - requiredLease: a verify:port lease ONLY when the deliverable declares a
 *    dev-server start (config.start present, surfaced via the request) — the
 *    scheduler then spawns + leases the dev server (locked decision #1, S2) and
 *    rewrites ctx.input.url. For a pre-existing static url (no start) it returns null
 *    and the backend simply loads ctx.input.url (no lease).
 *  - multi-viewport: one PNG per viewport (responsive-multi-viewport / input.viewports[]),
 *    stem sanitized from the viewport label exactly like CapturePageBackend.
 *  - interactions: the click/type/navigate/wait array is PLAYED IN ORDER before the
 *    screenshot (interactive-web-behavior).
 *  - DETERMINISTIC-FIRST (decision #3): set CaptureResult.deterministicVerdict so the
 *    scheduler can skip the paid VLM. A FAIL (nav error / missing interaction target /
 *    uncaught page error) ALWAYS short-circuits. A PASS is set ONLY when the
 *    deliverable declares EXPLICIT assertions and ALL pass (conservative-skip);
 *    structural success WITHOUT assertions leaves it undefined ⇒ the VLM runs.
 *  - lazy chromium: healthCheck() returns false when chromium is unavailable / the
 *    install fails ⇒ the resolver drops playwright from the chain (SKIP, never FAIL,
 *    never hang).
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join, basename } from 'node:path';
// `playwright` is a TYPE-ONLY import here (erased at compile time → no runtime
// require). The browser LIBRARY is loaded LAZILY via `await import('playwright')`
// inside the default browserFactory so a missing module soft-fails (healthCheck →
// false) exactly like a missing chromium BINARY, instead of crashing the boot path
// in a packaged build where electron-builder may prune the dependency. See the
// BLOCKER note in playwrightInstaller.ts.
import type { Browser, Page } from 'playwright';
import type {
  CaptureContext,
  CaptureResult,
  DeliverableAssertion,
  VerdictV1,
  VerificationRequestInput,
  VisualBackend,
  VisualBackendId,
} from '../../../../shared/types/visualVerification';
import { VERIFY_PORT_ANY } from '../../../../shared/types/visualVerification';
import { PlaywrightInstaller } from './playwrightInstaller';
import type { LoggerLike } from '../../orchestrator/types';

/** Default viewport when the request declares none — a common desktop size. */
const DEFAULT_VIEWPORT = { width: 1280, height: 800, label: 'default' } as const;

/** How long to wait for a single navigation / interaction before giving up. */
const ACTION_TIMEOUT_MS = 30_000;

/** The model id stamped on a deterministic verdict (no vision model was used). */
const DETERMINISTIC_MODEL = 'playwright-deterministic';

/**
 * The narrow browser-launch seam. Default = playwright's chromium.launch; tests DI
 * a fake so NO real browser launches. Returns a Browser the backend creates a fresh
 * BrowserContext from per capture.
 */
export type BrowserFactory = () => Promise<Browser>;

/**
 * Default launcher: LAZILY `import('playwright')` then chromium.launch headless. The
 * dynamic import means the `playwright` module is resolved at CAPTURE time, not at
 * module load — a packaged build that pruned the dependency throws here (caught by
 * capture()'s try/catch → ok:false soft-fail) instead of MODULE_NOT_FOUND-crashing
 * the boot path. healthCheck() guards this case earlier via the installer, which also
 * lazy-imports playwright (so the resolver drops the backend before capture).
 */
async function defaultBrowserFactory(): Promise<Browser> {
  const { chromium } = await import('playwright');
  return chromium.launch({ headless: true });
}

/** Construction-time deps (all optional; tests inject fakes). */
export interface PlaywrightBackendOptions {
  logger?: LoggerLike;
  /** Lazy chromium provisioner (defaults to a real PlaywrightInstaller). */
  installer?: PlaywrightInstaller;
  /** Browser launcher (defaults to chromium.launch headless). Tests inject a fake. */
  browserFactory?: BrowserFactory;
  /** Per-action timeout (ms). Defaults to ACTION_TIMEOUT_MS. */
  actionTimeoutMs?: number;
}

/**
 * Sanitize a viewport label into a safe PNG basename stem (identical rule to
 * CapturePageBackend so the two rungs produce comparable filenames). Falls back to
 * the index when the label sanitizes to empty.
 */
function viewportFileStem(label: string | undefined, index: number): string {
  const cleaned = (label ?? '').replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  return cleaned.length > 0 ? cleaned : String(index);
}

/** Build a deterministic VerdictV1 (pass or fail) with the supplied issues/feedback. */
function deterministicVerdict(
  status: 'pass' | 'fail',
  feedback: string,
  fileNames: string[],
  issues: VerdictV1['issues'] = [],
): VerdictV1 {
  return {
    status,
    confidence: 1,
    issues,
    feedback,
    judgedFileNames: fileNames,
    baselineUsed: false,
    model: DETERMINISTIC_MODEL,
  };
}

export class PlaywrightBackend implements VisualBackend {
  readonly id: VisualBackendId = 'playwright';
  readonly rung = 1;

  private readonly logger?: LoggerLike;
  private readonly installer: PlaywrightInstaller;
  private readonly browserFactory: BrowserFactory;
  private readonly actionTimeoutMs: number;

  constructor(opts: PlaywrightBackendOptions = {}) {
    this.logger = opts.logger;
    this.installer = opts.installer ?? new PlaywrightInstaller({ logger: opts.logger });
    this.actionTimeoutMs = opts.actionTimeoutMs ?? ACTION_TIMEOUT_MS;
    this.browserFactory = opts.browserFactory ?? defaultBrowserFactory;
  }

  /**
   * A pooled verify:port lease ONLY when the deliverable declares a dev-server
   * start — the scheduler then spawns + leases the dev server (on a REAL configured
   * port it picks from the pool) and rewrites ctx.input.url. A pre-existing static
   * url (no start) needs no lease (null) and is captured as-is.
   *
   * We return the VERIFY_PORT_ANY sentinel ("any free pooled port") rather than a
   * synthetic 'verify:port:0': the scheduler's poolCandidatesFor expands the sentinel
   * PURELY from the configured pool and acquires a real free member. A ':0' name was
   * a latent bug — poolCandidatesFor APPENDED it as an extra always-free count-1 slot,
   * which under pool exhaustion let a phantom slot defeat the dev-server concurrency
   * cap and (portFromLease(':0') → 0) attempt a dev server on port 0.
   */
  requiredLease(input: VerificationRequestInput): string | null {
    return inputDeclaresDevServer(input) ? VERIFY_PORT_ANY : null;
  }

  /**
   * Health = chromium is available. Lazy-installs on first probe (idempotent +
   * memoized in the installer). Returns false — never throws, never hangs — when the
   * binary is absent and the install fails, so the resolver drops playwright from
   * the chain (missing precondition ⇒ SKIP, never FAIL).
   */
  async healthCheck(): Promise<boolean> {
    try {
      return await this.installer.ensureChromium();
    } catch (err) {
      this.logger?.warn('[PlaywrightBackend] healthCheck threw', {
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  }

  async capture(ctx: CaptureContext, signal: AbortSignal): Promise<CaptureResult> {
    const url = ctx.input.url?.trim();
    if (!url) {
      // Playwright drives a URL (the scheduler rewrites ctx.input.url to the
      // dev-server baseUrl when one was spawned). Without one there is nothing to
      // load — a runtime failure (capturePage handles raw htmlPath; this rung does
      // not in S3).
      return { ok: false, fileNames: [], error: 'no url provided' };
    }
    if (signal.aborted) {
      return { ok: false, fileNames: [], error: 'capture aborted' };
    }

    // Lazy-install chromium before launching. A failed install ⇒ runtime failure
    // (the resolver's healthCheck would normally have dropped us, but a request
    // already chosen for this backend must still fail soft, never throw/hang).
    const ready = await this.installer.ensureChromium(signal);
    if (!ready) {
      return { ok: false, fileNames: [], error: 'chromium unavailable (install failed)' };
    }

    const viewports =
      ctx.input.viewports && ctx.input.viewports.length > 0
        ? ctx.input.viewports
        : [DEFAULT_VIEWPORT];
    const interactions = ctx.input.interactions ?? [];
    const assertions = ctx.input.assertions ?? [];

    let browser: Browser | null = null;
    try {
      await mkdir(ctx.artifactsDir, { recursive: true });
      browser = await this.browserFactory();

      const fileNames: string[] = [];
      const usedStems = new Set<string>();
      // Captured-error accumulator across viewports: the FIRST deterministic FAIL
      // short-circuits (we still return the PNGs captured so far for the gallery).
      // When assertions are declared, any failing one sets failVerdict + breaks, so
      // reaching the end of the loop with failVerdict null means EVERY viewport's
      // assertions passed — that is the only path to a deterministic PASS below.
      let failVerdict: VerdictV1 | null = null;

      for (let i = 0; i < viewports.length; i++) {
        if (signal.aborted) {
          return { ok: false, fileNames, error: 'capture aborted' };
        }
        const vp = viewports[i];

        // Fresh, isolated BrowserContext PER viewport — no cookie/storage bleed.
        const context = await browser.newContext({
          viewport: { width: vp.width, height: vp.height },
        });
        const page = await context.newPage();
        page.setDefaultTimeout(this.actionTimeoutMs);
        page.setDefaultNavigationTimeout(this.actionTimeoutMs);

        // (a) deterministic FAIL — an uncaught page error always short-circuits.
        let pageError: Error | null = null;
        page.on('pageerror', (err: Error) => {
          pageError = pageError ?? err;
        });

        try {
          // Navigation. A nav error is a deterministic FAIL (decision #3a).
          const response = await page.goto(url, { waitUntil: 'load' });
          if (response && !response.ok()) {
            failVerdict = deterministicVerdict(
              'fail',
              `navigation to ${url} returned HTTP ${response.status()}`,
              fileNames,
              [{ severity: 'high', description: `HTTP ${response.status()} at ${url}` }],
            );
            await context.close();
            break;
          }

          // Play the interactions IN ORDER (interactive-web-behavior). A missing
          // target / failed step is a deterministic FAIL.
          const interactionError = await this.playInteractions(page, interactions);
          if (interactionError) {
            failVerdict = deterministicVerdict('fail', interactionError, fileNames, [
              { severity: 'high', description: interactionError },
            ]);
            await context.close();
            break;
          }

          // An uncaught page error observed during nav/interactions is a FAIL.
          if (pageError) {
            const message = `uncaught page error: ${(pageError as Error).message}`;
            failVerdict = deterministicVerdict('fail', message, fileNames, [
              { severity: 'high', description: message },
            ]);
            await context.close();
            break;
          }

          // Screenshot AFTER interactions (the post-interaction state is the check).
          let stem = viewportFileStem(vp.label, i);
          if (usedStems.has(stem)) stem = `${stem}-${i}`;
          usedStems.add(stem);
          const fileName = `${stem}.png`;
          const png = await page.screenshot({ fullPage: false });
          if (png.length === 0) {
            failVerdict = deterministicVerdict(
              'fail',
              `screenshot produced an empty image for viewport ${vp.label ?? i}`,
              fileNames,
              [{ severity: 'high', description: 'empty screenshot' }],
            );
            await context.close();
            break;
          }
          await writeFile(join(ctx.artifactsDir, fileName), png);
          fileNames.push(basename(fileName));

          // (b) EXPLICIT assertions — evaluate when declared. Any failure is a
          // deterministic FAIL; all-pass keeps the PASS candidate alive.
          if (assertions.length > 0) {
            const assertFailure = await this.evaluateAssertions(page, assertions);
            if (assertFailure) {
              failVerdict = deterministicVerdict('fail', assertFailure, fileNames, [
                { severity: 'high', description: assertFailure, fileName },
              ]);
              await context.close();
              break;
            }
          }
        } finally {
          await context.close().catch(() => {});
        }
      }

      // A deterministic FAIL short-circuits the VLM (decision #3a) — return what we
      // captured plus the FAIL verdict. ok:true so the scheduler delivers the
      // verdict (it is a real, judged outcome) rather than a fall-forward failure.
      if (failVerdict) {
        return { ok: true, fileNames, deterministicVerdict: failVerdict };
      }
      if (fileNames.length === 0) {
        return { ok: false, fileNames, error: 'no screenshots produced' };
      }

      // (b) deterministic PASS — ONLY when explicit assertions were declared AND
      // every one passed across every viewport (conservative-skip). Otherwise leave
      // deterministicVerdict undefined ⇒ the scheduler runs the VLM (decision #3c:
      // structural success without assertions is NEVER a fabricated pass).
      if (assertions.length > 0) {
        return {
          ok: true,
          fileNames,
          deterministicVerdict: deterministicVerdict(
            'pass',
            `all ${assertions.length} declared assertion(s) passed`,
            fileNames,
          ),
        };
      }

      return { ok: true, fileNames };
    } catch (err) {
      return {
        ok: false,
        fileNames: [],
        error: err instanceof Error ? err.message : String(err),
      };
    } finally {
      if (browser) {
        await browser.close().catch(() => {});
      }
    }
  }

  /**
   * Play the ordered interaction steps. Returns null on success or a human-readable
   * failure message (a missing target / failed step) on the FIRST failure — which
   * the caller turns into a deterministic FAIL verdict.
   */
  private async playInteractions(
    page: Page,
    interactions: NonNullable<VerificationRequestInput['interactions']>,
  ): Promise<string | null> {
    for (let i = 0; i < interactions.length; i++) {
      const step = interactions[i];
      try {
        switch (step.action) {
          case 'navigate': {
            if (!step.target) return `interaction ${i} (navigate) is missing a target url`;
            const response = await page.goto(step.target, { waitUntil: 'load' });
            if (response && !response.ok()) {
              return `interaction ${i} (navigate) returned HTTP ${response.status()} for ${step.target}`;
            }
            break;
          }
          case 'click': {
            if (!step.target) return `interaction ${i} (click) is missing a target selector`;
            await page.locator(step.target).click({ timeout: this.actionTimeoutMs });
            break;
          }
          case 'type': {
            if (!step.target) return `interaction ${i} (type) is missing a target selector`;
            await page.locator(step.target).fill(step.value ?? '', { timeout: this.actionTimeoutMs });
            break;
          }
          case 'wait': {
            if (step.target) {
              await page.locator(step.target).waitFor({ timeout: step.ms ?? this.actionTimeoutMs });
            } else {
              await page.waitForTimeout(step.ms ?? 0);
            }
            break;
          }
          default: {
            // Exhaustiveness: an unknown action is a deterministic failure.
            return `interaction ${i} has an unknown action`;
          }
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return `interaction ${i} (${step.action}${step.target ? ` "${step.target}"` : ''}) failed: ${message}`;
      }
    }
    return null;
  }

  /**
   * Evaluate the EXPLICIT assertions against the post-interaction page. Returns null
   * when ALL pass, or the FIRST failure message (turned into a deterministic FAIL).
   */
  private async evaluateAssertions(
    page: Page,
    assertions: DeliverableAssertion[],
  ): Promise<string | null> {
    for (let i = 0; i < assertions.length; i++) {
      const a = assertions[i];
      try {
        const locator = page.locator(a.selector);
        switch (a.kind) {
          case 'visible': {
            const visible = await locator.first().isVisible();
            if (!visible) return `assertion ${i}: "${a.selector}" is not visible`;
            break;
          }
          case 'hidden': {
            const count = await locator.count();
            if (count === 0) break; // absent counts as hidden
            const visible = await locator.first().isVisible();
            if (visible) return `assertion ${i}: "${a.selector}" is visible (expected hidden)`;
            break;
          }
          case 'text': {
            if (a.text === undefined) return `assertion ${i}: 'text' kind requires a text value`;
            const content = (await locator.first().textContent()) ?? '';
            if (!content.includes(a.text)) {
              return `assertion ${i}: "${a.selector}" text does not contain "${a.text}"`;
            }
            break;
          }
          default: {
            return `assertion ${i}: unknown kind`;
          }
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return `assertion ${i} ("${a.selector}") errored: ${message}`;
      }
    }
    return null;
  }
}

/**
 * Whether THIS request's deliverable declares a dev-server start (⇒ needs a
 * `verify:port` lease). The signal is `input.start` — hydrated onto the request
 * from the matched verify.json deliverable's `start` command (the input mirrors
 * DeliverableVerifyConfig, exactly as interactions/viewports/assertions do). Its
 * presence means the scheduler will spawn + lease a dev server (locked decision #1)
 * and rewrite ctx.input.url; absent ⇒ a pre-existing static url, no lease.
 */
function inputDeclaresDevServer(input: VerificationRequestInput): boolean {
  return typeof input.start === 'string' && input.start.trim().length > 0;
}
