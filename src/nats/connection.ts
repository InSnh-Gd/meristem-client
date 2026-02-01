import { connect, JSONCodec } from 'nats';
import type { ConnectionOptions, JetStreamClient, NatsConnection } from 'nats';
import { logger } from '../utils/logger';

const DEFAULT_NATS_URL = process.env.MERISTEM_NATS_URL || 'nats://localhost:4222';

class NatsConnectionManager {
  private nc: NatsConnection | null = null;
  private js: JetStreamClient | null = null;
  private readonly codec = JSONCodec();

  async connect(): Promise<void> {
    if (this.nc) {
      logger.warn('NATS connection already established');
      return;
    }

    const options: ConnectionOptions = {
      servers: DEFAULT_NATS_URL,
      reconnect: true,
      maxReconnectAttempts: -1,
    };

    logger.info('Connecting to NATS', { url: DEFAULT_NATS_URL });

    this.nc = await connect(options);
    this.js = this.nc.jetstream();
    logger.info('NATS connection established');

    this.nc.closed().then((err) => {
      if (err) {
        logger.error('NATS connection closed with error', { error: err.message });
      } else {
        logger.info('NATS connection closed');
      }
      this.nc = null;
      this.js = null;
    });

    (async () => {
      const nc = this.nc;
      if (!nc) return;
      for await (const status of nc.status()) {
        if (status.type === 'disconnect') {
          logger.warn('NATS disconnected');
        } else if (status.type === 'reconnect') {
          logger.info('NATS reconnected');
        } else if (status.type === 'error') {
          logger.error('NATS error', { error: String(status.data) });
        }
      }
    })();
  }

  async disconnect(): Promise<void> {
    if (!this.nc) {
      return;
    }

    await this.nc.close();
  }

  getConnection(): NatsConnection {
    if (!this.nc) {
      throw new Error('NATS connection not established. Call connect() first.');
    }
    return this.nc;
  }

  getJetStream(): JetStreamClient {
    if (!this.js) {
      throw new Error('JetStream client not initialized. Call connect() first.');
    }
    return this.js;
  }

  getCodec(): ReturnType<typeof JSONCodec> {
    return this.codec;
  }

  isConnected(): boolean {
    return this.nc !== null && this.nc.isClosed() === false;
  }
}

export const natsManager = new NatsConnectionManager();
