import { afterEach, expect, test } from 'bun:test';
import { loadConfig } from '../config/index.js';

const originalCoreAddress = process.env.MERISTEM_CORE_ADDRESS;
const originalCoreUrl = process.env.MERISTEM_CORE_URL;
const originalMaxRetries = process.env.MERISTEM_GIG_MAX_RETRIES;
const originalRetryBackoff = process.env.MERISTEM_GIG_RETRY_BACKOFF_MS;
const originalPersona = process.env.MERISTEM_IDENTITY_PERSONA;

const restoreEnv = (): void => {
  if (originalCoreAddress === undefined) {
    delete process.env.MERISTEM_CORE_ADDRESS;
  } else {
    process.env.MERISTEM_CORE_ADDRESS = originalCoreAddress;
  }

  if (originalCoreUrl === undefined) {
    delete process.env.MERISTEM_CORE_URL;
  } else {
    process.env.MERISTEM_CORE_URL = originalCoreUrl;
  }

  if (originalMaxRetries === undefined) {
    delete process.env.MERISTEM_GIG_MAX_RETRIES;
  } else {
    process.env.MERISTEM_GIG_MAX_RETRIES = originalMaxRetries;
  }

  if (originalRetryBackoff === undefined) {
    delete process.env.MERISTEM_GIG_RETRY_BACKOFF_MS;
  } else {
    process.env.MERISTEM_GIG_RETRY_BACKOFF_MS = originalRetryBackoff;
  }

  if (originalPersona === undefined) {
    delete process.env.MERISTEM_IDENTITY_PERSONA;
  } else {
    process.env.MERISTEM_IDENTITY_PERSONA = originalPersona;
  }
};

afterEach((): void => {
  restoreEnv();
});

test('loadConfig parses gig retry policy from environment', (): void => {
  process.env.MERISTEM_CORE_URL = 'http://localhost:3000';
  process.env.MERISTEM_GIG_MAX_RETRIES = '4';
  process.env.MERISTEM_GIG_RETRY_BACKOFF_MS = '100,400,900';

  const config = loadConfig();

  expect(config.gig.max_retries).toBe(4);
  expect(config.gig.retry_backoff_ms).toEqual([100, 400, 900]);
  expect(config.core.address).toBe('http://localhost:3000');
});

test('loadConfig uses default gig retry policy when environment is missing', (): void => {
  process.env.MERISTEM_CORE_ADDRESS = 'http://localhost:3000';
  delete process.env.MERISTEM_GIG_MAX_RETRIES;
  delete process.env.MERISTEM_GIG_RETRY_BACKOFF_MS;

  const config = loadConfig();

  expect(config.gig.max_retries).toBe(3);
  expect(config.gig.retry_backoff_ms).toEqual([1000, 5000, 15000]);
});

test('loadConfig falls back to AGENT when persona env is invalid', (): void => {
  process.env.MERISTEM_CORE_ADDRESS = 'http://localhost:3000';
  process.env.MERISTEM_IDENTITY_PERSONA = 'WORKER';

  const config = loadConfig();

  expect(config.identity.persona).toBe('AGENT');
});
