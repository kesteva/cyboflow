/**
 * onboardingGreeting — the onboarding finale's one-shot rail handoff.
 *
 * The load-bearing property is that peek is NON-DESTRUCTIVE: React StrictMode
 * double-invokes state initializers, so a read-and-delete helper would consume
 * the greeting on the discarded first pass and render nothing.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  GREETING_KEY,
  clearAssistantGreeting,
  peekAssistantGreeting,
  primeAssistantGreeting,
} from './onboardingGreeting';

beforeEach(() => {
  localStorage.removeItem(GREETING_KEY);
});

describe('onboardingGreeting', () => {
  it('peeks the primed greeting repeatedly, then clears it', () => {
    primeAssistantGreeting('dogwalkr');

    const first = peekAssistantGreeting();
    expect(first).toBe('dogwalkr is set up. If you need more help, ask me questions at any time.');
    // StrictMode's second initializer pass must see the SAME text.
    expect(peekAssistantGreeting()).toBe(first);

    clearAssistantGreeting();
    expect(peekAssistantGreeting()).toBeNull();
  });

  it('a null project name yields the generic greeting (no-project exits)', () => {
    primeAssistantGreeting(null);
    expect(peekAssistantGreeting()).toBe(
      "You're set up. If you need more help, ask me questions at any time.",
    );
  });

  it('returns null when nothing is primed', () => {
    expect(peekAssistantGreeting()).toBeNull();
  });

  it('returns null for an unparseable or shapeless payload', () => {
    localStorage.setItem(GREETING_KEY, 'not-json');
    expect(peekAssistantGreeting()).toBeNull();

    localStorage.setItem(GREETING_KEY, JSON.stringify({ projectName: 42 }));
    expect(peekAssistantGreeting()).toBeNull();

    localStorage.setItem(GREETING_KEY, JSON.stringify({ projectName: '' }));
    expect(peekAssistantGreeting()).toBeNull();
  });

  it('clear is idempotent', () => {
    expect(() => {
      clearAssistantGreeting();
      clearAssistantGreeting();
    }).not.toThrow();
    expect(peekAssistantGreeting()).toBeNull();
  });
});
