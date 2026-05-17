import * as fs from 'fs';
import * as path from 'path';

/**
 * Normalizes a .gitignore entry for comparison purposes:
 * - Trims trailing whitespace
 * - Strips a leading `/`
 * - Strips a trailing `/`
 */
function normalizeEntry(entry: string): string {
  return entry.trim().replace(/^\//, '').replace(/\/$/, '');
}

/**
 * Ensures the given entry is present in <projectPath>/.gitignore.
 *
 * Rules:
 * - If the file does not exist, it is created with `entry + '\n'`.
 * - If the file already contains the entry (in any normalized form), no write occurs.
 * - If the file exists but does not end with a newline, a newline is prepended to
 *   the new entry before appending so that lines remain separate.
 * - All errors are logged and swallowed — callers must not depend on throw behaviour.
 */
export function ensureGitignoreEntry(projectPath: string, entry: string): void {
  try {
    const gitignorePath = path.join(projectPath, '.gitignore');
    const normalizedEntry = normalizeEntry(entry);

    if (!fs.existsSync(gitignorePath)) {
      fs.writeFileSync(gitignorePath, entry + '\n', 'utf8');
      return;
    }

    const contents = fs.readFileSync(gitignorePath, 'utf8');
    const lines = contents.split('\n');

    // Check whether any existing line already matches (ignoring leading/trailing slashes)
    const alreadyPresent = lines.some(line => normalizeEntry(line) === normalizedEntry);
    if (alreadyPresent) {
      return;
    }

    // Append, ensuring the new entry starts on its own line
    const prefix = contents.endsWith('\n') ? '' : '\n';
    fs.appendFileSync(gitignorePath, prefix + entry + '\n', 'utf8');
  } catch (error) {
    console.error('[gitignoreWriter] Failed to write .gitignore entry:', error);
  }
}
