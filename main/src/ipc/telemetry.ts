import { IpcMain } from 'electron';
import type { AppServices } from './types';
import { trackUsageFromRenderer, isSentryActive } from '../services/telemetry';

interface TelemetryTrackPayload {
  eventName: string;
  properties?: Record<string, string | number | boolean>;
}

function isTelemetryTrackPayload(value: unknown): value is TelemetryTrackPayload {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  return typeof (value as { eventName?: unknown }).eventName === 'string';
}

export function registerTelemetryHandlers(ipcMain: IpcMain, _services: AppServices): void {
  void _services;
  ipcMain.on('telemetry:track', (_event, payload: unknown) => {
    try {
      if (!isTelemetryTrackPayload(payload)) {
        return;
      }
      trackUsageFromRenderer(payload.eventName, payload.properties);
    } catch {
      // Telemetry must never throw into app code.
    }
  });

  // Synchronous query used by the renderer at boot to decide whether to init its
  // Sentry SDK. The renderer's `sentry-ipc://` transport only works when main's
  // Sentry is active; gating on this avoids console-flooding scheme errors under
  // `pnpm dev` and in packaged builds where reporting is opted out / has no DSN.
  ipcMain.on('telemetry:is-sentry-active', (event) => {
    event.returnValue = isSentryActive();
  });
}
