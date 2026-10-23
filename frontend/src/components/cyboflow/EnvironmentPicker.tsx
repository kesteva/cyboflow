/**
 * EnvironmentPicker — where a new session / workflow run executes ("This Mac" or an SSH environment).
 *
 * Rendered as a SIBLING above SubstrateSelector on the launch surfaces. Hidden unless environments are running
 * and at least one non-archived SSH machine exists, so a user without remote environments sees no change.
 * Disabled rows carry their reason (hostLaunchability); main re-validates every launch regardless.
 *
 * `useEnvironmentSelection` owns the choice so the launch callbacks and the picker agree: it resolves the
 * effective host (user pick → project default → This Mac, falling back to This Mac whenever the pick is gone or
 * not launchable) and exposes `remoteHostId` — null for This Mac, so local payloads omit `hostId` entirely.
 */
import { useCallback, useMemo, useState } from 'react';
import { useHostsStore } from '../../stores/hostsStore';
import { trpc } from '../../trpc/client';
import { errorText } from '../../utils/errorText';
import { cn } from '../../utils/cn';
import { runtimesLine } from '../agentsEnv/EnvironmentCard';
import {
  hostLaunchability,
  isRemoteLaunchRuntime,
  type HostLaunchKind,
} from '../agentsEnv/hostLaunchability';
import type { HostView } from '../../../../shared/types/hosts';

export const LOCAL_ENVIRONMENT = 'local';

export interface EnvironmentSelection {
  /** Picker is rendered at all (environments running + at least one non-archived SSH host). */
  visible: boolean;
  hosts: HostView[];
  /** 'local' or a host id; always a launchable choice. */
  selected: string;
  /** The remote host id to launch on, or null for This Mac (omit hostId from the request). */
  remoteHostId: string | null;
  /** The saved project default (null = This Mac). */
  savedDefault: string | null;
  setSelected: (id: string) => void;
  setSavedDefault: (id: string | null) => void;
}

/**
 * @param runtime the launch's current runtime; only an SDK runtime narrows launchability (a non-SDK runtime is
 *   coerced to an SDK one when a remote host is picked, so it must not disable the rows itself).
 */
export function useEnvironmentSelection(args: {
  projectId: number | null;
  projectDefaultHostId: string | null | undefined;
  runtime?: string;
  kind: HostLaunchKind;
}): EnvironmentSelection {
  const featureStatus = useHostsStore((s) => s.featureStatus);
  const allHosts = useHostsStore((s) => s.hosts);
  const [picked, setPicked] = useState<string | null>(null);
  const [savedOverride, setSavedOverride] = useState<{ projectId: number | null; value: string | null } | null>(null);

  const hosts = useMemo(() => allHosts.filter((h) => h.archivedAt === null), [allHosts]);
  const visible = featureStatus?.running === true && hosts.some((h) => h.kind === 'ssh');
  const savedDefault =
    savedOverride !== null && savedOverride.projectId === args.projectId
      ? savedOverride.value
      : (args.projectDefaultHostId ?? null);
  const checkRuntime = args.runtime !== undefined && isRemoteLaunchRuntime(args.runtime) ? args.runtime : undefined;

  const launchable = useCallback(
    (id: string): boolean => {
      if (id === LOCAL_ENVIRONMENT) return true;
      const host = hosts.find((h) => h.id === id);
      return host !== undefined && hostLaunchability(host, { kind: args.kind, runtime: checkRuntime, featureStatus }).ok;
    },
    [hosts, args.kind, checkRuntime, featureStatus],
  );

  let selected: string = LOCAL_ENVIRONMENT;
  if (visible) {
    if (picked !== null && launchable(picked)) selected = picked;
    else if (picked === null && savedDefault !== null && launchable(savedDefault)) selected = savedDefault;
  }
  const remoteHostId = selected === LOCAL_ENVIRONMENT ? null : selected;

  return {
    visible,
    hosts,
    selected,
    remoteHostId,
    savedDefault,
    setSelected: setPicked,
    setSavedDefault: (value) => setSavedOverride({ projectId: args.projectId, value }),
  };
}

