/**
 * Fallback demo script for unknown / user-created workflows — a short scripted
 * turn so launching any workflow in demo mode still shows a live transcript.
 */

import { DemoScriptContext } from '../demoScriptContext';

export async function genericRunScript(ctx: DemoScriptContext): Promise<void> {
  ctx.say('Starting this workflow in demo mode.');
  await ctx.sleep(1200);
  ctx.tool('Glob', { pattern: 'src/**/*.ts' }, 'src/server.ts\nsrc/habits.ts\nsrc/format.ts');
  await ctx.sleep(1200);
  ctx.say(
    'Demo mode ships scripted runs for the built-in **Planner** and **Sprint** flows — ' +
      'launch one of those to see step progress, human approvals, and code changes end-to-end.',
  );
}
