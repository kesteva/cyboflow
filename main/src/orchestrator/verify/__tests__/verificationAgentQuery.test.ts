/**
 * Unit tests for verificationAgentQuery — the verification agent's single SDK
 * boundary. Two surfaces:
 *
 *  - createTranscriptAccumulator (verifier-transcript capture): the
 *    markdown-transcript builder the drain loop feeds every raw SDK message
 *    through. Uses the REAL typed fakeSdk builders (sdkAssistantText,
 *    sdkAssistantToolUse, sdkUserToolResult) so a message-shape drift is caught
 *    by fakeSdk's own `satisfies` checks against the SDK's exported types, not
 *    just here.
 *  - the §7.2 dependency-mutation Bash guard: the `canUseTool` this module bakes
 *    into every deployed session, exercised BOTH directly and through a mocked
 *    `query()` (so the wiring — not just the predicate — is pinned, alongside
 *    the hermetic options it has to compose with).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CanUseTool, PermissionResult } from '@anthropic-ai/claude-agent-sdk';
import {
  makeFakeQuery,
  sdkAssistantText,
  sdkAssistantToolUse,
  sdkResultSuccess,
  sdkUserToolResult,
  type FakeQueryFn,
  type FakeQueryParams,
} from '../../../test/fakes/fakeSdk';

// The SDK `query` is mocked so the query wrapper is exercisable with a canned
// stream (no claude subprocess), mirroring eval/__tests__/evalJudgeQuery.test.ts.
const queryMock = vi.fn();
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: (...args: unknown[]) => queryMock(...args),
}));

/** Stand-in for the boot-resolved path the wiring site now injects as the factory's first argument. */
const FAKE_CLAUDE_EXECUTABLE_PATH = '/fake/claude';

import {
  createTranscriptAccumulator,
  forbiddenDepCommandDenyMessage,
  makeDependencyCommandCanUseTool,
  makeVerificationAgentQuery,
  VERIFICATION_REPORT_JSON_SCHEMA,
} from '../verificationAgentQuery';
import {
  ATTESTATION_KINDS,
  VERIFICATION_MODALITIES,
  VERIFICATION_REPORT_OUTCOMES,
  normalizeVerificationReportV1,
} from '../../../../../shared/types/visualVerification';

let lastOptions: Record<string, unknown> | undefined;

/** Point the mocked `query()` at a fakeSdk `FakeQueryFn`, capturing the options the module baked. */
function install(fn: FakeQueryFn): void {
  queryMock.mockImplementation((params: FakeQueryParams) => {
    lastOptions = params.options as unknown as Record<string, unknown>;
    return fn(params);
  });
}

beforeEach(() => {
  queryMock.mockReset();
  lastOptions = undefined;
});

/** Invoke a CanUseTool with the minimal options bag the SDK passes. */
async function decide(
  guard: ReturnType<typeof makeDependencyCommandCanUseTool>,
  toolName: string,
  input: Record<string, unknown>,
): Promise<PermissionResult | null> {
  return guard(toolName, input, {
    signal: new AbortController().signal,
    toolUseID: 'toolu_test',
    requestId: 'req_test',
  });
}

