/**
 * Named errors of the Environments (hosts) core. They live in orchestrator/ so HostStore can throw them
 * without a services/* import; the tRPC router recognises them BY NAME (HOSTS_ERROR_NAMES), so every class
 * sets `this.name`. Messages are fixed, user-presentable text: never a label, a target or a secret.
 */
import { HOSTS_ERROR_NAMES } from '../../../../shared/types/hosts';

export class HostNotFoundError extends Error {
  constructor() {
    super('Environment not found.');
    this.name = HOSTS_ERROR_NAMES.notFound;
  }
}

export class HostLabelTakenError extends Error {
  constructor() {
    super('An environment with that name already exists.');
    this.name = HOSTS_ERROR_NAMES.labelTaken;
  }
}

export class InvalidSshTargetError extends Error {
  constructor() {
    super('That SSH destination is not valid.');
    this.name = HOSTS_ERROR_NAMES.invalidTarget;
  }
}

export class TierCapAboveDetectedError extends Error {
  constructor() {
    super('A capability cap can only lower an environment to terminal-only.');
    this.name = HOSTS_ERROR_NAMES.capAboveDetected;
  }
}

export class LocalHostImmutableError extends Error {
  constructor() {
    super('This Mac cannot be changed or removed.');
    this.name = HOSTS_ERROR_NAMES.localImmutable;
  }
}

export class HostHasActiveWorkError extends Error {
  constructor() {
    super('This environment has running sessions or runs.');
    this.name = HOSTS_ERROR_NAMES.hasActiveWork;
  }
}

export class RemoteHostsDisabledError extends Error {
  constructor() {
    super('Remote environments are turned off.');
    this.name = HOSTS_ERROR_NAMES.killed;
  }
}

export class HostTerminalUnavailableError extends Error {
  constructor() {
    super('This environment cannot open a terminal.');
    this.name = HOSTS_ERROR_NAMES.terminalUnavailable;
  }
}

/** Label empty, too long, or containing control characters. */
export class InvalidHostLabelError extends Error {
  constructor() {
    super('That environment name is not valid.');
    this.name = HOSTS_ERROR_NAMES.invalidLabel;
  }
}

/** Any gated operation while the Environments feature is not running (toggle off or release build). */
export class HostsDisabledError extends Error {
  constructor() {
    super('Environments are turned off.');
    this.name = HOSTS_ERROR_NAMES.disabled;
  }
}
