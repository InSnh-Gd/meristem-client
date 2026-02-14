import { natsManager } from '../nats/connection';
import { createClientLogger } from '../utils/logger';

const logger = createClientLogger(true, process.env.MERISTEM_NODE_ID, () => natsManager.connect());

/**
 * NATS Heartbeat Message Format (EVENT_BUS_SPEC.md §6.2)
 */
export interface NatsHeartbeatMessage {
  node_id: string;
  ts: number;           // Unix timestamp in milliseconds
  v: number;            // Config version
  claimed_ip: string;   // Agent claimed IP for Soft Reclamation
}

/**
 * Heartbeat Service
 * Sends heartbeat every 15s to meristem.v1.hb.[node_id]
 */
export class HeartbeatService {
  private isRunning = false;
  private checkInterval: NodeJS.Timeout | null = null;

  /**
   * Start heartbeat service
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      logger.warn('Heartbeat service already running');
      return;
    }

    this.isRunning = true;
    logger.info('Heartbeat service started');

    // Send heartbeat every 15s
    this.checkInterval = setInterval(() => {
      void this.sendHeartbeat().catch((error: unknown) => {
        const reason = error instanceof Error ? error.message : String(error);
        logger.warn('Heartbeat send loop failed', { error: reason });
      });
    }, 15000); // 15s

    // Graceful shutdown
    process.on('SIGTERM', () => this.stop());
    process.on('SIGINT', () => this.stop());
  }

  /**
   * Stop heartbeat service
   */
  async stop(): Promise<void> {
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
  private async sendHeartbeat(): Promise<void> {
    try {
      let nc = natsManager.getConnection();
      if (!nc) {
        nc = await natsManager.connect();
      }

      const node_id = process.env.MERISTEM_NODE_ID || 'unknown';
      const ts = Date.now();
      const v = 1;

      const message: NatsHeartbeatMessage = {
        node_id,
        ts,
        v,
        claimed_ip: process.env.MERISTEM_CLAIMED_IP || '',
      };

      try {
        nc.publish('meristem.v1.hb.' + node_id, new TextEncoder().encode(JSON.stringify(message)));
      } catch {
        await natsManager.close();
        const reconnected = await natsManager.connect();
        reconnected.publish('meristem.v1.hb.' + node_id, new TextEncoder().encode(JSON.stringify(message)));
      }

      logger.debug('Heartbeat sent', { node_id, ts });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      logger.error('Heartbeat publish failed', { error: reason });
    }
  }
}