describe('createTranscriptAccumulator', () => {
  it('returns null when nothing was fed', () => {
    const acc = createTranscriptAccumulator();
    expect(acc.text()).toBeNull();
  });

  it('appends assistant text verbatim', () => {
    const acc = createTranscriptAccumulator();
    acc.onMessage(sdkAssistantText('building the widget'));
    expect(acc.text()).toBe('building the widget');
  });

  it('concatenates multiple text blocks in one assistant turn, then a later turn', () => {
    const acc = createTranscriptAccumulator();
    acc.onMessage(sdkAssistantText(['first', 'second']));
    acc.onMessage(sdkAssistantText('third'));
    expect(acc.text()).toBe('firstsecondthird');
  });

  it('renders a tool_use block as a fenced JSON excerpt of the tool name + input', () => {
    const acc = createTranscriptAccumulator();
    acc.onMessage(sdkAssistantToolUse('Bash', { command: 'npm run build' }));
    const text = acc.text() ?? '';
    expect(text).toContain('**Tool: Bash**');
    expect(text).toContain('```json');
    expect(text).toContain('"command":"npm run build"');
  });

  it('truncates a tool_use input JSON excerpt to 600 chars', () => {
    const acc = createTranscriptAccumulator();
    acc.onMessage(sdkAssistantToolUse('Bash', { command: 'x'.repeat(1000) }));
    const text = acc.text() ?? '';
    const match = /```json\n([\s\S]*?)\n```/.exec(text);
    expect(match).not.toBeNull();
    const body = match?.[1] ?? '';
    // 600 chars kept + the single truncation ellipsis char appended.
    expect(body.length).toBe(601);
    expect(body.endsWith('…')).toBe(true);
  });

  it('renders a tool_result block as a fenced text excerpt, labeled as an error when is_error', () => {
    const okAcc = createTranscriptAccumulator();
    okAcc.onMessage(sdkUserToolResult('toolu_1', 'build succeeded'));
    const okText = okAcc.text() ?? '';
    expect(okText).toContain('Tool result:');
    expect(okText).toContain('build succeeded');
    expect(okText).not.toContain('Tool error result:');

    const errAcc = createTranscriptAccumulator();
    errAcc.onMessage(sdkUserToolResult('toolu_2', 'build failed: TS1005', { isError: true }));
    const errText = errAcc.text() ?? '';
    expect(errText).toContain('Tool error result:');
    expect(errText).toContain('build failed: TS1005');
  });

  it('truncates a tool_result excerpt to 1_500 chars', () => {
    const acc = createTranscriptAccumulator();
    acc.onMessage(sdkUserToolResult('toolu_1', 'y'.repeat(3000)));
    const text = acc.text() ?? '';
    const match = /```\n([\s\S]*?)\n```/.exec(text);
    expect(match).not.toBeNull();
    const body = match?.[1] ?? '';
    expect(body.length).toBe(1501);
    expect(body.endsWith('…')).toBe(true);
  });

  it('caps the total transcript at 400_000 chars and appends the truncation marker exactly once', () => {
    const acc = createTranscriptAccumulator();
    // Each text block is far under the tool-excerpt caps, so many small pushes
    // drive the TOTAL cap rather than any per-message cap.
    for (let i = 0; i < 5000; i++) {
      acc.onMessage(sdkAssistantText('x'.repeat(100)));
    }
    const text = acc.text() ?? '';
    const marker = '[transcript truncated at 400000 chars]';
    const occurrences = text.split(marker).length - 1;
    expect(occurrences).toBe(1);
    // Further messages after truncation are silent no-ops (never re-append).
    acc.onMessage(sdkAssistantText('after truncation'));
    expect(acc.text()).toBe(text);
  });

  it('ignores message types it does not recognize, without throwing', () => {
    const acc = createTranscriptAccumulator();
    acc.onMessage({ type: 'system', subtype: 'init' });
    acc.onMessage(null);
    acc.onMessage('not a message');
    acc.onMessage(42);
    expect(acc.text()).toBeNull();
  });
});

