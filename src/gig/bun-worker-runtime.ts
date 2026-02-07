import type { GigResult, GigRuntime, GigTask } from './runtime.js';

type TaskExecutor = (task: GigTask, signal: AbortSignal) => Promise<unknown> | unknown;

export interface BunWorkerRuntimeOptions {
  readonly executeTask?: TaskExecutor;
  readonly healthCheck?: () => boolean | Promise<boolean>;
  readonly now?: () => Date;
}

const defaultExecuteTask: TaskExecutor = async (task) => {
  return task.payload;
};

const toErrorMessage = (error: unknown): string => {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === 'string') {
    return error;
  }
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
};

const isAbortError = (error: unknown): boolean => {
  if (error instanceof DOMException) {
    return error.name === 'AbortError';
  }

  if (!(error instanceof Error)) {
    return false;
  }

  const normalized = error.message.toLowerCase();
  return normalized.includes('abort') || normalized.includes('cancel');
};

const toTimestamp = (now: () => Date): string => {
  return now().toISOString();
};

const buildResult = (
  taskId: string,
  status: GigResult['status'],
  startedAt: string,
  finishedAt: string,
  fields: Readonly<{ state: GigResult['state']; result?: unknown; error?: string }>,
): GigResult => {
  return {
    taskId,
    status,
    state: fields.state,
    result: fields.result,
    error: fields.error,
    startedAt,
    finishedAt,
  };
};

export const createBunWorkerRuntime = (options: BunWorkerRuntimeOptions = {}): GigRuntime => {
  const runningControllers = new Map<string, AbortController>();
  const executeTask = options.executeTask ?? defaultExecuteTask;
  const healthCheck = options.healthCheck ?? (() => true);
  const now = options.now ?? (() => new Date());

  const execute = async (task: GigTask): Promise<GigResult> => {
    const startedAt = toTimestamp(now);

    if (runningControllers.has(task.taskId)) {
      return buildResult(task.taskId, 'failed', startedAt, toTimestamp(now), {
        state: 'degraded',
        error: `任务 ${task.taskId} 正在执行中`,
      });
    }

    const controller = new AbortController();
    runningControllers.set(task.taskId, controller);

    const timeoutHandle =
      typeof task.timeoutMs === 'number' && task.timeoutMs > 0
        ? setTimeout(() => {
            controller.abort(new Error('task timeout'));
          }, task.timeoutMs)
        : null;

    try {
      const result = await Promise.resolve(executeTask(task, controller.signal));
      const finishedAt = toTimestamp(now);

      if (controller.signal.aborted) {
        return buildResult(task.taskId, 'cancelled', startedAt, finishedAt, {
          state: 'idle',
          error: '任务已中止',
        });
      }

      return buildResult(task.taskId, 'completed', startedAt, finishedAt, {
        state: 'idle',
        result,
      });
    } catch (error: unknown) {
      const finishedAt = toTimestamp(now);
      const cancelled = controller.signal.aborted || isAbortError(error);

      return buildResult(task.taskId, cancelled ? 'cancelled' : 'failed', startedAt, finishedAt, {
        state: cancelled ? 'idle' : 'degraded',
        error: toErrorMessage(error),
      });
    } finally {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
      runningControllers.delete(task.taskId);
    }
  };

  const abort = async (taskId: string): Promise<boolean> => {
    const controller = runningControllers.get(taskId);
    if (!controller) {
      return false;
    }

    controller.abort(new Error('manual abort'));
    return true;
  };

  const isHealthy = async (): Promise<boolean> => {
    return await Promise.resolve(healthCheck());
  };

  return {
    execute,
    abort,
    isHealthy,
  };
};
