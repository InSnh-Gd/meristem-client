import { describe, expect, test } from 'bun:test';
import { checkNatsConnectivity, waitForNatsWithRetry } from '../services/ota-preflight';

describe('ota-preflight', () => {
  test('checkNatsConnectivity returns false when endpoint is unreachable', async () => {
    const connected = await checkNatsConnectivity('nats://127.0.0.1:1');
    expect(connected).toBe(false);
  });

  test('waitForNatsWithRetry returns false after retries are exhausted', async () => {
    const connected = await waitForNatsWithRetry('nats://127.0.0.1:1', 2, 5);
    expect(connected).toBe(false);
  });
});