describe('makeDependencyCommandCanUseTool — the §7.2 execution-time guard', () => {
  /** The runner's tool ceiling, as the query builder passes it to the factory. */
  const VERIFY_SET = ['Bash', 'Read', 'Grep', 'Glob'] as const;

  const INSTALLS = [
    'pnpm install',
    'pnpm install --frozen-lockfile',
    'npm ci',
    'yarn add left-pad',
    'pnpm -r rebuild',
    'cd frontend && npm install',
    'npx playwright install chromium',
    'npx electron-builder install-app-deps',
    './node_modules/.bin/electron-rebuild -f',
  ];

  it.each(INSTALLS)('denies the dependency-mutating Bash command %j', async (command) => {
    const guard = makeDependencyCommandCanUseTool(VERIFY_SET);

    const decision = await decide(guard, 'Bash', { command });

    expect(decision?.behavior).toBe('deny');
    if (decision?.behavior !== 'deny') throw new Error('expected a deny');
    // Names the command back, states the rule, and routes the agent to the
    // honest outcome instead of a workaround.
    expect(decision.message).toContain(command);
    expect(decision.message).toContain('forbidden inside verification snapshots');
    expect(decision.message).toContain('build_failed');
    // Not an interrupt: the agent should continue and report, not be killed.
    expect(decision.interrupt).toBeUndefined();
  });

  const BENIGN = [
    'pnpm run build',
    'pnpm dev --port 29260',
    'pnpm test:unit',
    'node scripts/serve.mjs',
    'ls node_modules',
    'electron . --remote-debugging-port=29261',
  ];

  it.each(BENIGN)('allows the benign Bash command %j, echoing its input', async (command) => {
    const guard = makeDependencyCommandCanUseTool(VERIFY_SET);

    const decision = await decide(guard, 'Bash', { command });

    // `updatedInput` is MANDATORY on allow — a bare { behavior: 'allow' }
    // ZodErrors at the CLI and reaches the model as an is_error tool_result.
    expect(decision).toEqual({ behavior: 'allow', updatedInput: { command } });
  });

  it('leaves every non-Bash tool IN THE SET untouched, even when its input reads like an install', async () => {
    const guard = makeDependencyCommandCanUseTool(VERIFY_SET);

    for (const toolName of ['Read', 'Grep', 'Glob']) {
      const input = { pattern: 'pnpm install', file_path: '/wt/README.md' };
      expect(await decide(guard, toolName, input)).toEqual({ behavior: 'allow', updatedInput: input });
    }
  });

  it('default-DENIES any tool outside the verify set (a handler must not widen the sandbox)', async () => {
    const guard = makeDependencyCommandCanUseTool(VERIFY_SET);

    for (const toolName of ['Write', 'Edit', 'WebFetch', 'NotebookEdit']) {
      const decision = await decide(guard, toolName, { file_path: '/wt/a.ts', content: 'x' });
      expect(decision?.behavior).toBe('deny');
      if (decision?.behavior !== 'deny') throw new Error('expected a deny');
      expect(decision.message).toContain(toolName);
      expect(decision.message).toContain('not part of the verification harness');
    }
  });

  it('allows a Bash call with no string command rather than guessing', async () => {
    const guard = makeDependencyCommandCanUseTool(VERIFY_SET);

    expect(await decide(guard, 'Bash', {})).toEqual({ behavior: 'allow', updatedInput: {} });
  });

  it('logs the denial (a blocked command must be diagnosable from the run log)', async () => {
    const warn = vi.fn();
    const guard = makeDependencyCommandCanUseTool(VERIFY_SET, { info: vi.fn(), warn, error: vi.fn(), debug: vi.fn() });

    await decide(guard, 'Bash', { command: 'pnpm install' });

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('dependency-mutating'), { command: 'pnpm install' });
  });
});

// ---------------------------------------------------------------------------
// A1.4 explore guards — `guards` is OPTIONAL and gated per call: absent (the
// pinned/legacy shape every existing test above uses) means no change from
// before; present, each of its two members turns on exactly one extra deny.
// ---------------------------------------------------------------------------

