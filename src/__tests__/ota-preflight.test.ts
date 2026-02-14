import { describe, expect, test } from 'bun:test';
import {
  checkNatsConnectivity,
  waitForNatsWithRetry,
  waitForNatsWithRetryDetailed,
} from '../services/ota-preflight';

describe('ota-preflight', () => {
  test('checkNatsConnectivity returns false when endpoint is unreachable', async () => {
    const connected = await checkNatsConnectivity('nats://127.0.0.1:1');
    expect(connected).toBe(false);
  });

  test('waitForNatsWithRetry returns false after retries are exhausted', async () => {
    const connected = await waitForNatsWithRetry('nats://127.0.0.1:1', 2, 5);
    expect(connected).toBe(false);
  });

  test('waitForNatsWithRetryDetailed returns failure reason and attempt count', async () => {
    const result = await waitForNatsWithRetryDetailed('nats://127.0.0.1:1', 2, 1);
    expect(result.connected).toBe(false);
    expect(result.attempts).toBe(3);
    expect(typeof result.lastError).toBe('string');
    expect(result.lastError?.length ?? 0).toBeGreaterThan(0);
  });
});
