/**
 * verifyComposition — the visual-verification composition root, extracted
 * from index.ts's initializeServices() (GitHub issue #19, the god-file split,
 * step 4). It assembles the VerificationScheduler singleton and everything it
 * is injected with: the capture backends, the capped VLM judge, the dev/static
 * server managers + their context resolvers, the verification-agent runner,
 * the machine-local runbook store + status resolver, the host probes the
 * health panel reads, and the lane runbook bootstrap. The body is index.ts's
 * verbatim, apart from: the four outputs index.ts still consumes are RETURNED
 * instead of assigned to module-scope holders, `rawDb` became
 * `databaseService.getDb()` (the same connection), and the compiled driver-CLI
 * path is INJECTED (`driverCliPath`) because resolving it in dev mode needs
 * index.ts's own `__dirname`.
 *
 * This is a SIBLING of index.ts on purpose: it is composition-root code and
 * imports electron + concrete services freely, so it must stay OUT of
 * main/src/orchestrator/** (the standalone-typecheck invariant scans that tree).
 * There is no unit test over it, exactly as there was none over
 * initializeServices(); the file-size ratchet is the only signal it emits.
 *
 * ORDER IS LOAD-BEARING at the call site: ArtifactRouter + ReviewItemRouter
 * must already be initialized (verdict delivery + the bootstrap write through
 * them), and VerificationScheduler.initialize() must precede the
 * OrchSocketServer, whose mcp-request-verification handler reaches the
 * singleton via getInstance().
 */

import { app, shell, systemPreferences } from 'electron';
import * as path from 'path';
import { isModelUsable } from './services/modelAvailabilityService';
import { getCyboflowDirectory, getCyboflowSubdirectory } from './utils/cyboflowDirectory';
import { resolveRunEffectiveAgents } from './services/panels/claude/agentOverlayWriter';
import { bareModelId } from '../../shared/agents/modelContext';
import { ReviewItemRouter } from './orchestrator/reviewItemRouter';
import { ArtifactRouter } from './orchestrator/artifactRouter';
import type { VerifyHostProbesLike, VerifyRunbookStatusLike } from './orchestrator/trpc/context';
import { VerificationScheduler } from './orchestrator/verify/verificationScheduler';
import {
  createVerdictDelivery,
  createCapabilityBreakerFinding,
  createExploreStaleProofFinding,
} from './orchestrator/verify/verdictDelivery';
import { VerificationAgentRunner } from './orchestrator/verify/verificationAgentRunner';
import { VerifyCapabilityStore } from './orchestrator/verify/capabilityStore';
import { VerifyRunbookStore } from './orchestrator/verify/runbookStore';
import { RunbookBootstrapStampStore } from './orchestrator/verify/bootstrapStampStore';
import { BootstrapSuppressionStore } from './orchestrator/verify/bootstrapSuppressionStore';
import { MAX_BOOTSTRAP_ROUNDS, runRunbookBootstrap } from './orchestrator/verify/runbookBootstrapRunner';
import { makeRunbookDraftQuery, runbookDraftTimeoutMs } from './orchestrator/verify/runbookDraftAgentQuery';
import { composeRunbookDraftPrompt } from './orchestrator/verify/runbookDraftPrompt';
import { commitPathspec } from './orchestrator/verify/bootstrapCommit';
import { enqueueTaskVerification } from './orchestrator/verify/enqueueFromTask';
import { VERIFY_RUNBOOK_RELATIVE_PATH } from '../../shared/types/verifyRunbook';
import { probeChromiumExecutable } from './orchestrator/verify/driver/driverCore';
import {
  computeVerifyInputHash,
  computeVerifyHostFingerprint,
  probeHasPackageJson,
} from './services/visualVerify/verifyDriftProbes';
import { makeVerificationAgentQuery } from './orchestrator/verify/verificationAgentQuery';
import { makeCodexVerificationAgentQuery } from './orchestrator/verify/codexVerificationAgentQuery';
import { CapturePageBackend } from './services/visualVerify/capturePageBackend';
import { PlaywrightBackend } from './services/visualVerify/playwrightBackend';
import { PlaywrightInstaller } from './services/visualVerify/playwrightInstaller';
import {
  makeAccessibilityRequester,
  makeChromiumProvisioner,
  makeDriverCliProbe,
  makeScreenRecordingSettingsOpener,
} from './services/visualVerify/hostProbeAdapters';
import { composeMobileVerification } from './services/visualVerify/mobileComposition';
import { PeekabooBackend } from './services/visualVerify/peekabooBackend';
import { resolvePeekabooExecutable } from './services/visualVerify/peekabooExecutablePath';
import { VlmJudgeImpl, DEFAULT_JUDGE_MODEL } from './services/visualVerify/vlmJudge';
import { findNodeExecutable } from './utils/nodeFinder';
import * as net from 'node:net';
import type { AgentProvider } from '../../shared/types/agentRuntime';
import { isAgentProvider } from '../../shared/types/agentRuntime';
import { DevServerManager } from './services/visualVerify/devServerManager';
import { StaticServerManager } from './services/visualVerify/staticServerManager';
import { comparePngFiles } from './services/visualVerify/pixelDiff';
import { resolveDeliverableContext, resolveStaticHtmlContext } from './orchestrator/verifyConfigLoader';
import type { DeliverableVerifyConfig, VerdictV1, VlmJudge } from '../../shared/types/visualVerification';
import * as fs from 'fs';
import { runGitAsync } from './utils/runGit';
import type { ConfigManager } from './services/configManager';
import type { DatabaseService } from './database/database';
import type { FsBaselineStore } from './services/visualVerify/baselineStore';
import type { LoggerLike, DatabaseLike } from './orchestrator/types';

export interface VerifyCompositionDeps {
  configManager: ConfigManager;
  cyboflowLogger: LoggerLike;
  cyboflowDb: DatabaseLike;
  databaseService: Pick<DatabaseService, 'getProject' | 'getDb'>;
  /** The SAME store the ArtifactRouter's acceptBaseline hook writes through. */
  fsBaselineStore: FsBaselineStore;
  /** resolveClaudeExecutablePath()'s answer — undefined when no bundled CLI resolved. */
  claudeExecutablePath: string | undefined;
  /**
   * Absolute path of the compiled verification driver CLI (driverCli.js) —
   * asar-unpacked when packaged, `__dirname`-relative under index.ts in dev.
   * Resolved by index.ts, never here: this module's own `__dirname` is not the
   * contract.
   */
  driverCliPath: string;
}

