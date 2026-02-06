import pino from 'pino';
const DEFAULT_MAX_BUFFER_BYTES = 5 * 1024 * 1024;
const DEFAULT_MIN_BATCH_SIZE = 50;
const DEFAULT_MAX_BATCH_SIZE = 100;
const DEFAULT_FLUSH_INTERVAL_MS = 100;
const SYSTEM_TOPIC_PREFIX = 'meristem.v1.logs.sys.';
const TASK_TOPIC_PREFIX = 'meristem.v1.logs.task.';
const freezeTraceContext = (context) => Object.freeze({ ...context });
export function generateTraceId() {
    const timestamp = Date.now();
    const randomSuffix = Math.random().toString(36).substring(2, 10);
    return `trace-${timestamp}-${randomSuffix}`;
}
export function createTraceContext(props) {
    const base = {
        traceId: props.traceId ?? generateTraceId(),
        nodeId: props.nodeId,
        source: props.source,
        taskId: props.taskId,
    };
    return freezeTraceContext(base);
}
export function withTaskId(ctx, taskId) {
    return freezeTraceContext({ ...ctx, taskId });
}
export function withSource(ctx, source) {
    return freezeTraceContext({ ...ctx, source });
}
export function withNodeId(ctx, nodeId) {
    return freezeTraceContext({ ...ctx, nodeId });
}
const isRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
const isLogLevel = (value) => value === 'DEBUG' ||
    value === 'INFO' ||
    value === 'WARN' ||
    value === 'ERROR' ||
    value === 'FATAL';
