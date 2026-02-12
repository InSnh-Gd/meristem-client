import { createHash } from 'crypto';
import { access, mkdir, readdir, readFile, rename, rm, writeFile } from 'fs/promises';
import { dirname, join } from 'path';
import { createClientLogger, type Logger } from '../utils/logger.js';

const DEFAULT_PENDING_DIR = process.env.MERISTEM_PATHS_PENDING_DIR || '/var/lib/meristem/pending';
const DEFAULT_STAGING_DIR = process.env.MERISTEM_PATHS_STAGING_DIR || join(dirname(DEFAULT_PENDING_DIR), 'staging');
const DEFAULT_RETRY_DELAYS_MS = [1000, 5000, 15000];
const STAGING_SUFFIX = '.tmp';
const CHECKPOINT_PREPARE_FILE = 'checkpoint.prepare';
const CHECKPOINT_COMMIT_FILE = 'checkpoint.commit';
const RESULT_FILE = 'result.json';
const CHECKSUM_FILE = 'checksum.sha256';
const RETRY_COUNT_FILE = 'retry_count';
const DELIVERY_ID_FILE = 'delivery_id';
const ORPHANED_FILE = 'orphaned';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isResultStatus = (value: unknown): value is ResultRecord['status'] =>
  value === 'completed' || value === 'failed' || value === 'cancelled';

const normalizeOptionalString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 ? value : undefined;

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
  delivery_id?: string;
  completed_at?: string;
}

export interface ResultSendOutcome {
  acked?: boolean;
  code?: string;
}

const isResultSendOutcome = (value: unknown): value is ResultSendOutcome => {
  if (!isRecord(value)) {
    return false;
  }

  return (
    (value.acked === undefined || typeof value.acked === 'boolean') &&
    (value.code === undefined || typeof value.code === 'string')
  );
};

const toResultRecord = (value: unknown): ResultRecord | null => {
  if (!isRecord(value)) {
    return null;
  }

  const taskId = value.task_id;
  const status = value.status;
  if (typeof taskId !== 'string' || taskId.length === 0 || !isResultStatus(status)) {
    return null;
  }

  const record: ResultRecord = {
    task_id: taskId,
    status,
  };

  if ('result' in value) {
    record.result = value.result;
  }

  const error = normalizeOptionalString(value.error);
  if (error) {
    record.error = error;
  }

  const resultUri = normalizeOptionalString(value.result_uri);
  if (resultUri) {
    record.result_uri = resultUri;
  }

  const checksum = normalizeOptionalString(value.checksum);
  if (checksum) {
    record.checksum = checksum;
  }

  const deliveryId = normalizeOptionalString(value.delivery_id);
  if (deliveryId) {
    record.delivery_id = deliveryId;
  }

  const completedAt = normalizeOptionalString(value.completed_at);
  if (completedAt) {
    record.completed_at = completedAt;
  }

  return record;
};

export interface ResultInboxOptions {
  pendingDir?: string;
  stagingDir?: string;
  maxRetries?: number;
  retryDelaysMs?: number[];
  isJoined?: boolean;
  nodeId?: string;
  sendResult: (record: ResultRecord) => Promise<ResultSendOutcome | void>;
  onOrphaned?: (taskId: string) => Promise<void> | void;
}

