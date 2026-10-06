/**
 * Spawn-marker chokepoint-enforcement gate.
 *
 * FALLBACK NOTE: most of these modules have no injectable spawner (the PTY
 * managers call node-pty directly, runConfig is a pure env builder), and their
 * behavioural env assertions live in each module's own test. This gate is a
 * deliberate source-layout check — the one place the requirement "every spawn
 * path routes its env through stampSpawnMarker instead of hand-writing the
 * marker keys" can be enforced across all modules at once. It does NOT count
 * as behavioural coverage of any single spawn site.
 *
 * MANUAL STEP: a new spawn module must be added to STAMPED_MODULES (or, if it
 * legitimately inherits the stamp from AbstractCliManager, to INHERITING_MODULES).
 * The discovery test below fails loudly if a file calls a PTY spawn directly and
 * is enumerated in neither list. Full automatic discovery of every spawn
 * flavour (child_process.spawn/execFile) is out of scope.
 */
import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import ts from 'typescript';

const SRC = path.resolve(__dirname, '..', '..');

/** Modules that build/own a spawn env and must call stampSpawnMarker themselves. */
const STAMPED_MODULES = [
  'services/panels/cli/AbstractCliManager.ts',
  'services/sessionManager.ts',
  'services/terminalPanelManager.ts',
  'services/runShellManager.ts',
  'services/panels/codex/appServer/runConfig.ts',
  'services/panels/logPanel/logsManager.ts',
  'orchestrator/verify/verificationAgentRunner.ts',
  'orchestrator/verify/verificationAgentQuery.ts',
  'orchestrator/mcpServer/mcpServerLifecycle.ts',
];

/**
 * Files that mention pty.spawn but only as an injected spawner for an enumerated
 * manager, which stamps the env itself before invoking it.
 */
const SPAWNER_INJECTION_ONLY = new Set(['runLiveDepsComposition.ts']); // wires RunShellManager's ShellSpawner

/** Interactive PTY managers stamped via AbstractCliManager.spawnPtyProcess. */
const INHERITING_MODULES = [
  'services/panels/codex/codexPtyManager.ts',
  'services/panels/pi/piPtyManager.ts',
  'services/panels/omp/ompPtyManager.ts',
];

/**
 * Hand-written marker forms: a quoted key (`env['CYBOFLOW_INSTANCE']`), an object
 * literal key (`{ CYBOFLOW_INSTANCE: id }`) and a direct property write
 * (`env.CYBOFLOW_INSTANCE = id`, also `??=` / `||=`). Reads are not flagged.
 */
const MARKER_LITERAL =
  /['"`]CYBOFLOW_(INSTANCE|WORKTREE)['"`]|\bCYBOFLOW_(INSTANCE|WORKTREE)\s*:|\.CYBOFLOW_(INSTANCE|WORKTREE)\s*(?:\?\?|\|\|)?=(?!=)/;

/**
 * Per-site enforcement. `callsStamp` alone accepts ONE stamp anywhere in a module,
 * so a module with two spawn sites could lose the stamp at one and still pass.
 * Each entry names a spawn site structurally (an AST node, not a source regex) and
 * how many such sites the module has; every site's `env` must then resolve to a
 * stamped value.
 *  - `call`         — a CallExpression whose callee text is `callee`; every `env`
 *                     property in its object-literal arguments (one nesting level,
 *                     e.g. `options: { env }`) must be stamped.
 *  - `property`     — a PropertyAssignment named `name` holding an object literal
 *                     (e.g. an MCP server block); its `env` property must be stamped.
 *  - `return-stamp` — a `return stampSpawnMarker(...)` in a pure env builder (the
 *                     node itself IS the stamp).
 */
type SpawnSite =
  | { kind: 'call'; callee: string; count: number }
  | { kind: 'property'; name: string; count: number }
  | { kind: 'return-stamp'; count: number };

const SPAWN_SITES: Record<string, SpawnSite[]> = {
  'services/panels/cli/AbstractCliManager.ts': [{ kind: 'call', callee: 'pty.spawn', count: 2 }],
  'services/sessionManager.ts': [{ kind: 'call', callee: 'execAsync', count: 1 }],
  'services/terminalPanelManager.ts': [{ kind: 'call', callee: 'pty.spawn', count: 1 }],
  'services/runShellManager.ts': [{ kind: 'call', callee: 'this.spawn', count: 1 }],
  'services/panels/codex/appServer/runConfig.ts': [
    { kind: 'property', name: 'cyboflow', count: 1 },
    { kind: 'return-stamp', count: 1 },
  ],
  'services/panels/logPanel/logsManager.ts': [{ kind: 'call', callee: 'spawn', count: 1 }],
  'orchestrator/verify/verificationAgentRunner.ts': [{ kind: 'call', callee: 'queryFn', count: 1 }],
  'orchestrator/verify/verificationAgentQuery.ts': [{ kind: 'call', callee: 'query', count: 1 }],
  'orchestrator/mcpServer/mcpServerLifecycle.ts': [{ kind: 'call', callee: 'spawn', count: 1 }],
};

const MARKER_KEYS = new Set(['CYBOFLOW_INSTANCE', 'CYBOFLOW_WORKTREE']);

function propName(p: ts.ObjectLiteralElementLike): string | undefined {
  const n = p.name;
  if (n && (ts.isIdentifier(n) || ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n))) return n.text;
  return undefined;
}

