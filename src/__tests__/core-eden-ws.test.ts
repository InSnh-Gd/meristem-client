import { expect, test } from 'bun:test';
import type { WsPushMessage } from '@insnh-gd/meristem-shared';
import { createCoreEdenWsClient } from '../services/core-eden-ws.js';

type FakeSubscribePacket = {
  data: unknown;
  rawData?: unknown;
};

type FakeSubscription = {
  subscribe: (handler: (packet: FakeSubscribePacket) => void) => () => void;
  close: () => void;
};

test('core eden ws client subscribes with token and topic query', async (): Promise<void> => {
  let capturedTopic = '';
  let capturedToken = '';
  let closed = false;

  const client = createCoreEdenWsClient('http://localhost:3000', {
    createTreatyClient: () => ({
      ws: {
        subscribe: async (options) => {
          capturedTopic = options.query.topic;
          capturedToken = options.query.token;
          return {
            subscribe: () => () => {
              // no-op
            },
            close: () => {
              closed = true;
            },
          };
        },
      },
    }),
  });

  const session = await client.subscribeTopic({
    token: 'token-1',
    topic: 'task.1.status',
    onPush: () => {
      // no-op
    },
  });

  expect(capturedTopic).toBe('task.1.status');
  expect(capturedToken).toBe('token-1');
  session.close();
  expect(closed).toBe(true);
});

test('core eden ws client forwards parsed push payload only', async (): Promise<void> => {
  let handler: ((packet: FakeSubscribePacket) => void) | null = null;
  const received: WsPushMessage[] = [];

  const client = createCoreEdenWsClient('http://localhost:3000', {
    createTreatyClient: () => ({
      ws: {
        subscribe: async () =>
          ({
            subscribe: (next) => {
              handler = next;
              return () => {
                handler = null;
              };
            },
            close: () => {
              // no-op
            },
          }) as FakeSubscription,
      },
    }),
  });

  await client.subscribeTopic({
    token: 'token-1',
    topic: 'task.2.status',
    onPush: (message) => {
      received.push(message);
    },
  });

  if (!handler) {
    throw new Error('expected subscription handler');
  }

  handler({
    data: {
      type: 'ACK',
      action: 'CONNECTED',
    },
  });
  handler({
    data: {
      type: 'PUSH',
      topic: 'task.2.status',
      payload: { state: 'done' },
      trace_id: 'trace-2',
    },
  });
  handler({
    data: {
      type: 'PUSH',
      topic: 'task.3.status',
      payload: { state: 'running' },
      trace_id: 'trace-3',
    },
  });

  expect(received).toHaveLength(1);
  expect(received[0]).toMatchObject({
    type: 'PUSH',
    topic: 'task.2.status',
    payload: { state: 'done' },
  });
});
