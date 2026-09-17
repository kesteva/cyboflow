/**
 * Mechanical ratchet: the `cyboflow_*` MCP tool surfaces stay derived from ONE
 * registry.
 *
 * A tool used to be declared in three hand-maintained places — a JSON Schema
 * literal in the ListTools reply, a `case` arm that re-typechecked the same
 * fields and built the socket envelope, and the `McpQueryMessage` union member
 * the main process reads. Nothing tied them together, so a change to one drifted
 * from the others silently (the same failure class docs/CODE-PATTERNS.md
 * documents for IPC type parity). ./toolRegistry collapsed the first two onto a
 * single zod schema per tool and made the third a compile error. This test is
 * what keeps that structural, rather than merely true on the day it landed.
 *
 * The scans are CALL-SITE anchored: they read the actual dispatch files and
 * assert on what is in them, so moving a switch or renaming a table breaks the
 * anchor assertion (below) rather than silently scanning nothing. They
 * deliberately do NOT parse TypeScript — a regex over the two dispatch sites is
 * enough to answer "is there per-tool code here", and a parser would fail on
 * syntax this test has no opinion about.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  MCP_TOOL_SCOPES,
  declarationsForScope,
  findTool,
  toolsForScope,
  type McpEnvelopeType,
  type McpToolScope,
} from '../toolRegistry';

/**
 * Walk up to whichever ancestor holds the mcpServer directory, so the scan works
 * whether vitest is rooted at the repo or at main/. `import.meta` is unavailable
 * under this package's CommonJS target.
 */
function locateMcpServerDir(): string {
  let dir = process.cwd();
  for (;;) {
    for (const base of [dir, path.join(dir, 'main')]) {
      const candidate = path.join(base, 'src', 'orchestrator', 'mcpServer');
      if (fs.existsSync(path.join(candidate, 'toolRegistry', 'index.ts'))) return candidate;
    }
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error(`Could not locate orchestrator/mcpServer from ${process.cwd()}`);
    dir = parent;
  }
}

const MCP_DIR = locateMcpServerDir();
const SERVER_SRC = fs.readFileSync(path.join(MCP_DIR, 'cyboflowMcpServer.ts'), 'utf8');
const HANDLER_SRC = fs.readFileSync(path.join(MCP_DIR, 'mcpQueryHandler.ts'), 'utf8');
// McpQueryMessage / McpQueryResponse were extracted out of mcpQueryHandler.ts
// into mcpQueryMessages.ts (issue #19, the god-file split) — declaredEnvelopes()
// below scans THIS source, not the handler's.
const MESSAGES_SRC = fs.readFileSync(path.join(MCP_DIR, 'mcpQueryMessages.ts'), 'utf8');

/**
 * Envelopes the main process dispatches that NO tool produces. These are the
 * other traffic on the same socket — the shell-approval hook and the two
 * interactive-PTY notifications — not tools with a missing registry entry.
 */
const NON_TOOL_ENVELOPES: ReadonlySet<string> = new Set([
  'shell-approval-request',
  'interactive-turn-end',
  'interactive-question-open',
]);

/**
 * Tools that advertise `required: []` yet still reject `{}`, because a
 * CROSS-FIELD rule no single property can express is what actually gates them.
 * Each entry needs the rule spelled out, because the gap is real: an agent
 * reading only the schema is told the call takes no mandatory argument.
 *
 * This list may shrink. Growing it means another tool's contract has become
 * unreadable from its declaration, which a reviewer should have to agree to.
 */
const CROSS_FIELD_REQUIRED: ReadonlyMap<string, string> = new Map([
  [
    'cyboflow_request_verification',
    'Needs an acceptance sentence, but it may arrive as `intent` OR as `task.summary` '
      + '(the composed VerificationTaskV1 form), so neither property alone can be marked required. '
      + 'Pre-dates the registry — the hand-written arm rejected {} the same way.',
  ],
]);

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

