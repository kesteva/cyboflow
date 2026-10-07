import { readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

const BRIDGE_DIR = resolve(__dirname, '..');
const PA_DIR = resolve(BRIDGE_DIR, '..', '..');

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (p.endsWith('.ts')) out.push(p);
  }
  return out;
}

const allFiles = walk(BRIDGE_DIR);
const productionFiles = allFiles.filter((f) => !f.split(sep).includes('__tests__'));

function importSpecifiers(src: string): string[] {
  const specs: string[] = [];
  const re = /(?:from\s+|import\s*\(\s*|require\(\s*)['"]([^'"]+)['"]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) specs.push(m[1]);
  return specs;
}

describe('bridge architecture', () => {
  it('has production files to check', () => {
    expect(productionFiles.map((f) => basename(f)).sort()).toEqual([
      'bridgeConnector.ts', 'bridgeRemote.ts', 'bridgeRuntime.ts', 'constants.ts', 'copy.ts', 'descriptor.ts',
      'doorbell.ts', 'doorbellSocket.ts', 'inboundMapper.ts', 'index.ts', 'instructionBrief.ts', 'relayClient.ts',
      'relayErrors.ts', 'requestBudget.ts', 'types.ts',
    ]);
  });

  it('no bridge file imports electron', () => {
    const offenders = productionFiles.filter((f) =>
      /from ['"]electron['"]|require\(['"]electron['"]\)|import\(['"]electron['"]\)/.test(readFileSync(f, 'utf8')));
    expect(offenders).toEqual([]);
  });

  it('only doorbellSocket.ts touches globalThis.WebSocket', () => {
    const touching = productionFiles.filter((f) => {
      const src = readFileSync(f, 'utf8');
      return /globalThis[^\n]*WebSocket|\bnew\s+WebSocket\b/.test(src);
    });
    expect(touching.map((f) => basename(f))).toEqual(['doorbellSocket.ts']);
  });

  it('production files import from services/persistentAgents only the contract, errors and flags', () => {
    const allowed = new Set(['connectorContract', 'connectorErrors', 'flags']);
    const violations: string[] = [];
    for (const f of productionFiles) {
      for (const spec of importSpecifiers(readFileSync(f, 'utf8'))) {
        if (!spec.startsWith('.')) continue;
        const target = resolve(dirname(f), spec);
        if (!target.startsWith(PA_DIR + sep)) continue;
        if (target.startsWith(BRIDGE_DIR + sep)) continue;
        const rel = target.slice(PA_DIR.length + 1);
        if (!allowed.has(rel)) violations.push(`${basename(f)} -> ${spec}`);
      }
    }
    expect(violations).toEqual([]);
  });

  it('bridge sources carry no private-repo references', () => {
    const forbidden = [
      ['Durable', 'Object'].join(' '),
      ['Better', 'Auth'].join(' '),
      ['apps', 'bridge-relay'].join('/'),
      ['apps', 'accounts'].join('/'),
      ['packages', 'accounts-contract'].join('/'),
    ];
    const hits: string[] = [];
    for (const f of allFiles) {
      const src = readFileSync(f, 'utf8');
      for (const word of forbidden) if (src.includes(word)) hits.push(`${basename(f)}: ${word}`);
      if (/\b(?:D\d{1,2}a?|R\d{1,2}|W\d(?:\.\d)?|P\d)\b(?![-_])/.test(src.replace(/\bP\d{3,}\b/g, ''))) {
        const m = /\b(?:D\d{1,2}a?|R\d{1,2}|W\d(?:\.\d)?|P\d)\b(?![-_])/.exec(src);
        hits.push(`${basename(f)}: spec id ${m?.[0] ?? ''}`);
      }
    }
    expect(hits).toEqual([]);
  });
});