const isLogEnvelope = (value) => {
    if (!isRecord(value)) {
        return false;
    }
    return (typeof value.ts === 'number' &&
        isLogLevel(value.level) &&
        typeof value.node_id === 'string' &&
        typeof value.source === 'string' &&
        typeof value.trace_id === 'string' &&
        typeof value.content === 'string' &&
        isRecord(value.meta));
};
const parseJson = (value) => {
    try {
        return JSON.parse(value);
    }
    catch {
        return undefined;
    }
};
const parseEnvelope = (input) => {
    if (isLogEnvelope(input)) {
        return input;
    }
    if (typeof input === 'string') {
        const parsed = parseJson(input);
        return isLogEnvelope(parsed) ? parsed : null;
    }
    return null;
};
const safeStringify = (value) => {
    try {
        return JSON.stringify(value);
    }
    catch {
        return null;
    }
};
const extractTaskId = (meta) => {
    const direct = meta.taskId;
    if (typeof direct === 'string' && direct.length > 0) {
        return direct;
    }
    const snake = meta.task_id;
    if (typeof snake === 'string' && snake.length > 0) {
        return snake;
    }
    return undefined;
};
const resolveSubject = (envelope) => {
    const taskId = extractTaskId(envelope.meta);
    if (taskId) {
        return `${TASK_TOPIC_PREFIX}${envelope.node_id}.${taskId}`;
    }
    return `${SYSTEM_TOPIC_PREFIX}${envelope.node_id}`;
};
const createRingBuffer = (maxBytes) => Object.freeze({
    entries: Object.freeze([]),
    totalBytes: 0,
    maxBytes,
});
const sumEntryBytes = (entries) => {
    let total = 0;
    for (const entry of entries) {
        total += entry.size;
    }
    return total;
};
const appendEntry = (state, entry) => {
    if (entry.size > state.maxBytes) {
        return { state, dropped: 1 };
    }
    const combined = [...state.entries, entry];
    let totalBytes = state.totalBytes + entry.size;
    let dropCount = 0;
    let startIndex = 0;
    while (totalBytes > state.maxBytes && startIndex < combined.length) {
        totalBytes -= combined[startIndex].size;
        startIndex += 1;
        dropCount += 1;
    }
    const entries = startIndex > 0 ? combined.slice(startIndex) : combined;
    const nextState = Object.freeze({
        entries: Object.freeze(entries),
        totalBytes,
        maxBytes: state.maxBytes,
    });
    return { state: nextState, dropped: dropCount };
};
const takeBatch = (state, size) => {
    if (state.entries.length === 0 || size <= 0) {
        return { batch: Object.freeze([]), state };
    }
    const batch = state.entries.slice(0, size);
    const remaining = state.entries.slice(batch.length);
    const remainingBytes = state.totalBytes - sumEntryBytes(batch);
    const nextState = Object.freeze({
        entries: Object.freeze(remaining),
        totalBytes: remainingBytes,
        maxBytes: state.maxBytes,
    });
    return { batch: Object.freeze(batch), state: nextState };
};
const prependBatch = (state, batch) => {
    if (batch.length === 0) {
        return state;
    }
    const entries = [...batch, ...state.entries];
    const totalBytes = state.totalBytes + sumEntryBytes(batch);
    return Object.freeze({
        entries: Object.freeze(entries),
        totalBytes,
        maxBytes: state.maxBytes,
    });
};
const clampBatchSize = (value, fallback) => {
    if (!Number.isFinite(value) || value <= 0) {
        return fallback;
    }
    return value;
};
const createEntry = (subject, payload) => Object.freeze({ subject, payload, size: payload.byteLength });
export function createNatsTransport(options = {}) {
    const bufferMaxBytes = options.bufferMaxBytes ?? DEFAULT_MAX_BUFFER_BYTES;
    const minBatchSize = clampBatchSize(options.minBatchSize ?? DEFAULT_MIN_BATCH_SIZE, DEFAULT_MIN_BATCH_SIZE);
    const resolvedMaxBatch = clampBatchSize(options.maxBatchSize ?? DEFAULT_MAX_BATCH_SIZE, DEFAULT_MAX_BATCH_SIZE);
    const maxBatchSize = Math.max(minBatchSize, resolvedMaxBatch);
    const flushIntervalMs = options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
    const getConnection = options.getConnection;
    const textEncoder = new TextEncoder();
    const encoder = options.encode ?? ((value) => textEncoder.encode(value));
    let bufferState = createRingBuffer(bufferMaxBytes);
    let droppedCount = 0;
    let jetStreamAvailable = null;
    let flushTimer = null;
    let flushPromise = null;
    const scheduleFlush = () => {
        if (flushTimer) {
            return;
        }
        flushTimer = setTimeout(() => {
            void flush(true);
        }, flushIntervalMs);
    };
    const clearFlushTimer = () => {
        if (!flushTimer) {
            return;
        }
        clearTimeout(flushTimer);
        flushTimer = null;
    };
    const recordDrop = (count) => {
        if (count > 0) {
            droppedCount += count;
        }
    };
    const updateJetStreamAvailability = async (connection) => {
        try {
            await connection.jetstreamManager();
            jetStreamAvailable = true;
        }
        catch {
            jetStreamAvailable = false;
        }
    };
    const publishBatch = async (connection, batch) => {
        for (let index = 0; index < batch.length; index += 1) {
            const entry = batch[index];
            try {
                await connection.publish(entry.subject, entry.payload);
            }
            catch {
                return batch.slice(index);
            }
        }
        return [];
    };
    const runFlush = async (allowPartial) => {
        clearFlushTimer();
        if (bufferState.entries.length === 0) {
            return;
        }
        if (!getConnection) {
            scheduleFlush();
            return;
        }
        let connection;
        try {
            connection = await getConnection();
        }
        catch {
            scheduleFlush();
            return;
        }
        await updateJetStreamAvailability(connection);
        while (bufferState.entries.length > 0) {
            const available = bufferState.entries.length;
            const batchSize = Math.min(maxBatchSize, available);
            if (!allowPartial && batchSize < minBatchSize) {
                break;
            }
            const { batch, state } = takeBatch(bufferState, batchSize);
            bufferState = state;
            const remaining = await publishBatch(connection, batch);
            if (remaining.length > 0) {
                bufferState = prependBatch(bufferState, remaining);
                break;
            }
        }
        if (bufferState.entries.length > 0) {
            scheduleFlush();
        }
    };
    const flush = async (allowPartial = true) => {
        if (flushPromise) {
            return flushPromise;
        }
        flushPromise = runFlush(allowPartial).finally(() => {
            flushPromise = null;
        });
        return flushPromise;
    };
    const write = (input) => {
        const envelope = parseEnvelope(input);
        if (!envelope) {
            droppedCount += 1;
            return;
        }
        const serialized = safeStringify(envelope);
        if (!serialized) {
            droppedCount += 1;
            return;
        }
        const payload = encoder(serialized);
        const entry = createEntry(resolveSubject(envelope), payload);
        const result = appendEntry(bufferState, entry);
        bufferState = result.state;
        recordDrop(result.dropped);
        if (bufferState.entries.length >= minBatchSize) {
            void flush(false);
            return;
        }
        scheduleFlush();
    };
    const stop = async () => {
        clearFlushTimer();
        await flush(true);
    };
    const stats = () => Object.freeze({
        bufferedCount: bufferState.entries.length,
        bufferedBytes: bufferState.totalBytes,
        droppedCount,
        jetStreamAvailable,
    });
    return Object.freeze({ write, flush, stop, stats });
}
const PINO_LEVEL_TO_LOG_LEVEL = {
    10: 'DEBUG',
    20: 'INFO',
    30: 'WARN',
    40: 'ERROR',
    50: 'FATAL',
};
const transformToEnvelope = (traceContext, data) => {
    const pinoLevel = typeof data.level === 'number' ? data.level : 20;
    const logLevel = PINO_LEVEL_TO_LOG_LEVEL[pinoLevel] ?? 'INFO';
    const timestamp = typeof data.time === 'number' ? data.time : Date.now();
    const msg = typeof data.msg === 'string' ? data.msg : '';
    const { level, time, msg: _, ...rest } = data;
    const meta = { ...rest };
    if (traceContext.taskId) {
        meta.taskId = traceContext.taskId;
    }
    return Object.freeze({
        ts: timestamp,
        level: logLevel,
        node_id: traceContext.nodeId,
        source: traceContext.source,
        trace_id: traceContext.traceId,
        content: msg,
        meta: Object.freeze(meta),
    });
};
const createNoopLogger = () => Object.freeze({
    debug: () => { },
    info: () => { },
    warn: () => { },
    error: () => { },
    fatal: () => { },
});
const getNodeId = (nodeId) => {
    const envNodeId = process.env.MERISTEM_NODE_ID;
    if (envNodeId && envNodeId.length > 0) {
        return envNodeId;
    }
    return nodeId;
};
export function createClientLogger(isJoined, nodeId, getConnection) {
    const resolvedNodeId = getNodeId(nodeId);
    if (!isJoined || !resolvedNodeId) {
        return createNoopLogger();
    }
    const traceContext = createTraceContext({
        nodeId: resolvedNodeId,
        source: 'client',
    });
    const transport = createNatsTransport({
        getConnection,
    });
    const pinoLogger = pino({
        level: 'debug',
        base: null,
        timestamp: false,
        formatters: {
            level: () => ({}),
            bindings: () => ({}),
        },
    }, transport);
    const createLogMethod = (methodName) => (message, meta = {}) => {
        try {
            const pinoLevelMap = {
                debug: 10,
                info: 20,
                warn: 30,
                error: 40,
                fatal: 50,
            };
            const envelope = transformToEnvelope(traceContext, {
                level: pinoLevelMap[methodName],
                time: Date.now(),
                ...meta,
                msg: message,
            });
            pinoLogger[methodName](envelope);
        }
        catch (err) {
            const errorMessage = err instanceof Error ? err.message : String(err);
            pinoLogger.error({ msg: 'Logger error:', error: errorMessage });
        }
    };
    return Object.freeze({
        debug: createLogMethod('debug'),
        info: createLogMethod('info'),
        warn: createLogMethod('warn'),
        error: createLogMethod('error'),
        fatal: createLogMethod('fatal'),
    });
}
//# sourceMappingURL=logger.js.map