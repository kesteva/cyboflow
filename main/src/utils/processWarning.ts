/**
 * Format a node `process` 'warning' event for the app log (see the listener in
 * main/src/index.ts, which routes these to WARN).
 *
 * Deprecation warnings carry their top stack frames. Without them a warning
 * raised from a dependency names no caller: DEP0180 ("fs.Stats constructor is
 * deprecated") recurred across smoke runs from August to October with the
 * caller unidentifiable, because node's own `message` says only WHAT is
 * deprecated, never WHO called it. Other warning kinds stay one line.
 */
export const DEPRECATION_STACK_FRAMES = 6;

export function formatProcessWarning(
  warning: Error & { code?: string; detail?: string },
  pid: number,
): string {
  const code = warning.code ? ` [${warning.code}]` : '';
  const detail = warning.detail ? `\n${warning.detail}` : '';
  let frames = '';
  if (warning.name === 'DeprecationWarning' && typeof warning.stack === 'string') {
    const atLines = warning.stack
      .split('\n')
      .filter((line) => line.trimStart().startsWith('at '))
      .slice(0, DEPRECATION_STACK_FRAMES);
    if (atLines.length > 0) frames = `\n${atLines.join('\n')}`;
  }
  return `(node:${pid})${code} ${warning.name}: ${warning.message}${detail}${frames}`;
}
