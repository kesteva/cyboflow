import type { PersistentAgentVendor } from '../../../../shared/types/persistentAgents';
import { VENDOR_META } from './agentsVocabulary';

/** Initial-in-a-circle avatar; no vendor logos (no brand assets). */
export function VendorAvatar({
  vendor,
  name,
  size = 22,
}: {
  vendor: PersistentAgentVendor;
  name: string;
  size?: 22 | 28;
}): React.JSX.Element {
  const glyph = VENDOR_META[vendor].glyph || (name.trim().charAt(0).toUpperCase() || '?');
  const dims = size === 28 ? 'h-[28px] w-[28px] text-[12px]' : 'h-[22px] w-[22px] text-[10px]';
  return (
    <span
      aria-hidden
      className={`flex shrink-0 items-center justify-center rounded-full border border-border-primary bg-surface-tertiary font-bold text-text-secondary ${dims}`}
    >
      {glyph}
    </span>
  );
}
