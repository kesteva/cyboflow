/**
 * Unit tests for substrateResolver + CliManagerFactory dual-substrate dispatch
 * (IDEA-013 / TASK-806).
 *
 * Behaviors covered:
 *  1. resolveSubstrate honors the override ladder in precedence order
 *     (frontmatter > projectConfig > globalDefault > env > 'sdk' floor): one
 *     case per level winning, a full-precedence case, the floor case, and an
 *     invalid-value-ignored case (fail-soft fall-through).
 *  2. CliManagerFactory.createManager dispatches 'claude-interactive' →
 *     InteractiveClaudeManager and 'claude' → ClaudeCodeManager; the interactive
 *     factory db-guard throws when db is missing — WITHOUT invoking any
 *     throwing stub method on InteractiveClaudeManager.
 */
import { describe, it, expect, afterEach } from 'vitest';
import type { SessionManager } from '../../services/sessionManager';
import { resolveSubstrate, SUBSTRATE_ENV_VAR } from '../substrateResolver';
import { DEFAULT_SUBSTRATE } from '../../../../shared/types/substrate';
import { CliManagerFactory } from '../../services/cliManagerFactory';
import { ClaudeCodeManager } from '../../services/panels/claude/claudeCodeManager';
import { InteractiveClaudeManager } from '../../services/panels/claude/interactiveClaudeManager';
import { createTestDb } from '../__test_fixtures__/orchestratorTestDb';

// ---------------------------------------------------------------------------
// resolveSubstrate — override ladder
// ---------------------------------------------------------------------------

describe('resolveSubstrate — override ladder', () => {
  it("floors to 'sdk' when nothing is set (zero-behavior-change invariant)", () => {
    expect(resolveSubstrate({ env: {} })).toBe(DEFAULT_SUBSTRATE);
    expect(resolveSubstrate({ env: {} })).toBe('sdk');
  });

  it('requestedSubstrate (explicit per-run UI choice) wins over every lower level', () => {
    const result = resolveSubstrate({
      requestedSubstrate: 'interactive',
      frontmatterSubstrate: 'sdk',
      projectConfigSubstrate: 'sdk',
      globalDefaultSubstrate: 'sdk',
      env: { [SUBSTRATE_ENV_VAR]: 'sdk' },
    });
    expect(result).toBe('interactive');
  });

  it('an absent/invalid requestedSubstrate falls through to the next level (fail-soft)', () => {
    // Picker not consulted (undefined) → frontmatter wins.
    expect(
      resolveSubstrate({ requestedSubstrate: undefined, frontmatterSubstrate: 'interactive', env: {} }),
    ).toBe('interactive');
    // Garbage requested value is ignored → falls through to env.
    expect(
      resolveSubstrate({ requestedSubstrate: 'garbage', env: { [SUBSTRATE_ENV_VAR]: 'interactive' } }),
    ).toBe('interactive');
  });

  it('frontmatter wins when set, even with all lower levels present', () => {
    const result = resolveSubstrate({
      frontmatterSubstrate: 'interactive',
      projectConfigSubstrate: 'sdk',
      globalDefaultSubstrate: 'sdk',
      env: { [SUBSTRATE_ENV_VAR]: 'sdk' },
    });
    expect(result).toBe('interactive');
  });

  it('projectConfig wins when frontmatter is absent', () => {
    const result = resolveSubstrate({
      projectConfigSubstrate: 'interactive',
      globalDefaultSubstrate: 'sdk',
      env: { [SUBSTRATE_ENV_VAR]: 'sdk' },
    });
    expect(result).toBe('interactive');
  });

  it('globalDefault wins when frontmatter and projectConfig are absent', () => {
    const result = resolveSubstrate({
      globalDefaultSubstrate: 'interactive',
      env: { [SUBSTRATE_ENV_VAR]: 'sdk' },
    });
    expect(result).toBe('interactive');
  });

  it('env CYBOFLOW_SUBSTRATE wins when only the env level is set', () => {
    const result = resolveSubstrate({
      env: { [SUBSTRATE_ENV_VAR]: 'interactive' },
    });
    expect(result).toBe('interactive');
  });

  it('full precedence: frontmatter beats projectConfig beats globalDefault beats env', () => {
    // Every level set to a DISTINCT-but-valid value where applicable; only the
    // highest set level should win. Use 'interactive' at the top and 'sdk' below.
    expect(
      resolveSubstrate({
        frontmatterSubstrate: 'interactive',
        projectConfigSubstrate: 'sdk',
        globalDefaultSubstrate: 'sdk',
        env: { [SUBSTRATE_ENV_VAR]: 'sdk' },
      }),
    ).toBe('interactive');

    // Drop frontmatter → projectConfig (here 'interactive') wins.
    expect(
      resolveSubstrate({
        projectConfigSubstrate: 'interactive',
        globalDefaultSubstrate: 'sdk',
        env: { [SUBSTRATE_ENV_VAR]: 'sdk' },
      }),
    ).toBe('interactive');

    // Drop projectConfig → globalDefault (here 'interactive') wins.
    expect(
      resolveSubstrate({
        globalDefaultSubstrate: 'interactive',
        env: { [SUBSTRATE_ENV_VAR]: 'sdk' },
      }),
    ).toBe('interactive');

    // Drop globalDefault → env wins.
    expect(
      resolveSubstrate({
        env: { [SUBSTRATE_ENV_VAR]: 'interactive' },
      }),
    ).toBe('interactive');
  });

  it('an invalid value at a level is ignored and resolution falls through (fail-soft)', () => {
    // A typo at the highest level must NOT throw and must NOT win — resolution
    // falls through to the next valid level (here projectConfig).
    const result = resolveSubstrate({
      frontmatterSubstrate: 'interactiv', // typo — invalid
      projectConfigSubstrate: 'interactive',
      env: { [SUBSTRATE_ENV_VAR]: 'sdk' },
    });
    expect(result).toBe('interactive');
  });

  it('an invalid value at every level falls through to the sdk floor', () => {
    const result = resolveSubstrate({
      frontmatterSubstrate: 'gemini',
      projectConfigSubstrate: 'bogus',
      globalDefaultSubstrate: '',
      env: { [SUBSTRATE_ENV_VAR]: 'not-a-substrate' },
    });
    expect(result).toBe('sdk');
  });
});

