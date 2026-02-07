import { createHash } from 'crypto';
import { access, mkdir, readdir, readFile, rename, rm, writeFile } from 'fs/promises';
import { dirname, join } from 'path';
import { createClientLogger, type Logger } from '../utils/logger.js';

const DEFAULT_PENDING_DIR = process.env.MERISTEM_PATHS_PENDING_DIR || '/var/lib/meristem/pending';
const DEFAULT_STAGING_DIR = process.env.MERISTEM_PATHS_STAGING_DIR || join(dirname(DEFAULT_PENDING_DIR), 'staging');
const DEFAULT_RETRY_DELAYS_MS = [1000, 5000, 15000];

const parsePositiveInt = (value: string | undefined, fallback: number): number => {
  if (!value) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  if (Number.isFinite(parsed) && parsed > 0) {
    return parsed;
  }

  return fallback;
};

const parseRetryBackoffFromEnv = (): number[] => {
  const value = process.env.MERISTEM_GIG_RETRY_BACKOFF_MS;
  if (!value) {
    return DEFAULT_RETRY_DELAYS_MS;
  }

  const parsed = value
    .split(',')
    .map((item) => Number.parseInt(item.trim(), 10))
    .filter((item) => Number.isFinite(item) && item > 0);

  return parsed.length > 0 ? parsed : DEFAULT_RETRY_DELAYS_MS;
};

export interface ResultRecord {
  task_id: string;
  status: 'completed' | 'failed' | 'cancelled';
  result?: unknown;
  error?: string;
  result_uri?: string;
  checksum?: string;
  completed_at?: string;
}

export interface ResultInboxOptions {
  pendingDir?: string;
  stagingDir?: string;
  maxRetries?: number;
  retryDelaysMs?: number[];
  isJoined?: boolean;
  nodeId?: string;
  sendResult: (record: ResultRecord) => Promise<void>;
  onOrphaned?: (taskId: string) => Promise<void> | void;
}

export class ResultInbox {
  private readonly pendingDir: string;
  private readonly stagingDir: string;
  private readonly maxRetries: number;
  private readonly retryDelaysMs: number[];
  private readonly sendResult: (record: ResultRecord) => Promise<void>;
  private readonly onOrphaned?: (taskId: string) => Promise<void> | void;
  private readonly logger: Logger;
  private readonly retryTimers = new Map<string, NodeJS.Timeout>();

  constructor(options: ResultInboxOptions) {
    this.pendingDir = options.pendingDir || DEFAULT_PENDING_DIR;
    this.stagingDir = options.stagingDir || DEFAULT_STAGING_DIR;
    this.maxRetries = options.maxRetries ?? parsePositiveInt(process.env.MERISTEM_GIG_MAX_RETRIES, 3);
    this.retryDelaysMs = options.retryDelaysMs?.length ? options.retryDelaysMs : parseRetryBackoffFromEnv();
    this.sendResult = options.sendResult;
    this.onOrphaned = options.onOrphaned;
    const isJoined = options.isJoined ?? false;
    this.logger = createClientLogger(isJoined, options.nodeId);
  }

  async start(): Promise<void> {
    await this.ensureDirs();
    await this.recoverStaging();
    await this.resendPending();
  }

  async stop(): Promise<void> {
    for (const timer of this.retryTimers.values()) {
      clearTimeout(timer);
    }
    this.retryTimers.clear();
  }

  async enqueueResult(record: ResultRecord): Promise<void> {
    await this.ensureDirs();
    await this.writePending(record);
    await this.sendAndSchedule(record.task_id);
  }

  async handleAck(taskId: string): Promise<void> {
    this.clearTimer(taskId);
    const pendingTaskDir = join(this.pendingDir, taskId);
    await rm(pendingTaskDir, { recursive: true, force: true });
  }

  private async ensureDirs(): Promise<void> {
    await mkdir(this.pendingDir, { recursive: true });
    await mkdir(this.stagingDir, { recursive: true });
  }

