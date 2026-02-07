import { describe, expect, it } from 'bun:test';
import { createBunWorkerRuntime } from '../gig/bun-worker-runtime.js';

describe('createBunWorkerRuntime', () => {
  it('应返回最小可用的运行时接口', async () => {
    const runtime = createBunWorkerRuntime({
      executeTask: async (task) => ({ received: task.payload }),
    });

    const result = await runtime.execute({
      taskId: 'task-success',
      payload: { value: 1 },
    });

    expect(result.taskId).toBe('task-success');
    expect(result.status).toBe('completed');
    expect(result.result).toEqual({ received: { value: 1 } });
    expect(typeof result.startedAt).toBe('string');
    expect(typeof result.finishedAt).toBe('string');
    expect(await runtime.isHealthy()).toBe(true);
  });

  it('执行异常时应返回 failed 状态', async () => {
    const runtime = createBunWorkerRuntime({
      executeTask: async () => {
        throw new Error('boom');
      },
    });

    const result = await runtime.execute({
      taskId: 'task-failed',
      payload: null,
    });

    expect(result.status).toBe('failed');
    expect(result.error).toContain('boom');
  });

  it('中止进行中的任务时应返回 cancelled 状态', async () => {
    const runtime = createBunWorkerRuntime({
      executeTask: async (_task, signal) => {
        return await new Promise<never>((_resolve, reject) => {
          const onAbort = () => {
            reject(new Error('aborted'));
          };

          if (signal.aborted) {
            onAbort();
            return;
          }

          signal.addEventListener('abort', onAbort, { once: true });
        });
      },
    });

    const execution = runtime.execute({
      taskId: 'task-cancelled',
      payload: null,
    });

    const aborted = await runtime.abort('task-cancelled');
    const result = await execution;

    expect(aborted).toBe(true);
    expect(result.status).toBe('cancelled');
  });
});