/** Every envelope `handleMessage`'s switch has an arm for. */
function dispatchedEnvelopes(): Set<string> {
  const start = HANDLER_SRC.indexOf('async handleMessage(');
  expect(start, 'handleMessage moved — this ratchet scans the wrong region').toBeGreaterThan(-1);
  // Strip comments first: a `case` arm demoted to a comment must count as
  // REMOVED, not still dispatched.
  const body = stripComments(HANDLER_SRC.slice(start));
  return new Set([...body.matchAll(/case ['"]([a-z-]+)['"]:/g)].map((match) => match[1]));
}

/** Every envelope the `McpQueryMessage` union declares a member for. */
function declaredEnvelopes(): Set<string> {
  const start = MESSAGES_SRC.indexOf('export type McpQueryMessage =');
  const end = MESSAGES_SRC.indexOf('export interface McpQueryResponse');
  expect(start, 'McpQueryMessage moved — this ratchet scans the wrong region').toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  const union = stripComments(MESSAGES_SRC.slice(start, end));
  return new Set([...union.matchAll(/type: ['"]([a-z-]+)['"];/g)].map((match) => match[1]));
}

describe('MCP tool registry ratchet: every surface derives from one entry', () => {
  it('the dispatch file holds NO per-tool code', () => {
    // The whole point of the registry. A re-introduced `case 'cyboflow_…'` arm
    // in the server means a tool's validation has drifted back out of its entry.
    const armed = [...SERVER_SRC.matchAll(/case '(cyboflow_[a-z_]+)'/g)].map((match) => match[1]);
    expect(armed).toEqual([]);

    // …and no hand-written declaration either: an `inputSchema:` literal here
    // would be a second, unvalidated copy of a registry entry's schema.
    expect(SERVER_SRC).not.toContain('inputSchema:');
  });

  it('a blocking gate keeps its null transport budget, distinct from omitting one', () => {
    // `null` means WAIT FOREVER; `undefined` takes sendQuery's 30-second
    // default. cyboflow_request_user_input is a HUMAN question gate that
    // legitimately blocks for days, so collapsing the two — a plausible
    // "tidy the optional away" edit, or a `?? 30_000` in the dispatcher —
    // would kill the gate 30 seconds in, with every other test still green.
    const gate = findTool('run', 'cyboflow_request_user_input');
    expect(gate).toBeDefined();
    expect(gate?.timeoutMs, 'the question gate must carry null, not undefined').toBeNull();

    // …and the dispatcher must hand it straight to executeMcpQuery, whose own
    // parameter is `number | null | undefined`.
    expect(SERVER_SRC).toContain('executeMcpQuery(tool.envelope, prepared.params, tool.timeoutMs)');
  });

  it('dispatches through the registry rather than a scope-specific switch', () => {
    // Anchors the scan above: if these calls disappear, the "no per-tool code"
    // assertion could pass simply because the file no longer dispatches at all.
    expect(SERVER_SRC).toContain('declarationsForScope(ACTIVE_SCOPE)');
    expect(SERVER_SRC).toContain('findTool(ACTIVE_SCOPE, request.params.name)');
    expect(SERVER_SRC).toContain('tool.prepare(');
  });

  for (const scope of MCP_TOOL_SCOPES) {
    describe(`scope: ${scope}`, () => {
      const tools = toolsForScope(scope);

      it('advertises at least one tool', () => {
        expect(tools.length).toBeGreaterThan(0);
      });

      it('every entry yields exactly one declaration, findable by name', () => {
        const declarations = declarationsForScope(scope);
        expect(declarations).toHaveLength(tools.length);

        const names = declarations.map((declaration) => declaration.name);
        expect(new Set(names).size, `duplicate tool name in ${scope}`).toBe(names.length);

        for (const declaration of declarations) {
          expect(declaration.description.length, `${declaration.name} has no description`).toBeGreaterThan(0);
          // The advertised shape agents and the SDK read. `required` is present
          // even when empty — the no-argument tools advertise `required: []`.
          expect(declaration.inputSchema.type).toBe('object');
          expect(declaration.inputSchema.properties).toBeTypeOf('object');
          expect(Array.isArray(declaration.inputSchema.required)).toBe(true);
          expect(findTool(scope, declaration.name)).toBeDefined();
        }
      });

      it('every declared required property is enforced by the entry validator', () => {
        // The lockstep that used to be maintained by hand: a property the
        // declaration marks required must actually fail validation when absent,
        // and a tool that declares no required property must accept `{}`.
        for (const tool of tools) {
          const result = tool.prepare({});
          if (tool.inputSchema.required.length > 0) {
            expect(result.ok, `${tool.name} declares required args but accepts {}`).toBe(false);
          } else if (CROSS_FIELD_REQUIRED.has(tool.name)) {
            expect(result.ok, `${tool.name} is allowlisted as cross-field-gated but now accepts {}`).toBe(false);
          } else {
            expect(result.ok, `${tool.name} declares no required args but rejects {}`).toBe(true);
          }
        }
      });

      it('every declared required property exists in the advertised properties', () => {
        for (const tool of tools) {
          for (const required of tool.inputSchema.required) {
            expect(
              Object.keys(tool.inputSchema.properties),
              `${tool.name} requires '${required}' but does not advertise it`,
            ).toContain(required);
          }
        }
      });

      it('every entry names an envelope the main process both declares and dispatches', () => {
        const declared = declaredEnvelopes();
        const dispatched = dispatchedEnvelopes();
        for (const tool of tools) {
          if (tool.envelope === null) continue; // served locally — asserted below
          expect(declared, `${tool.name} -> ${tool.envelope} has no McpQueryMessage member`).toContain(tool.envelope);
          expect(dispatched, `${tool.name} -> ${tool.envelope} has no handleMessage arm`).toContain(tool.envelope);
        }
      });

      it('every locally-served entry has a local handler, and vice versa', () => {
        // `envelope: null` means the subprocess answers the call itself. The
        // table lives in cyboflowMcpServer.ts (it holds content, not schema), so
        // this pairing is the one thing the type system cannot check.
        const localTable = SERVER_SRC.slice(SERVER_SRC.indexOf('const LOCAL_TOOLS'));
        for (const tool of tools) {
          if (tool.envelope !== null) continue;
          expect(localTable, `${tool.name} is envelope:null with no LOCAL_TOOLS handler`).toContain(`${tool.name}:`);
        }
        const handled = [...localTable.matchAll(/^ {2}(cyboflow_[a-z_]+):/gm)].map((match) => match[1]);
        for (const name of handled) {
          const entry = MCP_TOOL_SCOPES.map((candidate) => findTool(candidate, name)).find(
            (found) => found !== undefined,
          );
          expect(entry, `LOCAL_TOOLS handles ${name} but no registry entry declares it`).toBeDefined();
          expect(entry?.envelope, `${name} has a local handler but forwards an envelope`).toBeNull();
        }
      });
    });
  }

  it('the union and the dispatch switch agree, and every non-tool envelope is accounted for', () => {
    const declared = declaredEnvelopes();
    const dispatched = dispatchedEnvelopes();

    // Neither side may grow a member the other lacks — an undispatched union
    // member is a silently-dropped message, an undeclared arm is dead code.
    expect([...declared].filter((envelope) => !dispatched.has(envelope))).toEqual([]);
    expect([...dispatched].filter((envelope) => !declared.has(envelope))).toEqual([]);

    // Every envelope is either produced by a registry entry or a known
    // non-tool message. A new envelope with no tool behind it has to be listed
    // in NON_TOOL_ENVELOPES deliberately, which is a reviewable act.
    const produced = new Set<string>(
      MCP_TOOL_SCOPES.flatMap((scope: McpToolScope) =>
        toolsForScope(scope)
          .map((tool) => tool.envelope)
          .filter((envelope): envelope is McpEnvelopeType => envelope !== null),
      ),
    );
    const orphans = [...declared].filter(
      (envelope) => !produced.has(envelope) && !NON_TOOL_ENVELOPES.has(envelope),
    );
    expect(orphans).toEqual([]);
  });
});