  private async recoverStaging(): Promise<void> {
    if (!(await this.pathExists(this.stagingDir))) {
      return;
    }

    const entries = await readdir(this.stagingDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (!entry.name.endsWith('.tmp')) continue;
      await rm(join(this.stagingDir, entry.name), { recursive: true, force: true });
    }
  }

  private async resendPending(): Promise<void> {
    if (!(await this.pathExists(this.pendingDir))) {
      return;
    }

    const entries = await readdir(this.pendingDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      await this.sendAndSchedule(entry.name);
    }
  }

  private async writePending(record: ResultRecord): Promise<void> {
    const pendingTaskDir = join(this.pendingDir, record.task_id);
    if (await this.pathExists(pendingTaskDir)) {
      return;
    }

    const stagingTaskDir = join(this.stagingDir, `${record.task_id}.tmp`);
    await rm(stagingTaskDir, { recursive: true, force: true });
    await mkdir(join(stagingTaskDir, 'payload'), { recursive: true });

    const serialized = JSON.stringify(record, null, 2);
    const checksum = record.checksum || this.sha256(serialized);

    await writeFile(join(stagingTaskDir, 'result.json'), serialized);
    await writeFile(join(stagingTaskDir, 'checksum.sha256'), `${checksum}\n`);
    await writeFile(join(stagingTaskDir, 'retry_count'), '0\n');

    await rename(stagingTaskDir, pendingTaskDir);
  }

  private async sendAndSchedule(taskId: string): Promise<void> {
    const record = await this.readRecord(taskId);
    if (!record) {
      return;
    }

    try {
      await this.sendResult(record);
    } catch (error) {
      this.logger.error('[ResultInbox] Send failed', { taskId, error: String(error) });
    }

    await this.scheduleNext(taskId);
  }

  private async scheduleNext(taskId: string): Promise<void> {
    this.clearTimer(taskId);

    const retryCount = await this.readRetryCount(taskId);
    const delay = this.retryDelaysMs[Math.min(retryCount, this.retryDelaysMs.length - 1)] ?? 10000;

    const timer = setTimeout(() => {
      void this.onRetryTimer(taskId);
    }, delay);

    this.retryTimers.set(taskId, timer);
  }

  private async onRetryTimer(taskId: string): Promise<void> {
    this.retryTimers.delete(taskId);

    const retryCount = await this.readRetryCount(taskId);
    if (retryCount >= this.maxRetries) {
      await this.markOrphaned(taskId);
      return;
    }

    await this.writeRetryCount(taskId, retryCount + 1);
    await this.sendAndSchedule(taskId);
  }

  private async markOrphaned(taskId: string): Promise<void> {
    const pendingTaskDir = join(this.pendingDir, taskId);
    const markerPath = join(pendingTaskDir, 'orphaned');
    await writeFile(markerPath, `${new Date().toISOString()}\n`);

    if (this.onOrphaned) {
      await this.onOrphaned(taskId);
    }
  }

  private async readRecord(taskId: string): Promise<ResultRecord | null> {
    try {
      const data = await readFile(join(this.pendingDir, taskId, 'result.json'), 'utf-8');
      return JSON.parse(data) as ResultRecord;
    } catch {
      return null;
    }
  }

  private async readRetryCount(taskId: string): Promise<number> {
    try {
      const data = await readFile(join(this.pendingDir, taskId, 'retry_count'), 'utf-8');
      const value = Number.parseInt(data.trim(), 10);
      return Number.isNaN(value) ? 0 : value;
    } catch {
      return 0;
    }
  }

  private async writeRetryCount(taskId: string, count: number): Promise<void> {
    await writeFile(join(this.pendingDir, taskId, 'retry_count'), `${count}\n`);
  }

  private clearTimer(taskId: string): void {
    const timer = this.retryTimers.get(taskId);
    if (timer) {
      clearTimeout(timer);
      this.retryTimers.delete(taskId);
    }
  }

  private async pathExists(path: string): Promise<boolean> {
    try {
      await access(path);
      return true;
    } catch {
      return false;
    }
  }

  private sha256(value: string): string {
    return createHash('sha256').update(value).digest('hex');
  }
}
