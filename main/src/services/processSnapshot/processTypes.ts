/**
 * Process-type taxonomy for the process snapshot: what KIND of process a `ps`
 * row is. The by-type grouping and its Kill-all actions key on this.
 */
import type { ProcessSnapshotRow } from '../processTable';
import { isBrokerProcess } from '../codexBrokerReaper';
import type { OwnedCliProcess } from '../panels/cli/AbstractCliManager';
import type { OwnedRunShell } from '../runShellManager';

export type ProcessType =
  | 'claude-cli'
  | 'codex-cli'
  | 'pi-cli'
  | 'omp-cli'
  | 'shell-pty'
  | 'codex-broker'
  | 'unknown';

/** Owned-handle lookups gathered from the managers' read-only accessors. */
export interface OwnedHandles {
  /** From `AbstractCliManager.listOwnedProcesses()` (union across managers). */
  cli: readonly OwnedCliProcess[];
  /** From `RunShellManager.listOwnedShells()`. */
  shells: readonly OwnedRunShell[];
}

const CLI_TYPE_BY_PROVIDER: Record<OwnedCliProcess['provider'], ProcessType> = {
  claude: 'claude-cli',
  codex: 'codex-cli',
  pi: 'pi-cli',
  omp: 'omp-cli',
};

/**
 * Classify one `ps` row. Pure — no I/O. Precedence: a CLI manager handle
 * (tool identity from its provider), then a run shell, then the Codex broker
 * command-line predicate, else `'unknown'`.
 */
export function classifyProcessType(
  row: Pick<ProcessSnapshotRow, 'pid' | 'command'>,
  owned: OwnedHandles,
): ProcessType {
  const cli = owned.cli.find((h) => h.pid === row.pid);
  if (cli) return CLI_TYPE_BY_PROVIDER[cli.provider];
  if (owned.shells.some((h) => h.pid === row.pid)) return 'shell-pty';
  if (isBrokerProcess(row)) return 'codex-broker';
  return 'unknown';
}