describe('makeDependencyCommandCanUseTool — A1.4 explore guards (guards param)', () => {
  const VERIFY_SET = ['Bash', 'Read', 'Grep', 'Glob'] as const;

  it('guards absent ⇒ a kill/simctl command is allowed unchanged (no behavior change for pinned/legacy)', async () => {
    const guard = makeDependencyCommandCanUseTool(VERIFY_SET);

    const killDecision = await decide(guard, 'Bash', { command: 'kill -9 1234' });
    expect(killDecision).toEqual({ behavior: 'allow', updatedInput: { command: 'kill -9 1234' } });

    const simctlDecision = await decide(guard, 'Bash', { command: 'xcrun simctl boot $VERIFY_SIM_UDID' });
    expect(simctlDecision).toEqual({
      behavior: 'allow',
      updatedInput: { command: 'xcrun simctl boot $VERIFY_SIM_UDID' },
    });
  });

  it('guards={} (every member absent) ⇒ same as guards absent', async () => {
    const guard = makeDependencyCommandCanUseTool(VERIFY_SET, undefined, {});
    const decision = await decide(guard, 'Bash', { command: 'kill -9 1234' });
    expect(decision?.behavior).toBe('allow');
  });

  it('denyProcessKill: true denies a command-position kill/pkill/killall', async () => {
    const guard = makeDependencyCommandCanUseTool(VERIFY_SET, undefined, { denyProcessKill: true });

    const decision = await decide(guard, 'Bash', { command: 'lsof -ti :3000 | xargs kill -9' });
    expect(decision?.behavior).toBe('deny');
    if (decision?.behavior !== 'deny') throw new Error('expected a deny');
    expect(decision.message).toContain('lsof -ti :3000 | xargs kill -9');
    expect(decision.message).toContain('harness-owned');
    expect(decision.interrupt).toBeUndefined();
  });

  it('denyProcessKill: true still allows the documented false-positive shapes', async () => {
    const guard = makeDependencyCommandCanUseTool(VERIFY_SET, undefined, { denyProcessKill: true });

    for (const command of ['pnpm dev --kill-others', 'echo "kill this process"', '$VERIFY_DRIVER stop']) {
      const decision = await decide(guard, 'Bash', { command });
      expect(decision).toEqual({ behavior: 'allow', updatedInput: { command } });
    }
  });

  it('denySimctlLifecycle: true denies an xcrun simctl lifecycle verb (including bare simctl)', async () => {
    const guard = makeDependencyCommandCanUseTool(VERIFY_SET, undefined, { denySimctlLifecycle: true });

    const decision = await decide(guard, 'Bash', { command: 'xcrun simctl terminate $VERIFY_SIM_UDID com.example.app' });
    expect(decision?.behavior).toBe('deny');
    if (decision?.behavior !== 'deny') throw new Error('expected a deny');
    expect(decision.message).toContain('xcrun simctl terminate $VERIFY_SIM_UDID com.example.app');
    expect(decision.message).toContain('harness-owned');

    const bareDecision = await decide(guard, 'Bash', { command: 'simctl boot $VERIFY_SIM_UDID' });
    expect(bareDecision?.behavior).toBe('deny');
  });

  it('each guard is independently gated: denyProcessKill alone does not deny a simctl command', async () => {
    const guard = makeDependencyCommandCanUseTool(VERIFY_SET, undefined, { denyProcessKill: true });
    const decision = await decide(guard, 'Bash', { command: 'xcrun simctl boot $VERIFY_SIM_UDID' });
    expect(decision?.behavior).toBe('allow');
  });

  it('the dependency deny still applies first, even with every explore guard on', async () => {
    const guard = makeDependencyCommandCanUseTool(VERIFY_SET, undefined, {
      denyProcessKill: true,
      denySimctlLifecycle: true,
    });
    // Matches ALL THREE patterns, so only the order decides which message wins.
    const command = 'pnpm install && xcrun simctl boot $VERIFY_SIM_UDID && kill -9 1234';
    const decision = await decide(guard, 'Bash', { command });
    expect(decision?.behavior).toBe('deny');
    if (decision?.behavior !== 'deny') throw new Error('expected a deny');
    expect(decision.message).toBe(forbiddenDepCommandDenyMessage(command));
  });

  // Adversarial-review fix: the deny text is the instruction the agent sees at
  // the moment of action, so in explore it must route to "unverifiable" (design
  // A2), never contradict BUILD_RULE_EXPLORE with "build_failed".
  it('words the dependency deny by guards.executionMode: explore → unverifiable, pinned/absent → build_failed', async () => {
    const command = 'pod install';
    const explore = await decide(makeDependencyCommandCanUseTool(VERIFY_SET, undefined, { executionMode: 'explore' }), 'Bash', { command });
    if (explore?.behavior !== 'deny') throw new Error('expected a deny');
    expect(explore.message).toBe(forbiddenDepCommandDenyMessage(command, 'explore'));
    expect(explore.message).toContain('"unverifiable"');
    expect(explore.message).not.toContain('report outcome "build_failed"');

    for (const guards of [{ executionMode: 'pinned' as const }, undefined]) {
      const decision = await decide(makeDependencyCommandCanUseTool(VERIFY_SET, undefined, guards), 'Bash', { command });
      if (decision?.behavior !== 'deny') throw new Error('expected a deny');
      expect(decision.message).toContain('report outcome "build_failed"');
    }
  });

  it('denyProcessKill reads quoting: a `sh -c "kill …"` body is denied, a quoted grep alternation and `timeout -s KILL` are not', async () => {
    const guard = makeDependencyCommandCanUseTool(VERIFY_SET, undefined, { denyProcessKill: true });
    expect((await decide(guard, 'Bash', { command: 'sh -c "kill -9 $(lsof -ti :3000)"' }))?.behavior).toBe('deny');
    for (const command of ['timeout -s KILL 120 pnpm build', 'grep -E "error|kill" serve.log']) {
      expect(await decide(guard, 'Bash', { command })).toEqual({ behavior: 'allow', updatedInput: { command } });
    }
  });

  it('denySimctlLifecycle denies targeting "booted" / "all", and allows the leased UDID', async () => {
    const guard = makeDependencyCommandCanUseTool(VERIFY_SET, undefined, { denySimctlLifecycle: true });
    for (const command of ['xcrun simctl io booted screenshot shot.png', 'xcrun simctl openurl booted myapp://x', 'xcrun simctl shutdown all']) {
      expect((await decide(guard, 'Bash', { command }))?.behavior).toBe('deny');
    }
    const command = 'xcrun simctl io $VERIFY_SIM_UDID screenshot shot.png';
    expect(await decide(guard, 'Bash', { command })).toEqual({ behavior: 'allow', updatedInput: { command } });
  });
});

