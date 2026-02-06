import { createHash } from 'crypto';
import { access, mkdir, readdir, readFile, rename, rm, writeFile } from 'fs/promises';
import { dirname, join } from 'path';
import { createClientLogger } from '../utils/logger.js';
const DEFAULT_PENDING_DIR = process.env.MERISTEM_PATHS_PENDING_DIR || '/var/lib/meristem/pending';
const DEFAULT_STAGING_DIR = process.env.MERISTEM_PATHS_STAGING_DIR || join(dirname(DEFAULT_PENDING_DIR), 'staging');
const DEFAULT_RETRY_DELAYS_MS = [10000, 30000, 90000, 270000, 810000];
export class ResultInbox {
    pendingDir;
    stagingDir;
    maxRetries;
    retryDelaysMs;
    sendResult;
    onOrphaned;
    logger;
    retryTimers = new Map();
    constructor(options) {
        this.pendingDir = options.pendingDir || DEFAULT_PENDING_DIR;
        this.stagingDir = options.stagingDir || DEFAULT_STAGING_DIR;
        this.maxRetries = options.maxRetries ?? 5;
        this.retryDelaysMs = options.retryDelaysMs?.length ? options.retryDelaysMs : DEFAULT_RETRY_DELAYS_MS;
        this.sendResult = options.sendResult;
        this.onOrphaned = options.onOrphaned;
        const isJoined = options.isJoined ?? false;
        this.logger = createClientLogger(isJoined, options.nodeId);
    }
    async start() {
        await this.ensureDirs();
        await this.recoverStaging();
        await this.resendPending();
    }
    async stop() {
        for (const timer of this.retryTimers.values()) {
            clearTimeout(timer);
        }
        this.retryTimers.clear();
    }
    async enqueueResult(record) {
        await this.ensureDirs();
        await this.writePending(record);
        await this.sendAndSchedule(record.task_id);
    }
    async handleAck(taskId) {
        this.clearTimer(taskId);
        const pendingTaskDir = join(this.pendingDir, taskId);
        await rm(pendingTaskDir, { recursive: true, force: true });
    }
    async ensureDirs() {
        await mkdir(this.pendingDir, { recursive: true });
        await mkdir(this.stagingDir, { recursive: true });
    }
    async recoverStaging() {
        if (!(await this.pathExists(this.stagingDir))) {
            return;
        }
        const entries = await readdir(this.stagingDir, { withFileTypes: true });
        for (const entry of entries) {
            if (!entry.isDirectory())
                continue;
            if (!entry.name.endsWith('.tmp'))
                continue;
            await rm(join(this.stagingDir, entry.name), { recursive: true, force: true });
        }
    }
    async resendPending() {
        if (!(await this.pathExists(this.pendingDir))) {
            return;
        }
        const entries = await readdir(this.pendingDir, { withFileTypes: true });
        for (const entry of entries) {
            if (!entry.isDirectory())
                continue;
            await this.sendAndSchedule(entry.name);
        }
    }
    async writePending(record) {
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
    async sendAndSchedule(taskId) {
        const record = await this.readRecord(taskId);
        if (!record) {
            return;
        }
        try {
            await this.sendResult(record);
        }
        catch (error) {
            this.logger.error('[ResultInbox] Send failed', { taskId, error: String(error) });
        }
        await this.scheduleNext(taskId);
    }
    async scheduleNext(taskId) {
        this.clearTimer(taskId);
        const retryCount = await this.readRetryCount(taskId);
        const delay = this.retryDelaysMs[Math.min(retryCount, this.retryDelaysMs.length - 1)] ?? 10000;
        const timer = setTimeout(() => {
            void this.onRetryTimer(taskId);
        }, delay);
        this.retryTimers.set(taskId, timer);
    }
    async onRetryTimer(taskId) {
        this.retryTimers.delete(taskId);
        const retryCount = await this.readRetryCount(taskId);
        if (retryCount >= this.maxRetries) {
            await this.markOrphaned(taskId);
            return;
        }
        await this.writeRetryCount(taskId, retryCount + 1);
        await this.sendAndSchedule(taskId);
    }
    async markOrphaned(taskId) {
        const pendingTaskDir = join(this.pendingDir, taskId);
        const markerPath = join(pendingTaskDir, 'orphaned');
        await writeFile(markerPath, `${new Date().toISOString()}\n`);
        if (this.onOrphaned) {
            await this.onOrphaned(taskId);
        }
    }
    async readRecord(taskId) {
        try {
            const data = await readFile(join(this.pendingDir, taskId, 'result.json'), 'utf-8');
            return JSON.parse(data);
        }
        catch {
            return null;
        }
    }
    async readRetryCount(taskId) {
        try {
            const data = await readFile(join(this.pendingDir, taskId, 'retry_count'), 'utf-8');
            const value = Number.parseInt(data.trim(), 10);
            return Number.isNaN(value) ? 0 : value;
        }
        catch {
            return 0;
        }
    }
    async writeRetryCount(taskId, count) {
        await writeFile(join(this.pendingDir, taskId, 'retry_count'), `${count}\n`);
    }
    clearTimer(taskId) {
        const timer = this.retryTimers.get(taskId);
        if (timer) {
            clearTimeout(timer);
            this.retryTimers.delete(taskId);
        }
    }
    async pathExists(path) {
        try {
            await access(path);
            return true;
        }
        catch {
            return false;
        }
    }
    sha256(value) {
        return createHash('sha256').update(value).digest('hex');
    }
}
//# sourceMappingURL=result-inbox.js.map