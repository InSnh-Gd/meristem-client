import { connect, type NatsConnection } from 'nats';

const DEFAULT_NATS_TIMEOUT_MS = 5000;
const DEFAULT_BASE_DELAY_MS = 1000;

export type NatsConnectivityCheckResult = Readonly<{
  connected: boolean;
  lastError?: string;
}>;

export type NatsRetryResult = Readonly<{
  connected: boolean;
  attempts: number;
  lastError?: string;
}>;

const sleep = (delayMs: number): Promise<void> => {
  return new Promise((resolve) => {
    setTimeout(resolve, delayMs);
  });
};

const normalizeRetryCount = (maxRetries: number): number => {
  if (!Number.isFinite(maxRetries) || maxRetries < 0) {
    return 0;
  }

  return Math.floor(maxRetries);
};

const normalizeBaseDelay = (baseDelayMs: number): number => {
  if (!Number.isFinite(baseDelayMs) || baseDelayMs <= 0) {
    return DEFAULT_BASE_DELAY_MS;
  }

  return Math.floor(baseDelayMs);
};

const formatError = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export async function checkNatsConnectivityDetailed(
  natsUrl: string,
): Promise<NatsConnectivityCheckResult> {
  let connection: NatsConnection | null = null;

  try {
    connection = await connect({
      servers: natsUrl,
      timeout: DEFAULT_NATS_TIMEOUT_MS,
    });
    return { connected: true };
  } catch (error) {
    return {
      connected: false,
      lastError: formatError(error),
    };
  } finally {
    if (connection) {
      await connection.close();
    }
  }
}

export async function checkNatsConnectivity(natsUrl: string): Promise<boolean> {
  const result = await checkNatsConnectivityDetailed(natsUrl);
  return result.connected;
}

export async function waitForNatsWithRetryDetailed(
  natsUrl: string,
  maxRetries = 5,
  baseDelayMs = DEFAULT_BASE_DELAY_MS,
): Promise<NatsRetryResult> {
  const retryCount = normalizeRetryCount(maxRetries);
  const initialDelayMs = normalizeBaseDelay(baseDelayMs);
  let lastError: string | undefined;

  /**
   * 在 OTA 预检查阶段，先做一次即时连通性探测；若失败再进入指数退避。
   * 这样可在 NATS 已可用时快速放行，同时在短暂抖动时避免高频重试放大负载。
   */
  for (let attempt = 0; attempt <= retryCount; attempt += 1) {
    const connectivity = await checkNatsConnectivityDetailed(natsUrl);
    if (connectivity.connected) {
      return {
        connected: true,
        attempts: attempt + 1,
      };
    }
    lastError = connectivity.lastError;

    if (attempt === retryCount) {
      break;
    }

    /**
     * 失败路径使用 2^attempt 的退避系数：默认延迟序列为 1s/2s/4s/8s/16s。
     * 当达到最大重试次数后返回 false，由上层 OTA 状态机执行回滚或中止。
     */
    const delayMs = initialDelayMs * 2 ** attempt;
    await sleep(delayMs);
  }

  return {
    connected: false,
    attempts: retryCount + 1,
    lastError,
  };
}

export async function waitForNatsWithRetry(
  natsUrl: string,
  maxRetries = 5,
  baseDelayMs = DEFAULT_BASE_DELAY_MS,
): Promise<boolean> {
  const result = await waitForNatsWithRetryDetailed(natsUrl, maxRetries, baseDelayMs);
  return result.connected;
}