function unwrap(e: ts.Expression): ts.Expression {
  let cur = e;
  while (
    ts.isParenthesizedExpression(cur) ||
    ts.isAsExpression(cur) ||
    ts.isNonNullExpression(cur) ||
    ts.isSatisfiesExpression(cur) ||
    ts.isTypeAssertionExpression(cur)
  ) {
    cur = cur.expression;
  }
  return cur;
}

/** The nearest visible `const`/`let`/`var` initializer for `name` at `from`, lexically; null if unresolved. */
function resolveInitializer(name: string, from: ts.Node): ts.Expression | null {
  const declIn = (list: ts.VariableDeclarationList | undefined, use: ts.Node): ts.VariableDeclaration | null => {
    if (!list) return null;
    const hits = list.declarations.filter((d) => ts.isIdentifier(d.name) && d.name.text === name);
    if (hits.length === 0) return null;
    const before = hits.filter((d) => d.pos <= use.pos);
    return before.length > 0 ? before[before.length - 1] : hits[0];
  };
  for (let scope: ts.Node | undefined = from.parent; scope; scope = scope.parent) {
    // Shadowing binders that carry no analysable initializer: unresolved -> not stamped.
    if (ts.isFunctionLike(scope) && scope.parameters.some((p) => ts.isIdentifier(p.name) && p.name.text === name)) {
      return null;
    }
    if (ts.isCatchClause(scope) && scope.variableDeclaration && ts.isIdentifier(scope.variableDeclaration.name)) {
      if (scope.variableDeclaration.name.text === name) return null;
    }
    let found: ts.VariableDeclaration | null = null;
    if (ts.isBlock(scope) || ts.isSourceFile(scope) || ts.isModuleBlock(scope) || ts.isCaseClause(scope)) {
      const stmts: readonly ts.Statement[] = ts.isCaseClause(scope) ? scope.statements : (scope as ts.Block).statements;
      for (const st of stmts) {
        if (ts.isVariableStatement(st)) found = declIn(st.declarationList, from) ?? found;
      }
    } else if (ts.isForStatement(scope) || ts.isForOfStatement(scope) || ts.isForInStatement(scope)) {
      const init = scope.initializer;
      if (init && ts.isVariableDeclarationList(init)) found = declIn(init, from);
    }
    if (found) return found.initializer ?? null;
  }
  return null;
}

