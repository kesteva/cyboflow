/**
 * xcodePassEvidence — the §B5 pass-evidence rule for a `mobile` request the
 * Xcode DeviceInteraction rung drove (docs/proposals/runbook-optional-verification.md §B5).
 *
 * A `pass` behaviour counts only when it cites at least one screenshot that
 * is a HARNESS capture in the runner-held ledger — matched by the sha256 of the
 * file the report cites, re-read from the artifacts dir NOW, so an agent that
 * overwrote a capture after the fact cites bytes the ledger never saw — whose
 * foreground app is `VERIFY_APP_BUNDLE_ID` and which was taken with no relaunch
 * since the pinned `mobile-launch` (xcodeDriveSocketServer.evaluateLedgerEvidence).
 *
 * The answer is a list of reasons, one per `pass` behaviour whose evidence does
 * not stand; the runner folds a non-empty list into the verdict exactly the way
 * an undeclared attestation channel is folded (`capPassedAtLowConfidence`): a
 * `passed` becomes an advisory `low_confidence` with the reasons stated. It
 * never FAILS a request — the ledger proves what the harness saw, and a
 * missing citation is an unproven claim, not a disproven one.
 */
import { createHash } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import * as path from 'node:path';
import type { VerificationReportV1 } from '../../../../../shared/types/visualVerification';
import { evaluateLedgerEvidence, type CaptureLedger } from './xcodeDriveSocketServer';

/** The message lead the runner puts in front of the reasons. */
export const XCODE_LEDGER_CAP_MESSAGE =
  'capped at low_confidence: a passing behavior does not cite a harness capture of the app under test (xcode capture ledger)';

async function defaultHashFile(absPath: string): Promise<string> {
  return createHash('sha256').update(await fsp.readFile(absPath)).digest('hex');
}

/**
 * Reasons the report's `pass` behaviours do not stand on the ledger; empty ⇒
 * every one does. Cited names are the report's bare basenames (the runner has
 * already refused a report whose screenshots do not exist); an unreadable one
 * simply contributes no hash.
 */
export async function xcodePassEvidenceReasons(
  report: VerificationReportV1,
  ledger: CaptureLedger,
  artifactsDir: string,
  hashFile: (absPath: string) => Promise<string> = defaultHashFile,
): Promise<string[]> {
  const reasons: string[] = [];
  const hashes = new Map<string, string | null>();
  const hashOf = async (name: string): Promise<string | null> => {
    if (hashes.has(name)) return hashes.get(name) ?? null;
    let sha: string | null = null;
    try {
      sha = await hashFile(path.join(artifactsDir, path.basename(name)));
    } catch {
      sha = null;
    }
    hashes.set(name, sha);
    return sha;
  };
  for (const behavior of report.behaviors) {
    if (behavior.result !== 'pass') continue;
    const shas: string[] = [];
    for (const name of behavior.evidence.screenshots) {
      const sha = await hashOf(name);
      if (sha !== null) shas.push(sha);
    }
    const verdict =
      behavior.evidence.screenshots.length > 0 && shas.length === 0
        ? ({ counts: false, reason: 'none of its cited screenshots could be read back' } as const)
        : evaluateLedgerEvidence(ledger, shas);
    if (!verdict.counts) reasons.push(`behavior ${behavior.id}: ${verdict.reason}`);
  }
  return reasons;
}
