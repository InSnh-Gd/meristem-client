import type { GigExecutionStatus, GigState } from './types.js';

export interface GigTask {
  readonly taskId: string;
  readonly payload: unknown;
  readonly timeoutMs?: number;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface GigResult {
  readonly taskId: string;
  readonly status: GigExecutionStatus;
  readonly state: GigState;
  readonly result?: unknown;
  readonly error?: string;
  readonly startedAt: string;
  readonly finishedAt: string;
}

export interface GigRuntime {
  execute(task: GigTask): Promise<GigResult>;
  abort(taskId: string): Promise<boolean>;
  isHealthy(): boolean | Promise<boolean>;
}
