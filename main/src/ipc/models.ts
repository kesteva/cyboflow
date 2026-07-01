import { IpcMain } from 'electron';
import type { AppServices } from './types';
import { ModelAvailabilityService } from '../services/modelAvailabilityService';
import type { ModelAvailabilityMap } from '../../../shared/types/modelAvailability';

/**
 * Model availability IPC — exposes the guarded-model (Fable 5) availability
 * snapshot to the renderer so the pickers can grey out a model that's been pulled
 * from release. The live push (`model-availability-changed`) is broadcast from
 * events.ts when the service's status flips.
 *
 * Returns an empty map when the service isn't initialized (early boot / tests) —
 * every alias then reads as usable, the optimistic default.
 */
export function registerModelHandlers(ipcMain: IpcMain, _services: AppServices): void {
  void _services;
  ipcMain.handle(
    'models:get-availability',
    (): { success: true; data: ModelAvailabilityMap } => ({
      success: true,
      data: ModelAvailabilityService.tryGetInstance()?.snapshot() ?? {},
    }),
  );
}