describe('makeVerificationAgentQuery — sandbox wiring', () => {
  it('installs the dependency guard as canUseTool WITHOUT weakening the hermetic options', async () => {
    install(makeFakeQuery([sdkResultSuccess({ structuredOutput: { version: 1 } })]));
    const fn = makeVerificationAgentQuery(FAKE_CLAUDE_EXECUTABLE_PATH);

    await fn({ prompt: 'p', systemPrompt: 's', cwd: '/wt', allowedTools: ['Bash', 'Read'], env: {} });

    const opts = lastOptions ?? {};
    // The immutable sandbox is intact…
    expect(opts.settingSources).toEqual([]);
    expect(opts.strictMcpConfig).toBe(true);
    expect(opts.mcpServers).toEqual({});
    expect(opts.pathToClaudeCodeExecutable).toBe(FAKE_CLAUDE_EXECUTABLE_PATH);
    // …and mutually exclusive with permissionPromptToolName, which is never set.
    expect(opts.permissionPromptToolName).toBeUndefined();

    // Availability vs auto-approval split: `tools` is the HARD whitelist (the
    // full verify set), while `allowedTools` auto-approves only the read-only
    // members — 'Bash' is excluded so every shell call consults canUseTool
    // (an allowedTools entry bypasses the handler entirely, SDK contract).
    expect(opts.tools).toEqual(['Bash', 'Read']);
    expect(opts.allowedTools).toEqual(['Read']);

    const canUseTool = opts.canUseTool as CanUseTool | undefined;
    expect(typeof canUseTool).toBe('function');
    if (!canUseTool) throw new Error('expected canUseTool to be installed');

    const denied = await decide(canUseTool, 'Bash', { command: 'pnpm install --frozen-lockfile' });
    expect(denied?.behavior).toBe('deny');
    const allowed = await decide(canUseTool, 'Bash', { command: 'pnpm run build' });
    expect(allowed?.behavior).toBe('allow');
  });

  it('threads args.guards through to canUseTool (A1.4 explore guards)', async () => {
    install(makeFakeQuery([sdkResultSuccess({ structuredOutput: { version: 1 } })]));
    const fn = makeVerificationAgentQuery(FAKE_CLAUDE_EXECUTABLE_PATH);

    await fn({
      prompt: 'p',
      systemPrompt: 's',
      cwd: '/wt',
      allowedTools: ['Bash'],
      env: {},
      guards: { denyProcessKill: true, denySimctlLifecycle: true },
    });

    const canUseTool = (lastOptions ?? {}).canUseTool as CanUseTool | undefined;
    if (!canUseTool) throw new Error('expected canUseTool to be installed');

    const killDenied = await decide(canUseTool, 'Bash', { command: 'kill -9 1234' });
    expect(killDenied?.behavior).toBe('deny');
    const simctlDenied = await decide(canUseTool, 'Bash', { command: 'xcrun simctl boot $VERIFY_SIM_UDID' });
    expect(simctlDenied?.behavior).toBe('deny');
  });

  it('omitting args.guards leaves kill/simctl commands allowed (pinned/legacy behavior)', async () => {
    install(makeFakeQuery([sdkResultSuccess({ structuredOutput: { version: 1 } })]));
    const fn = makeVerificationAgentQuery(FAKE_CLAUDE_EXECUTABLE_PATH);

    await fn({ prompt: 'p', systemPrompt: 's', cwd: '/wt', allowedTools: ['Bash'], env: {} });

    const canUseTool = (lastOptions ?? {}).canUseTool as CanUseTool | undefined;
    if (!canUseTool) throw new Error('expected canUseTool to be installed');

    const killAllowed = await decide(canUseTool, 'Bash', { command: 'kill -9 1234' });
    expect(killAllowed?.behavior).toBe('allow');
  });

  // Property, not a list: whatever the runner hands over, NO `mcp__*` name may
  // ever be auto-approved (an allowedTools entry bypasses canUseTool entirely),
  // while the availability list may carry it. Inert today — nothing composes an
  // MCP server into this query — so a future grant lands on a closed trap.
  it('never auto-approves an mcp__ tool, and canUseTool denies it per call', async () => {
    install(makeFakeQuery([sdkResultSuccess({ structuredOutput: { version: 1 } })]));
    const fn = makeVerificationAgentQuery(FAKE_CLAUDE_EXECUTABLE_PATH);
    const handed = ['Bash', 'Read', 'mcp__xcode__GetBuildLog', 'Grep', 'mcp__xcode__DocumentationSearch'];

    await fn({ prompt: 'p', systemPrompt: 's', cwd: '/wt', allowedTools: handed, env: {} });

    const opts = lastOptions ?? {};
    expect(opts.tools).toEqual(handed);
    const autoApproved = opts.allowedTools as string[];
    expect(autoApproved).toEqual(['Read', 'Grep']);
    expect(autoApproved.some((t) => t.startsWith('mcp__'))).toBe(false);

    const canUseTool = opts.canUseTool as CanUseTool | undefined;
    if (!canUseTool) throw new Error('expected canUseTool to be installed');
    const denied = await decide(canUseTool, 'mcp__xcode__GetBuildLog', {});
    expect(denied?.behavior).toBe('deny');
    const read = await decide(canUseTool, 'Read', {});
    expect(read?.behavior).toBe('allow');
  });
});

