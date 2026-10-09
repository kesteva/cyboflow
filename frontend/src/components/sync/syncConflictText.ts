import type { RemoteSyncConflict, RemoteSyncConflictSide } from '../../../../shared/types/remoteSync';

/** Fields whose values are long text and read best as a line diff. */
const LONG_TEXT_FIELDS = new Set(['body', 'summary']);

export function isLongText(conflict: RemoteSyncConflict): boolean {
  if (conflict.kind !== 'field') return false;
  if (conflict.field !== null && LONG_TEXT_FIELDS.has(conflict.field)) return true;
  const values = [conflict.current.value, conflict.other.value];
  return values.some((v) => typeof v === 'string' && (v.length > 80 || v.includes('\n')));
}

export function kindLabel(conflict: RemoteSyncConflict): string {
  switch (conflict.kind) {
    case 'field':
      return conflict.field ?? 'Field';
    case 'delete_vs_edit':
      return 'Deleted while edited here';
    case 'orphaned':
      return 'Children detached from a deleted parent';
    case 'dependency_edge':
      return 'Dependency removed to break a cycle';
    default:
      return 'Sync conflict';
  }
}

export function capitalize(s: string): string {
  return s.length === 0 ? s : s[0].toUpperCase() + s.slice(1);
}

export function deviceName(side: RemoteSyncConflictSide): string {
  return side.thisDevice ? 'This computer' : 'Another computer';
}

export function formatTime(at: number | null): string {
  if (at === null) return 'unknown time';
  const d = new Date(at);
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return d.toDateString() === new Date().toDateString()
    ? time
    : `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })}, ${time}`;
}

export function sideLabel(side: RemoteSyncConflictSide): string {
  return `${deviceName(side)} · ${formatTime(side.at)}`;
}

export function formatValue(value: unknown): string {
  if (value === null || value === undefined || value === '') return '(empty)';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value, null, 2);
}

export function resolutionLabel(conflict: RemoteSyncConflict): string {
  const r = conflict.pendingResolution ?? conflict.resolution;
  if (r === null) return 'Resolved';
  return conflict.pendingResolution !== null ? `${r} (waiting to send)` : r;
}

/** Banner copy: "<Field> changed on two machines — the <device> edit was applied." */
export function bannerText(conflict: RemoteSyncConflict): string {
  if (conflict.kind === 'field') {
    return `${capitalize(conflict.field ?? 'A field')} changed on two machines — the edit from ${deviceName(conflict.current).toLowerCase()} was applied.`;
  }
  return `${kindLabel(conflict)}.`;
}
