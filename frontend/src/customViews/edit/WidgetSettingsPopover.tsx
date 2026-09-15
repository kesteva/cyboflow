/**
 * WidgetSettingsPopover — one widget's inspector (docs/proposals/CUSTOM-VIEWS.md
 * §6, the "Widget settings" artboard). Rendered as a `Modal` (size `sm`) rather
 * than a true anchored popover — it gets the shared escape-stack and portal
 * behaviour for free and every other Custom Views dialog already uses it, so
 * the "popover" in the plan's naming reads as this dialog's ROLE, not a literal
 * implementation constraint.
 *
 * A **section** item (a tier-1 catalog entry with no `spec` — `entry.spec ===
 * undefined`) never runs through `runWidget`, so it gets only a Title field
 * plus the catalog's STATIC Reads/Can-do description; everything else (a
 * tier-2 spec widget or a custom widget) gets Title, Refresh, one control per
 * declared `settings` field, and — when a live `payload` was handed down from
 * `ViewSurface` — the REAL source names and warnings instead of the static
 * fallback. Every change applies to the draft immediately via
 * `updateItemSettings`; the already-mounted `WidgetHost` re-fetches on its own
 * (its poll depends on the settings' serialization), so nothing here has to
 * trigger a refetch itself.
 */
import React, { useEffect, useState } from 'react';
import { Modal, ModalBody, ModalFooter, ModalHeader } from '../../components/ui/Modal';
import { Chip, GhostButton, SecondaryButton } from '../../components/landing/QueuePrimitives';
import { Dropdown, type DropdownItem } from '../../components/ui/Dropdown';
import { Toggle } from '../../components/ui/Toggle';
import { useCustomViewsStore } from '../../stores/customViewsStore';
import { useAgentThreadStore } from '../../stores/agentThreadStore';
import { useLayoutStore } from '../../stores/layoutStore';
import { useLandingProjects } from '../../stores/landingStore';
import type { CatalogEntry } from '../catalog';
import {
  WIDGET_LIMITS,
  type LayoutItem,
  type Scalar,
  type WidgetDataPayload,
  type WidgetSettingField,
  type WidgetSpec,
} from '../../../../shared/types/customViews';

export interface WidgetSettingsPopoverProps {
  isOpen: boolean;
  onClose: () => void;
  item: LayoutItem;
  /** The item's resolved spec, or `null` for a section entry / an unresolvable ref. */
  spec: WidgetSpec | null;
  /** The catalog entry for a `type:'catalog'` ref; `null` for a custom widget. */
  entry: CatalogEntry | null;
  /** The item's latest run payload, for the live Reads row; `null` when none has landed yet. */
  payload: WidgetDataPayload | null;
  /** S6 fills this for a custom widget's "Edit with assistant"; omitted hides that footer button. */
  onEditWithAssistant?: () => void;
}

