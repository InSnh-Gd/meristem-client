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
export declare class ResultInbox {
    private readonly pendingDir;
    private readonly stagingDir;
    private readonly maxRetries;
    private readonly retryDelaysMs;
    private readonly sendResult;
    private readonly onOrphaned?;
    private readonly logger;
    private readonly retryTimers;
    constructor(options: ResultInboxOptions);
    start(): Promise<void>;
    stop(): Promise<void>;
    enqueueResult(record: ResultRecord): Promise<void>;
    handleAck(taskId: string): Promise<void>;
    private ensureDirs;
    private recoverStaging;
    private resendPending;
    private writePending;
    private sendAndSchedule;
    private scheduleNext;
    private onRetryTimer;
    private markOrphaned;
    private readRecord;
    private readRetryCount;
    private writeRetryCount;
    private clearTimer;
    private pathExists;
    private sha256;
}
//# sourceMappingURL=result-inbox.d.ts.map