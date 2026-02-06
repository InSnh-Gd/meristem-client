import { natsManager } from '../nats/connection';
import { createClientLogger } from '../utils/logger';
const logger = createClientLogger(true, process.env.MERISTEM_NODE_ID, () => natsManager.connect());
/**
 * Heartbeat Service
 * Sends heartbeat every 15s to meristem.v1.hb.[node_id]
 */
export class HeartbeatService {
    isRunning = false;
    checkInterval = null;
    lastHeartbeatTs = 0;
    /**
     * Start heartbeat service
     */
    async start() {
        if (this.isRunning) {
            logger.warn('Heartbeat service already running');
            return;
        }
        this.isRunning = true;
        logger.info('Heartbeat service started');
        // Send heartbeat every 15s
        this.checkInterval = setInterval(() => {
            this.sendHeartbeat();
        }, 15000); // 15s
        // Graceful shutdown
        process.on('SIGTERM', () => this.stop());
        process.on('SIGINT', () => this.stop());
    }
    /**
     * Stop heartbeat service
     */
    async stop() {
        if (!this.isRunning) {
            return;
        }
        this.isRunning = false;
        logger.info('Heartbeat service stopped');
        if (this.checkInterval) {
            clearInterval(this.checkInterval);
            this.checkInterval = null;
        }
    }
    /**
     * Send heartbeat message
     */
    async sendHeartbeat() {
        const nc = natsManager.getConnection();
        if (!nc) {
            logger.error('NATS connection not available');
            return;
        }
        const node_id = process.env.MERISTEM_NODE_ID || 'unknown';
        const ts = Date.now();
        const v = 1;
        const message = {
            node_id,
            ts,
            v,
            claimed_ip: process.env.MERISTEM_CLAIMED_IP || '',
        };
        await nc.publish('meristem.v1.hb.' + node_id, new TextEncoder().encode(JSON.stringify(message)));
        logger.debug('Heartbeat sent', { node_id, ts });
    }
}
//# sourceMappingURL=heartbeat.js.map