/** WidgetSettingsPopover — see {@link WidgetSettingsPopoverProps}. */
export function WidgetSettingsPopover({
  isOpen,
  onClose,
  item,
  spec,
  entry,
  payload,
  onEditWithAssistant,
}: WidgetSettingsPopoverProps): React.JSX.Element {
  const isSection = entry !== null && entry.spec === undefined;

  const [title, setTitle] = useState(item.title ?? '');
  useEffect(() => {
    setTitle(item.title ?? '');
  }, [item.instanceId, item.title]);

  const commitTitle = (): void => {
    const trimmed = title.trim();
    useCustomViewsStore.getState().updateItemSettings(item.instanceId, {
      title: trimmed.length === 0 ? null : trimmed,
    });
  };

  const refreshValue = clampRefresh(item.refreshSec ?? spec?.refreshSec ?? WIDGET_LIMITS.defaultRefreshSec);
  const settingValue = (name: string, fallback: Scalar): Scalar =>
    item.settings[name] !== undefined ? item.settings[name] : fallback;

  const readsNames =
    payload !== null
      ? Object.keys(payload.sources)
      : (entry?.reads ?? (spec !== null ? Object.keys(spec.sources) : []));
  const warnings = payload?.warnings ?? [];
  const canDo = spec?.actions?.map((a) => a.label) ?? entry?.actions ?? [];

  const handleAskAssistant = (): void => {
    const layout = useLayoutStore.getState();
    if (layout.agentRailCollapsed) layout.toggleAgentRail();
    const label = item.title ?? entry?.title ?? 'this widget';
    void useAgentThreadStore.getState().sendMessage(
      `Tell me more about the "${label}" widget and what I can change on it.`,
      { contextHint: `widget:${item.instanceId}` },
    );
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} size="sm" showCloseButton={false}>
      <ModalHeader title="Widget settings" onClose={onClose} />
      <ModalBody>
        <div className="flex flex-col gap-3">
          <label className="flex items-center gap-2 text-[11px] text-text-tertiary">
            <span className="w-16 shrink-0">Title</span>
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              onBlur={commitTitle}
              placeholder={entry?.title ?? 'Widget'}
              className="flex-1 border border-border-primary bg-surface-primary px-2 py-1 text-[12px] text-text-primary"
              data-testid="widget-settings-title"
            />
          </label>

          {!isSection && (
            <NumberStepper
              label="Refresh (s)"
              value={refreshValue}
              min={WIDGET_LIMITS.minRefreshSec}
              max={WIDGET_LIMITS.maxRefreshSec}
              step={15}
              onChange={(v) =>
                useCustomViewsStore.getState().updateItemSettings(item.instanceId, { refreshSec: v })
              }
              testId="widget-settings-refresh"
            />
          )}

          {!isSection &&
            (spec?.settings ?? []).map((field) => (
              <SettingField
                key={field.name}
                field={field}
                value={settingValue(field.name, field.default)}
                onChange={(v) =>
                  useCustomViewsStore
                    .getState()
                    .updateItemSettings(item.instanceId, { settings: { [field.name]: v } })
                }
              />
            ))}

          <div className="border-t border-border-primary pt-2">
            <div className="text-[10px] font-bold uppercase tracking-[0.06em] text-text-tertiary">Reads</div>
            <div className="mt-1 flex flex-wrap gap-1" data-testid="widget-settings-reads">
              {readsNames.length === 0 ? (
                <span className="text-[11px] text-text-tertiary">Nothing</span>
              ) : (
                readsNames.map((name) => (
                  <Chip key={name} title={warnings.length > 0 ? warnings.join('\n') : undefined}>
                    {name}
                  </Chip>
                ))
              )}
            </div>
            {warnings.length > 0 && (
              <div className="mt-1 text-[10px] text-status-warning" data-testid="widget-settings-warnings">
                {warnings.join(' · ')}
              </div>
            )}
          </div>

          <div>
            <div className="text-[10px] font-bold uppercase tracking-[0.06em] text-text-tertiary">Can do</div>
            <div className="mt-1 flex flex-wrap gap-1" data-testid="widget-settings-actions">
              {canDo.length === 0 ? (
                <span className="text-[11px] text-text-tertiary">Nothing</span>
              ) : (
                canDo.map((label) => <Chip key={label}>{label}</Chip>)
              )}
            </div>
          </div>
        </div>
      </ModalBody>
      <ModalFooter>
        {item.widget.type === 'custom' ? (
          onEditWithAssistant !== undefined && (
            <SecondaryButton onClick={onEditWithAssistant} data-testid="widget-settings-edit-assistant">
              Edit with assistant
            </SecondaryButton>
          )
        ) : (
          <SecondaryButton onClick={handleAskAssistant} data-testid="widget-settings-ask-assistant">
            Ask the assistant
          </SecondaryButton>
        )}
      </ModalFooter>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Fields
// ---------------------------------------------------------------------------

function clampRefresh(value: number): number {
  return Math.min(WIDGET_LIMITS.maxRefreshSec, Math.max(WIDGET_LIMITS.minRefreshSec, Math.round(value)));
}

interface SettingFieldProps {
  field: WidgetSettingField;
  value: Scalar;
  onChange: (value: Scalar) => void;
}

function SettingField({ field, value, onChange }: SettingFieldProps): React.JSX.Element {
  // Called unconditionally regardless of `field.kind` — hooks cannot live
  // inside the switch below.
  const projects = useLandingProjects();

  switch (field.kind) {
    case 'select':
      return (
        <div className="flex items-center gap-2" data-testid={`widget-settings-field-${field.name}`}>
          <span className="w-16 shrink-0 text-[11px] text-text-tertiary">{field.label}</span>
          <div className="flex gap-1">
            {(field.options ?? []).map((opt) => (
              <Toggle
                key={String(opt.value)}
                size="sm"
                pressed={value === opt.value}
                onPressedChange={() => onChange(opt.value)}
              >
                {opt.label}
              </Toggle>
            ))}
          </div>
        </div>
      );

    case 'number':
      return (
        <NumberStepper
          label={field.label}
          value={typeof value === 'number' ? value : Number(field.default)}
          min={field.min}
          max={field.max}
          step={field.step ?? 1}
          onChange={onChange}
          testId={`widget-settings-field-${field.name}`}
        />
      );

    case 'boolean':
      return (
        <div
          className="flex items-center justify-between gap-2"
          data-testid={`widget-settings-field-${field.name}`}
        >
          <span className="text-[11px] text-text-tertiary">{field.label}</span>
          <Toggle
            size="sm"
            checked={value === true}
            onChange={(next) => onChange(next)}
            aria-label={field.label}
          />
        </div>
      );

    case 'project': {
      const items: DropdownItem[] = [
        { id: 'none', label: 'All projects', onClick: () => onChange(null) },
        ...projects.map((p) => ({ id: String(p.id), label: p.name, onClick: () => onChange(p.id) })),
      ];
      const current =
        value === null || value === undefined ? 'All projects' : (projects.find((p) => p.id === value)?.name ?? 'All projects');
      return (
        <div className="flex items-center gap-2" data-testid={`widget-settings-field-${field.name}`}>
          <span className="w-16 shrink-0 text-[11px] text-text-tertiary">{field.label}</span>
          <Dropdown
            trigger={
              <SecondaryButton onClick={() => {}} data-testid={`widget-settings-field-${field.name}-trigger`}>
                {current}
              </SecondaryButton>
            }
            items={items}
            width="sm"
          />
        </div>
      );
    }

    case 'text':
    default:
      return (
        <label
          className="flex items-center gap-2 text-[11px] text-text-tertiary"
          data-testid={`widget-settings-field-${field.name}`}
        >
          <span className="w-16 shrink-0">{field.label}</span>
          <input
            value={typeof value === 'string' ? value : ''}
            onChange={(e) => onChange(e.target.value)}
            className="flex-1 border border-border-primary bg-surface-primary px-2 py-1 text-[12px] text-text-primary"
          />
        </label>
      );
  }
}

interface NumberStepperProps {
  label: string;
  value: number;
  min?: number;
  max?: number;
  step: number;
  onChange: (value: number) => void;
  testId?: string;
}

function NumberStepper({ label, value, min, max, step, onChange, testId }: NumberStepperProps): React.JSX.Element {
  const clamp = (n: number): number => Math.min(max ?? Number.POSITIVE_INFINITY, Math.max(min ?? Number.NEGATIVE_INFINITY, n));
  return (
    <div className="flex items-center gap-2" data-testid={testId}>
      <span className="w-16 shrink-0 text-[11px] text-text-tertiary">{label}</span>
      <div className="flex items-center gap-1">
        <GhostButton onClick={() => onChange(clamp(value - step))} data-testid={testId !== undefined ? `${testId}-dec` : undefined}>
          −
        </GhostButton>
        <span className="w-10 text-center text-[12px] tabular-nums">{value}</span>
        <GhostButton onClick={() => onChange(clamp(value + step))} data-testid={testId !== undefined ? `${testId}-inc` : undefined}>
          +
        </GhostButton>
      </div>
    </div>
  );
}
