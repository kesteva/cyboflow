/**
 * Named errors thrown by CloudAccountService. The cyboflow.cloud router matches them by `name`
 * (it may not import services/*), so each name is the shared CLOUD_ERROR_NAMES value.
 * Messages are fixed text: no server body, token or URL ever lands in one.
 */
import { CLOUD_ERROR_NAMES } from '../../../../shared/types/cloudAccountWire';

export class CloudNotAvailableError extends Error {
  constructor() {
    super('cyboflow cloud is not available: turn on Agents & Environments');
    this.name = CLOUD_ERROR_NAMES.notAvailable;
  }
}

export class CloudAlreadySignedInError extends Error {
  constructor() {
    super('This computer is already signed in to cyboflow cloud');
    this.name = CLOUD_ERROR_NAMES.alreadySignedIn;
  }
}

export class CloudSignInInProgressError extends Error {
  constructor() {
    super('A cyboflow cloud sign-in is already in progress');
    this.name = CLOUD_ERROR_NAMES.signInInProgress;
  }
}

export class CloudNotSignedInError extends Error {
  constructor() {
    super('This computer is not signed in to cyboflow cloud');
    this.name = CLOUD_ERROR_NAMES.notSignedIn;
  }
}

export type CloudSignInStartCode = 'browser_open_failed' | 'loopback_failed' | 'secrets_unavailable';

export class CloudSignInStartError extends Error {
  readonly code: CloudSignInStartCode;
  constructor(code: CloudSignInStartCode) {
    super(`cyboflow cloud sign-in could not start (${code})`);
    this.name = CLOUD_ERROR_NAMES.signInStart;
    this.code = code;
  }
}