// ---------------------------------------------------------------------------
// CliManagerFactory — dual-substrate dispatch
// ---------------------------------------------------------------------------

describe('CliManagerFactory — claude / claude-interactive dispatch', () => {
  const mockSessionManager = { id: 'mock-session-manager' } as unknown as SessionManager;

  // Share a single CliManagerFactory singleton across all tests. The
  // CliToolRegistry singleton's `tools` map is NOT torn down by shutdown(), so
  // constructing a fresh factory per test would re-register 'claude' and throw.
  // shutdown() (in afterEach) only clears the registry's MANAGER cache, which is
  // what lets each createManager() build a fresh instance. Mirrors the cleanup
  // contract in claudeCodeManagerWiring.test.ts.
  const factory = CliManagerFactory.getInstance();

  afterEach(async () => {
    await factory.shutdown();
  });

  it("createManager('claude-interactive', cfg) returns an InteractiveClaudeManager", async () => {
    const db = createTestDb();

    const manager = await factory.createManager('claude-interactive', {
      sessionManager: mockSessionManager,
      additionalOptions: { db },
      skipValidation: true,
    });

    expect(manager).toBeInstanceOf(InteractiveClaudeManager);
    // Must NOT be the SDK manager.
    expect(manager).not.toBeInstanceOf(ClaudeCodeManager);

    db.close();
  });

  it("createManager('claude', cfg) still returns a ClaudeCodeManager (SDK path unchanged)", async () => {
    const db = createTestDb();

    const manager = await factory.createManager('claude', {
      sessionManager: mockSessionManager,
      additionalOptions: { db },
      skipValidation: true,
    });

    expect(manager).toBeInstanceOf(ClaudeCodeManager);

    db.close();
  });

  it('the two tool ids resolve to two DISTINCT manager classes', async () => {
    const db = createTestDb();

    const sdkManager = await factory.createManager('claude', {
      sessionManager: mockSessionManager,
      additionalOptions: { db },
      skipValidation: true,
    });
    const interactiveManager = await factory.createManager('claude-interactive', {
      sessionManager: mockSessionManager,
      additionalOptions: { db },
      skipValidation: true,
    });

    expect(sdkManager).toBeInstanceOf(ClaudeCodeManager);
    expect(interactiveManager).toBeInstanceOf(InteractiveClaudeManager);
    expect(sdkManager).not.toBe(interactiveManager);

    db.close();
  });

  it("claude-interactive db-guard throws TypeError naming `db` when additionalOptions is empty", async () => {
    await expect(
      factory.createManager('claude-interactive', {
        sessionManager: mockSessionManager,
        additionalOptions: {},
        skipValidation: true,
      }),
    ).rejects.toThrow(/requires `db`/);
  });

  it("claude-interactive db-guard throws TypeError naming .prepare() when db lacks .prepare", async () => {
    await expect(
      factory.createManager('claude-interactive', {
        sessionManager: mockSessionManager,
        additionalOptions: { db: { foo: 'bar' } },
        skipValidation: true,
      }),
    ).rejects.toThrow(/\.prepare\(\)/);
  });
});
