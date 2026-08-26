import { spawn } from 'node:child_process';
import type { OmpModelOption, PiModelCatalog } from '../../../../../shared/types/agentModels';

/**
 * Pi's model catalog, discovered from the machine's own `pi --list-models`.
 *
 * pi has no catalog call in json mode (models are a startup concern), so —
 * exactly like the OMP probe this mirrors — the fetcher spawns a short-lived
 * child and parses its output. `--list-models` prints a fixed-column table:
 *
 *   provider         model                    context  max-out  thinking  images
 *   antigravity      claude-opus-4-6          250K     64K      yes       yes
 *
 * Rows project to the canonical `${provider}/${id}` selection form the model
 * family predicate rests on. The context/max-out/thinking columns are display
 * metadata Cyboflow's picker does not surface today; they are dropped here
 * rather than carried half-parsed.
 *
 * Side-effect free and UNCACHED: the caller (PROVIDER_CATALOG_FETCHERS) owns
 * caching policy, mirroring how the OMP catalog probe behaves.
 */

/** A `provider`/`model` header row guard — the table always prints one. */
const HEADER_PREFIX = 'provider';

export async function fetchPiModelCatalog(
  binaryPath: string,
  timeoutMs = 15_000,
): Promise<PiModelCatalog> {
  const { stdout, stderr } = await new Promise<{ stdout: string; stderr: string }>(
    (resolve, reject) => {
      const child = spawn(binaryPath, ['--list-models'], {
        env: { ...process.env },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let out = '';
      let err = '';
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error(`pi --list-models timed out after ${timeoutMs}ms`));
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
        else reject(new Error(`pi --list-models exited ${code}${err ? `: ${err.trim()}` : ''}`));
      });
    },
  );

  const models: OmpModelOption[] = [];
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    // Header, blank, or notice lines (auth warnings print above the table).
    if (!trimmed || trimmed.startsWith(HEADER_PREFIX)) continue;
    // Columns separate on runs of spaces; ids never contain double spaces.
    const cells = trimmed.split(/\s{2,}/);
    if (cells.length < 2) continue;
    const [provider, id] = cells;
    if (!provider || !id) continue;
    // Canonical selection form `${provider}/${id}` — the wire id is bare, the
    // persisted value is not (same invariant as the OMP catalog).
    models.push({ id: `${provider}/${id}`, label: id, ompProvider: provider });
  }

  if (models.length === 0) {
    // Auth notices print to stderr above an empty table; quote the first line
    // so "why is my provider missing" is answerable from the picker's error.
    const firstErr = stderr.trim().split('\n')[0];
    throw new Error(`pi --list-models returned no models${firstErr ? `: ${firstErr}` : ''}`);
  }
  return { models };
}