describe('makeVerificationAgentQuery — the harness env reaches the deployed session', () => {
  // F3 / RC4: the harness env is merged OVER process.env, which is what makes
  // the runner's PATH the one the agent's Bash — and every serve child under it
  // — actually sees. Without this precedence a packaged app's GUI PATH (no
  // pnpm, no node) would win and the deploy would be worse off than a terminal.
  // NODE_PATH is deliberately NOT in this env (round-2 review): the runner binds
  // it in the $VERIFY_DRIVER wrapper instead, so the deliverable's build never
  // resolves modules out of cyboflow's own install.
  it('merges the harness env over process.env, harness keys winning', async () => {
    install(makeFakeQuery([sdkResultSuccess({ structuredOutput: { version: 1 } })]));
    const fn = makeVerificationAgentQuery(FAKE_CLAUDE_EXECUTABLE_PATH);
    const previousPath = process.env.PATH;
    process.env.PATH = '/usr/bin:/bin';
    process.env.CYBOFLOW_QUERY_ENV_PROBE = 'inherited';
    try {
      await fn({
        prompt: 'p',
        systemPrompt: 's',
        cwd: '/wt',
        allowedTools: ['Bash'],
        env: {
          PATH: '/opt/homebrew/bin:/usr/bin:/bin',
          VERIFY_DATA_DIR: '/artifacts/data/vr-1',
        },
      });

      const env = (lastOptions ?? {}).env as Record<string, string>;
      expect(env.PATH).toBe('/opt/homebrew/bin:/usr/bin:/bin');
      expect(env.VERIFY_DATA_DIR).toBe('/artifacts/data/vr-1');
      // …and everything the process already had is still there.
      expect(env.CYBOFLOW_QUERY_ENV_PROBE).toBe('inherited');
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      delete process.env.CYBOFLOW_QUERY_ENV_PROBE;
    }
  });
});

