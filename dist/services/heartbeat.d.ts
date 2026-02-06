/**
 * NATS Heartbeat Message Format (EVENT_BUS_SPEC.md §6.2)
 */
export interface NatsHeartbeatMessage {
    node_id: string;
    ts: number;
    v: number;
    claimed_ip: string;
}
/**
 * Heartbeat Service
 * Sends heartbeat every 15s to meristem.v1.hb.[node_id]
 */
export declare class HeartbeatService {
    private isRunning;
    private checkInterval;
    private lastHeartbeatTs;
    /**
     * Start heartbeat service
     */
    start(): Promise<void>;
    /**
     * Stop heartbeat service
     */
    stop(): Promise<void>;
    /**
     * Send heartbeat message
     */
    private sendHeartbeat;
}
//# sourceMappingURL=heartbeat.d.ts.map