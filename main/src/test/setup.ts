// Test setup file for Vitest
import { vi } from 'vitest';

// Mock Electron modules
vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => '/mock/path'),
    getName: vi.fn(() => 'Cyboflow'),
    getVersion: vi.fn(() => '0.1.0'),
  },
  ipcMain: {
    handle: vi.fn(),
    on: vi.fn(),
    removeHandler: vi.fn(),
  },
  BrowserWindow: vi.fn(),
}));

// Mock the telemetry SDKs — their native/electron-coupled entry points do not
// load in the host-Node test environment. Any module that transitively imports
// main/src/services/telemetry (e.g. the IPC layer via trackUsage) would otherwise
// fail to collect. Telemetry is a no-op in tests regardless (never initialized).
vi.mock('@sentry/electron/main', () => ({
  init: vi.fn(),
  captureException: vi.fn(),
}));
vi.mock('@aptabase/electron/main', () => ({
  initialize: vi.fn(),
  trackEvent: vi.fn(),
}));

// Set up global test environment
global.console = {
  ...console,
  // Suppress logs during tests unless debugging
  log: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};