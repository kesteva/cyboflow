/**
 * Unit tests for verifyConfigLoader — the SOLE reader of a project's
 * `.cyboflow/verify.json` (see docs/visual-verification-design.md §"Config homes").
 *
 * The loader's whole job is its fail-soft contract: absent file => null;
 * malformed JSON => logger.warn + null; valid JSON => parsed VerifyConfigFile.
 * Tests use a real temp dir (the loader reads from disk via node:fs/promises) and
 * a vitest-spy logger to assert the warn path without coupling to a concrete
 * logger. No electron / DB / runtime is touched.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  loadVerifyConfig,
  matchDeliverable,
  resolveDeliverableContext,
  VERIFY_CONFIG_RELATIVE_PATH,
} from '../verifyConfigLoader';
import type { LoggerLike } from '../types';
import type {
  DeliverableVerifyConfig,
  VerifyConfigFile,
} from '../../../../shared/types/visualVerification';

function makeLogger(): LoggerLike {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}

/** Write `<projectPath>/.cyboflow/verify.json` with the given raw text. */
async function writeVerifyJson(projectPath: string, raw: string): Promise<void> {
  const dir = join(projectPath, '.cyboflow');
  await mkdir(dir, { recursive: true });
  await writeFile(join(projectPath, VERIFY_CONFIG_RELATIVE_PATH), raw, 'utf-8');
}

