/**
 * xcodePassEvidence — the §B5 pass-evidence rule over a real artifacts dir
 * (docs/proposals/runbook-optional-verification.md §B5).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { VerificationReportV1 } from '../../../../../../shared/types/visualVerification';
import { createCaptureLedger, recordLedgerCapture, recordLedgerLaunch, type CaptureLedger } from '../xcodeDriveSocketServer';
import { xcodePassEvidenceReasons } from '../xcodePassEvidence';

const APP = 'com.acme.ios';
const dirs: string[] = [];
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

function sha(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function capture(ledger: CaptureLedger, name: string, bytes: string, over: { foreground?: string; pid?: number } = {}): void {
  recordLedgerCapture(ledger, {
    name,
    verb: 'mobile-capture',
    sha256: sha(bytes),
    file: name,
    applicationState: 'NotRun',
    foregroundBundleId: over.foreground ?? APP,
    pid: over.pid ?? 100,
    activated: false,
  });
}

function report(cites: Record<string, string[]>, results: Record<string, 'pass' | 'fail' | 'not_testable'> = {}): VerificationReportV1 {
  return {
    version: 1,
    behaviors: Object.entries(cites).map(([id, screenshots]) => ({
      id,
      result: results[id] ?? 'pass',
      evidence: { screenshots, notes: '' },
    })),
    screenshots: [],
    outcome: 'pass',
    confidence: 1,
    feedback: '',
    issues: [],
  };
}

function artifacts(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'cf-xpe-'));
  dirs.push(dir);
  for (const [name, bytes] of Object.entries(files)) writeFileSync(join(dir, name), bytes);
  return dir;
}

describe('xcodePassEvidenceReasons', () => {
  it('a pass citing a foreground capture since the pinned launch stands', async () => {
    const ledger = createCaptureLedger(APP);
    recordLedgerLaunch(ledger, 100);
    capture(ledger, 'home.png', 'A');
    expect(await xcodePassEvidenceReasons(report({ b1: ['home.png'] }), ledger, artifacts({ 'home.png': 'A' }))).toEqual([]);
  });

  it('a capture the agent OVERWROTE after the fact no longer matches its ledger hash', async () => {
    const ledger = createCaptureLedger(APP);
    recordLedgerLaunch(ledger, 100);
    capture(ledger, 'home.png', 'A');
    const reasons = await xcodePassEvidenceReasons(report({ b1: ['home.png'] }), ledger, artifacts({ 'home.png': 'B' }));
    expect(reasons).toEqual(['behavior b1: no cited screenshot is a harness capture recorded in the ledger']);
  });

  it('a capture of another app in the foreground does not count', async () => {
    const ledger = createCaptureLedger(APP);
    recordLedgerLaunch(ledger, 100);
    capture(ledger, 'sb.png', 'S', { foreground: 'com.apple.springboard' });
    const reasons = await xcodePassEvidenceReasons(report({ b1: ['sb.png'] }), ledger, artifacts({ 'sb.png': 'S' }));
    expect(reasons[0]).toContain('com.apple.springboard');
  });

  it('a capture after a relaunch does not count', async () => {
    const ledger = createCaptureLedger(APP);
    recordLedgerLaunch(ledger, 100);
    capture(ledger, 'late.png', 'L', { pid: 200 });
    const reasons = await xcodePassEvidenceReasons(report({ b1: ['late.png'] }), ledger, artifacts({ 'late.png': 'L' }));
    expect(reasons[0]).toContain('relaunched');
  });

  it('only pass behaviours are judged, and a pass citing nothing is named', async () => {
    const ledger = createCaptureLedger(APP);
    recordLedgerLaunch(ledger, 100);
    const reasons = await xcodePassEvidenceReasons(
      report({ b1: [], b2: ['x.png'] }, { b2: 'not_testable' }),
      ledger,
      artifacts({}),
    );
    expect(reasons).toEqual(['behavior b1: the behaviour cites no screenshot']);
  });
});
