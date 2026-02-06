import type { NatsConnection } from 'nats';
type TraceContextFields = {
    traceId: string;
    nodeId: string;
    source: string;
    taskId?: string;
};
type TraceContextInput = {
    traceId?: string;
    nodeId: string;
    source: string;
    taskId?: string;
};
export type TraceContext = Readonly<TraceContextFields>;
export type NatsTransportOptions = Readonly<{
    readonly bufferMaxBytes?: number;
    readonly minBatchSize?: number;
    readonly maxBatchSize?: number;
    readonly flushIntervalMs?: number;
    readonly getConnection?: () => Promise<NatsConnection>;
    readonly encode?: (value: string) => Uint8Array;
}>;
export type TransportStats = Readonly<{
    readonly bufferedCount: number;
    readonly bufferedBytes: number;
    readonly droppedCount: number;
    readonly jetStreamAvailable: boolean | null;
}>;
export type NatsTransport = Readonly<{
    readonly write: (input: unknown) => void;
    readonly flush: (allowPartial?: boolean) => Promise<void>;
    readonly stop: () => Promise<void>;
    readonly stats: () => TransportStats;
}>;
export type Logger = Readonly<{
    readonly debug: (message: string, meta?: Record<string, unknown>) => void;
    readonly info: (message: string, meta?: Record<string, unknown>) => void;
    readonly warn: (message: string, meta?: Record<string, unknown>) => void;
    readonly error: (message: string, meta?: Record<string, unknown>) => void;
    readonly fatal: (message: string, meta?: Record<string, unknown>) => void;
}>;
export declare function generateTraceId(): string;
export declare function createTraceContext(props: TraceContextInput): TraceContext;
export declare function withTaskId(ctx: TraceContext, taskId: string): TraceContext;
export declare function withSource(ctx: TraceContext, source: string): TraceContext;
export declare function withNodeId(ctx: TraceContext, nodeId: string): TraceContext;
export declare function createNatsTransport(options?: NatsTransportOptions): NatsTransport;
export declare function createClientLogger(isJoined: boolean, nodeId?: string, getConnection?: () => Promise<NatsConnection>): Logger;
export {};
//# sourceMappingURL=logger.d.ts.map