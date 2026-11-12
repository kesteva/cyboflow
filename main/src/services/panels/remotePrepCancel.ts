/**
 * Remote spawns still preparing their environment (the SSH round trips before a manager has a run entry a stop can
 * find). A stop marks the spawn's token and the spawn checks it before starting anything. A fresh token per spawn,
 * so a stale cancel never poisons the next spawn on the same key. Shared by the Claude and Codex SDK managers.
 */
export interface PendingRemotePrep {
  readonly panelId: string;
  readonly runId: string | null;
  cancelled: boolean;
}

export class PendingRemotePreps {
  private readonly preps = new Map<string, PendingRemotePrep>();

  /** Registers (and returns) a fresh token for `spawnKey`. */
  begin(spawnKey: string, panelId: string, runId: string | null = null): PendingRemotePrep {
    const prep: PendingRemotePrep = { panelId, runId, cancelled: false };
    this.preps.set(spawnKey, prep);
    return prep;
  }

  /** Forgets `prep` once its spawn settles, unless a newer spawn on the key already replaced it. */
  end(spawnKey: string, prep: PendingRemotePrep): void {
    if (this.preps.get(spawnKey) === prep) this.preps.delete(spawnKey);
  }

  /** Marks every preparing spawn of `identity` (spawnKey, panelId or runId; null = all) cancelled. */
  cancel(identity: string | null): void {
    for (const [spawnKey, prep] of this.preps) {
      if (identity === null || spawnKey === identity || prep.panelId === identity || prep.runId === identity) {
        prep.cancelled = true;
      }
    }
  }
}