// ---------------------------------------------------------------------------
// The structured-output schema's attestation echo (B5)
// ---------------------------------------------------------------------------

describe('VERIFICATION_REPORT_JSON_SCHEMA — the attestation kind enum', () => {
  /** Walk to `properties.attestation.properties.kind.enum` without an `any` in sight. */
  function attestationKindEnum(): string[] {
    const asRecord = (v: unknown): Record<string, unknown> => v as Record<string, unknown>;
    const props = asRecord(asRecord(VERIFICATION_REPORT_JSON_SCHEMA).properties);
    const kind = asRecord(asRecord(asRecord(props.attestation).properties).kind);
    return kind.enum as string[];
  }

  it('accepts bundle-identity — the mobile tier\'s channel', () => {
    expect(attestationKindEnum()).toContain('bundle-identity');
  });

  // The echo is never load-bearing, but a kind the schema rejects is dropped at
  // the SDK boundary: a mobile agent reporting honestly would have its whole
  // structured output refused for naming the only channel it can run.
  it('mirrors the closed AttestationSpec union exactly, in both directions', () => {
    expect([...attestationKindEnum()].sort()).toEqual([...ATTESTATION_KINDS].sort());
  });
});

// ---------------------------------------------------------------------------
// The runbook-optional report-contract widening (F6) — schema + Claude round trip
// ---------------------------------------------------------------------------

