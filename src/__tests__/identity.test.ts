import { afterEach, describe, expect, it } from 'bun:test';
import { detectPersona } from '../services/identity.js';

const originalPersona = process.env.MERISTEM_IDENTITY_PERSONA;

afterEach((): void => {
  if (originalPersona === undefined) {
    delete process.env.MERISTEM_IDENTITY_PERSONA;
    return;
  }

  process.env.MERISTEM_IDENTITY_PERSONA = originalPersona;
});

describe('detectPersona', () => {
  it('prefers MERISTEM_IDENTITY_PERSONA when set', () => {
    process.env.MERISTEM_IDENTITY_PERSONA = 'GIG';
    expect(detectPersona()).toBe('GIG');
  });

  it('defaults to AGENT when MERISTEM_IDENTITY_PERSONA is missing', () => {
    delete process.env.MERISTEM_IDENTITY_PERSONA;
    expect(detectPersona()).toBe('AGENT');
  });

  it('falls back to AGENT when MERISTEM_IDENTITY_PERSONA is invalid', () => {
    process.env.MERISTEM_IDENTITY_PERSONA = 'WORKER';
    expect(detectPersona()).toBe('AGENT');
  });
});
