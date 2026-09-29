/**
 * Contract pins for the shipped `visual-verify` agent prompt.
 *
 * The prompt is one half of a two-sided contract: the harness ENFORCES (the
 * runner probes identity itself and reaps the serve at teardown) and the prompt
 * EXPLAINS (start the serve through the driver, then leave it alone). Enforcement
 * without explanation produces the worst failure available here — an agent that
 * tidily kills its own dev server, and a perfectly honest pass that fails
 * because there was nothing left to attest. So the instructions that keep the
 * surface alive are pinned as tightly as the code that depends on them.
 *
 * The byte-parity assertion exists because sprint and ship ship SEPARATE copies
 * (ship is self-contained by design), and a fix applied to one is invisible in
 * the other until a run mysteriously behaves differently depending on which flow
 * launched it.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const WORKFLOWS = join(__dirname, '..', '..', 'workflows');
const SPRINT_PROMPT = join(WORKFLOWS, 'sprint', 'agents', 'visual-verify.md');
const SHIP_PROMPT = join(WORKFLOWS, 'ship', 'agents', 'visual-verify.md');

const sprint = readFileSync(SPRINT_PROMPT, 'utf8');

describe('visual-verify prompt', () => {
  it('is byte-identical across sprint and ship', () => {
    expect(readFileSync(SHIP_PROMPT, 'utf8')).toBe(sprint);
  });

  it('routes the serve through the driver rather than a hand-rolled background job', () => {
    expect(sprint).toContain('$VERIFY_DRIVER serve');
    expect(sprint).toContain('never with your own `&` or `nohup`');
  });

  it('tells the agent to leave the surface running, and why', () => {
    expect(sprint).toContain('Leave everything running when you finish');
    expect(sprint).toContain('Do not kill the serve');
    expect(sprint).toContain('A surface you shut down cannot be attested');
  });

  it('frames attest as a SELF-CHECK and names the harness as the authority', () => {
    expect(sprint).toContain('SELF-CHECKS');
    expect(sprint).toContain('the HARNESS runs that channel itself');
    expect(sprint).toContain('write anywhere — including under `$VERIFY_ARTIFACTS_DIR` — counts as proof');
    // The forgeable promise from phase 2 must not come back in any form.
    expect(sprint).not.toContain("re-derives the real\nattestation verdict from the driver's own state");
  });

  it('keeps `confidence` numeric and leaves the identity floor to the harness', () => {
    // `confidence` is a finite number in the report schema; telling the agent to
    // set it to a STATUS string makes normalization reject a valid report.
    expect(sprint).not.toMatch(/`confidence`[^.]*\b(?:at|to)\s+`(?:low_confidence|passed|failed|unverifiable)`/);
    expect(sprint).toMatch(/`confidence`\s+\(a number from 0 to 1\)/);
    expect(sprint).toMatch(/the harness\s+applies the final identity floor/);
    // …including the two explore-only floors the agent must not pre-empt.
    expect(sprint).toMatch(/composed serve ran\s+verbatim and bound to its port/);
    expect(sprint).toMatch(/implicit\s+`bundle-identity`/);
  });

  it('still tells the agent where a launch_failed excerpt comes from', () => {
    // The serve moved into the driver, so its output moved too — an agent that
    // cannot find the log reports `launch_failed` with nothing in it.
    expect(sprint).toContain('.driver/serve.log');
  });
});
