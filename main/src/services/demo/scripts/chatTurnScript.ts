/**
 * Demo chat turn — played for quick-session panel chat (and any spawn that has
 * no workflow_runs row). Makes a small REAL change in the session worktree and
 * commits it, so the diff view, merge, and Create-PR demos have substance.
 */

import { DemoScriptContext } from '../demoScriptContext';

const FORMAT_TS_UPGRADED = `import type { Habit } from './habits';

export function formatHabit(habit: Habit): string {
  const done = habit.completions.length;
  const suffix = done > 0 ? ' (' + done + (done === 1 ? ' check-in)' : ' check-ins)') : '';
  return '#' + habit.id + ' ' + habit.name + suffix;
}
`;

export async function chatTurnScript(ctx: DemoScriptContext): Promise<void> {
  const userAsk = ctx.prompt.trim();

  ctx.think('The user wants a change in this worktree. I will look at the formatting helper and improve it.');
  await ctx.sleep(900);

  ctx.say(
    userAsk.length > 0
      ? `Sure — let me take a look at the project and handle that.\n\n> ${userAsk}`
      : 'Let me take a look at the project.',
  );
  await ctx.sleep(1100);

  const current = ctx.readFile('src/format.ts');
  ctx.tool('Read', { file_path: 'src/format.ts' }, current || '(file not found)');
  await ctx.sleep(1200);

  if (!current.includes('check-in')) {
    // First turn: upgrade the formatter to show check-in counts.
    ctx.writeFile('src/format.ts', FORMAT_TS_UPGRADED);
    ctx.tool(
      'Edit',
      {
        file_path: 'src/format.ts',
        old_string: "return '#' + habit.id + ' ' + habit.name;",
        new_string:
          "const done = habit.completions.length;\n  const suffix = done > 0 ? ' (' + done + (done === 1 ? ' check-in)' : ' check-ins)') : '';\n  return '#' + habit.id + ' ' + habit.name + suffix;",
      },
      'Edit applied to src/format.ts',
    );
    await ctx.sleep(800);
    ctx.commit('feat: show check-in counts in formatted output');
    ctx.say(
      'Done. I updated `formatHabit` in `src/format.ts` to show each habit\'s check-in count and committed the change.\n\n' +
        'Check the **Diff** tab to review it — then you can **Merge** it back to main or open a **PR** from the session actions.',
    );
  } else {
    // Subsequent turns: extend the README so every turn still produces a diff.
    const readme = ctx.readFile('README.md');
    ctx.writeFile('README.md', readme + '\n## Display\n\nFormatted output now includes check-in counts.\n');
    ctx.tool(
      'Edit',
      { file_path: 'README.md', old_string: '(end of file)', new_string: '## Display …' },
      'Edit applied to README.md',
    );
    await ctx.sleep(800);
    ctx.commit('docs: document check-in counts in output');
    ctx.say('I added a short section to the README documenting the check-in counts, and committed it.');
  }
}