export interface EnvironmentPickerProps {
  selection: EnvironmentSelection;
  projectId: number | null;
  kind: HostLaunchKind;
  runtime?: string;
  id?: string;
}

export function EnvironmentPicker({
  selection,
  projectId,
  kind,
  runtime,
  id = 'environment-picker',
}: EnvironmentPickerProps): React.JSX.Element | null {
  const featureStatus = useHostsStore((s) => s.featureStatus);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  if (!selection.visible) return null;

  const checkRuntime = runtime !== undefined && isRemoteLaunchRuntime(runtime) ? runtime : undefined;
  const localHost = selection.hosts.find((h) => h.kind === 'local');
  const sshHosts = selection.hosts.filter((h) => h.kind === 'ssh');
  const rows: Array<{ key: string; label: string; host: HostView | null }> = [
    { key: LOCAL_ENVIRONMENT, label: localHost?.label ?? 'This Mac', host: null },
    ...sshHosts.map((h) => ({ key: h.id, label: h.label, host: h })),
  ];
  const isDefault = (selection.savedDefault ?? LOCAL_ENVIRONMENT) === selection.selected;

  const handleDefault = async (checked: boolean): Promise<void> => {
    if (projectId === null || saving) return;
    // Checking pins the current pick (This Mac = no default); unchecking resets the default to This Mac.
    const next = checked ? selection.remoteHostId : null;
    setSaving(true);
    setSaveError(null);
    try {
      const res = await trpc.cyboflow.hosts.setProjectDefault.mutate({ projectId, hostId: next });
      if (res.ok) selection.setSavedDefault(next);
      else setSaveError(res.message);
    } catch (err: unknown) {
      setSaveError(errorText(err) ?? 'Could not save the default environment');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div data-testid={id} className="flex flex-col gap-1.5">
      <span id={`${id}-label`} className="text-xs font-medium text-text-secondary">Environment</span>
      <div role="radiogroup" aria-labelledby={`${id}-label`} className="flex flex-col gap-1">
        {rows.map(({ key, label, host }) => {
          const verdict = host === null ? { ok: true as const } : hostLaunchability(host, { kind, runtime: checkRuntime, featureStatus });
          const checked = selection.selected === key;
          const subtitle = host?.preflight ? runtimesLine(host.preflight.runtimes) : null;
          return (
            <button
              key={key}
              type="button"
              role="radio"
              aria-checked={checked}
              disabled={!verdict.ok}
              title={verdict.ok ? undefined : verdict.reason}
              data-testid={`${id}-option-${key}`}
              onClick={() => selection.setSelected(key)}
              className={cn(
                'flex flex-col items-start rounded-input border px-2 py-1 text-left text-sm',
                checked ? 'border-interactive bg-bg-secondary text-text-primary' : 'border-border-primary bg-bg-primary text-text-secondary',
                !verdict.ok && 'cursor-not-allowed opacity-60',
              )}
            >
              <span>{label}</span>
              {subtitle !== null && <span className="text-xs text-text-tertiary">{subtitle}</span>}
              {!verdict.ok && (
                <span data-testid={`${id}-reason-${key}`} className="text-xs text-text-tertiary">{verdict.reason}</span>
              )}
            </button>
          );
        })}
      </div>
      {projectId !== null && (
        <label className="flex items-center gap-1.5 text-xs text-text-secondary">
          <input
            type="checkbox"
            data-testid={`${id}-make-default`}
            checked={isDefault}
            disabled={saving || (isDefault && selection.selected === LOCAL_ENVIRONMENT)}
            onChange={(e) => void handleDefault(e.target.checked)}
          />
          Make default for this project
        </label>
      )}
      {saveError !== null && (
        <span data-testid={`${id}-error`} role="alert" className="text-xs text-status-error">{saveError}</span>
      )}
    </div>
  );
}
