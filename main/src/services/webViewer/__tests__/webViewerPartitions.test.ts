/**
 * webViewerPartitions — the two cookie jars.
 *
 * The partition NAMES are the security boundary here, so they are pinned: a
 * human tab and an agent tab must never resolve to the same jar, two cyboflow
 * sessions' agent tabs must never share one, and an agent jar must never
 * accidentally become durable by carrying a `persist:` prefix.
 */
import { describe, it, expect } from 'vitest';
import {
  agentPartition,
  HUMAN_EPHEMERAL_PARTITION,
  HUMAN_PARTITION,
  partitionFor,
} from '../webViewerPartitions';

describe('partitionFor', () => {
  it('puts human tabs in the persistent jar and agent tabs in a per-session one', () => {
    expect(partitionFor('user', 'sess-1', true)).toBe(HUMAN_PARTITION);
    expect(partitionFor('agent', 'sess-1', true)).toBe(agentPartition('sess-1'));
  });

  it('never lets a human and an agent tab share a jar', () => {
    // This is the whole point: the exfiltration chain starts with an agent
    // reading an authenticated page the HUMAN signed into.
    for (const persist of [true, false]) {
      expect(partitionFor('user', 'sess-1', persist)).not.toBe(
        partitionFor('agent', 'sess-1', persist),
      );
    }
  });

  it('gives each cyboflow session its OWN agent jar', () => {
    // One shared agent jar would let a credential a user happened to enter in
    // one session's agent tab reach another session's runs, before the
    // human_touched tripwire had anything to say about it.
    expect(partitionFor('agent', 'sess-1', true)).not.toBe(partitionFor('agent', 'sess-2', true));
  });

  it('honours persistLogin for human tabs with a DISTINCT name, not a stripped prefix', () => {
    const ephemeral = partitionFor('user', 'sess-1', false);
    expect(ephemeral).toBe(HUMAN_EPHEMERAL_PARTITION);
    // Sharing a name minus the prefix would let flipping the setting half-adopt
    // the existing on-disk jar.
    expect(ephemeral).not.toBe(HUMAN_PARTITION.replace('persist:', ''));
  });
});

describe('agentPartition', () => {
  it('is ephemeral — no persist: prefix, whatever the session id contains', () => {
    expect(agentPartition('sess-1').startsWith('persist:')).toBe(false);
    expect(agentPartition('persist:evil').startsWith('persist:')).toBe(false);
    expect(agentPartition('persist:evil')).toBe('cyboflow-web-agent-persistevil');
  });

  it('sanitizes a hostile session id down to a safe partition name', () => {
    expect(agentPartition('../../etc/passwd')).toBe('cyboflow-web-agent-etcpasswd');
  });
});
