import { spawn } from 'child_process';
import { randomUUID } from 'crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import type { JetStreamSubscription, JsMsg, Subscription } from 'nats';
import { natsManager } from '../nats/connection';
import { logger } from '../utils/logger';
import { ResultInbox, type ResultRecord } from './result-inbox';

type MessageType = 'CMD' | 'EVENT' | 'REQ' | 'RESP';

interface Envelope<TPayload> extends Record<string, unknown> {
  id: string;
  traceId: string;
  source: string;
  target: string;
  type: MessageType;
  subject: string;
  payload: TPayload;
  timestamp: number;
  expires: number;
  priority: number;
}

type TaskStatus = 'PENDING' | 'RUNNING' | 'FINISHED' | 'FAILED' | 'ORPHANED';

interface TaskPayload {
  command?: string;
  args?: string[];
  script?: string;
  env?: Record<string, string>;
  timeout_ms?: number;
  volatile?: boolean;
}

interface TaskLease {
  expire_at?: number;
  heartbeat_interval?: number;
}

interface TaskCommand {
  task_id?: string;
  taskId?: string;
  trace_id?: string;
  traceId?: string;
  payload?: TaskPayload;
  lease?: TaskLease;
}

interface TaskStateUpdate {
  node_id: string;
  task_id: string;
  status: TaskStatus;
  ts: number;
  trace_id?: string;
  message?: string;
  progress?: {
    percent?: number;
    last_log_snippet?: string;
  };
}

interface TaskResultMessage {
  taskId: string;
  nodeId: string;
  status: 'completed' | 'failed';
  result?: unknown;
  error?: string;
  checksum?: string;
  resultUri?: string;
  timestamp: number;
}

interface TaskResultAck {
  taskId: string;
  nodeId: string;
  status: 'ACK' | 'ERROR';
  message?: string;
  timestamp: number;
}

interface NormalizedTask {
  taskId: string;
  traceId?: string;
  payload: TaskPayload;
  lease?: TaskLease;
}

interface ExecutionOutcome {
  status: 'completed' | 'failed';
  result?: unknown;
  error?: string;
  orphaned?: boolean;
  workspace?: string;
}

interface ActiveTask {
  taskId: string;
  process?: ReturnType<typeof spawn>;
  leaseTimer?: ReturnType<typeof setTimeout>;
  timeoutTimer?: ReturnType<typeof setTimeout>;
  workspace: string;
  orphaned: boolean;
}

const DEFAULT_TEMP_DIR = process.env.MERISTEM_PATHS_TEMP_DIR || '/tmp/meristem';

export class TaskExecutorService {
  private subscription: JetStreamSubscription | null = null;
  private ackSubscription: Subscription | null = null;
  private isRunning = false;
  private readonly activeTasks = new Map<string, ActiveTask>();
  private readonly resultInbox: ResultInbox;
  private readonly nodeId: string;
  private readonly tempDir: string;

  constructor(options?: { nodeId?: string; tempDir?: string }) {
    this.nodeId = options?.nodeId || process.env.MERISTEM_NODE_ID || 'unknown';
    this.tempDir = options?.tempDir || DEFAULT_TEMP_DIR;
    this.resultInbox = new ResultInbox({
      sendResult: async (record) => this.sendResult(record),
    });
  }

  async start(): Promise<void> {
    if (this.isRunning) {
      logger.warn('TaskExecutorService already running');
      return;
    }

    await natsManager.connect();
    await this.resultInbox.start();
    await this.ensureTempDir();

    const js = natsManager.getJetStream();
    const subject = `meristem.v1.node.${this.nodeId}.cmd`;

    this.subscription = await js.subscribe(subject, { manualAck: true });
    this.isRunning = true;
    logger.info('TaskExecutorService started', { subject });

    void this.consumeCommands(this.subscription);
    this.subscribeAcks();
  }

  async stop(): Promise<void> {
    if (!this.isRunning) {
      return;
    }

    this.subscription?.unsubscribe();
    this.subscription = null;
    this.ackSubscription?.unsubscribe();
    this.ackSubscription = null;
    this.isRunning = false;

    for (const task of this.activeTasks.values()) {
      this.terminateTask(task);
    }

    this.activeTasks.clear();
    await this.resultInbox.stop();
    logger.info('TaskExecutorService stopped');
  }

  private async consumeCommands(subscription: JetStreamSubscription): Promise<void> {
    for await (const msg of subscription) {
      void this.handleCommand(msg);
    }
  }

  private subscribeAcks(): void {
    const nc = natsManager.getConnection();
    const codec = natsManager.getCodec();
    const subject = `meristem.v1.node.${this.nodeId}.ack`;

    this.ackSubscription = nc.subscribe(subject, {
      callback: async (err, msg) => {
        if (err) {
          logger.error('Result ACK subscription error', { error: err.message });
          return;
        }

        try {
          const ack = codec.decode(msg.data) as TaskResultAck;
          if (ack?.taskId) {
            await this.resultInbox.handleAck(ack.taskId);
          }
        } catch (error) {
          logger.warn('Failed to process result ACK', { error: String(error) });
        }
      },
    });
  }