describe('VERIFICATION_REPORT_JSON_SCHEMA — the runbook-optional widening', () => {
  const asRecord = (v: unknown): Record<string, unknown> => v as Record<string, unknown>;
  const schema = asRecord(VERIFICATION_REPORT_JSON_SCHEMA);
  const props = asRecord(schema.properties);

  it('the outcome enum mirrors the shared VERIFICATION_REPORT_OUTCOMES exactly', () => {
    expect(asRecord(props.outcome).enum).toEqual([...VERIFICATION_REPORT_OUTCOMES]);
  });

  it('declares diagnosis / neededModality / app / recipeJson as OPTIONAL properties', () => {
    const required = schema.required as string[];
    for (const key of ['diagnosis', 'neededModality', 'app', 'recipeJson']) {
      expect(props).toHaveProperty(key);
      expect(required).not.toContain(key);
    }
    // The pre-widening required set is unchanged — an old-shaped report still validates.
    expect(required).toEqual(['version', 'behaviors', 'screenshots', 'outcome', 'confidence', 'feedback', 'issues']);
  });

  it('neededModality enumerates every VerificationModality; recipeJson is a flat string', () => {
    expect(asRecord(props.neededModality).enum).toEqual([...VERIFICATION_MODALITIES]);
    expect(props.recipeJson).toEqual({ type: 'string' });
    expect(props.diagnosis).toEqual({ type: 'string' });
  });

  it('shapes app like MobileAppSpec: platform/bundleId/scheme required, productGlob optional', () => {
    const app = asRecord(props.app);
    expect(app.required).toEqual(['platform', 'bundleId', 'scheme']);
    const appProps = asRecord(app.properties);
    expect(Object.keys(appProps).sort()).toEqual(['bundleId', 'platform', 'productGlob', 'scheme']);
    expect(asRecord(appProps.platform).enum).toEqual(['ios-simulator']);
  });
});

describe('makeVerificationAgentQuery — a new-outcome report round-trips to the normalizer', () => {
  const base = {
    version: 1,
    screenshots: [],
    confidence: 0.6,
    feedback: 'see diagnosis',
    issues: [],
  };
  const cases: Array<{ name: string; structured: Record<string, unknown>; outcome: string }> = [
    {
      name: 'unverifiable',
      structured: {
        ...base,
        behaviors: [{ id: 'b1', result: 'not_testable', evidence: { screenshots: [], notes: 'no data dir lever' } }],
        outcome: 'unverifiable',
        diagnosis: 'the app cannot be confined to VERIFY_DATA_DIR',
      },
      outcome: 'unverifiable',
    },
    {
      name: 'wrong_environment',
      structured: {
        ...base,
        behaviors: [],
        outcome: 'wrong_environment',
        neededModality: 'mobile',
        app: { platform: 'ios-simulator', bundleId: 'com.example.app', scheme: 'App' },
        diagnosis: 'an iOS application target, stamped web',
      },
      outcome: 'wrong_environment',
    },
    {
      name: 'pass carrying a recipeJson',
      structured: {
        ...base,
        behaviors: [{ id: 'b1', result: 'pass', evidence: { screenshots: [], notes: 'ok' } }],
        outcome: 'pass',
        recipeJson: '{"build":["pnpm run build"]}',
      },
      outcome: 'pass',
    },
  ];

  for (const c of cases) {
    it(`${c.name}: the structured output the SDK returns normalizes ok`, async () => {
      install(makeFakeQuery([sdkResultSuccess({ structuredOutput: c.structured })]));
      const fn = makeVerificationAgentQuery(FAKE_CLAUDE_EXECUTABLE_PATH);

      const out = await fn({ prompt: 'p', systemPrompt: 's', cwd: '/wt', allowedTools: ['Bash'], env: {} });

      // The widened schema is what the session was actually constrained by…
      const outputFormat = (lastOptions ?? {}).outputFormat as { schema?: unknown } | undefined;
      expect(outputFormat?.schema).toBe(VERIFICATION_REPORT_JSON_SCHEMA);
      // …and the Claude path hands the report through untouched to the normalizer.
      const normalized = normalizeVerificationReportV1(out.structured, ['b1']);
      expect(normalized.ok).toBe(true);
      if (normalized.ok) expect(normalized.report.outcome).toBe(c.outcome);
    });
  }
});
