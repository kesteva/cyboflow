import { spawn } from 'node:child_process';
import type { AgyModelOption, AgyModelCatalog } from '../../../../../shared/types/agentModels';
import { DEFAULT_AGY_MODEL } from '../../../../../shared/types/agentModels';

/**
 * Antigravity's model catalog, discovered from the machine's own `agy models`.
 *
 * `agy models` outputs a tab-separated table of id and label, with an optional
 * progress header line like "Fetching available models...":
 *
 *   gemini-3.8-flash-high\tGemini 3.8 Flash (High)
 *   gemini-3.8-flash-medium\tGemini 3.8 Flash (Medium)
 *   claude-sonnet-4-6\tClaude Sonnet 4.6 (Thinking)
 */
export function parseAgyModelsStdout(stdout: string): AgyModelOption[] {
  const models: AgyModelOption[] = [];
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('Fetching')) continue;
    const parts = trimmed.split('\t');
    if (parts.length < 2) continue;
    const [id, label] = parts;
    if (!id || !label) continue;
    models.push({ id: id.trim(), label: label.trim() });
  }
  return models;
}

export async function fetchAgyModelCatalog(
  binaryPath: string,
  timeoutMs = 15_000,
): Promise<AgyModelCatalog> {
  const { stdout, stderr } = await new Promise<{ stdout: string; stderr: string }>(
    (resolve, reject) => {
      const child = spawn(binaryPath, ['models'], {
        env: { ...process.env },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let out = '';
      let err = '';
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error(`agy models timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      child.stdout.on('data', (chunk: Buffer) => {
        out += chunk.toString('utf8');
      });
      child.stderr.on('data', (chunk: Buffer) => {
        err += chunk.toString('utf8');
      });
      child.on('error', (e: Error) => {
        clearTimeout(timer);
        reject(e);
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (code === 0) resolve({ stdout: out, stderr: err });
        else reject(new Error(`agy models exited ${code}${err ? `: ${err.trim()}` : ''}`));
      });
    },
  );

  const models = parseAgyModelsStdout(stdout);

  if (models.length === 0) {
    const firstErr = stderr.trim().split('\n')[0];
    throw new Error(`agy models returned no models${firstErr ? `: ${firstErr}` : ''}`);
  }

  return {
    models,
    defaultModel: DEFAULT_AGY_MODEL,
  };
}