export interface VerifyComposition {
  /** The ONE runbook store — the scheduler, the MCP register tool and the bootstrap share it. */
  verifyRunbookStore: VerifyRunbookStore;
  /** The health panel's runbook-status resolver; the SAME closure the scheduler's degrade gate uses. */
  verifyRunbookStatus: VerifyRunbookStatusLike;
  /** The §6 health-panel host probes (the preflight's own implementations). */
  verifyHostProbes: VerifyHostProbesLike;
  /** The bootstrap stamp store — the eval diff filter and address-review's protected-path list read it. */
  runbookBootstrapStamps: RunbookBootstrapStampStore;
}

export function composeVerification(deps: VerifyCompositionDeps): VerifyComposition {
  const {
    configManager,
    cyboflowLogger,
    cyboflowDb,
    databaseService,
    fsBaselineStore,
    claudeExecutablePath,
    driverCliPath: verifyDriverCliPath,
  } = deps;

  // VerificationScheduler — the main-process singleton that owns the DB-backed
  // verification_requests queue, the ResourceLeasePool (over the shared `mutex`),
  // and the waterfall drain loop (migration 055 / layered visual verification).
  // Lane agents fire-and-continue via the mcp-request-verification handler (P6),
  // which reaches this singleton through getInstance() to enqueue + nudge.
  //
  // P7 wires the Rung-0 backend (CapturePageBackend — offscreen BrowserWindow →
  // capturePage → PNG) and the real Rung-4 VlmJudge (a stateless Claude vision
  // call). Rungs 1-3 (playwright/peekaboo/maestro) land in later layers and are
  // simply absent from the registry until then. P8a wires the ADVISORY verdict
  // delivery: createVerdictDelivery enriches the SAME 'screenshots' artifact with
  // the verdict block (via ArtifactRouter) on every judged outcome and raises ONE
  // non-blocking 'visual-regression' finding (via ReviewItemRouter) only on FAIL /
  // low_confidence (PASS raises none); the merge-gate loopback is a later layer.
  // The artifactsDir resolver matches the screenshots auto-mint subtree
  // (CYBOFLOW_DIR/artifacts/runs/<runId>). The resolved visualVerify config
  // supplies the confidence threshold + port/sim pools. Standalone-typecheck
  // invariant: the scheduler imports no electron/service code — the verdict
  // delivery hook (which calls the electron-free routers) is INJECTED here.
  const visualVerifyConfig = configManager.getVisualVerifyConfig();
  // ------------------------------------------------------------------------
  // The §8 MOBILE tier's host objects — built ONCE, darwin-gated, here.
  //
  // Three consumers share this one composition: the scheduler's gate 1
  // (`mobileToolchainProbe`), the runner's pre-deploy preflight + simulator
  // acquisition (`mobile`), and the §6 health panel's `'mobile-simulator'` row
  // (`verifyHostProbes.mobileSimulator`). They must share ONE backend instance,
  // not three: the backend memoizes its verdict for 60 s and its Maestro path
  // for the process, and two instances could report different Maestro binaries
  // to the gate and to the driver — the exact 2026-08-05 peekaboo divergence
  // this tier was told not to repeat.
  //
  // `dataDir` is the per-instance cyboflow data dir (the same one
  // `getCyboflowSubdirectory` resolves under), because `verify-mobile/` holds
  // the §8.2 OWNERSHIP MARKERS: the boot sweep may only reclaim devices whose
  // marker lives under the data dir THIS instance owns, so a dev instance can
  // never delete a packaged instance's live simulator.
  //
  // Off darwin this constructs nothing and spawns nothing — see
  // mobileComposition.ts's off-darwin contract.
  // ------------------------------------------------------------------------
  const mobileVerification = composeMobileVerification({
    dataDir: getCyboflowDirectory(),
    logger: cyboflowLogger,
  });
  const realVlmJudge: VlmJudge = new VlmJudgeImpl({
    confidenceThreshold: visualVerifyConfig.vlmConfidenceThreshold,
    logger: cyboflowLogger,
  });
  // Per-run judge-call cap (bounds 2026 Agent-SDK vision billing). LEGACY-ENGINE
  // ONLY (redesign §5.8): the scheduler calls the judge per request only on the
  // capture-backend + VLM waterfall (a pre-upgrade run's legacy `verify_chain`
  // stamp, or CYBOFLOW_VERIFY_LEGACY); this decorator counts calls per run and,
  // beyond maxPerRunJudgeCalls, returns a low_confidence verdict (a human
  // review_item) instead of spending another vision call — never a fabricated
  // pass/fail. The default v1 engine's verification-AGENT deployment never
  // calls VlmJudge and is capped separately by the PERSISTED per-project
  // verification budget shared with this engine (visual_verify_budget_calls /
  // judge_calls_used, below).
  const judgeCallsByRun = new Map<string, number>();
  const cappedVlmJudge: VlmJudge = {
    judge: async (judgeArgs, signal) => {
      // The scheduler's judge args carry no runId; the artifactsDir is
      // ...artifacts/runs/<runId>, so derive the run scope from its last segment.
      const runId = path.basename(judgeArgs.artifactsDir);
      const used = judgeCallsByRun.get(runId) ?? 0;
      if (used >= visualVerifyConfig.maxPerRunJudgeCalls) {
        const exhausted: VerdictV1 = {
          status: 'low_confidence',
          confidence: 0,
          issues: [],
          feedback: `per-run visual-judge budget exhausted (${visualVerifyConfig.maxPerRunJudgeCalls} calls); needs human visual review`,
          judgedFileNames: judgeArgs.fileNames,
          baselineUsed: !!judgeArgs.baselinePath,
          model: 'capped',
        };
        return exhausted;
      }
      judgeCallsByRun.set(runId, used + 1);
      return realVlmJudge.judge(judgeArgs, signal);
    },
  };
  // S2 — the scheduler-owned dev-server runner. DevServerManager (a service that
  // imports node:child_process) is the concrete spawner; the scheduler knows only
  // the narrow DevServerProvider interface. The context resolver closure does the
  // DB path lookup (project + run worktree) and delegates the fs work to the pure
  // resolveDeliverableContext helper (worktree-first verify.json load + honest
  // deliverable match) so the scheduler stays fs/electron/service-free (standalone-
  // typecheck invariant) — mirrors the ArtifactRouter artifactCommitDir +
  // artifactsDir resolver closures above. It returns the checkout cwd the winning
  // verify.json was loaded from (the worktree when the branch owns the recipe, the
  // project root on fallback) + the matching deliverable recipe whose `start` the
  // runner runs on the leased port.
  const devServerManager = new DevServerManager({ logger: cyboflowLogger });
  const devServerContextResolver = async (args: {
    runId: string;
    projectId: number;
    input: { url?: string; htmlPath?: string };
  }): Promise<{ cwd: string; deliverable: DeliverableVerifyConfig } | null> => {
    try {
      const project = databaseService.getProject(args.projectId);
      if (!project?.path) return null;
      // WORKTREE-FIRST (locked decision #1): the build/start commands run in the
      // run's WORKTREE, so a deliverable recipe added/edited by the very branch under
      // verification must be read from the worktree checkout — the project ROOT
      // checkout is only the fallback (quick runs / sessions without a worktree /
      // pre-branch projects). resolveDeliverableContext loads worktree verify.json
      // first, falls back to the project root, returns the matching cwd, and matches
      // the deliverable HONESTLY (no `?? startable[0]` binding — a non-match returns
      // null so the request captures its own url/htmlPath unchanged).
      const row = cyboflowDb
        .prepare('SELECT worktree_path FROM workflow_runs WHERE id = ?')
        .get(args.runId) as { worktree_path: string | null } | undefined;
      return await resolveDeliverableContext(
        {
          worktreePath: row?.worktree_path ?? null,
          projectPath: project.path,
          input: args.input,
        },
        cyboflowLogger,
      );
    } catch (err) {
      cyboflowLogger?.warn('[VerificationScheduler] dev-server context resolve failed', {
        runId: args.runId,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  };
  // S9 — the scheduler-owned STATIC file server (the file:// ES-module-block fix).
  // A request that targets a BUILT html file (no running url, no verify.json `start`)
  // was previously loaded over `file://` by the rung-0 CapturePageBackend; Chromium
  // treats `file://` as an opaque origin and CORS-blocks every `<script
  // type="module">`, so bundler output silently rendered a blank styled shell — no
  // error, no signal, just an empty page a human had to notice by eye. StaticServerManager
  // (a service that imports node:http/node:crypto) is the concrete spawner; the
  // scheduler knows only the narrow StaticServerProvider interface (mirrors the S2
  // DevServerProvider split immediately above). The token-prefixed URL space IS the
  // authorization boundary (see StaticServerManager's header) — binding a loopback
  // port alone grants zero access control, so every request must present the
  // unguessable per-spawn token as its first path segment. There is deliberately NO
  // lease (unlike the S2 dev-server pool): the OS assigns an ephemeral port
  // (127.0.0.1:0), so static captures stay fully parallel — the `verify:port` pool
  // exists solely to interpolate `${PORT}` into a user's own `start` command, which a
  // static file server has no need of.
  //
  // staticHtmlContextResolver mirrors devServerContextResolver's shape exactly: it
  // does the DB path lookup (project path + the run's worktree_path, same SELECT)
  // and delegates ALL fs work to the pure resolveStaticHtmlContext helper (worktree-
  // first htmlPath resolution + the explicit-staticRoot containment check), so the
  // scheduler stays fs/electron/service-free (standalone-typecheck invariant). A
  // thrown error (or a null resolution — html not found in either checkout) fail-
  // softs to null; the scheduler then captures the request's raw htmlPath unchanged
  // (pre-S9 behavior, never a fabricated request FAIL).
  const staticServerManager = new StaticServerManager({ logger: cyboflowLogger });
  const staticHtmlContextResolver = async (args: {
    runId: string;
    projectId: number;
    htmlPath: string;
    staticRoot?: string;
  }): Promise<{ absoluteHtmlPath: string; staticRoot: string } | null> => {
    try {
      const project = databaseService.getProject(args.projectId);
      if (!project?.path) return null;
      const row = cyboflowDb
        .prepare('SELECT worktree_path FROM workflow_runs WHERE id = ?')
        .get(args.runId) as { worktree_path: string | null } | undefined;
      return await resolveStaticHtmlContext(
        {
          worktreePath: row?.worktree_path ?? null,
          projectPath: project.path,
          htmlPath: args.htmlPath,
          staticRoot: args.staticRoot,
        },
        cyboflowLogger,
      );
    } catch (err) {
      cyboflowLogger?.warn('[VerificationScheduler] static html context resolve failed', {
        runId: args.runId,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  };
  // S3 — Rung-1 PlaywrightBackend (interactive-web + multi-viewport + the
  // deterministic-first a11y/assertion gate). It drives a REAL headless browser via
  // the `playwright` LIBRARY in a fresh BrowserContext per capture (NOT the MCP
  // server — its single shared profile cannot serve N concurrent lanes). chromium is
  // LAZY-installed on first use (PlaywrightInstaller; idempotent + memoized), NOT
  // bundled in the app package. It is registered unconditionally — and that is SAFE
  // even though `playwright` is a ROOT devDependency electron-builder prunes when
  // packaging: the backend + installer load the library LAZILY (`await
  // import('playwright')`, never an eager top-level require), so an absent MODULE
  // soft-fails (healthCheck/ensureChromium → false, capture → ok:false) exactly like
  // an absent chromium BINARY — never a MODULE_NOT_FOUND boot crash. When chromium is
  // unavailable + the install fails, healthCheck() returns false and capture()
  // soft-fails (ok:false) so the request falls forward / is SKIPPED per
  // never-silently-pass — a missing browser binary must never wedge a sprint. The
  // backend sets CaptureResult.deterministicVerdict on an unambiguous nav/interaction
  // FAIL or an all-pass explicit-assertions PASS; the scheduler then SKIPS the paid
  // VLM (decision #3). It takes a verify:port lease ONLY when the deliverable
  // declares a dev-server `start` (the scheduler then owns + leases the dev server,
  // S2); a pre-existing static url needs no lease.
  const playwrightBackend = new PlaywrightBackend({ logger: cyboflowLogger });
  // S4 — Rung-2 PeekabooBackend (native-desktop). It is the ONLY backend that can
  // see cyboflow's OWN renderer: it SCREENSHOTS the already-running app via the
  // `peekaboo` CLI (DefaultPeekabooClient shells out behind the injected
  // PeekabooClient seam) instead of bootstrapping a renderer that needs the
  // preload-injected electronTRPC (capturePage / playwright both fail identically
  // on cyboflow's own window). It is registered unconditionally; the runtime
  // healthCheck() is the gate — it probes the `peekaboo` binary on PATH AND the two
  // required macOS TCC grants (Screen Recording + Accessibility) on the host
  // binary, returning false (⇒ resolver/scheduler drops peekaboo ⇒ SKIPPED) when
  // the binary is absent or a grant is declined. A missing TCC grant must NEVER
  // wedge a sprint (the recurring SPRINT-031..039 gotcha) — every error path
  // soft-fails (capture ⇒ ok:false fall-forward), never throws/hangs. requiredLease
  // ALWAYS returns the count-1 verify:screen lease (one display/focus/input), so
  // the scheduler (Peekaboo's sole client) serializes all native-desktop captures
  // app-wide through the shared mutex. dev builds run under the 'Electron' app
  // owner; the packaged app owner is 'Cyboflow' (the backend's default appTarget).
  // The BUNDLED peekaboo, not whatever is on PATH. macOS TCC grants attach to
  // a binary, and an npx-resolved one sits under a content-hashed cache path
  // that moves on every version bump — silently revoking both grants and
  // reporting them as declined. See peekabooExecutablePath.ts.
  //
  // ONE path, resolved ONCE, handed to BOTH sides. The capability gate (this
  // backend, via nativeCaptureProbe / unsupportedModalityDetail below) and the
  // deployed driver (VerificationAgentRunner's `peekabooBin`, exported as
  // VERIFY_PEEKABOO_BIN) must measure the SAME binary. They agreed by accident
  // while both defaulted to the bare PATH name; pointing only the gate at the
  // bundled copy would have it affirm a capability the driver then cannot use —
  // and on the very host bundling exists for (grants held, nothing on PATH) the
  // gate would pass, a count-1 screen lease and a full agent deploy would be
  // spent, and the driver's spawn would ENOENT deep inside the run.
  const verifyPeekabooPath = resolvePeekabooExecutable({
    isPackaged: app.isPackaged,
    ...(process.resourcesPath ? { resourcesPath: process.resourcesPath } : {}),
  });
  const peekabooBackend = new PeekabooBackend({
    logger: cyboflowLogger,
    executablePath: verifyPeekabooPath,
  });
  // S5 — the golden-baseline SSIM pre-diff resolver. When a request carries a
  // baselineKey, this closure resolves the accepted baseline PNG per captured
  // viewport (FsBaselineStore) and compares it (comparePngFiles → nativeImage decode,
  // zero-dep pixel/SSIM). It returns the MIN score across viewports + the first
  // resolved baseline path; the scheduler owns the match gate (>= threshold ⇒ cheap
  // PASS, no VLM). It does ALL fs + image-decode work so the scheduler stays
  // fs/electron/service-free (standalone-typecheck invariant). null ⇒ no baselineKey
  // resolved / no accepted baseline ⇒ intent-only judging (pre-S5 behavior).
  const baselinePreDiff = async (args: {
    projectId: number;
    runId: string;
    input: { baselineKey?: string };
    artifactsDir: string;
    fileNames: string[];
  }): Promise<{ baselinePath?: string; ssimScore: number; match: boolean } | null> => {
    const key = args.input.baselineKey;
    if (!key || key.trim().length === 0) return null;
    const project = databaseService.getProject(args.projectId);
    if (!project?.path) return null;
    const projectRoot = project.path;
    let minScore = 1;
    let firstBaselinePath: string | undefined;
    let compared = 0;
    for (const fileName of args.fileNames) {
      const stem = path.basename(fileName).replace(/\.png$/i, '');
      const baselinePath = await fsBaselineStore.read(projectRoot, key, stem);
      if (!baselinePath) continue; // no accepted baseline for this viewport — skip it
      if (!firstBaselinePath) firstBaselinePath = baselinePath;
      const capturedPath = path.join(args.artifactsDir, path.basename(fileName));
      const score = comparePngFiles(capturedPath, baselinePath);
      if (score < minScore) minScore = score;
      compared += 1;
    }
    // No captured viewport had an accepted baseline — nothing to compare.
    if (compared === 0) return null;
    return {
      ...(firstBaselinePath ? { baselinePath: firstBaselinePath } : {}),
      ssimScore: minScore,
      // The scheduler re-derives the authoritative match against its own threshold;
      // this is a hint only.
      match: false,
    };
  };
  // Verification-AGENT engine (redesign §5.4). The runner deploys the workflow-
  // defined 'visual-verify' agent per request; the scheduler routes a run stamped
  // verify_chain=['agent'] to it (default engine) instead of the capture backends.
  // The SDK boundary, the Claude-namespace agent/model resolvers, the node +
  // compiled-driver paths, and a real port-free probe are wired HERE so the runner
  // itself stays SDK/electron-free. (The driver-CLI path itself is INJECTED — see
  // `driverCliPath` on the deps: it is resolved against index.ts's own __dirname.)
  // Phase 2 (docs/proposals/verification-setup-flow.md §5.2 seam 1 + §5.3): the
  // The §5.3 drift probes (services/visualVerify/verifyDriftProbes.ts), hoisted
  // OUT of the store literal so the runbook BOOTSTRAP keys its §10 suppression
  // on the IDENTICAL hashes the store demotes a proof on.
  const verifyComputeInputHash = computeVerifyInputHash;
  const verifyHostFingerprint = (): Promise<string> =>
    computeVerifyHostFingerprint({
      probeChromium: probeChromiumExecutable,
      appExePath: app.getPath('exe'),
    });

  const verifyRunbookStore = new VerifyRunbookStore(cyboflowDb, {
    // ABSENT AND UNREADABLE ARE NOT THE SAME ANSWER (F4/F10 + Codex #8 —
    // docs/proposals/visual-verification-brittleness-fixes.md). `null` is the
    // store's "this tree genuinely does not carry the file" — the ordinary
    // pre-merge state on every branch that has not landed the runbook yet — and
    // the store now treats it as RECORD-AUTHORITATIVE: it skips the
    // portable-hash conjunct and judges the proof on the project input hash and
    // the host fingerprint alone. That makes the narrowness load-bearing. This
    // used to collapse EVERY fs error into `null`, which under the new gate
    // would launder an unreadable tree (a permissions error, a truncated read,
    // an IO fault) into a proof; so only the two codes that genuinely mean
    // "nothing is there" answer `null`, and anything else REJECTS, landing in
    // the store's own fail-soft catch as 'absent'/'indeterminate'.
    readPortableFile: async (dirPath: string): Promise<string | null> => {
      try {
        return await fs.promises.readFile(path.join(dirPath, VERIFY_RUNBOOK_RELATIVE_PATH), 'utf8');
      } catch (err) {
        // ENOENT: no such file. ENOTDIR: a path component is not a directory —
        // the same "there is nothing here" fact observed one level up (an
        // unresolvable/stale worktree path), not a read failure.
        const code = (err as NodeJS.ErrnoException | null)?.code;
        if (code === 'ENOENT' || code === 'ENOTDIR') return null;
        throw err;
      }
    },
    computeInputHash: verifyComputeInputHash,
    hostFingerprint: verifyHostFingerprint,
    // A0 legacy-NULL compat: a record proven before the fallback input hash
    // stored NULL for a package.json-less tree; this lets it keep matching.
    hasPackageJson: probeHasPackageJson,
    logger: cyboflowLogger,
  });

  // ONE resolver, two consumers: the scheduler's §3.2 degrade gate (below) and
  // the health panel's setup badge (via the tRPC context) — one implementation
  // so a record's badge and its gate can never be computed two different ways.
  //
  // The CALLER chooses the tree. The gate passes the requesting run's worktree,
  // because that is the tree whose commands would actually execute and the tree
  // the enqueue-time injection (scheduler.resolveProvenRunbook) has always
  // probed; before lane-runbook-bootstrap.md §3 this resolver forced the project
  // root on both, so a runbook committed on a session branch was invisible to
  // the gate until it merged. The health panel omits the path and gets the
  // project root, which is the level its question is actually asked at.
  //
  // No path at all (a deleted/unresolvable project row and no caller-supplied
  // one) ⇒ 'absent', which skips with the setup CTA rather than guessing.
  const verifyRunbookStatus: VerifyRunbookStatusLike = async (projectId, modality, probePath) => {
    const probeDir = probePath ?? databaseService.getProject(projectId)?.path;
    // No tree to probe at all: 'absent' with the honest reason. NOT
    // 'indeterminate' — an unresolvable project row is a missing project, not an
    // unreadable record — and the gate skips with the setup CTA either way.
    if (!probeDir) return { status: 'absent', reason: 'no-record' };
    return verifyRunbookStore.statusDetail(projectId, probeDir, modality);
  };

  const verificationAgentRunner = new VerificationAgentRunner({
    // The SAME binary the capability gate measured — see verifyPeekabooPath.
    peekabooBin: verifyPeekabooPath,
    query: makeVerificationAgentQuery(claudeExecutablePath, cyboflowLogger),
    // Codex runtime for a codex-pinned/inherited visual-verify agent; absent Codex CLI fails open to skipped.
    codexQuery: makeCodexVerificationAgentQuery(cyboflowLogger),
    // The workflow-defined 'visual-verify' agent + the run's provider/model, for the
    // Claude-namespace model rule (§5.4). Mirrors the resolveStepAgent thunk below
    // but returns the FULL EffectiveAgent for 'visual-verify'.
    resolveVerifyAgent: (runId: string) => {
      const eff = resolveRunEffectiveAgents(databaseService.getDb(), runId);
      const agent = eff.find((e) => e.agentKey === 'visual-verify');
      if (!agent) return undefined;
      const runRow = databaseService
        .getDb()
        .prepare('SELECT agent_provider AS provider, model FROM workflow_runs WHERE id = ?')
        .get(runId) as { provider: string | null; model: string | null } | undefined;
      const provider = runRow?.provider;
      const runProvider: AgentProvider = isAgentProvider(provider) ? provider : 'claude';
      return { agent, runProvider, runModel: runRow?.model ?? null };
    },
    // Alias→concrete Claude id, the SAME mechanism resolveStepAgent uses (bareModelId
    // at the agent default window; strips any [1m] suffix).
    resolveClaudeAlias: (alias) => bareModelId(alias, isModelUsable) ?? null,
    // Validated Claude fallback for an unpinned agent on a non-Claude run — reuse the
    // vision-judge default model source.
    claudeDefaultModel: DEFAULT_JUDGE_MODEL,
    resolveNode: findNodeExecutable,
    driverCliPath: verifyDriverCliPath,
    // §3.5 pre-deploy preflight probes (verification-setup-flow.md). Chromium
    // resolution is the driver's OWN, so preflight and the driver's later launch
    // can never disagree; the port probe is literally the same TCP connect the
    // scheduler's teardown uses below (declared after this block — referenced
    // through a closure so it is resolved at CALL time, not construction time).
    resolveChromium: probeChromiumExecutable,
    portFreeProbe: (port: number) => verifyPortFreeProbe(port),
    // The same never-throws two-grant Peekaboo probe the scheduler's native-screen
    // gate uses (§4) — wired here too so the runner's own §3.5 'native-capture'
    // preflight check actually runs on a native-screen deployment (the gate and
    // the preflight must agree on the same evidence source).
    nativeCaptureProbe: () => peekabooBackend.healthCheck(),
    // §5.2 seam 3 — resolve the PINNED runbook revision by its content hash so
    // the runner can refuse to execute anything else. The store answers from
    // `portable_json` (stored verbatim for exactly this reason): the snapshot the
    // runner executes in may predate the runbook file entirely, so the content
    // cannot come from the tree under test.
    resolveRunbookByHash: (projectId, modality, hash) =>
      verifyRunbookStore.getByHash(projectId, modality, hash),
    // §8 mobile collaborators. Present only on darwin: absent, a mobile request
    // returns a pre-deploy `skipped` carrying the synthetic 'mobile-simulator'
    // check, which the §3.1 classifier reads as `env` and never charges.
    //
    // The two pins floor to ABSENT when config leaves them '' — '' means
    // "resolve the newest compatible device type / runtime live at request
    // time", and passing it through as a literal would hand `simctl create` an
    // empty name to match.
    ...(mobileVerification.session !== null && mobileVerification.toolchain !== null
      ? {
          mobile: {
            session: mobileVerification.session,
            toolchain: mobileVerification.toolchain,
            dataDir: getCyboflowDirectory(),
            ...(visualVerifyConfig.mobileSimDeviceType !== ''
              ? { deviceType: visualVerifyConfig.mobileSimDeviceType }
              : {}),
            ...(visualVerifyConfig.mobileSimRuntime !== ''
              ? { runtime: visualVerifyConfig.mobileSimRuntime }
              : {}),
          },
        }
      : {}),
    logger: cyboflowLogger,
  });

  // §6 health panel — the SAME probe implementations the preflight above wires,
  // exposed to the renderer through the tRPC context. Sharing them is the
  // point: a panel row and a preflight check that disagreed would make the
  // panel a decorative second opinion.
  //
  // The two adapters with rules of their own (fail-open on the CLI probe,
  // retry semantics over the memoizing installer) live in hostProbeAdapters.ts
  // — this file boots Electron and cannot be imported by a unit test, so
  // anything with a rule worth asserting does not belong inline here.
  const verifyHostProbes: VerifyHostProbesLike = {
    // The SAME composition the scheduler's gate and the runner's preflight read
    // — the panel is not a second opinion. Wired UNCONDITIONALLY, unlike the two
    // macOS grant probes below: off darwin this reports an honest
    // `'inconclusive'` row without spawning anything, and a host that can never
    // run the tier is exactly what a user deciding whether to declare `mobile`
    // needs told.
    mobileSimulator: mobileVerification.probeRow,
    resolveNode: findNodeExecutable,
    resolveChromium: probeChromiumExecutable,
    probeDriverCli: makeDriverCliProbe(verifyDriverCliPath, (p) => fs.promises.access(p)),
    ensureChromium: makeChromiumProvisioner(
      () => new PlaywrightInstaller({ logger: cyboflowLogger }),
      cyboflowLogger,
    ),
    // The grant PROBE and the two grant ACTIONS are all macOS-only: no other
    // platform has these TCC grants at all. Leaving the probe wired off darwin
    // spawned a binary that is not there on every panel open, and reported the
    // resulting failure as two permanent `unknown` rows — describing grants the
    // platform does not have as something we merely could not read. Omitted, the
    // router's own unwired branch says the honest thing instead ("no native
    // capture backend wired on this host"). The router likewise omits a row's
    // fix rather than offering a button for a settings pane that does not exist.
    ...(process.platform === 'darwin'
      ? {
          nativeGrants: () => peekabooBackend.probeGrants(),
          requestAccessibility: makeAccessibilityRequester({
            isTrustedAccessibilityClient: (prompt) =>
              systemPreferences.isTrustedAccessibilityClient(prompt),
            openSettings: (url) => shell.openExternal(url),
            logger: cyboflowLogger,
          }),
          openScreenRecordingSettings: makeScreenRecordingSettingsOpener({
            openSettings: (url) => shell.openExternal(url),
            logger: cyboflowLogger,
          }),
        }
      : {}),
  };
  // Real port-free probe (§5.4 step 6): a refused/timed-out TCP connect to
  // 127.0.0.1:<port> means nothing is listening ⇒ the port is free; a successful
  // connect means a leaked server ⇒ NOT free (quarantine the lease).
  const verifyPortFreeProbe = (port: number): Promise<boolean> =>
    new Promise((resolve) => {
      const socket = net.connect({ host: '127.0.0.1', port });
      let settled = false;
      const done = (free: boolean): void => {
        if (settled) return;
        settled = true;
        socket.destroy();
        resolve(free);
      };
      socket.setTimeout(500);
      socket.once('connect', () => done(false));
      socket.once('timeout', () => done(true));
      socket.once('error', () => done(true));
    });
  // Shared by the scheduler AND verdict delivery (verifier-transcript capture):
  // both must resolve the SAME on-disk run-artifacts dir, so delivery's transcript
  // existence check observes exactly where the runner wrote the transcript.
  const verifyArtifactsDirResolver = (runId: string): string =>
    getCyboflowSubdirectory('artifacts', 'runs', runId);
  // ------------------------------------------------------------------------
  // The lane RUNBOOK BOOTSTRAP (docs/proposals/lane-runbook-bootstrap.md §12).
  //
  // Everything below is IO the sequence itself must not own: a git binary, a
  // filesystem, an SDK query, the scheduler singleton. `runRunbookBootstrap` is
  // a pure sequence over these closures, which is what lets the whole
  // draft → validate → commit → register → prove path be unit-tested with no
  // worktree and no subprocess.
  //
  // Gated twice before any of it runs — the project toggle and the kill switch
  // (combined in `evaluateRunbookBootstrap`), then §4's runbook-situation check.
  // Default ON since F9 (visual-verification-brittleness-fixes.md); the kill
  // switch is CYBOFLOW_DISABLE_RUNBOOK_BOOTSTRAP=1.
  // ------------------------------------------------------------------------
  const runbookBootstrapStamps = new RunbookBootstrapStampStore(cyboflowDb, cyboflowLogger);
  const runbookBootstrapSuppression = new BootstrapSuppressionStore(cyboflowDb, cyboflowLogger);
  const runbookDraftQuery = makeRunbookDraftQuery(claudeExecutablePath, cyboflowLogger);

  const runbookBootstrapRunner = (
    args: Parameters<typeof runRunbookBootstrap>[0],
  ): ReturnType<typeof runRunbookBootstrap> =>
    runRunbookBootstrap(args, {
      stamps: runbookBootstrapStamps,
      suppression: runbookBootstrapSuppression,
      // The READ-ONLY drafting agent (§8). Resolved through the same effective-
      // agent layering every other bundled agent uses, so its prompt and its
      // model are overridable per project/workflow exactly like visual-verify's
      // — this is a bundled agent that happens to be deployed by the controller
      // rather than bound to a step, not a hardcoded prompt.
      draft: async (request) => {
        const effective = resolveRunEffectiveAgents(databaseService.getDb(), request.runId);
        const agent = effective.find((e) => e.agentKey === 'runbook-bootstrap');
        if (!agent) {
          cyboflowLogger?.warn?.('[runbookBootstrap] the runbook-bootstrap agent is not resolvable for this run');
          return { kind: 'error', message: 'the runbook-bootstrap agent is not resolvable for this run' };
        }
        // Claude-only, deliberately: this deployment's whole output is a
        // structured object validated against a JSON schema, and the query below
        // is the Claude SDK boundary. A run pinned to another provider gets the
        // Claude default rather than a deployment that cannot honor the contract.
        const model =
          agent.model !== null ? bareModelId(agent.model, isModelUsable) ?? DEFAULT_JUDGE_MODEL : DEFAULT_JUDGE_MODEL;
        // Authoring from scratch gets the longer budget; adopting a committed
        // runbook keeps the short one — the agent is told which so it can pace.
        const timeoutMs = runbookDraftTimeoutMs(request.adopt && request.existingRunbookRaw !== null);
        return runbookDraftQuery({
          prompt: composeRunbookDraftPrompt({
            modality: request.modality,
            round: request.round,
            maxRounds: MAX_BOOTSTRAP_ROUNDS,
            adopt: request.adopt,
            existingRunbookRaw: request.existingRunbookRaw,
            feedback: request.feedback,
            laneTaskRef: request.laneTaskRef,
            timeBudgetMs: timeoutMs,
          }),
          systemPrompt: agent.systemPrompt,
          cwd: request.worktreePath,
          model,
          timeoutMs,
        });
      },
      readFile: async (worktreePath, relativePath) => {
        try {
          return await fs.promises.readFile(path.join(worktreePath, relativePath), 'utf8');
        } catch {
          return null;
        }
      },
      writeFile: async (worktreePath, relativePath, content) => {
        const target = path.join(worktreePath, relativePath);
        await fs.promises.mkdir(path.dirname(target), { recursive: true });
        await fs.promises.writeFile(target, content, 'utf8');
      },
      // Pathspec commit with index-lock retry — NEVER a bare commit, which in a
      // worktree five lanes are editing would sweep up whatever they had staged
      // (§8 check 4).
      commitPaths: (worktreePath, paths, message) =>
        commitPathspec({
          git: (gitArgs) => runGitAsync(worktreePath, gitArgs),
          paths,
          message,
          ...(cyboflowLogger ? { logger: cyboflowLogger } : {}),
        }),
      registerDraft: (projectId, worktreePath, modality) =>
        verifyRunbookStore.registerDraft(projectId, worktreePath, modality),
      // The 'reprove' mode's only input (F4 / Codex #2): the record as it stands,
      // content and pin together. It reads the DB, NOT this worktree's file —
      // what a re-prove must prove is the revision the engine will execute, and
      // a divergence between the two is itself one of the things that made the
      // record drift.
      currentRecord: (projectId, modality) => verifyRunbookStore.getCurrent(projectId, modality),
      setOrigin: (projectId, modality, origin) => verifyRunbookStore.setOrigin(projectId, modality, origin),
      // A passing proof and a proven record are two different facts: the engine
      // declines to promote a proof that ran in the dirty-worktree fallback,
      // carried no pin, or lost its CAS. Ask the record itself rather than infer
      // it from the request's status — probing the RUN WORKTREE, the same tree
      // the lane's own enqueue will resolve against.
      confirmProven: async () =>
        (await verifyRunbookStore.status(args.projectId, args.worktreePath, args.modality)) === 'proven',
      // The proof rides the SAME enqueue seam as ordinary lane traffic, with the
      // migration-105 kind set. `bootstrapProof` is not a wire field and this is
      // its only writer, which makes it a strictly stronger guarantee than
      // setup_proof's workflow-identity check (§5).
      enqueueProof: async ({ runId, laneTaskRef, task, round, runbookHash, runbookLocalVersion }) => {
        const worktree = databaseService.getDb()
          .prepare('SELECT worktree_path AS worktreePath FROM workflow_runs WHERE id = ?')
          .get(runId) as { worktreePath?: unknown } | undefined;
        const worktreePath =
          typeof worktree?.worktreePath === 'string' && worktree.worktreePath.length > 0
            ? worktree.worktreePath
            : null;
        if (worktreePath === null) return { error: 'the run has no worktree to snapshot' };
        const result = await enqueueTaskVerification({
          db: cyboflowDb,
          runId,
          task,
          laneTaskRef,
          // The lane's attempt is irrelevant to the proof's identity — the
          // `:bootstrap:<round>` generation segment is what makes each round its
          // own request, and it is appended to this number rather than replacing
          // it. Pinned at 1 so a lane loopback cannot make round 1 look fresh.
          attempt: 1,
          worktreePath,
          bootstrapProof: true,
          bootstrapRound: round,
          runbookHash,
          runbookLocalVersion,
          ...(cyboflowLogger ? { logger: cyboflowLogger } : {}),
        });
        return result.outcome === 'enqueued'
          ? { requestId: result.requestId }
          : { error: result.reason };
      },
      awaitProof: (requestId, timeoutMs) =>
        VerificationScheduler.getInstance().awaitTerminal(requestId, timeoutMs),
      computeInputHash: verifyComputeInputHash,
      hostFingerprint: verifyHostFingerprint,
      // §12 step 10 — the `verify-runbook` tab, through the artifact chokepoint.
      // One artifact per (run, atype), so a second modality's bootstrap in the
      // same run replaces this rather than minting a rival tab.
      reportArtifact: async ({ projectId, runId, label, markdown }) => {
        await ArtifactRouter.getInstance().apply(projectId, {
          op: 'create',
          runId,
          atype: 'verify-runbook',
          label,
          payloadJson: JSON.stringify({ markdown }),
          actor: 'orchestrator',
        });
      },
      // §8.1 — the review-queue row naming an auto-edited config file. This is
      // the REVIEW-BACKED half of §15A's trade: rung 1 is only as safe as the
      // review it gets, so the finding is the guarantee rather than a courtesy.
      // Non-blocking — it asks for eyes at the merge gate, it does not park the
      // run.
      reportFinding: async ({ projectId, runId, title, body, locations }) => {
        await ReviewItemRouter.getInstance().applyReviewItem(projectId, {
          op: 'create',
          actor: 'orchestrator',
          kind: 'finding',
          title,
          body,
          blocking: false,
          audience: 'human',
          severity: 'warning',
          source: 'runbook-bootstrap',
          entityType: null,
          entityId: null,
          runId,
          // `locations` rides on the finding PAYLOAD, not on the review item —
          // that is where the queue's card reads file references from.
          payload: { kind: 'finding', category: 'runbook-bootstrap', locations },
        });
      },
      ...(cyboflowLogger ? { logger: cyboflowLogger } : {}),
    });

  VerificationScheduler.initialize({
    db: cyboflowDb,
    backends: {
      capturePage: new CapturePageBackend(),
      playwright: playwrightBackend,
      peekaboo: peekabooBackend,
    },
    judge: cappedVlmJudge,
    artifactsDirResolver: verifyArtifactsDirResolver,
    logger: cyboflowLogger,
    config: visualVerifyConfig,
    // Re-read per call, for the settings a user expects to take effect without
    // relaunching the app — see `liveConfig` on the scheduler's deps.
    liveConfig: () => configManager.getVisualVerifyConfig(),
    // P8a — advisory verdict delivery through the existing router chokepoints
    // (artifact enrich on every judged outcome + a FAIL/low-confidence finding).
    onVerdict: createVerdictDelivery({
      db: cyboflowDb,
      logger: cyboflowLogger,
      artifactsDirResolver: verifyArtifactsDirResolver,
    }),
    // S2 — scheduler-owned dev server per verify.json build/start/readyWhen/${PORT}.
    devServerProvider: devServerManager,
    devServerContextResolver,
    // S9 — scheduler-owned static file server for a built htmlPath (file:// CORS fix).
    staticServerProvider: staticServerManager,
    staticHtmlContextResolver,
    // S5 — golden-baseline SSIM pre-diff gates the (paid) VLM (§5.10: the
    // baseline feature itself is retired; this closure now always resolves
    // null — see baselineStore.ts / pixelDiff.ts). The per-project
    // VERIFICATION budget + judge_calls_used telemetry (migration 056;
    // generalized §5.8 to also cover an agent deployment on the default v1
    // engine, not just a legacy VLM call) is enforced inside the scheduler off
    // its injected db (isProjectBudgetExhausted); the per-RUN, LEGACY-ONLY
    // vision-call cap stays the cappedVlmJudge decorator above.
    baselinePreDiff,
    // Verification-AGENT engine (redesign §5.4): a run stamped verify_chain=['agent']
    // routes to this runner instead of the capture backends above; the port probe
    // decides release-vs-quarantine at agent teardown.
    agentRunner: verificationAgentRunner,
    portFreeProbe: verifyPortFreeProbe,
    // Phase 0 honest failures (docs/proposals/verification-setup-flow.md §3):
    // the per-(project, modality) capability ledger backing the `unsupported`
    // mark + the K-consecutive-env-failure circuit breaker, and the non-blocking
    // finding its trip raises (through verdictDelivery, which owns the
    // ReviewItemRouter chokepoint — the scheduler never touches a router).
    capabilityStore: new VerifyCapabilityStore(cyboflowDb, cyboflowLogger),
    // Phase 2 §3.2/§5.3: the degrade gate's real answer, replacing the honest
    // 'absent' placeholder. Probed against the PROJECT path — the gate asks a
    // project-level question ("has this project ever proven a runbook for this
    // modality on this host"), while the enqueue-time injection
    // (scheduler.resolveProvenRunbook) probes the requesting RUN's worktree,
    // which is the tree whose commands would actually execute. No project path
    // (a deleted/unresolvable project row) ⇒ 'absent', which skips with the setup
    // CTA rather than guessing.
    runbookStatus: verifyRunbookStatus,
    // The same store instance backs the enqueue-time pinned injection (§5.2 seam
    // 3) and the ENGINE-ENFORCED proof flip (§5.3) — a setup-proof request that
    // actually passed is the only transition into 'proven'.
    runbookStore: verifyRunbookStore,
    capabilityFinding: createCapabilityBreakerFinding({ db: cyboflowDb, logger: cyboflowLogger }),
    // §A7 — the "runbook needs re-proving, lanes explore meanwhile" notice.
    staleProofFinding: createExploreStaleProofFinding({ db: cyboflowDb, logger: cyboflowLogger }),
    // Phase 1 modality roster (§4): the live grant probe that decides whether a
    // `native-screen` request may deploy at all. Reuses the capture backend's
    // healthCheck verbatim, exactly as the proposal prescribes ("the retired
    // peekabooBackend.healthCheck() (both-grants probe, never-throws) is reused
    // as the live grant probe") — binary-on-PATH AND both macOS TCC grants, and
    // it never throws, so the scheduler's gate gets a plain boolean. Bound to the
    // SAME backend instance registered above, so the agent path and the legacy
    // capture path can never disagree about this host's screen capability.
    nativeCaptureProbe: () => peekabooBackend.healthCheck(),
    // §8 gate 1 for the `mobile` modality — the SAME probe instance the runner's
    // preflight and the health panel read. The two layers keep OPPOSITE, correct
    // rules over it (§10): this gate fails CLOSED (an unanswerable toolchain must
    // not lease a 2 GB simulator boot), while preflight fails OPEN. Both are
    // satisfied by one probe because `healthCheck` already folds `absent` and
    // `inconclusive` alike to `false` and never throws.
    mobileToolchainProbe: mobileVerification.probe,
    // §12 steps 3–8: derive, commit, register and PROVE a runbook for a lane
    // whose verification would otherwise be skipped. The scheduler owns the
    // DECISION (it holds the toggle and the runbook status); this closure is the
    // ACTING half, assembled above out of IO the scheduler must not hold.
    runbookBootstrap: runbookBootstrapRunner,
  });

  // §8.2 boot sweep — reclaim simulators and DerivedData whose owning process is
  // PROVABLY dead (marker pid gone, or its start time no longer matches). Fired
  // AFTER the scheduler exists so a request that arrives mid-sweep already has a
  // queue to land in, and deliberately NOT awaited: reclaiming disk is
  // best-effort housekeeping, and `simctl delete` on a stale device can take
  // seconds that boot must not spend. It never throws (the factory catches and
  // logs), so the `.catch` here is belt-and-braces against an unhandled
  // rejection rather than a real branch.
  void mobileVerification.sweepAtBoot().catch(() => {});

  return { verifyRunbookStore, verifyRunbookStatus, verifyHostProbes, runbookBootstrapStamps };
}
