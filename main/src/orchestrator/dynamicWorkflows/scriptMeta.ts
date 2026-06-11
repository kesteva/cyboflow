/**
 * scriptMeta — fail-soft regex extraction of the `export const meta = {...}`
 * literal from a persisted dynamic-workflow script
 * (`<sessionDir>/workflows/scripts/<name>-wf_<id>.js`).
 *
 * The meta block is a PURE object literal by construction (the CLI writes it),
 * so a quote-aware brace scanner + per-key string regexes are sufficient — no
 * JS parsing/eval. Any parse miss degrades to nulls / an empty phases array;
 * this function never throws.
 */
import type { DynamicWorkflowPhase } from '../../../../shared/types/dynamicWorkflows';

/** Result shape of {@link parseScriptMeta}. */
export interface ParsedScriptMeta {
  name: string | null;
  description: string | null;
  phases: DynamicWorkflowPhase[];
}

const EMPTY_META: ParsedScriptMeta = { name: null, description: null, phases: [] };

/**
 * Extract `name`, `description`, and `phases` from a workflow script's
 * `export const meta = {...}` literal.
 *
 * Accepts single- or double-quoted strings; `detail` on a phase is optional.
 * Fail-soft: on any parse miss returns `{ name: null, description: null, phases: [] }`.
 */
export function parseScriptMeta(source: string): ParsedScriptMeta {
  try {
    const metaOpen = source.match(/export\s+const\s+meta\s*=\s*\{/);
    if (metaOpen === null || metaOpen.index === undefined) {
      return { ...EMPTY_META, phases: [] };
    }
    const braceIdx = metaOpen.index + metaOpen[0].length - 1;
    const block = extractBalanced(source, braceIdx, '{', '}');
    if (block === null) {
      return { ...EMPTY_META, phases: [] };
    }

    // Extract the phases array FIRST and cut it out of the block, so keys
    // inside phase objects can never pollute the top-level name/description
    // matches (e.g. a phase title containing "name: 'x'").
    let phases: DynamicWorkflowPhase[] = [];
    let scalarScope = block;
    const phasesOpen = block.match(/\bphases\s*:\s*\[/);
    if (phasesOpen !== null && phasesOpen.index !== undefined) {
      const bracketIdx = phasesOpen.index + phasesOpen[0].length - 1;
      const arrayLiteral = extractBalanced(block, bracketIdx, '[', ']');
      if (arrayLiteral !== null) {
        phases = parsePhases(arrayLiteral);
        scalarScope = block.slice(0, phasesOpen.index) + block.slice(bracketIdx + arrayLiteral.length);
      }
    }

    return {
      name: extractStringValue(scalarScope, 'name'),
      description: extractStringValue(scalarScope, 'description'),
      phases,
    };
  } catch {
    // Fail-soft: a malformed script must never break detection.
    return { ...EMPTY_META, phases: [] };
  }
}

/**
 * Return the balanced `open`...`close` span starting at `openIdx` (which must
 * point at an `open` character), skipping over quoted strings so braces or
 * brackets inside string values do not confuse the depth count. Returns null
 * when the span never closes.
 */
function extractBalanced(source: string, openIdx: number, open: string, close: string): string | null {
  let depth = 0;
  let inString: string | null = null;
  for (let i = openIdx; i < source.length; i++) {
    const ch = source[i];
    if (inString !== null) {
      if (ch === '\\') {
        i++; // skip the escaped character
        continue;
      }
      if (ch === inString) inString = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      inString = ch;
      continue;
    }
    if (ch === open) {
      depth++;
    } else if (ch === close) {
      depth--;
      if (depth === 0) return source.slice(openIdx, i + 1);
    }
  }
  return null;
}

/**
 * Extract a `key: '...'` / `key: "..."` string value from `scope`.
 * Unescapes `\'`, `\"`, and `\\`; returns null when the key is absent or its
 * value is not a quoted string literal.
 */
function extractStringValue(scope: string, key: string): string | null {
  const re = new RegExp(`\\b${key}\\s*:\\s*(?:'((?:[^'\\\\]|\\\\.)*)'|"((?:[^"\\\\]|\\\\.)*)")`);
  const m = scope.match(re);
  if (m === null) return null;
  const raw = m[1] ?? m[2];
  if (raw === undefined) return null;
  return raw.replace(/\\(['"\\])/g, '$1');
}

/**
 * Parse the body of the `phases: [...]` array literal into phase objects.
 * Each `{...}` entry contributes a phase iff it has a string `title`;
 * `detail` is carried when present. Objects are isolated via the quote-aware
 * scanner so braces inside title/detail strings cannot truncate an entry.
 */
function parsePhases(arrayLiteral: string): DynamicWorkflowPhase[] {
  const phases: DynamicWorkflowPhase[] = [];
  let cursor = arrayLiteral.indexOf('{');
  while (cursor !== -1) {
    const obj = extractBalanced(arrayLiteral, cursor, '{', '}');
    if (obj === null) break;
    const title = extractStringValue(obj, 'title');
    if (title !== null) {
      const detail = extractStringValue(obj, 'detail');
      phases.push(detail === null ? { title } : { title, detail });
    }
    cursor = arrayLiteral.indexOf('{', cursor + obj.length);
  }
  return phases;
}
