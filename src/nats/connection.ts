import { connect, type NatsConnection } from 'nats';

type NatsConfig = Readonly<{
  servers?: string;
  token?: string;
  timeoutMs?: number;
}>;

const resolveConfig = (override: NatsConfig = {}): NatsConfig => {
  return {
    servers: override.servers ?? process.env.MERISTEM_NATS_URL ?? 'nats://localhost:4222',
    token: override.token ?? process.env.MERISTEM_NATS_TOKEN,
    timeoutMs: override.timeoutMs ?? 5000,
  };
};

let connection: NatsConnection | null = null;

const connectInternal = async (override: NatsConfig = {}): Promise<NatsConnection> => {
  if (connection) {
    return connection;
  }

  const config = resolveConfig(override);
  const nc = await connect({
    servers: config.servers,
    token: config.token,
    timeout: config.timeoutMs,
  });
  connection = nc;
  return nc;
};

const closeInternal = async (): Promise<void> => {
  if (!connection) {
    return;
  }
  await connection.close();
  connection = null;
};

const getConnection = (): NatsConnection | null => connection;

export const natsManager = {
  connect: connectInternal,
  close: closeInternal,
  getConnection,
};
