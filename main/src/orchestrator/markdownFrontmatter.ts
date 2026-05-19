/**
 * markdownFrontmatter — single canonical flat-key:value frontmatter parser
 * for SoloFlow workflow files and ad-hoc markdown inputs.
 *
 * Shared by workflowPromptReader.readWorkflowPrompt and
 * WorkflowRegistry.extractPermissionMode. Do NOT inline a copy of this regex
 * anywhere else under main/src/orchestrator/.
 */
export function parseMarkdownFrontmatter(md: string): {
  frontmatter: Record<string, string>;
  body: string;
} {
  const match = md.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!match) {
    return { frontmatter: {}, body: md };
  }
  const fmBlock = match[1];
  const body = md.slice(match[0].length);
  const out: Record<string, string> = {};
  for (const line of fmBlock.split(/\r?\n/)) {
    const m = line.match(/^([a-zA-Z0-9_-]+)\s*:\s*(.*?)\s*$/);
    if (!m) continue;
    let val = m[2];
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    out[m[1]] = val;
  }
  return { frontmatter: out, body };
}