/** True when `expr` evaluates to (a value derived from) the output of stampSpawnMarker. */
function isStamped(expr: ts.Expression, seen: Set<ts.Node> = new Set()): boolean {
  const e = unwrap(expr);
  if (ts.isCallExpression(e)) return ts.isIdentifier(e.expression) && e.expression.text === 'stampSpawnMarker';
  if (ts.isConditionalExpression(e)) return isStamped(e.whenTrue, seen) && isStamped(e.whenFalse, seen);
  if (ts.isObjectLiteralExpression(e)) {
    // Stamped iff a stamped spread is present and nothing after it can overwrite the marker keys.
    let stampedAt = -1;
    e.properties.forEach((p, i) => {
      if (ts.isSpreadAssignment(p) && isStamped(p.expression, seen)) stampedAt = i;
    });
    if (stampedAt < 0) return false;
    return e.properties.slice(stampedAt + 1).every((p) => {
      if (ts.isSpreadAssignment(p)) return isStamped(p.expression, seen);
      const key = propName(p);
      return key !== undefined && !MARKER_KEYS.has(key); // computed keys could be the marker: not provably safe
    });
  }
  if (ts.isIdentifier(e)) {
    if (seen.has(e)) return false;
    seen.add(e);
    const init = resolveInitializer(e.text, e);
    return init !== null && isStamped(init, seen);
  }
  return false;
}

/** Every `env` property reachable in an object literal, descending one level into non-env properties. */
function envProps(obj: ts.ObjectLiteralExpression, depth = 0): ts.ObjectLiteralElementLike[] {
  const out: ts.ObjectLiteralElementLike[] = [];
  for (const p of obj.properties) {
    if (propName(p) === 'env' && (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p))) out.push(p);
    else if (depth === 0 && ts.isPropertyAssignment(p)) {
      const v = unwrap(p.initializer);
      if (ts.isObjectLiteralExpression(v)) out.push(...envProps(v, 1));
    }
  }
  return out;
}

function envPropStamped(p: ts.ObjectLiteralElementLike): boolean {
  if (ts.isShorthandPropertyAssignment(p)) return isStamped(p.name);
  return ts.isPropertyAssignment(p) && isStamped(p.initializer);
}

/** True when the object literals given have at least one `env` and EVERY `env` is stamped. */
function objectsStamped(objs: ts.ObjectLiteralExpression[]): boolean {
  const props = objs.flatMap((o) => envProps(o));
  return props.length > 0 && props.every(envPropStamped);
}

function visitAll(node: ts.Node, visit: (n: ts.Node) => void): void {
  visit(node);
  node.forEachChild((c) => visitAll(c, visit));
}

