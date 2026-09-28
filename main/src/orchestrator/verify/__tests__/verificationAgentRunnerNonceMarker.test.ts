/**
 * VerificationAgentRunner — the HARNESS-INJECTED WEB NONCE MARKER
 * (`webNonceMarker.ts`, wired into the runner's `run()` at the "(b0) WEB NONCE
 * MARKER" step).
 *
 * Split from the sibling explore suite so this one feature — stamping
 * `<meta name="cyboflow-verify-nonce" …>` into a snapshot's entry HTML before
 * the agent runs, so a runbook-less web project can verify identity on
 * something stronger than the serve binding alone — has its own readable
 * record: the `wantsNonceMarker` / `markerUpgradesDeclaration` truth tables,
 * the mode-aware floor's marker fallback, the runner's actual injection +
 * prompt note + attest + mutation-check wiring, and the learned-recipe
 * override. Same fake-seam posture as the sibling suite: no SDK, no process
 * spawned, no socket dialled, no real filesystem touched (every test supplies
 * its own `nonceMarkerFs`).
 */
import { describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import {
  VerificationAgentRunner,
  effectiveAttestationSpec,
  evaluateAttestationFloorForMode,
  markerUpgradesDeclaration,
  wantsNonceMarker,
  type AttestationFloorOutcome,
  type ServeBindingResult,
  type VerificationAgentQueryArgs,
  type VerificationAgentQueryOutcome,
  type VerificationAgentRequest,
  type VerificationAgentRunnerDeps,
} from '../verificationAgentRunner';
import { validateLearnedRecipe } from '../learnedRecipe';
import {
  HARNESS_NONCE_MARKER_SELECTOR,
  HARNESS_NONCE_MARKER_SPEC,
  type NonceMarkerFs,
} from '../webNonceMarker';
import type { HarnessAttestationResult } from '../harnessAttestation';
import type { EffectiveAgent } from '../../agents/effectiveAgents';
import type { AttestationSpec, VerificationReportV1, VerificationTaskV1 } from '../../../../../shared/types/visualVerification';

// ---------------------------------------------------------------------------
// Fixtures (mirrors verificationAgentRunnerExplore.test.ts's fixtures)
// ---------------------------------------------------------------------------

const SERVE_CMD = 'pnpm run preview --port ${PORT}';
const HTTP_SPEC: AttestationSpec = { kind: 'http-endpoint', urlPath: '/__cyboflow_verify__' };
const SNAPSHOT_ROOT = '/snap';
const ENTRY_HTML_PATH = join(SNAPSHOT_ROOT, 'index.html');
const ENTRY_HTML = ['<!DOCTYPE html>', '<html>', '<head>', '  <title>App</title>', '</head>', '<body></body>', '</html>', ''].join(
  '\n',
);
const PKG = JSON.stringify({ scripts: { build: 'vite build', preview: 'vite preview' } });

const SERVE_LEADER_PID = 4242;
const SERVE_CHILD_PID = 4243;
const FOREIGN_PID = 9001;

function makeAgent(): EffectiveAgent {
  return {
    agentKey: 'visual-verify',
    name: 'cyboflow-visual-verify',
    role: 'verify',
    description: 'd',
    systemPrompt: 'SYSTEM PROMPT BODY',
    tools: [],
    model: null,
    enabledMcps: [],
    source: 'builtin',
  };
}

function makeTask(overrides: Partial<VerificationTaskV1> = {}): VerificationTaskV1 {
  return {
    version: 1,
    summary: 'verify the widget',
    behaviors: [{ id: 'b1', description: 'renders', expected: 'the widget is visible' }],
    ...overrides,
  };
}

function validReport(overrides: Partial<VerificationReportV1> = {}): VerificationReportV1 {
  return {
    version: 1,
    behaviors: [{ id: 'b1', result: 'pass', evidence: { screenshots: ['s.png'], notes: 'ok' } }],
    screenshots: [{ fileName: 's.png', caption: 'the widget' }],
    outcome: 'pass',
    confidence: 0.9,
    feedback: 'looks right',
    issues: [],
    ...overrides,
  };
}

function makeReq(overrides: Partial<VerificationAgentRequest> = {}): VerificationAgentRequest {
  return {
    runId: 'run-1',
    requestId: 'vr-nonce-1',
    projectId: 1,
    task: makeTask(),
    runWorktreePath: '/live/worktree',
    snapshotSha: 'abc123',
    artifactsDir: '/artifacts',
    verifyPort: 29260,
    verifyDriverPort: 29261,
    signal: new AbortController().signal,
    ...overrides,
  };
}

function outcome(structured: unknown): VerificationAgentQueryOutcome {
  return { structured, transcript: null };
}

/** The three binding probes for a HEALTHY serve of `serveCmd` (a child of the recorded leader holds the port). */
function servedBy(serveCmd: string): Partial<VerificationAgentRunnerDeps> {
  return {
    readServePid: async () => SERVE_LEADER_PID,
    listeningPidForPort: async () => SERVE_CHILD_PID,
    processInfo: async (pid: number) =>
      pid === SERVE_CHILD_PID
        ? { pgid: SERVE_LEADER_PID, command: 'node /snap/node_modules/.bin/vite' }
        : { pgid: SERVE_LEADER_PID, command: `sh -c ${serveCmd}` },
  };
}

/** The driver recorded a serve group, but the port is held by a process in ANOTHER group. */
const foreignListener: Partial<VerificationAgentRunnerDeps> = {
  readServePid: async () => SERVE_LEADER_PID,
  listeningPidForPort: async () => FOREIGN_PID,
  processInfo: async (pid: number) =>
    pid === FOREIGN_PID
      ? { pgid: FOREIGN_PID, command: 'node /Users/dev/their-own/vite' }
      : { pgid: SERVE_LEADER_PID, command: `sh -c ${SERVE_CMD}` },
};

/** A `NonceMarkerFs` with no entry HTML anywhere — every candidate reads as absent. */
function noEntryNonceMarkerFs(): { fs: NonceMarkerFs; writeFile: ReturnType<typeof vi.fn> } {
  const writeFile = vi.fn(async (_absPath: string, _content: string): Promise<void> => {});
  return { fs: { readRegularFile: async () => null, writeFile }, writeFile };
}

/** A `NonceMarkerFs` whose single entry HTML candidate is `path`, holding `html`. */
function stampableNonceMarkerFs(path: string, html: string): { fs: NonceMarkerFs; writeFile: ReturnType<typeof vi.fn> } {
  const writeFile = vi.fn(async (_absPath: string, _content: string): Promise<void> => {});
  return {
    fs: { readRegularFile: async (absPath: string) => (absPath === path ? html : null), writeFile },
    writeFile,
  };
}

function makeRunner(overrides: Partial<VerificationAgentRunnerDeps> = {}) {
  const query = vi.fn(async (args: VerificationAgentQueryArgs) => {
    void args;
    return outcome(validReport());
  });
  const codexQuery = vi.fn(async (args: VerificationAgentQueryArgs) => {
    void args;
    return outcome(validReport());
  });
  const attest = vi.fn(
    async (): Promise<HarnessAttestationResult> => ({
      verified: true,
      kind: 'http-endpoint',
      detail: 'endpoint returned this request nonce',
    }),
  );
  const writeDriverScript = vi.fn(
    async (...args: Parameters<NonNullable<VerificationAgentRunnerDeps['writeDriverScript']>>) => {
      void args;
      return '/artifacts/.driver/verify-driver.sh';
    },
  );
  const materializeDependencyGuardShim = vi.fn(async (): Promise<{ binDir: string | null }> => ({ binDir: null }));
  const { fs: defaultNonceMarkerFs } = noEntryNonceMarkerFs();
  const deps: VerificationAgentRunnerDeps = {
    query,
    codexQuery,
    resolveVerifyAgent: () => ({ agent: makeAgent(), runProvider: 'claude', runModel: 'claude-sonnet-5' }),
    resolveClaudeAlias: (alias) => `claude-${alias}-resolved`,
    claudeDefaultModel: 'claude-opus-4-8',
    resolveNode: async () => '/usr/bin/node',
    driverCliPath: '/app/driverCli.js',
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    provision: async () => ({ worktreePath: SNAPSHOT_ROOT, sha: 'abc123', dispose: async () => {} }),
    checkSnapshotMutated: async () => false,
    fileExists: async () => true,
    resolveChromium: async () => '/opt/chromium',
    portFreeProbe: async () => true,
    writeDriverScript,
    stopDriver: async () => {},
    reapBrowser: () => {},
    reapServe: () => {},
    writeTranscript: async () => {},
    attest,
    // Nothing was served through the driver unless a test opts in.
    readServePid: async () => null,
    listeningPidForPort: async () => null,
    processInfo: async () => null,
    resolveShellPath: async () => '/usr/bin',
    resolveNodeModulesRoot: async () => null,
    prepareDataDir: async () => {},
    materializeDependencyGuardShim,
    nonceMarkerFs: defaultNonceMarkerFs,
    ...overrides,
  };
  return { runner: new VerificationAgentRunner(deps), query, codexQuery, attest, writeDriverScript, materializeDependencyGuardShim };
}

const noChannelTask = makeTask({ serve: { cmd: SERVE_CMD } });
const serveBindingTask = makeTask({ attestation: { kind: 'serve-binding' }, serve: { cmd: SERVE_CMD } });

// ---------------------------------------------------------------------------
// wantsNonceMarker — truth table
// ---------------------------------------------------------------------------

describe('wantsNonceMarker', () => {
  it('a web explore task with no declared attestation wants the marker', () => {
    expect(wantsNonceMarker(noChannelTask, 'web', 'explore')).toBe(true);
  });

  it('a web explore task that declared serve-binding also wants the marker (the upgrade case)', () => {
    expect(wantsNonceMarker(serveBindingTask, 'web', 'explore')).toBe(true);
  });

  it('a web task declaring the harness marker itself wants it, in EVERY mode', () => {
    const declared = makeTask({ attestation: HARNESS_NONCE_MARKER_SPEC, serve: { cmd: SERVE_CMD } });
    expect(wantsNonceMarker(declared, 'web', 'explore')).toBe(true);
    expect(wantsNonceMarker(declared, 'web', 'pinned')).toBe(true);
    expect(wantsNonceMarker(declared, 'web', 'legacy')).toBe(true);
  });

  it('a web explore task declaring a different channel does not want the marker', () => {
    const declared = makeTask({ attestation: HTTP_SPEC, serve: { cmd: SERVE_CMD } });
    expect(wantsNonceMarker(declared, 'web', 'explore')).toBe(false);
  });

  it('cdp-attach serve never wants the marker', () => {
    const attach = makeTask({ serve: { cmd: SERVE_CMD, attach: 'cdp' } });
    expect(wantsNonceMarker(attach, 'web', 'explore')).toBe(false);
  });

  it('no composed serve.cmd never wants the marker', () => {
    const noServe = makeTask({ target: { url: 'http://127.0.0.1:1/' } });
    expect(wantsNonceMarker(noServe, 'web', 'explore')).toBe(false);
  });

  it('a non-web modality never wants the marker, whatever the task looks like', () => {
    expect(wantsNonceMarker(noChannelTask, 'cdp-app', 'explore')).toBe(false);
    expect(wantsNonceMarker(noChannelTask, 'mobile', 'explore')).toBe(false);
    expect(wantsNonceMarker(noChannelTask, 'native-screen', 'explore')).toBe(false);
  });

  it('a legacy or pinned web task with no declared attestation does not want the marker', () => {
    expect(wantsNonceMarker(noChannelTask, 'web', 'legacy')).toBe(false);
    expect(wantsNonceMarker(noChannelTask, 'web', 'pinned')).toBe(false);
  });

  it('a pinned web task declaring serve-binding does not want the marker (the upgrade is explore-only)', () => {
    expect(wantsNonceMarker(serveBindingTask, 'web', 'pinned')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// markerUpgradesDeclaration — truth table
// ---------------------------------------------------------------------------

describe('markerUpgradesDeclaration', () => {
  it('is true for no declaration and for a declared serve-binding', () => {
    expect(markerUpgradesDeclaration(undefined)).toBe(true);
    expect(markerUpgradesDeclaration({ kind: 'serve-binding' })).toBe(true);
  });

  it('is false for every other declared channel, including the marker spec itself', () => {
    expect(markerUpgradesDeclaration(HTTP_SPEC)).toBe(false);
    expect(markerUpgradesDeclaration(HARNESS_NONCE_MARKER_SPEC)).toBe(false);
    expect(markerUpgradesDeclaration({ kind: 'bundle-identity', bundleId: 'com.acme.app' })).toBe(false);
    expect(markerUpgradesDeclaration({ kind: 'file-identity' })).toBe(false);
    expect(markerUpgradesDeclaration({ kind: 'window-identity', titlePattern: 'App', app: 'App' })).toBe(false);
    expect(markerUpgradesDeclaration({ kind: 'cdp-token', expression: '1', expected: '1' })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// effectiveAttestationSpec — the harness marker wins first
// ---------------------------------------------------------------------------

describe('effectiveAttestationSpec — harness marker', () => {
  it('returns the marker spec first when harnessMarker is true, even over a declared channel', () => {
    const spec = effectiveAttestationSpec(serveBindingTask, { executionMode: 'explore', mobileLeased: false, harnessMarker: true });
    expect(spec).toEqual(HARNESS_NONCE_MARKER_SPEC);
  });

  it('falls through to the declared channel when harnessMarker is false or absent', () => {
    const declared = makeTask({ attestation: HTTP_SPEC });
    expect(effectiveAttestationSpec(declared, { executionMode: 'explore', mobileLeased: false, harnessMarker: false })).toEqual(
      HTTP_SPEC,
    );
    expect(effectiveAttestationSpec(declared)).toEqual(HTTP_SPEC);
  });
});

// ---------------------------------------------------------------------------
// evaluateAttestationFloorForMode — the marker fallback (§A1.2 upgrade)
// ---------------------------------------------------------------------------

describe('evaluateAttestationFloorForMode — harness marker fallback', () => {
  const composedTask = (attestation?: AttestationSpec): VerificationTaskV1 =>
    makeTask({ serve: { cmd: SERVE_CMD }, ...(attestation !== undefined ? { attestation } : {}) });

  const boundBinding: ServeBindingResult = { bound: true, detail: 'bound to the recorded serve group' };
  const unboundNonForeign: ServeBindingResult = { bound: false, failure: 'serve-pid', detail: 'no serve process recorded' };
  const foreignBinding: ServeBindingResult = {
    bound: false,
    failure: 'port-owner',
    detail: 'a different process holds the port',
    foreignListener: { pid: 1, pgid: 2, recordedGroup: 3 },
  };
  const verifiedMarkerProbe: HarnessAttestationResult = { verified: true, kind: 'dom-marker', detail: 'marker matched' };
  const unverifiedMarkerProbe: HarnessAttestationResult = { verified: false, kind: 'dom-marker', detail: 'marker not found' };

  it('a verified marker with a bound composed-serve binding verifies as dom-marker', () => {
    const floor = evaluateAttestationFloorForMode(
      'explore',
      composedTask(),
      HARNESS_NONCE_MARKER_SPEC,
      verifiedMarkerProbe,
      boundBinding,
      { harnessSuppliedMarker: true },
    );
    expect(floor).toEqual({ kind: 'verified', channel: 'dom-marker', detail: verifiedMarkerProbe.detail });
  });

  it('an unverified marker with a bound binding falls back to a verified serve-binding', () => {
    const floor = evaluateAttestationFloorForMode(
      'explore',
      composedTask(),
      HARNESS_NONCE_MARKER_SPEC,
      unverifiedMarkerProbe,
      boundBinding,
      { harnessSuppliedMarker: true },
    );
    expect(floor.kind).toBe('verified');
    expect((floor as Extract<AttestationFloorOutcome, { kind: 'verified' }>).channel).toBe('serve-binding');
  });

  it('an unverified marker with an unbound, non-foreign binding is exactly the null-spec verdict', () => {
    const withMarker = evaluateAttestationFloorForMode(
      'explore',
      composedTask(),
      HARNESS_NONCE_MARKER_SPEC,
      unverifiedMarkerProbe,
      unboundNonForeign,
      { harnessSuppliedMarker: true },
    );
    const nullSpec = evaluateAttestationFloorForMode('explore', composedTask(), null, null, unboundNonForeign);
    expect(withMarker).toEqual(nullSpec);
  });

  it('a foreign listener fails the marker fallback exactly as the undeclared floor would', () => {
    const floor = evaluateAttestationFloorForMode(
      'explore',
      composedTask(),
      HARNESS_NONCE_MARKER_SPEC,
      unverifiedMarkerProbe,
      foreignBinding,
      { harnessSuppliedMarker: true },
    );
    expect(floor.kind).toBe('foreign');
  });

  it('a declared serve-binding task gets exactly the same marker fallback as an undeclared one', () => {
    const declaredFloor = evaluateAttestationFloorForMode(
      'explore',
      composedTask({ kind: 'serve-binding' }),
      HARNESS_NONCE_MARKER_SPEC,
      verifiedMarkerProbe,
      boundBinding,
      { harnessSuppliedMarker: true },
    );
    const undeclaredFloor = evaluateAttestationFloorForMode(
      'explore',
      composedTask(),
      HARNESS_NONCE_MARKER_SPEC,
      verifiedMarkerProbe,
      boundBinding,
      { harnessSuppliedMarker: true },
    );
    expect(declaredFloor).toEqual(undeclaredFloor);
  });

  it('the flag has no effect on a task declaring a channel the marker does not upgrade', () => {
    const withFlag = evaluateAttestationFloorForMode(
      'explore',
      composedTask(HTTP_SPEC),
      HTTP_SPEC,
      unverifiedMarkerProbe,
      boundBinding,
      { harnessSuppliedMarker: true },
    );
    const withoutFlag = evaluateAttestationFloorForMode('explore', composedTask(HTTP_SPEC), HTTP_SPEC, unverifiedMarkerProbe, boundBinding);
    expect(withFlag).toEqual(withoutFlag);
  });
});

// ---------------------------------------------------------------------------
// VerificationAgentRunner.run — actual injection, prompt, attest, mutation
// check wiring
// ---------------------------------------------------------------------------

describe('VerificationAgentRunner.run — nonce marker injection (undeclared task)', () => {
  it('writes the marker into the snapshot, notes it in the prompt, attests it, and exempts it from the mutation check', async () => {
    const { fs, writeFile } = stampableNonceMarkerFs(ENTRY_HTML_PATH, ENTRY_HTML);
    const checkSnapshotMutated = vi.fn(async () => false);
    const attest = vi.fn(async (spec: AttestationSpec): Promise<HarnessAttestationResult> => ({
      verified: true,
      kind: spec.kind,
      detail: 'marker matched',
    }));
    const { runner, query } = makeRunner({ ...servedBy(SERVE_CMD), nonceMarkerFs: fs, attest, checkSnapshotMutated });

    const result = await runner.run(makeReq({ executionMode: 'explore', task: noChannelTask }));

    expect(result.status).toBe('passed');
    expect(writeFile).toHaveBeenCalledTimes(1);
    const [writtenPath, writtenContent] = writeFile.mock.calls[0] as [string, string];
    expect(writtenPath).toBe(ENTRY_HTML_PATH);
    expect(writtenContent).toContain('cyboflow-verify-nonce');
    expect(writtenContent).toContain('data-verify-nonce="');

    expect(query.mock.calls[0][0].prompt).toContain('HARNESS NONCE MARKER');
    expect(query.mock.calls[0][0].prompt).toContain('index.html');

    expect(attest).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'dom-marker', selector: HARNESS_NONCE_MARKER_SELECTOR }),
      expect.anything(),
    );

    expect(checkSnapshotMutated).toHaveBeenCalledWith(SNAPSHOT_ROOT, { relPath: 'index.html', content: writtenContent });
  });

  it('a verified marker upgrades a passing explore run, and the learned recipe records the marker channel whatever the agent wrote', async () => {
    const recorded = JSON.stringify({ build: ['pnpm run build'], serve: { cmd: SERVE_CMD }, attestation: { kind: 'serve-binding' } });
    const omitted = JSON.stringify({ build: ['pnpm run build'], serve: { cmd: SERVE_CMD } });
    for (const recipeJson of [recorded, omitted]) {
      const { fs } = stampableNonceMarkerFs(ENTRY_HTML_PATH, ENTRY_HTML);
      const attest = vi.fn(async (spec: AttestationSpec): Promise<HarnessAttestationResult> => ({
        verified: true,
        kind: spec.kind,
        detail: 'marker matched',
      }));
      const readTextFile = vi.fn(async (path: string) => (path === join(SNAPSHOT_ROOT, 'package.json') ? PKG : null));
      const { runner, query } = makeRunner({ ...servedBy(SERVE_CMD), nonceMarkerFs: fs, attest, readTextFile });
      query.mockImplementation(async () => outcome(validReport({ recipeJson })));

      const result = await runner.run(makeReq({ executionMode: 'explore', task: noChannelTask }));

      expect(result.status).toBe('passed');
      expect(result.learnedRecipe).toMatchObject({ ok: true, entry: { attestation: HARNESS_NONCE_MARKER_SPEC } });
    }
  });

  it('an unverified marker with a bound serve still passes via the serve-binding fallback (no regression)', async () => {
    const { fs } = stampableNonceMarkerFs(ENTRY_HTML_PATH, ENTRY_HTML);
    const attest = vi.fn(async (spec: AttestationSpec): Promise<HarnessAttestationResult> => ({
      verified: false,
      kind: spec.kind,
      detail: 'no marker found on the page',
    }));
    const { runner } = makeRunner({ ...servedBy(SERVE_CMD), nonceMarkerFs: fs, attest });

    const result = await runner.run(makeReq({ executionMode: 'explore', task: noChannelTask }));

    expect(result.status).toBe('passed');
  });

  it('with no entry HTML candidate, nothing is written, the prompt carries no note, and attest never runs', async () => {
    const { fs, writeFile } = noEntryNonceMarkerFs();
    const checkSnapshotMutated = vi.fn(async () => false);
    const { runner, query, attest } = makeRunner({ ...servedBy(SERVE_CMD), nonceMarkerFs: fs, checkSnapshotMutated });

    const result = await runner.run(makeReq({ executionMode: 'explore', task: noChannelTask }));

    expect(writeFile).not.toHaveBeenCalled();
    expect(query.mock.calls[0][0].prompt).not.toContain('HARNESS NONCE MARKER');
    expect(attest).not.toHaveBeenCalled();
    expect(checkSnapshotMutated).toHaveBeenCalledWith(SNAPSHOT_ROOT, undefined);
    // Binding-only path still passes — the missing marker only costs the
    // stronger channel, never the request.
    expect(result.status).toBe('passed');
  });
});

describe('VerificationAgentRunner.run — nonce marker injection (declared serve-binding task)', () => {
  it('injects the marker and attest sees the marker spec, not serve-binding', async () => {
    const { fs } = stampableNonceMarkerFs(ENTRY_HTML_PATH, ENTRY_HTML);
    const attest = vi.fn(async (spec: AttestationSpec): Promise<HarnessAttestationResult> => ({
      verified: true,
      kind: spec.kind,
      detail: 'marker matched',
    }));
    const { runner } = makeRunner({ ...servedBy(SERVE_CMD), nonceMarkerFs: fs, attest });

    const result = await runner.run(makeReq({ executionMode: 'explore', task: serveBindingTask }));

    expect(attest).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'dom-marker', selector: HARNESS_NONCE_MARKER_SELECTOR }),
      expect.anything(),
    );
    expect(result.status).toBe('passed');
  });

  it('a verified marker on this declared task also learns the marker channel', async () => {
    const { fs } = stampableNonceMarkerFs(ENTRY_HTML_PATH, ENTRY_HTML);
    const attest = vi.fn(async (spec: AttestationSpec): Promise<HarnessAttestationResult> => ({
      verified: true,
      kind: spec.kind,
      detail: 'marker matched',
    }));
    const readTextFile = vi.fn(async (path: string) => (path === join(SNAPSHOT_ROOT, 'package.json') ? PKG : null));
    const { runner, query } = makeRunner({ ...servedBy(SERVE_CMD), nonceMarkerFs: fs, attest, readTextFile });
    query.mockImplementation(async () =>
      outcome(validReport({ recipeJson: JSON.stringify({ build: ['pnpm run build'], serve: { cmd: SERVE_CMD } }) })),
    );

    const result = await runner.run(makeReq({ executionMode: 'explore', task: serveBindingTask }));

    expect(result.status).toBe('passed');
    expect(result.learnedRecipe).toMatchObject({ ok: true, entry: { attestation: HARNESS_NONCE_MARKER_SPEC } });
  });

  it('an unverified marker still passes via the serve-binding fallback', async () => {
    const { fs } = stampableNonceMarkerFs(ENTRY_HTML_PATH, ENTRY_HTML);
    const attest = vi.fn(async (spec: AttestationSpec): Promise<HarnessAttestationResult> => ({
      verified: false,
      kind: spec.kind,
      detail: 'no marker found',
    }));
    const { runner } = makeRunner({ ...servedBy(SERVE_CMD), nonceMarkerFs: fs, attest });

    const result = await runner.run(makeReq({ executionMode: 'explore', task: serveBindingTask }));

    expect(result.status).toBe('passed');
  });

  it('a foreign listener still fails the pass, marker or not', async () => {
    const { fs } = stampableNonceMarkerFs(ENTRY_HTML_PATH, ENTRY_HTML);
    const { runner } = makeRunner({ ...foreignListener, nonceMarkerFs: fs });

    const result = await runner.run(makeReq({ executionMode: 'explore', task: serveBindingTask }));

    expect(result.status).toBe('failed');
    expect(result.foreignSurface).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// validateLearnedRecipe — harnessAttestation override
// ---------------------------------------------------------------------------

describe('validateLearnedRecipe — harnessAttestation override', () => {
  const composed = { serve: { cmd: SERVE_CMD } };
  const leased = { ports: [], udid: null, snapshotPath: null };

  it('overrides a recipe-declared dom-marker selector with the harness marker spec', () => {
    const recipeJson = JSON.stringify({
      build: ['pnpm run build'],
      serve: { cmd: SERVE_CMD },
      attestation: { kind: 'dom-marker', selector: 'meta[name="something-else"]' },
    });
    const result = validateLearnedRecipe({
      recipeJson,
      modality: 'web',
      verifiedChannel: 'dom-marker',
      harnessAttestation: HARNESS_NONCE_MARKER_SPEC,
      composed,
      packageJsonRaw: PKG,
      leased,
    });
    expect(result).toMatchObject({ ok: true, entry: { attestation: HARNESS_NONCE_MARKER_SPEC } });
  });

  it('without harnessAttestation, the recipe keeps its own declared selector', () => {
    const customSpec: AttestationSpec = { kind: 'dom-marker', selector: 'meta[name="custom-marker"]' };
    const recipeJson = JSON.stringify({ build: ['pnpm run build'], serve: { cmd: SERVE_CMD }, attestation: customSpec });
    const result = validateLearnedRecipe({
      recipeJson,
      modality: 'web',
      verifiedChannel: 'dom-marker',
      composed,
      packageJsonRaw: PKG,
      leased,
    });
    expect(result).toMatchObject({ ok: true, entry: { attestation: customSpec } });
  });

  it('overrides even when the recipe named no attestation at all', () => {
    const recipeJson = JSON.stringify({ build: ['pnpm run build'], serve: { cmd: SERVE_CMD } });
    const result = validateLearnedRecipe({
      recipeJson,
      modality: 'web',
      verifiedChannel: 'dom-marker',
      harnessAttestation: HARNESS_NONCE_MARKER_SPEC,
      composed,
      packageJsonRaw: PKG,
      leased,
    });
    expect(result).toMatchObject({ ok: true, entry: { attestation: HARNESS_NONCE_MARKER_SPEC } });
  });
});
