import { describe, expect, it } from 'bun:test';
import { createGracefulShutdown } from '../index.js';
import type { Logger } from '../utils/logger.js';

const noopLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  fatal: () => undefined,
};

describe('createGracefulShutdown', () => {
  it('stops services and closes connection once', async () => {
    const order: string[] = [];
    const services = [
      { stop: async () => order.push('heartbeat') },
      { stop: async () => order.push('pulse') },
    ];

    let closeCalls = 0;
    const exitCodes: number[] = [];

    const shutdown = createGracefulShutdown({
      logger: noopLogger,
      services,
      closeConnection: async () => {
        closeCalls += 1;
      },
      onExit: (code = 0) => {
        exitCodes.push(code);
      },
    });

    await shutdown();
    await shutdown(123);

    expect(order).toEqual(['heartbeat', 'pulse']);
    expect(closeCalls).toBe(1);
    expect(exitCodes).toEqual([0]);
  });

  it('resolves even when a task rejects', async () => {
    const shutdown = createGracefulShutdown({
      logger: noopLogger,
      services: [
        {
          stop: async () => {
            throw new Error('boom');
          },
        },
      ],
      closeConnection: async () => {
        throw new Error('close fail');
      },
    });

    await expect(shutdown()).resolves.toBeUndefined();
  });
});
