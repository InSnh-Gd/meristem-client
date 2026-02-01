declare module 'nats' {
  export interface ConnectionOptions {
    servers?: string | string[];
    reconnect?: boolean;
    maxReconnectAttempts?: number;
  }

  export interface Subscription {
    unsubscribe(): void;
  }

  export interface JsMsg {
    data: Uint8Array;
    subject: string;
    ack(): void;
  }

  export interface JetStreamSubscription extends AsyncIterable<JsMsg> {
    unsubscribe(): void;
  }

  export interface JetStreamClient {
    subscribe(subject: string, opts?: { manualAck?: boolean }): Promise<JetStreamSubscription>;
  }

  export interface NatsConnection {
    publish(subject: string, data: Uint8Array): Promise<void> | void;
    subscribe(
      subject: string,
      opts?: { callback?: (err: Error | null, msg: { data: Uint8Array; subject: string }) => void }
    ): Subscription;
    jetstream(): JetStreamClient;
    closed(): Promise<Error | void>;
    status(): AsyncIterable<{ type: string; data?: unknown }>;
    isClosed(): boolean;
    close(): Promise<void>;
  }

  export function connect(options: ConnectionOptions): Promise<NatsConnection>;

  export function JSONCodec<T = unknown>(): {
    encode(data: T): Uint8Array;
    decode(data: Uint8Array): T;
  };
}
