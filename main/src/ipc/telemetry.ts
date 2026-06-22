import { IpcMain } from 'electron';
import type { AppServices } from './types';
import { trackUsage } from '../services/telemetry';

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
      trackUsage(payload.eventName, payload.properties);
    } catch {
      // Telemetry must never throw into app code.
    }
  });
}