/** One entry per structural spawn site kind: how many sites exist and how many carry an unstamped env. */
export function spawnSiteStamps(rawSrc: string, sites: SpawnSite[]): { count: number; unstamped: number }[] {
  const sf = ts.createSourceFile('module.ts', rawSrc, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  return sites.map((site) => {
    let count = 0;
    let unstamped = 0;
    visitAll(sf, (n) => {
      if (site.kind === 'call' && ts.isCallExpression(n) && n.expression.getText(sf) === site.callee) {
        count++;
        if (!objectsStamped(n.arguments.filter(ts.isObjectLiteralExpression))) unstamped++;
      } else if (site.kind === 'property' && ts.isPropertyAssignment(n) && propName(n) === site.name) {
        const v = unwrap(n.initializer);
        if (ts.isObjectLiteralExpression(v)) {
          count++;
          if (!objectsStamped([v])) unstamped++;
        }
      } else if (site.kind === 'return-stamp' && ts.isReturnStatement(n) && n.expression) {
        const e = unwrap(n.expression);
        if (ts.isCallExpression(e) && ts.isIdentifier(e.expression) && e.expression.text === 'stampSpawnMarker') count++;
      }
    });
    return { count, unstamped };
  });
}

function read(rel: string): string {
  return fs.readFileSync(path.join(SRC, rel), 'utf8');
}

export function callsStamp(src: string): boolean {
  return /\bstampSpawnMarker\s*\(/.test(src) && /from\s+['"][^'"]*spawnMarker['"]/.test(src);
}
export function handWritesMarker(src: string): boolean {
  return MARKER_LITERAL.test(src);
}

describe('spawn marker chokepoint coverage', () => {
  // 15 epic modules, minus the three spawn owners the Crystal cleanup deleted
  // (terminalSessionManager, runCommandManager, visualVerify/devServerManager).
  it('enumerates all 12 live spawn-owning modules', () => {
    expect(STAMPED_MODULES.length + INHERITING_MODULES.length).toBe(12);
  });

  it.each(STAMPED_MODULES)('%s calls stampSpawnMarker', (rel) => {
    expect(callsStamp(read(rel))).toBe(true);
  });

  it.each(Object.keys(SPAWN_SITES))('%s stamps the env at EVERY spawn site', (rel) => {
    const sites = SPAWN_SITES[rel];
    const results = spawnSiteStamps(read(rel), sites);
    results.forEach((r, i) => {
      // A count drift means a spawn site was added/removed: update SPAWN_SITES deliberately.
      expect(r.count, `${rel}: site ${JSON.stringify(sites[i])} count`).toBe(sites[i].count);
      expect(r.unstamped, `${rel}: unstamped sites for ${JSON.stringify(sites[i])}`).toBe(0);
    });
  });

  it('SPAWN_SITES covers every stamped module', () => {
    expect(Object.keys(SPAWN_SITES).sort()).toEqual([...STAMPED_MODULES].sort());
  });

  it.each([...STAMPED_MODULES, ...INHERITING_MODULES])('%s never hand-writes the marker keys', (rel) => {
    expect(handWritesMarker(read(rel))).toBe(false);
  });

  it.each(INHERITING_MODULES)('%s inherits the stamp via AbstractCliManager and never spawns a PTY itself', (rel) => {
    const src = read(rel);
    expect(src).toMatch(/extends AbstractCliManager/);
    expect(src).not.toMatch(/\bpty\.spawn\s*\(/);
  });

  it('flags any non-enumerated production file that calls pty.spawn directly', () => {
    const known = new Set([...STAMPED_MODULES, ...INHERITING_MODULES, ...SPAWNER_INJECTION_ONLY]);
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === 'node_modules' || entry.name === '__tests__') continue;
          walk(full);
        } else if (/\.ts$/.test(entry.name) && !/\.(test|itest|spec)\.ts$/.test(entry.name)) {
          const rel = path.relative(SRC, full).split(path.sep).join('/');
          if (!known.has(rel) && /\bpty\.spawn\s*\(/.test(fs.readFileSync(full, 'utf8'))) offenders.push(rel);
        }
      }
    };
    walk(SRC);
    expect(offenders).toEqual([]);
  });

  describe('detectors can fail (negative controls on synthetic sources)', () => {
    it('rejects a module that spawns without stamping', () => {
      expect(callsStamp(`import * as pty from 'node-pty'; pty.spawn(sh, [], { env })`)).toBe(false);
    });
    it('rejects a module that hand-writes the marker literals', () => {
      expect(handWritesMarker(`const env = { CYBOFLOW_INSTANCE: 'x' };`)).toBe(true);
      expect(handWritesMarker(`env['CYBOFLOW_WORKTREE'] = cwd;`)).toBe(true);
    });
    it('rejects direct property writes of the marker keys', () => {
      expect(handWritesMarker(`env.CYBOFLOW_INSTANCE = id;`)).toBe(true);
      expect(handWritesMarker(`childEnv.CYBOFLOW_WORKTREE ??= cwd;`)).toBe(true);
      expect(handWritesMarker(`const v = process.env.CYBOFLOW_INSTANCE;`)).toBe(false);
    });
    const spawnSite = (count: number): SpawnSite[] => [{ kind: 'call', callee: 'spawn', count }];
    const HEAD = `import { stampSpawnMarker } from '../utils/spawnMarker';\n`;
    it('rejects a module where only one of two spawn sites is stamped', () => {
      const src = `${HEAD}
        const a = spawn(cmd, { env: stampSpawnMarker({ ...process.env }, cwd) });
        const b = spawn(cmd, { env: { ...process.env, PORT: '1' } });`;
      expect(callsStamp(src)).toBe(true); // the module-level check would wave this through
      expect(spawnSiteStamps(src, spawnSite(2))).toEqual([{ count: 2, unstamped: 1 }]);
    });
    it('is scope-aware: a stamped `env` in one function does not vouch for an unstamped `env` in another', () => {
      const src = `${HEAD}
        function good() {
          const env = stampSpawnMarker(base, cwd);
          return spawn(cmd, { env });
        }
        function bad() {
          const env = { ...process.env };
          return spawn(cmd, { env });
        }`;
      expect(spawnSiteStamps(src, spawnSite(2))).toEqual([{ count: 2, unstamped: 1 }]);
    });
    it('is scope-aware: an unstamped inner `env` shadowing a stamped outer one is unstamped', () => {
      const src = `${HEAD}
        const env = stampSpawnMarker(base, cwd);
        function inner() {
          const env = { ...process.env };
          return spawn(cmd, { env });
        }
        function outer() {
          return spawn(cmd, { env });
        }`;
      expect(spawnSiteStamps(src, spawnSite(2))).toEqual([{ count: 2, unstamped: 1 }]);
    });
    it('is scope-aware: a parameter named env is unresolved, not stamped', () => {
      const src = `${HEAD}
        const env = stampSpawnMarker(base, cwd);
        function f(env) { return spawn(cmd, { env }); }`;
      expect(spawnSiteStamps(src, spawnSite(1))).toEqual([{ count: 1, unstamped: 1 }]);
    });
    it('checks EVERY env property at a site, including a nested options.env', () => {
      const src = `${HEAD}
        const marked = stampSpawnMarker(base, cwd);
        spawn(cmd, { env: marked, options: { env: process.env } });
        spawn(cmd, { env: marked, options: { env: marked } });
        spawn(cmd, { env: process.env, env: marked });`;
      expect(spawnSiteStamps(src, spawnSite(3))).toEqual([{ count: 3, unstamped: 2 }]);
    });
    it('rejects a spread-stamped object that then overwrites a marker key or spreads unstamped env', () => {
      const src = `${HEAD}
        const marked = stampSpawnMarker(base, cwd);
        spawn(cmd, { env: { ...marked, CYBOFLOW_INSTANCE: 'x' } });
        spawn(cmd, { env: { ...marked, ...process.env } });
        spawn(cmd, { env: { ...marked, PATH: p } });`;
      expect(spawnSiteStamps(src, spawnSite(3))).toEqual([{ count: 3, unstamped: 2 }]);
    });
    it('a spawn with no env property at all is unstamped', () => {
      expect(spawnSiteStamps(`${HEAD}spawn(cmd, { cwd });`, spawnSite(1))).toEqual([{ count: 1, unstamped: 1 }]);
    });
    it('catches losing the stamp at a real terminalPanelManager site (in-memory mutation)', () => {
      const rel = 'services/terminalPanelManager.ts';
      const real = read(rel);
      expect(spawnSiteStamps(real, SPAWN_SITES[rel])[0].unstamped).toBe(0);
      const idx = real.lastIndexOf('env: stampSpawnMarker(');
      const mutated = real.slice(0, idx) + 'env: (' + real.slice(idx + 'env: stampSpawnMarker('.length);
      expect(spawnSiteStamps(mutated, SPAWN_SITES[rel])[0].unstamped).toBe(1);
    });
    it('accepts stamped sites via derived identifiers, conditionals and shorthand env', () => {
      const src = `${HEAD}
        const marked = stampSpawnMarker(base, cwd);
        const derived = flag ? { ...marked, X: '1' } : marked;
        spawn(cmd, { env: derived });
        spawn(cmd, { cwd, env: marked, stdio: 'pipe' });`;
      expect(spawnSiteStamps(src, spawnSite(2))).toEqual([{ count: 2, unstamped: 0 }]);
      const shorthand = `const env = stampSpawnMarker(base, cwd);\nspawn(cmd, { stdio: 'pipe', env });`;
      expect(spawnSiteStamps(shorthand, spawnSite(1))).toEqual([{ count: 1, unstamped: 0 }]);
      const bare = `const env = base;\nspawn(cmd, { stdio: 'pipe', env });`;
      expect(spawnSiteStamps(bare, spawnSite(1))).toEqual([{ count: 1, unstamped: 1 }]);
      const halfCond = `const marked = stampSpawnMarker(base, cwd);\nconst e = f ? marked : process.env;\nspawn(cmd, { env: e });`;
      expect(spawnSiteStamps(halfCond, spawnSite(1))).toEqual([{ count: 1, unstamped: 1 }]);
    });
    it('accepts a properly stamped module', () => {
      const ok = `import { stampSpawnMarker } from '../utils/spawnMarker';\nconst e = stampSpawnMarker(env, cwd);`;
      expect(callsStamp(ok)).toBe(true);
      expect(handWritesMarker(ok)).toBe(false);
    });
  });
});
