import { afterEach, expect, test } from 'bun:test';
import { createCoreHttpClient } from '../services/core-http.js';

const originalFetch = globalThis.fetch;

afterEach((): void => {
  globalThis.fetch = originalFetch;
});

test('core http client sends join request with wire contract header', async (): Promise<void> => {
  let called = false;
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    called = true;
    expect(init?.headers).toMatchObject({
      'Content-Type': 'application/json',
      'X-Wire-Contract-Version': '2026-02-09',
    });
    return new Response(
      JSON.stringify({
        success: true,
        data: {
          node_id: 'node-1',
          core_ip: '10.25.0.1',
          status: 'new',
        },
      }),
      { status: 200 },
    );
  }) as typeof fetch;

  const client = createCoreHttpClient('http://localhost:3000');
  const response = await client.join({
    hwid: 'abc',
    hostname: 'host-a',
    persona: 'AGENT',
  });

  expect(called).toBe(true);
  expect(response.success).toBe(true);
});

test('core http client maps failed http status to error response', async (): Promise<void> => {
  globalThis.fetch = (async () =>
    new Response('bad request', {
      status: 400,
    })) as typeof fetch;

  const client = createCoreHttpClient('http://localhost:3000');
  const response = await client.join({
    hwid: 'abc',
    hostname: 'host-a',
    persona: 'AGENT',
  });

  expect(response.success).toBe(false);
  if (!response.success) {
    expect(response.error).toContain('HTTP 400');
  }
});

