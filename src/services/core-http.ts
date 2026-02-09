import type {
  JoinRequestPayload,
  JoinResponsePayload,
} from '@insnh-gd/meristem-shared';
import {
  CORE_API_PATHS,
  WIRE_CONTRACT_VERSION,
} from '@insnh-gd/meristem-shared';

export type CoreHttpClient = Readonly<{
  join: (payload: JoinRequestPayload) => Promise<JoinResponsePayload>;
}>;

const normalizeBaseUrl = (baseUrl: string): string =>
  baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;

const parseJoinResponse = (raw: unknown): JoinResponsePayload => {
  if (
    typeof raw === 'object' &&
    raw !== null &&
    'success' in raw &&
    typeof (raw as { success: unknown }).success === 'boolean'
  ) {
    return raw as JoinResponsePayload;
  }

  return {
    success: false,
    error: 'INVALID_JOIN_RESPONSE',
  };
};

export const createCoreHttpClient = (baseUrl: string): CoreHttpClient => {
  const normalizedBaseUrl = normalizeBaseUrl(baseUrl);
  const joinUrl = `${normalizedBaseUrl}${CORE_API_PATHS.join}`;

  return Object.freeze({
    join: async (payload: JoinRequestPayload): Promise<JoinResponsePayload> => {
      const response = await fetch(joinUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Wire-Contract-Version': WIRE_CONTRACT_VERSION,
        },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        const errorText = await response.text();
        return {
          success: false,
          error: `HTTP ${response.status}: ${errorText}`,
        };
      }

      return parseJoinResponse(await response.json());
    },
  });
};

