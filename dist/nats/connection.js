import { connect } from 'nats';
const resolveConfig = (override = {}) => {
    return {
        servers: override.servers ?? process.env.MERISTEM_NATS_URL ?? 'nats://localhost:4222',
        token: override.token ?? process.env.MERISTEM_NATS_TOKEN,
        timeoutMs: override.timeoutMs ?? 5000,
    };
};
let connection = null;
const connectInternal = async (override = {}) => {
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
const closeInternal = async () => {
    if (!connection) {
        return;
    }
    await connection.close();
    connection = null;
};
const getConnection = () => connection;
export const natsManager = {
    connect: connectInternal,
    close: closeInternal,
    getConnection,
};
//# sourceMappingURL=connection.js.map