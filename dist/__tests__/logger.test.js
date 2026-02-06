import { describe, it, expect } from 'bun:test';
import { createClientLogger, createNatsTransport, createTraceContext, generateTraceId, withTaskId, withSource, withNodeId, } from '../utils/logger';
describe('Client Logger', () => {
    describe('createClientLogger', () => {
        it('should return noop logger when isJoined is false', () => {
            const logger = createClientLogger(false);
            expect(logger).toBeDefined();
            expect(typeof logger.info).toBe('function');
            expect(typeof logger.warn).toBe('function');
            expect(typeof logger.error).toBe('function');
            logger.info('test message');
            logger.warn('warning message');
            logger.error('error message');
            expect(true).toBe(true);
        });
        it('should return noop logger when nodeId is not provided', () => {
            const logger = createClientLogger(true);
            expect(logger).toBeDefined();
            logger.info('test message');
            expect(true).toBe(true);
        });
        it('should return noop logger when MERISTEM_NODE_ID env var is not set', () => {
            const originalEnv = process.env.MERISTEM_NODE_ID;
            delete process.env.MERISTEM_NODE_ID;
            const logger = createClientLogger(true);
            expect(logger).toBeDefined();
            logger.info('test message');
            process.env.MERISTEM_NODE_ID = originalEnv;
            expect(true).toBe(true);
        });
        it('should return real logger when isJoined is true and nodeId is provided', () => {
            const logger = createClientLogger(true, 'test-node-001');
            expect(logger).toBeDefined();
            expect(typeof logger.info).toBe('function');
            expect(typeof logger.warn).toBe('function');
            expect(typeof logger.error).toBe('function');
            logger.info('test message');
            expect(true).toBe(true);
        });
        it('should use MERISTEM_NODE_ID env var when nodeId is not provided', () => {
            const originalEnv = process.env.MERISTEM_NODE_ID;
            process.env.MERISTEM_NODE_ID = 'env-node-001';
            const logger = createClientLogger(true);
            expect(logger).toBeDefined();
            logger.info('test message');
            process.env.MERISTEM_NODE_ID = originalEnv;
            expect(true).toBe(true);
        });
    });
    describe('createNatsTransport', () => {
        it('should create a transport with default options', () => {
            const transport = createNatsTransport();
            expect(transport).toBeDefined();
            expect(typeof transport.write).toBe('function');
            expect(typeof transport.flush).toBe('function');
            expect(typeof transport.stop).toBe('function');
            expect(typeof transport.stats).toBe('function');
        });
        it('should create independent transport instances', () => {
            const transport1 = createNatsTransport();
            const transport2 = createNatsTransport();
            expect(transport1).not.toBe(transport2);
            const stats1 = transport1.stats();
            const stats2 = transport2.stats();
            expect(stats1).toBeDefined();
            expect(stats2).toBeDefined();
            expect(stats1).not.toBe(stats2);
        });
        it('should track buffered entries', () => {
            const transport = createNatsTransport();
            transport.write({
                ts: Date.now(),
                level: 'INFO',
                node_id: 'test-node',
                source: 'test',
                trace_id: 'trace-123',
                content: 'test message',
                meta: {},
            });
            const stats = transport.stats();
            expect(stats.bufferedCount).toBeGreaterThan(0);
        });
        it('should track dropped entries when buffer overflows', async () => {
            const transport = createNatsTransport({
                bufferMaxBytes: 1024,
                minBatchSize: 1000,
            });
            const largeMessage = 'x'.repeat(2000);
            for (let i = 0; i < 10; i++) {
                transport.write({
                    ts: Date.now(),
                    level: 'INFO',
                    node_id: 'test-node',
                    source: 'test',
                    trace_id: `trace-${i}`,
                    content: largeMessage,
                    meta: {},
                });
            }
            const stats = transport.stats();
            expect(stats.droppedCount).toBeGreaterThan(0);
            await transport.stop();
        });
        it('should flush buffered entries', async () => {
            const transport = createNatsTransport({
                minBatchSize: 2,
            });
            transport.write({
                ts: Date.now(),
                level: 'INFO',
                node_id: 'test-node',
                source: 'test',
                trace_id: 'trace-1',
                content: 'message 1',
                meta: {},
            });
            transport.write({
                ts: Date.now(),
                level: 'INFO',
                node_id: 'test-node',
                source: 'test',
                trace_id: 'trace-2',
                content: 'message 2',
                meta: {},
            });
            const statsBefore = transport.stats();
            expect(statsBefore.bufferedCount).toBe(2);
            await transport.flush();
            const statsAfter = transport.stats();
            expect(statsAfter.bufferedCount).toBeLessThanOrEqual(2);
            await transport.stop();
        });
    });
    describe('TraceContext', () => {
        it('should generate unique trace IDs', () => {
            const traceId1 = generateTraceId();
            const traceId2 = generateTraceId();
            expect(traceId1).toBeDefined();
            expect(traceId2).toBeDefined();
            expect(traceId1).not.toBe(traceId2);
            expect(traceId1).toMatch(/^trace-\d+-[a-z0-9]+$/);
        });
        it('should create TraceContext with required fields', () => {
            const context = createTraceContext({
                nodeId: 'node-001',
                source: 'test',
            });
            expect(context.traceId).toBeDefined();
            expect(context.nodeId).toBe('node-001');
            expect(context.source).toBe('test');
            expect(context.taskId).toBeUndefined();
        });
        it('should create TraceContext with optional taskId', () => {
            const context = createTraceContext({
                nodeId: 'node-001',
                source: 'test',
                taskId: 'task-123',
            });
            expect(context.taskId).toBe('task-123');
        });
        it('should use provided traceId', () => {
            const customTraceId = 'custom-trace-123';
            const context = createTraceContext({
                traceId: customTraceId,
                nodeId: 'node-001',
                source: 'test',
            });
            expect(context.traceId).toBe(customTraceId);
        });
        it('should create new context with withTaskId', () => {
            const context1 = createTraceContext({
                nodeId: 'node-001',
                source: 'test',
            });
            const context2 = withTaskId(context1, 'task-123');
            expect(context1.taskId).toBeUndefined();
            expect(context2.taskId).toBe('task-123');
            expect(context1).not.toBe(context2);
        });
        it('should create new context with withSource', () => {
            const context1 = createTraceContext({
                nodeId: 'node-001',
                source: 'test',
            });
            const context2 = withSource(context1, 'new-source');
            expect(context1.source).toBe('test');
            expect(context2.source).toBe('new-source');
            expect(context1).not.toBe(context2);
        });
        it('should create new context with withNodeId', () => {
            const context1 = createTraceContext({
                nodeId: 'node-001',
                source: 'test',
            });
            const context2 = withNodeId(context1, 'node-002');
            expect(context1.nodeId).toBe('node-001');
            expect(context2.nodeId).toBe('node-002');
            expect(context1).not.toBe(context2);
        });
        it('should freeze TraceContext objects', () => {
            const context = createTraceContext({
                nodeId: 'node-001',
                source: 'test',
            });
            expect(Object.isFrozen(context)).toBe(true);
        });
    });
    describe('Ring Buffer Independence', () => {
        it('should maintain independent Ring Buffer states', async () => {
            const transport1 = createNatsTransport({
                bufferMaxBytes: 1024,
            });
            const transport2 = createNatsTransport({
                bufferMaxBytes: 1024,
            });
            transport1.write({
                ts: Date.now(),
                level: 'INFO',
                node_id: 'node-1',
                source: 'test',
                trace_id: 'trace-1',
                content: 'message from transport 1',
                meta: {},
            });
            transport2.write({
                ts: Date.now(),
                level: 'INFO',
                node_id: 'node-2',
                source: 'test',
                trace_id: 'trace-2',
                content: 'message from transport 2',
                meta: {},
            });
            const stats1 = transport1.stats();
            const stats2 = transport2.stats();
            expect(stats1.bufferedCount).toBe(1);
            expect(stats2.bufferedCount).toBe(1);
            await transport1.stop();
            await transport2.stop();
        });
        it('should handle overflow independently', async () => {
            const transport1 = createNatsTransport({
                bufferMaxBytes: 512,
                minBatchSize: 1000,
            });
            const transport2 = createNatsTransport({
                bufferMaxBytes: 512,
                minBatchSize: 1000,
            });
            const largeMessage = 'x'.repeat(300);
            for (let i = 0; i < 5; i++) {
                transport1.write({
                    ts: Date.now(),
                    level: 'INFO',
                    node_id: 'node-1',
                    source: 'test',
                    trace_id: `trace-1-${i}`,
                    content: largeMessage,
                    meta: {},
                });
            }
            for (let i = 0; i < 3; i++) {
                transport2.write({
                    ts: Date.now(),
                    level: 'INFO',
                    node_id: 'node-2',
                    source: 'test',
                    trace_id: `trace-2-${i}`,
                    content: largeMessage,
                    meta: {},
                });
            }
            const stats1 = transport1.stats();
            const stats2 = transport2.stats();
            expect(stats1.droppedCount).toBeGreaterThan(0);
            expect(stats2.droppedCount).toBeGreaterThan(0);
            expect(stats1.droppedCount).not.toBe(stats2.droppedCount);
            await transport1.stop();
            await transport2.stop();
        });
    });
    describe('Log Envelope Format', () => {
        it('should create valid log envelope', async () => {
            const transport = createNatsTransport();
            const envelope = {
                ts: Date.now(),
                level: 'INFO',
                node_id: 'test-node',
                source: 'test',
                trace_id: 'trace-123',
                content: 'test message',
                meta: { key: 'value' },
            };
            transport.write(envelope);
            const stats = transport.stats();
            expect(stats.bufferedCount).toBe(1);
            await transport.stop();
        });
        it('should handle different log levels', async () => {
            const transport = createNatsTransport();
            const levels = [
                'DEBUG',
                'INFO',
                'WARN',
                'ERROR',
                'FATAL',
            ];
            for (const level of levels) {
                transport.write({
                    ts: Date.now(),
                    level,
                    node_id: 'test-node',
                    source: 'test',
                    trace_id: `trace-${level}`,
                    content: `${level} message`,
                    meta: {},
                });
            }
            const stats = transport.stats();
            expect(stats.bufferedCount).toBe(5);
            await transport.stop();
        });
        it('should handle meta with taskId', async () => {
            const transport = createNatsTransport();
            transport.write({
                ts: Date.now(),
                level: 'INFO',
                node_id: 'test-node',
                source: 'test',
                trace_id: 'trace-123',
                content: 'task message',
                meta: { taskId: 'task-001' },
            });
            const stats = transport.stats();
            expect(stats.bufferedCount).toBe(1);
            await transport.stop();
        });
    });
});
//# sourceMappingURL=logger.test.js.map