/**
 * @deprecated Use main/src/utils/cyboflowDirectory.ts instead.
 * This module is a thin re-export shim preserved for backward compatibility.
 */
import {
  getCyboflowDirectory,
  getCyboflowSubdirectory,
  setCyboflowDirectory,
} from './cyboflowDirectory';

/** @deprecated Use getCyboflowDirectory from cyboflowDirectory.ts */
export const getCrystalDirectory = getCyboflowDirectory;
/** @deprecated Use getCyboflowSubdirectory from cyboflowDirectory.ts */
export const getCrystalSubdirectory = getCyboflowSubdirectory;
/** @deprecated Use setCyboflowDirectory from cyboflowDirectory.ts */
export const setCrystalDirectory = setCyboflowDirectory;
