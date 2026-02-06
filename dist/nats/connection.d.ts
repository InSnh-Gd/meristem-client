import { type NatsConnection } from 'nats';
type NatsConfig = Readonly<{
    servers?: string;
    token?: string;
    timeoutMs?: number;
}>;
export declare const natsManager: {
    connect: (override?: NatsConfig) => Promise<NatsConnection>;
    close: () => Promise<void>;
    getConnection: () => NatsConnection | null;
};
export {};
//# sourceMappingURL=connection.d.ts.map