/**
 * Capability-tier rule (pure). `cli` = interactive terminal only; `full` = sessions + workflows.
 * Unreachability is lifecycle, not capability: an unreachable host has a null detected tier.
 */
import type {
  CapabilityTier,
  PreflightCheckResult,
  PreflightRuntimes,
} from '../../../../shared/types/hosts';
import { TierCapAboveDetectedError } from './errors';

export function effectiveTier(
  detected: CapabilityTier | null,
  cap: CapabilityTier | null,
): CapabilityTier | null {
  if (detected === null) return null;
  if (cap === null) return detected;
  if (detected === 'cli' || cap === 'cli') return 'cli';
  return 'full';
}

/**
 * The only legal caps are `cli` or none (null): a cap of `full` is meaningless and throws.
 * `detected` is accepted for call-site symmetry and future tiers.
 */
export function clampUserCap(
  _detected: CapabilityTier | null,
  requested: CapabilityTier | null,
): CapabilityTier | null {
  if (requested === null) return null;
  if (requested === 'cli') return 'cli';
  throw new TierCapAboveDetectedError();
}

export function computeDetectedTier(
  results: readonly PreflightCheckResult[],
  runtimes: PreflightRuntimes,
): CapabilityTier | null {
  if (results.some((r) => r.tierImpact === 'blocks-cli' && r.status !== 'pass')) return null;
  if (results.some((r) => r.tierImpact === 'blocks-full' && (r.status === 'fail' || r.status === 'skipped'))) {
    return 'cli';
  }
  return runtimes.claudeSdk || runtimes.codexSdk ? 'full' : 'cli';
}