  private async handleCommand(msg: JsMsg): Promise<void> {
    const codec = natsManager.getCodec();

    try {
      const decoded = codec.decode(msg.data) as unknown;
      const normalized = this.normalizeCommand(decoded);

      if (!normalized) {
        logger.warn('Received invalid task command', { subject: msg.subject });
        msg.ack();
        return;
      }

      const now = Date.now();
      const expiresAt = this.extractExpires(decoded);
      if (expiresAt && expiresAt > 0 && expiresAt <= now) {
        logger.warn('Discarding expired task command', { taskId: normalized.taskId });
        msg.ack();
        return;
      }

      await this.publishState(normalized.taskId, 'RUNNING', normalized.traceId);
      const outcome = await this.executeTask(normalized);

      await this.finalizeTask(normalized, outcome);
      msg.ack();
    } catch (error) {
      logger.error('Failed to handle task command', { error: String(error) });
      msg.ack();
    }
  }

  private normalizeCommand(message: unknown): NormalizedTask | null {
    if (!this.isRecord(message)) {
      return null;
    }

    const maybeEnvelope = this.isEnvelope(message) ? message : null;
    const payload = (maybeEnvelope ? maybeEnvelope.payload : message) as unknown;
    if (!this.isRecord(payload)) {
      return null;
    }

    const candidate = this.isRecord(payload.task) ? payload.task : payload;
    const command = candidate as TaskCommand;
    const taskId = this.asString(command.task_id) || this.asString(command.taskId);
    if (!taskId) {
      return null;
    }

    const traceId = this.asString(command.trace_id) || this.asString(command.traceId) || maybeEnvelope?.traceId;
    const taskPayload = this.isRecord(command.payload) ? (command.payload as TaskPayload) : {};
    const lease = this.isRecord(command.lease) ? (command.lease as TaskLease) : undefined;

    return {
      taskId,
      traceId: traceId || undefined,
      payload: taskPayload,
      lease,
    };
  }

  private async executeTask(task: NormalizedTask): Promise<ExecutionOutcome> {
    const workspace = await this.createWorkspace(task.taskId);
    const activeTask: ActiveTask = {
      taskId: task.taskId,
      workspace,
      orphaned: false,
    };

    this.activeTasks.set(task.taskId, activeTask);

    try {
      const outcome = await this.runPayload(task, activeTask);
      return outcome;
    } finally {
      this.cleanupTimers(activeTask);
      this.activeTasks.delete(task.taskId);
    }
  }

