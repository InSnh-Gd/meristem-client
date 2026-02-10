import { treaty } from '@elysiajs/eden';
import { parseWsPushMessage, type WsPushMessage, type WsTopic } from '@insnh-gd/meristem-shared';

type SubscribeOptions = {
  query: {
    token: string;
    topic: WsTopic;
  };
};

type SubscribePacket = {
  data: unknown;
  rawData?: unknown;
};

type TreatyWsSubscription = {
  subscribe: (handler: (packet: SubscribePacket) => void) => (() => void) | void;
  close: () => void;
};

type TreatyWsClient = {
  ws: {
    subscribe: (options: SubscribeOptions) => Promise<TreatyWsSubscription>;
  };
};

type TreatyClientFactory = (baseUrl: string) => TreatyWsClient;

export type SubscribeTopicOptions = {
  token: string;
  topic: WsTopic;
  onPush: (message: WsPushMessage) => void;
};

export type CoreWsSession = {
  close: () => void;
};

export type CoreEdenWsClient = {
  subscribeTopic: (options: SubscribeTopicOptions) => Promise<CoreWsSession>;
};

export type CreateCoreEdenWsClientOptions = {
  createTreatyClient?: TreatyClientFactory;
};

const normalizeBaseUrl = (value: string): string => value.replace(/\/+$/, '');

const defaultTreatyClientFactory: TreatyClientFactory = (baseUrl) =>
  treaty(normalizeBaseUrl(baseUrl)) as unknown as TreatyWsClient;

const isCloser = (value: unknown): value is () => void => typeof value === 'function';

export const createCoreEdenWsClient = (
  baseUrl: string,
  options: CreateCoreEdenWsClientOptions = {},
): CoreEdenWsClient => {
  const createTreatyClient = options.createTreatyClient ?? defaultTreatyClientFactory;
  const treatyClient = createTreatyClient(normalizeBaseUrl(baseUrl));

  return Object.freeze({
    subscribeTopic: async ({ token, topic, onPush }: SubscribeTopicOptions): Promise<CoreWsSession> => {
      const subscription = await treatyClient.ws.subscribe({
        query: {
          token,
          topic,
        },
      });

      const unsubscribe = subscription.subscribe((packet) => {
        const message = parseWsPushMessage(packet.data);
        if (!message) {
          return;
        }
        if (message.topic !== topic) {
          return;
        }
        onPush(message);
      });

      return Object.freeze({
        close: () => {
          if (isCloser(unsubscribe)) {
            unsubscribe();
          }
          subscription.close();
        },
      });
    },
  });
};
