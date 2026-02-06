/**
 * Pulse Message Format (HARDWARE_PROTOCOL.md §3.2)
 */
export interface PulseMessage {
    node_id: string;
    ts: number;
    core: {
        cpu_load: number;
        ram_usage: number;
        net_io?: {
            in: number;
            out: number;
        };
    };
}
/**
 * Pulse Service
 * Sends resource snapshot every 30s to meristem.v1.sys.pulse
 */
export declare class PulseService {
    private isRunning;
    private checkInterval;
    /**
     * Start pulse service
     */
    start(): Promise<void>;
    /**
     * Stop pulse service
     */
    stop(): Promise<void>;
    /**
     * Send pulse message
     */
    private sendPulse;
}
//# sourceMappingURL=pulse.d.ts.map