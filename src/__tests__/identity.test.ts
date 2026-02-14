import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  detectPersona,
  loadCredentials,
  saveCredentials,
  type NodeCredentials,
} from '../services/identity.js';

const originalPersona = process.env.MERISTEM_IDENTITY_PERSONA;
const originalCredentialsPath = process.env.MERISTEM_CREDENTIALS_PATH;

afterEach((): void => {
  if (originalPersona === undefined) {
    delete process.env.MERISTEM_IDENTITY_PERSONA;
  } else {
    process.env.MERISTEM_IDENTITY_PERSONA = originalPersona;
  }

  if (originalCredentialsPath === undefined) {
    delete process.env.MERISTEM_CREDENTIALS_PATH;
  } else {
    process.env.MERISTEM_CREDENTIALS_PATH = originalCredentialsPath;
  }
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

describe('credentials persistence', () => {
  it('saveCredentials creates parent directory when missing', async () => {
    const sandboxRoot = await mkdtemp(join(tmpdir(), 'meristem-client-identity-'));
    const credentialsPath = join(sandboxRoot, 'nested', '.meristem', 'credentials.json');
    process.env.MERISTEM_CREDENTIALS_PATH = credentialsPath;

    const credentials: NodeCredentials = {
      node_id: 'node-test-001',
      hwid: 'hwid-test-001',
      registered_at: new Date().toISOString(),
      core_ip: '10.25.0.1',
    };

    try {
      await saveCredentials(credentials);
      const content = await readFile(credentialsPath, 'utf-8');
      expect(content.includes('"node_id": "node-test-001"')).toBe(true);

      const loaded = await loadCredentials();
      expect(loaded?.node_id).toBe('node-test-001');
      expect(loaded?.core_ip).toBe('10.25.0.1');
    } finally {
      await rm(sandboxRoot, { recursive: true, force: true });
    }
  });
});
