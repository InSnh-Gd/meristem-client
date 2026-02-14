import { natsManager } from '../nats/connection';
import { createClientLogger } from '../utils/logger';

const logger = createClientLogger(true, process.env.MERISTEM_NODE_ID, () => natsManager.connect());

/**
 * Pulse Message Format (HARDWARE_PROTOCOL.md §3.2)
 */
export interface PulseMessage {
  node_id: string;
  ts: number;           // Unix timestamp in milliseconds
  core: {
    cpu_load: number;    // CPU usage (0-0-1)
    ram_usage: number;    // RAM usage (0-0-1)
    net_io?: {
      in: number;       // Bytes received
      out: number;      // Bytes sent
    };
  };
}

/**
 * Pulse Service
 * Sends resource snapshot every 30s to meristem.v1.sys.pulse
 */
export class PulseService {
  private isRunning = false;
  private checkInterval: NodeJS.Timeout | null = null;

  /**
   * Start pulse service
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      logger.warn('Pulse service already running');
      return;
    }

    this.isRunning = true;
    logger.info('Pulse service started');

    // Send pulse every 30s
    this.checkInterval = setInterval(() => {
      void this.sendPulse().catch((error: unknown) => {
        const reason = error instanceof Error ? error.message : String(error);
        logger.warn('Pulse send loop failed', { error: reason });
      });
    }, 30000); // 30s

    // Graceful shutdown
    process.on('SIGTERM', () => this.stop());
    process.on('SIGINT', () => this.stop());
  }

  /**
   * Stop pulse service
   */
  async stop(): Promise<void> {
    if (!this.isRunning) {
      return;
    }

    this.isRunning = false;
    logger.info('Pulse service stopped');

    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }
  }

  /**
   * Send pulse message
   */
  private async sendPulse(): Promise<void> {
    try {
      let nc = natsManager.getConnection();
      if (!nc) {
        nc = await natsManager.connect();
      }

      const node_id = process.env.MERISTEM_NODE_ID || 'unknown';
      const ts = Date.now();

      // Collect CPU and RAM usage
      const cpuUsage = process.cpuUsage();
      const ramUsage = process.memoryUsage();

      const cpuTotal = cpuUsage.user + cpuUsage.system;
      const cpuLoad = cpuTotal > 0 ? cpuUsage.user / cpuTotal : 0;

      const message: PulseMessage = {
        node_id,
        ts,
        core: {
          cpu_load: cpuLoad,
          ram_usage: ramUsage.heapUsed / ramUsage.heapTotal,
          net_io: {
            in: 0,
            out: 0,
          },
        },
      };

      try {
        nc.publish('meristem.v1.sys.pulse', new TextEncoder().encode(JSON.stringify(message)));
      } catch {
        await natsManager.close();
        const reconnected = await natsManager.connect();
        reconnected.publish('meristem.v1.sys.pulse', new TextEncoder().encode(JSON.stringify(message)));
      }

      logger.debug('Pulse sent', { node_id, cpu_load: message.core.cpu_load });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      logger.error('Pulse publish failed', { error: reason });
    }
  }
}