describe('loadVerifyConfig', () => {
  let projectPath: string;

  beforeEach(async () => {
    projectPath = await mkdtemp(join(tmpdir(), 'cyboflow-verify-'));
  });

  afterEach(async () => {
    await rm(projectPath, { recursive: true, force: true });
  });

  it('returns null when the file is absent (ENOENT is not fatal)', async () => {
    const logger = makeLogger();
    expect(await loadVerifyConfig(projectPath, logger)).toBeNull();
    // Absent is the expected common case — it must NOT warn.
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('returns null without throwing when no logger is supplied and the file is absent', async () => {
    expect(await loadVerifyConfig(projectPath)).toBeNull();
  });

  it('parses a valid JSON document into a VerifyConfigFile', async () => {
    const config: VerifyConfigFile = {
      enabled: true,
      defaultType: 'interactive-web-behavior',
      deliverables: [
        {
          id: 'settings-page',
          type: 'static-render-snapshot',
          build: 'pnpm build',
          start: 'pnpm preview --port ${PORT}',
          url: 'http://localhost:${PORT}/settings',
          readyWhen: 'http://localhost:${PORT}/health',
          viewports: [{ width: 1280, height: 800, label: 'desktop' }],
          interactions: [
            { action: 'click', target: '#open' },
            { action: 'type', target: '#name', value: 'hi' },
            { action: 'wait', ms: 500 },
          ],
          baselineKey: 'settings-v1',
        },
      ],
    };
    await writeVerifyJson(projectPath, JSON.stringify(config));

    const logger = makeLogger();
    const loaded = await loadVerifyConfig(projectPath, logger);
    expect(loaded).toEqual(config);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('round-trips enabled / defaultType / deliverables exactly', async () => {
    await writeVerifyJson(
      projectPath,
      JSON.stringify({
        enabled: false,
        defaultType: 'responsive-multi-viewport',
        deliverables: [{ id: 'a' }, { id: 'b', url: 'http://x' }],
      }),
    );
    const loaded = await loadVerifyConfig(projectPath);
    expect(loaded?.enabled).toBe(false);
    expect(loaded?.defaultType).toBe('responsive-multi-viewport');
    expect(loaded?.deliverables).toEqual([{ id: 'a' }, { id: 'b', url: 'http://x' }]);
  });

  it('accepts an empty {} document (every member optional)', async () => {
    await writeVerifyJson(projectPath, '{}');
    expect(await loadVerifyConfig(projectPath)).toEqual({});
  });

  it('returns null + warns on malformed JSON (never throws)', async () => {
    await writeVerifyJson(projectPath, '{ "enabled": true, ');
    const logger = makeLogger();
    const loaded = await loadVerifyConfig(projectPath, logger);
    expect(loaded).toBeNull();
    expect(logger.warn).toHaveBeenCalledTimes(1);
    const [msg, ctx] = (logger.warn as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(String(msg)).toMatch(/malformed JSON/i);
    expect(ctx).toMatchObject({ configPath: expect.stringContaining(VERIFY_CONFIG_RELATIVE_PATH) });
  });

  it('returns null on malformed JSON even with no logger (silent fail-soft)', async () => {
    await writeVerifyJson(projectPath, 'not json at all');
    expect(await loadVerifyConfig(projectPath)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// matchDeliverable — HONEST deliverable matching (R6 finding #2). The prior
// closure silently fell back to startable[0] and compared the raw `${PORT}` url
// template against a concrete url (which can never equal), binding + spawning an
// UNRELATED deliverable. These tests pin the honest-match contract: exact
// htmlPath/url, `${PORT}` template match, the single-startable hydration case, and
// — the regression — NO consolation binding for a request that matches nothing.
// ---------------------------------------------------------------------------
describe('matchDeliverable', () => {
  const ROOT = '/repo';

  function config(deliverables: DeliverableVerifyConfig[]): VerifyConfigFile {
    return { deliverables };
  }

  it('matches on exact htmlPath (normalized absolute against the checkout root)', () => {
    const target: DeliverableVerifyConfig = { id: 'docs', htmlPath: 'dist/docs.html' };
    const cfg = config([{ id: 'other', htmlPath: 'dist/other.html' }, target]);
    // Request passes an ABSOLUTE path; deliverable path is relative to ROOT.
    const m = matchDeliverable(cfg, { htmlPath: '/repo/dist/docs.html' }, ROOT);
    expect(m).toBe(target);
    // And the reverse (relative request, absolute-normalized comparison).
    expect(matchDeliverable(cfg, { htmlPath: 'dist/docs.html' }, ROOT)).toBe(target);
  });

  it('matches on exact url string', () => {
    const target: DeliverableVerifyConfig = { id: 'app', url: 'http://localhost:8080/docs' };
    const cfg = config([target, { id: 'b', url: 'http://localhost:8080/other' }]);
    expect(matchDeliverable(cfg, { url: 'http://localhost:8080/docs' }, ROOT)).toBe(target);
  });

  it('matches a `${PORT}` template against a concrete port url + path prefix', () => {
    const target: DeliverableVerifyConfig = {
      id: 'app',
      start: 'pnpm preview --port ${PORT}',
      url: 'http://localhost:${PORT}',
    };
    const cfg = config([target]);
    // bare host+port
    expect(matchDeliverable(cfg, { url: 'http://localhost:29260' }, ROOT)).toBe(target);
    // host+port + path prefix
    expect(matchDeliverable(cfg, { url: 'http://localhost:29260/app' }, ROOT)).toBe(target);
  });

  it('template match honors a path segment in the template (prefix, not any-path)', () => {
    const target: DeliverableVerifyConfig = { id: 'app', start: 'run', url: 'http://localhost:${PORT}/app' };
    const cfg = config([target]);
    expect(matchDeliverable(cfg, { url: 'http://localhost:29260/app/sub' }, ROOT)).toBe(target);
    // A different path does NOT match the /app prefix.
    expect(matchDeliverable(cfg, { url: 'http://localhost:29260/docs' }, ROOT)).toBeNull();
  });

  it('template match rejects a DIFFERENT host', () => {
    const cfg = config([{ id: 'app', start: 'run', url: 'http://localhost:${PORT}' }]);
    expect(matchDeliverable(cfg, { url: 'http://example.com:29260' }, ROOT)).toBeNull();
  });

  it('template match rejects non-numeric and out-of-range port shapes', () => {
    const cfg = config([{ id: 'app', start: 'run', url: 'http://localhost:${PORT}' }]);
    // non-numeric port
    expect(matchDeliverable(cfg, { url: 'http://localhost:abc' }, ROOT)).toBeNull();
    // one digit (below the 2-digit floor)
    expect(matchDeliverable(cfg, { url: 'http://localhost:8' }, ROOT)).toBeNull();
    // six digits (above the 5-digit ceiling — must NOT partial-match the first five)
    expect(matchDeliverable(cfg, { url: 'http://localhost:123456' }, ROOT)).toBeNull();
  });

  it('with no url/htmlPath on the request + exactly ONE startable deliverable, uses it', () => {
    const target: DeliverableVerifyConfig = { id: 'app', start: 'run', url: 'http://localhost:${PORT}' };
    const cfg = config([target, { id: 'static', htmlPath: 'dist/x.html' }]);
    // 'static' has no `start` → only ONE startable → the hydration-driven pick.
    expect(matchDeliverable(cfg, {}, ROOT)).toBe(target);
  });

  it('with no url/htmlPath + TWO startables, returns null (ambiguous)', () => {
    const cfg = config([
      { id: 'a', start: 'run', url: 'http://localhost:${PORT}' },
      { id: 'b', start: 'run', url: 'http://localhost:${PORT}/b' },
    ]);
    expect(matchDeliverable(cfg, {}, ROOT)).toBeNull();
  });

  it('REGRESSION: a concrete-url request matching nothing returns null (NO startable[0] binding)', () => {
    // The old closure fell back to startable[0] here, binding + spawning the (only,
    // startable) deliverable and rewriting ctx.input.url to its baseUrl — judging the
    // WRONG page. The deliverable's template is on a DIFFERENT host, so the request
    // genuinely matches nothing; honest matching returns null (capture own url).
    const cfg = config([
      { id: 'app', start: 'pnpm preview --port ${PORT}', url: 'http://127.0.0.1:${PORT}' },
    ]);
    expect(matchDeliverable(cfg, { url: 'http://localhost:8080/docs' }, ROOT)).toBeNull();
  });

  it('returns null for an absent / empty config or empty deliverable list', () => {
    expect(matchDeliverable(null, { url: 'http://localhost:1' }, ROOT)).toBeNull();
    expect(matchDeliverable({}, { url: 'http://localhost:1' }, ROOT)).toBeNull();
    expect(matchDeliverable(config([]), {}, ROOT)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// resolveDeliverableContext — WORKTREE-FIRST config load (R6 finding #1). The prior
// closure always read verify.json from the project ROOT, so a deliverable recipe
// added by the very branch under verification (built in the WORKTREE) was invisible.
// These tests use real temp dirs for the worktree + project checkouts.
// ---------------------------------------------------------------------------
describe('resolveDeliverableContext', () => {
  let projectRoot: string;
  let worktreeRoot: string;

  beforeEach(async () => {
    projectRoot = await mkdtemp(join(tmpdir(), 'cyboflow-project-'));
    worktreeRoot = await mkdtemp(join(tmpdir(), 'cyboflow-worktree-'));
  });

  afterEach(async () => {
    await rm(projectRoot, { recursive: true, force: true });
    await rm(worktreeRoot, { recursive: true, force: true });
  });

  it('worktree verify.json WINS and cwd is the worktree (recipe added by the branch)', async () => {
    // Project root has NO entry for the branch's new deliverable; only the worktree does.
    await writeVerifyJson(
      projectRoot,
      JSON.stringify({ deliverables: [{ id: 'old', start: 'run', url: 'http://localhost:${PORT}' }] }),
    );
    await writeVerifyJson(
      worktreeRoot,
      JSON.stringify({
        deliverables: [{ id: 'newui', start: 'pnpm preview --port ${PORT}', url: 'http://localhost:${PORT}/newui' }],
      }),
    );
    const resolved = await resolveDeliverableContext({
      worktreePath: worktreeRoot,
      projectPath: projectRoot,
      input: { url: 'http://localhost:29260/newui' },
    });
    expect(resolved?.cwd).toBe(worktreeRoot);
    expect(resolved?.deliverable.id).toBe('newui');
  });

  it('falls back to the project root when the worktree has no verify.json (cwd = project root)', async () => {
    await writeVerifyJson(
      projectRoot,
      JSON.stringify({ deliverables: [{ id: 'app', start: 'run', url: 'http://localhost:${PORT}' }] }),
    );
    // worktreeRoot has NO .cyboflow/verify.json.
    const resolved = await resolveDeliverableContext({
      worktreePath: worktreeRoot,
      projectPath: projectRoot,
      input: { url: 'http://localhost:29260' },
    });
    expect(resolved?.cwd).toBe(projectRoot);
    expect(resolved?.deliverable.id).toBe('app');
  });

  it('falls back to the project root when worktreePath is null (quick run / no worktree)', async () => {
    await writeVerifyJson(
      projectRoot,
      JSON.stringify({ deliverables: [{ id: 'app', start: 'run', url: 'http://localhost:${PORT}' }] }),
    );
    const resolved = await resolveDeliverableContext({
      worktreePath: null,
      projectPath: projectRoot,
      input: {},
    });
    expect(resolved?.cwd).toBe(projectRoot);
    expect(resolved?.deliverable.id).toBe('app');
  });

  it('returns null (no unrelated binding) when nothing matches — even with a startable deliverable present', async () => {
    // Deliverable template is on a DIFFERENT host, so the localhost request genuinely
    // matches nothing — the old startable[0] fallback would have bound + spawned it.
    await writeVerifyJson(
      worktreeRoot,
      JSON.stringify({ deliverables: [{ id: 'app', start: 'run', url: 'http://127.0.0.1:${PORT}' }] }),
    );
    const resolved = await resolveDeliverableContext({
      worktreePath: worktreeRoot,
      projectPath: projectRoot,
      input: { url: 'http://localhost:8080/docs' },
    });
    expect(resolved).toBeNull();
  });
});
