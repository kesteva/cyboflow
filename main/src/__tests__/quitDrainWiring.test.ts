/**
 * Source-level guard on how `before-quit` is wired in main/src/index.ts.
 *
 * Electron does not await a `before-quit` listener; `event.preventDefault()` is
 * the only thing that holds a quit open. So an `async` listener that awaits its
 * teardown does not drain on quit at all — it races Electron tearing the Node
 * environment down, which is what produced a fatal abort inside our own browser
 * process (CYBOFLOW-APP-12, `crash_source: app`, aborting in
 * `ThreadSafeFunction::AsyncCb` under `node::FreeEnvironment`) and runs stranded
 * in `running` across restarts (CYBOFLOW-APP-M).
 *
 * The correct shape reads as perfectly natural TypeScript, and the broken one
 * reads as MORE natural — `app.on('before-quit', async () => { await ... })` is
 * what anyone would write. Nothing in the type system objects, and no runtime
 * test of index.ts is practical (it is a large module with boot side effects).
 * Hence a source guard: the listener must stay synchronous, and the teardown
 * must go through runQuitDrain.
 *
 * Behaviour of the drain itself is covered in services/__tests__/quitDrain.test.ts.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import * as path from 'path';

const INDEX = path.join(__dirname, '..', 'index.ts');
const source = readFileSync(INDEX, 'utf8');

/**
 * The body of a top-level construct, by brace matching from the first `{` at or
 * after `declaration`. String and comment contents are not parsed out, which is
 * fine for the coarse presence/absence assertions below.
 */
function bodyOf(declaration: string): string {
  const start = source.indexOf(declaration);
  expect(start, `${declaration} not found in index.ts`).toBeGreaterThan(-1);
  const open = source.indexOf('{', start);
  expect(open).toBeGreaterThan(-1);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') {
      depth--;
      if (depth === 0) return source.slice(open + 1, i);
    }
  }
  throw new Error(`unbalanced braces in ${declaration}`);
}

const beforeQuitListenerBody = (): string => bodyOf("app.on('before-quit'");
const drainBody = (): string => bodyOf('async function drainOnQuit()');

describe('before-quit wiring (index.ts)', () => {
  it('registers exactly one before-quit listener', () => {
    expect(source.split("app.on('before-quit'").length - 1).toBe(1);
  });

  it('does NOT register an async before-quit listener', () => {
    // `async (event) =>` here is the defect: Electron discards the returned
    // promise and quits while the teardown is still running.
    expect(source).not.toMatch(/app\.on\(\s*'before-quit'\s*,\s*async\b/);
  });

  it('holds the quit open with preventDefault before starting the teardown', () => {
    const body = beforeQuitListenerBody();
    const prevented = body.indexOf('event.preventDefault()');
    const drainStarted = body.indexOf('runQuitDrain(');
    expect(prevented).toBeGreaterThan(-1);
    expect(drainStarted).toBeGreaterThan(-1);
    expect(prevented).toBeLessThan(drainStarted);
  });

  it('never awaits inside the listener body — nothing after an await is guaranteed to run', () => {
    expect(beforeQuitListenerBody()).not.toMatch(/\bawait\b/);
  });

  it('routes the teardown through runQuitDrain with drainOnQuit', () => {
    const body = beforeQuitListenerBody();
    expect(body).toMatch(/runQuitDrain\(\{[\s\S]*drain:\s*drainOnQuit/);
  });

  it('declares drainOnQuit as an async function that the listener does not inline', () => {
    expect(source).toMatch(/async function drainOnQuit\(\): Promise<void> \{/);
  });

  it('re-issues the quit from finish rather than hard-exiting, so will-quit still fires', () => {
    // `will-quit` is where the dock badge is cleared; app.exit() would skip it.
    const body = beforeQuitListenerBody();
    expect(body).toMatch(/finish:\s*\(\)\s*=>\s*\{[\s\S]*app\.quit\(\)/);
  });

  it('arms the post-quit exit watchdog with a hard app.exit', () => {
    // finish re-issues app.quit() so the graceful will-quit → quit sequence gets
    // its chance; forceExit is the backstop for the observed post-will-quit hang,
    // and the only sane action at that point is app.exit.
    const body = beforeQuitListenerBody();
    expect(body).toMatch(/runQuitDrain\(\{[\s\S]*forceExit:\s*\(\)\s*=>\s*app\.exit\(0\)/);
  });

  // Every owner of a node-pty handle must be torn down inside the drain. A pty
  // still live when Node disposes its environment is the mechanism behind the
  // CYBOFLOW-APP-12 abort — its onData callback fires through a napi
  // ThreadSafeFunction into an environment that is already going away. Wiring one
  // of these up is easy to forget precisely because nothing fails without it:
  // terminalPanelManager.destroyAllTerminals() sat with ZERO callers, so every
  // open terminal panel survived into teardown, silently, for as long as the
  // feature had existed.
  it.each([
    ['CLI panel processes', 'cliManagerFactory.shutdown()'],
    ['run user-shells', 'runShellManager.destroyAll()'],
    ['terminal tool panels', 'terminalPanelManager.destroyAllTerminals()'],
  ])('tears down %s inside the quit drain', (_label, call) => {
    expect(drainBody()).toContain(call);
  });
});
