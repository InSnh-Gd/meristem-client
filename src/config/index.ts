import { parse } from '@iarna/toml';
import { readFileSync, existsSync } from 'fs';
import { ClientConfig } from './schema.js';

const CONFIG_PATHS = [
    './config.toml',
    '/etc/meristem/config.toml',
];

type PartialClientConfig = {
    core?: Partial<ClientConfig['core']>;
    identity?: Partial<ClientConfig['identity']>;
    paths?: Partial<ClientConfig['paths']>;
    network?: Partial<ClientConfig['network']>;
    heartbeat?: Partial<ClientConfig['heartbeat']>;
    logging?: Partial<ClientConfig['logging']>;
    gig?: Partial<ClientConfig['gig']>;
};

const isObject = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null;

const toPartialClientConfig = (value: unknown): PartialClientConfig => {
    if (!isObject(value)) {
        return {};
    }
    return value as PartialClientConfig;
};

const parseBoolean = (value: unknown, fallback: boolean): boolean => {
    if (typeof value === 'boolean') {
        return value;
    }
    if (typeof value === 'string') {
        const normalized = value.trim().toLowerCase();
        if (normalized === 'true') {
            return true;
        }
        if (normalized === 'false') {
            return false;
        }
    }
    return fallback;
};

const parsePositiveInt = (value: unknown, fallback: number): number => {
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
        return Math.floor(value);
    }
    if (typeof value === 'string') {
        const parsed = Number.parseInt(value, 10);
        if (Number.isFinite(parsed) && parsed > 0) {
            return parsed;
        }
    }
    return fallback;
};

const parseRetryBackoff = (value: unknown, fallback: number[]): number[] => {
    if (Array.isArray(value)) {
        const fromArray = value
            .map((item) => parsePositiveInt(item, 0))
            .filter((item) => item > 0);
        if (fromArray.length > 0) {
            return fromArray;
        }
        return fallback;
    }

    if (typeof value === 'string') {
        const fromString = value
            .split(',')
            .map((item) => parsePositiveInt(item.trim(), 0))
            .filter((item) => item > 0);
        if (fromString.length > 0) {
            return fromString;
        }
    }

    return fallback;
};

export function loadConfig(): ClientConfig {
    let configPath: string | null = null;

    for (const path of CONFIG_PATHS) {
        if (existsSync(path)) {
            configPath = path;
            break;
        }
    }

    let fileConfig: PartialClientConfig = {};
    if (configPath) {
        const content = readFileSync(configPath, 'utf-8');
        fileConfig = toPartialClientConfig(parse(content));
    }

    const defaultRetryBackoff = [1000, 5000, 15000];
    const config: ClientConfig = {
        core: {
            address: process.env.MERISTEM_CORE_ADDRESS ?? process.env.MERISTEM_CORE_URL ?? fileConfig.core?.address ?? '',
        },
        identity: {
            auth_key: process.env.MERISTEM_IDENTITY_AUTH_KEY ?? fileConfig.identity?.auth_key,
            persona: (process.env.MERISTEM_IDENTITY_PERSONA ?? fileConfig.identity?.persona ?? 'AGENT') as 'AGENT' | 'GIG',
        },
        paths: {
            data_dir: process.env.MERISTEM_PATHS_DATA_DIR ?? fileConfig.paths?.data_dir ?? '/var/lib/meristem',
            temp_dir: process.env.MERISTEM_PATHS_TEMP_DIR ?? fileConfig.paths?.temp_dir ?? '/tmp/meristem',
            pending_dir: process.env.MERISTEM_PATHS_PENDING_DIR ?? fileConfig.paths?.pending_dir ?? '/var/lib/meristem/pending',
        },
        network: {
            extreme_mode: parseBoolean(process.env.MERISTEM_NETWORK_EXTREME_MODE ?? fileConfig.network?.extreme_mode, false),
            forced_tcp: parseBoolean(process.env.MERISTEM_NETWORK_FORCED_TCP ?? fileConfig.network?.forced_tcp, false),
            stun_timeout: parsePositiveInt(process.env.MERISTEM_NETWORK_STUN_TIMEOUT ?? fileConfig.network?.stun_timeout, 2000),
        },
        heartbeat: {
            interval: parsePositiveInt(process.env.MERISTEM_HEARTBEAT_INTERVAL ?? fileConfig.heartbeat?.interval, 15000),
            pulse_interval: parsePositiveInt(process.env.MERISTEM_HEARTBEAT_PULSE_INTERVAL ?? fileConfig.heartbeat?.pulse_interval, 30000),
        },
        logging: {
            level: (process.env.MERISTEM_LOGGING_LEVEL ?? fileConfig.logging?.level ?? 'info') as 'debug' | 'info' | 'warn' | 'error',
            format: (process.env.MERISTEM_LOGGING_FORMAT ?? fileConfig.logging?.format ?? 'json') as 'json' | 'pretty',
        },
        gig: {
            max_retries: parsePositiveInt(
                process.env.MERISTEM_GIG_MAX_RETRIES ?? fileConfig.gig?.max_retries,
                3,
            ),
            retry_backoff_ms: parseRetryBackoff(
                process.env.MERISTEM_GIG_RETRY_BACKOFF_MS ?? fileConfig.gig?.retry_backoff_ms,
                defaultRetryBackoff,
            ),
        },
    };

    if (!config.core.address) {
        throw new Error('Configuration Error: core.address is required');
    }

    return config;
}
