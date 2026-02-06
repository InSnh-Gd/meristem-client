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
      this.sendPulse();
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
    const nc = natsManager.getConnection();
    if (!nc) {
      logger.error('NATS connection not available');
      return;
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

    nc.publish('meristem.v1.sys.pulse', new TextEncoder().encode(JSON.stringify(message)));
    logger.debug('Pulse sent', { node_id, cpu_load: message.core.cpu_load });
  }
}