export class ResultInbox {
  private readonly pendingDir: string;
  private readonly stagingDir: string;
  private readonly maxRetries: number;
  private readonly retryDelaysMs: number[];
  private readonly sendResult: (record: ResultRecord) => Promise<ResultSendOutcome | void>;
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
      if (!entry.name.endsWith(STAGING_SUFFIX)) continue;
      await this.recoverStagingTask(entry.name);
    }
  }

  private async recoverStagingTask(entryName: string): Promise<void> {
    const taskId = entryName.slice(0, -STAGING_SUFFIX.length);
    const stagingTaskDir = join(this.stagingDir, entryName);
    const pendingTaskDir = join(this.pendingDir, taskId);

    if (taskId.length === 0) {
      await rm(stagingTaskDir, { recursive: true, force: true });
      return;
    }

    if (await this.pathExists(pendingTaskDir)) {
      await rm(stagingTaskDir, { recursive: true, force: true });
      return;
    }

    /**
     * 逻辑块：崩溃恢复以 checkpoint.commit 作为“可提升”边界。
     * - prepare 存在但 commit 不存在：视为中间态，直接清理，避免脏数据进入 pending。
     * - commit + 关键文件齐全：将 staging 原子提升到 pending，后续按常规重发流程处理。
     */
    const hasCommit = await this.pathExists(join(stagingTaskDir, CHECKPOINT_COMMIT_FILE));
    const hasResult = await this.pathExists(join(stagingTaskDir, RESULT_FILE));
    const hasRetryCount = await this.pathExists(join(stagingTaskDir, RETRY_COUNT_FILE));

    if (hasCommit && hasResult && hasRetryCount) {
      await rename(stagingTaskDir, pendingTaskDir);
      return;
    }

    await rm(stagingTaskDir, { recursive: true, force: true });
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
    const initialSerialized = JSON.stringify(record, null, 2);
    const checksum = record.checksum || this.sha256(initialSerialized);
    const deliveryId = record.delivery_id || this.sha256(`${record.task_id}:${checksum}`);
    const normalizedRecord: ResultRecord = {
      ...record,
      checksum,
      delivery_id: deliveryId,
    };

    const pendingTaskDir = join(this.pendingDir, record.task_id);
    if (await this.pathExists(pendingTaskDir)) {
      const existingDeliveryId = await this.readDeliveryId(record.task_id);
      if (existingDeliveryId === deliveryId) {
        return;
      }

      this.logger.warn('[ResultInbox] Duplicate task result ignored due to delivery_id mismatch', {
        taskId: record.task_id,
        existingDeliveryId,
        incomingDeliveryId: deliveryId,
      });
      return;
    }

    const stagingTaskDir = join(this.stagingDir, `${record.task_id}${STAGING_SUFFIX}`);
    await rm(stagingTaskDir, { recursive: true, force: true });
    await mkdir(join(stagingTaskDir, 'payload'), { recursive: true });

    /**
     * 逻辑块：prepare/commit 双 checkpoint 保障结果落盘原子性。
     * - prepare：声明“正在写入”，崩溃后不会被当成可重发数据。
     * - commit：声明“关键文件齐全”，恢复时可安全提升到 pending。
     */
    const serialized = JSON.stringify(normalizedRecord, null, 2);
    await writeFile(join(stagingTaskDir, CHECKPOINT_PREPARE_FILE), `${new Date().toISOString()}\n`);

    await writeFile(join(stagingTaskDir, RESULT_FILE), serialized);
    await writeFile(join(stagingTaskDir, CHECKSUM_FILE), `${checksum}\n`);
    await writeFile(join(stagingTaskDir, RETRY_COUNT_FILE), '0\n');
    await writeFile(join(stagingTaskDir, DELIVERY_ID_FILE), `${deliveryId}\n`);
    await writeFile(join(stagingTaskDir, CHECKPOINT_COMMIT_FILE), `${new Date().toISOString()}\n`);

    await rename(stagingTaskDir, pendingTaskDir);
  }

  private async sendAndSchedule(taskId: string): Promise<void> {
    const record = await this.readRecord(taskId);
    if (!record) {
      return;
    }

    try {
      const outcome = await this.sendResult(record);
      if (isResultSendOutcome(outcome) && outcome.acked === true) {
        await this.handleAck(taskId);
        return;
      }
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
    const markerPath = join(pendingTaskDir, ORPHANED_FILE);
    await writeFile(markerPath, `${new Date().toISOString()}\n`);

    if (this.onOrphaned) {
      await this.onOrphaned(taskId);
    }
  }

  private async readRecord(taskId: string): Promise<ResultRecord | null> {
    try {
      const data = await readFile(join(this.pendingDir, taskId, RESULT_FILE), 'utf-8');
      const parsed = toResultRecord(JSON.parse(data) as unknown);
      if (!parsed) {
        return null;
      }
      if (!parsed.delivery_id) {
        parsed.delivery_id = await this.readDeliveryId(taskId);
      }
      return parsed;
    } catch {
      return null;
    }
  }

  private async readRetryCount(taskId: string): Promise<number> {
    try {
      const data = await readFile(join(this.pendingDir, taskId, RETRY_COUNT_FILE), 'utf-8');
      const value = Number.parseInt(data.trim(), 10);
      return Number.isNaN(value) ? 0 : value;
    } catch {
      return 0;
    }
  }

  private async writeRetryCount(taskId: string, count: number): Promise<void> {
    await writeFile(join(this.pendingDir, taskId, RETRY_COUNT_FILE), `${count}\n`);
  }

  private async readDeliveryId(taskId: string): Promise<string | undefined> {
    try {
      const data = await readFile(join(this.pendingDir, taskId, DELIVERY_ID_FILE), 'utf-8');
      const value = data.trim();
      return value.length > 0 ? value : undefined;
    } catch {
      return undefined;
    }
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