  private async runPayload(task: NormalizedTask, activeTask: ActiveTask): Promise<ExecutionOutcome> {
    const payload = task.payload || {};

    if (!payload.command && !payload.script) {
      return {
        status: 'failed',
        error: 'Task payload missing command or script',
      };
    }

    let command = payload.command || '';
    let args = payload.args || [];

    if (payload.script) {
      const scriptPath = join(activeTask.workspace, 'task.sh');
      await writeFile(scriptPath, payload.script, { mode: 0o700 });
      command = 'sh';
      args = [scriptPath];
    }

    const env = {
      ...process.env,
      ...payload.env,
      MERISTEM_TASK_ID: task.taskId,
      MERISTEM_TASK_TRACE_ID: task.traceId || '',
    };

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    const maxBytes = 256 * 1024;
    let stdoutSize = 0;
    let stderrSize = 0;

    return new Promise<ExecutionOutcome>((resolve) => {
      const child = spawn(command, args, {
        cwd: activeTask.workspace,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      activeTask.process = child;
      this.armLeaseTimer(task, activeTask);
      this.armTimeoutTimer(payload, activeTask);

      child.stdout?.on('data', (chunk: Buffer) => {
        if (stdoutSize < maxBytes) {
          stdoutChunks.push(chunk);
          stdoutSize += chunk.length;
        }
      });

      child.stderr?.on('data', (chunk: Buffer) => {
        if (stderrSize < maxBytes) {
          stderrChunks.push(chunk);
          stderrSize += chunk.length;
        }
      });

      child.on('error', (error) => {
        resolve({
          status: 'failed',
          error: error.message,
        });
      });

      child.on('close', async (code, signal) => {
        const stdout = Buffer.concat(stdoutChunks).toString('utf-8');
        const stderr = Buffer.concat(stderrChunks).toString('utf-8');
        const result = {
          exit_code: code,
          signal,
          stdout,
          stderr,
          workspace: activeTask.workspace,
        };

        if (activeTask.orphaned) {
          resolve({
            status: 'failed',
            error: 'Task lease expired',
            orphaned: true,
            result,
            workspace: activeTask.workspace,
          });
          return;
        }

        if (code === 0) {
          resolve({ status: 'completed', result, workspace: activeTask.workspace });
        } else {
          resolve({
            status: 'failed',
            error: `Process exited with code ${code ?? 'unknown'}`,
            result,
            workspace: activeTask.workspace,
          });
        }
      });
    });
  }

  private async finalizeTask(task: NormalizedTask, outcome: ExecutionOutcome): Promise<void> {
    const status: TaskStatus = outcome.orphaned
      ? 'ORPHANED'
      : outcome.status === 'completed'
        ? 'FINISHED'
        : 'FAILED';

    await this.publishState(task.taskId, status, task.traceId, outcome.error);

    const resultRecord: ResultRecord = {
      task_id: task.taskId,
      status: outcome.status === 'completed' ? 'completed' : 'failed',
      result: outcome.result,
      error: outcome.error,
      completed_at: new Date().toISOString(),
    };

    await this.resultInbox.enqueueResult(resultRecord);

    if (task.payload?.volatile && outcome.workspace) {
      await rm(outcome.workspace, { recursive: true, force: true });
    }
  }

  private async publishState(taskId: string, status: TaskStatus, traceId?: string, message?: string): Promise<void> {
    const nc = natsManager.getConnection();
    const codec = natsManager.getCodec();

    const update: TaskStateUpdate = {
      node_id: this.nodeId,
      task_id: taskId,
      status,
      ts: Date.now(),
      trace_id: traceId,
      message,
    };

    const envelope: Envelope<TaskStateUpdate> = {
      id: randomUUID(),
      traceId: traceId || randomUUID(),
      source: `node:${this.nodeId}`,
      target: 'core',
      type: 'EVENT',
      subject: 'task.state',
      payload: update,
      timestamp: Date.now(),
      expires: 0,
      priority: 5,
    };

    await nc.publish(`meristem.v1.node.${this.nodeId}.state`, codec.encode(envelope));
  }

  private async sendResult(record: ResultRecord): Promise<void> {
    const nc = natsManager.getConnection();
    const codec = natsManager.getCodec();

    const result: TaskResultMessage = {
      taskId: record.task_id,
      nodeId: this.nodeId,
      status: record.status === 'completed' ? 'completed' : 'failed',
      result: record.result,
      error: record.error,
      checksum: record.checksum,
      resultUri: record.result_uri,
      timestamp: Date.now(),
    };

    await nc.publish(`meristem.v1.node.${this.nodeId}.result`, codec.encode(result));
  }

  private async ensureTempDir(): Promise<void> {
    await mkdir(this.tempDir, { recursive: true });
  }

  private async createWorkspace(taskId: string): Promise<string> {
    await this.ensureTempDir();
    const workspace = await mkdtemp(join(this.tempDir, `task-${taskId}-`));
    return workspace;
  }

  private armLeaseTimer(task: NormalizedTask, activeTask: ActiveTask): void {
    const expireAt = task.lease?.expire_at;
    if (!expireAt || expireAt <= 0) {
      return;
    }

    const delay = expireAt - Date.now();
    if (delay <= 0) {
      activeTask.orphaned = true;
      this.terminateTask(activeTask);
      return;
    }

    activeTask.leaseTimer = setTimeout(() => {
      activeTask.orphaned = true;
      this.terminateTask(activeTask);
    }, delay);
  }

  private armTimeoutTimer(payload: TaskPayload, activeTask: ActiveTask): void {
    const timeout = payload.timeout_ms;
    if (!timeout || timeout <= 0) {
      return;
    }

    activeTask.timeoutTimer = setTimeout(() => {
      this.terminateTask(activeTask);
    }, timeout);
  }

  private terminateTask(activeTask: ActiveTask): void {
    if (activeTask.process && !activeTask.process.killed) {
      activeTask.process.kill('SIGKILL');
    }
    this.cleanupTimers(activeTask);
  }

  private cleanupTimers(activeTask: ActiveTask): void {
    if (activeTask.leaseTimer) {
      clearTimeout(activeTask.leaseTimer);
      activeTask.leaseTimer = undefined;
    }
    if (activeTask.timeoutTimer) {
      clearTimeout(activeTask.timeoutTimer);
      activeTask.timeoutTimer = undefined;
    }
  }

  private extractExpires(message: unknown): number | null {
    if (!this.isRecord(message)) {
      return null;
    }
    if (this.isEnvelope(message)) {
      const expires = message.expires;
      return typeof expires === 'number' ? expires : null;
    }
    return null;
  }

  private isEnvelope(message: Record<string, unknown>): message is Envelope<unknown> {
    return typeof message.type === 'string' && typeof message.subject === 'string' && 'payload' in message;
  }

  private isRecord(value: unknown): value is Record<string, any> {
    return typeof value === 'object' && value !== null;
  }

  private asString(value: unknown): string | null {
    return typeof value === 'string' && value.length > 0 ? value : null;
  }
}

export const taskExecutorService = new TaskExecutorService();
