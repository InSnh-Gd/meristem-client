import { parse } from '@iarna/toml';
import { readFileSync, existsSync } from 'fs';
import { ClientConfig } from './schema.js';

const CONFIG_PATHS = [
    './config.toml',
    '/etc/meristem/config.toml',
];

export function loadConfig(): ClientConfig {
    let configPath: string | null = null;

    for (const path of CONFIG_PATHS) {
        if (existsSync(path)) {
            configPath = path;
            break;
        }
    }

    let fileConfig: any = {};
    if (configPath) {
        const content = readFileSync(configPath, 'utf-8');
        fileConfig = parse(content);
    }

    const config: ClientConfig = {
        core: {
            address: process.env.MERISTEM_CORE_ADDRESS ?? fileConfig.core?.address ?? '',
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
            extreme_mode: (process.env.MERISTEM_NETWORK_EXTREME_MODE ?? fileConfig.network?.extreme_mode ?? false) === 'true' || fileConfig.network?.extreme_mode === true,
            forced_tcp: (process.env.MERISTEM_NETWORK_FORCED_TCP ?? fileConfig.network?.forced_tcp ?? false) === 'true' || fileConfig.network?.forced_tcp === true,
            stun_timeout: Number(process.env.MERISTEM_NETWORK_STUN_TIMEOUT ?? fileConfig.network?.stun_timeout ?? 2000),
        },
        heartbeat: {
            interval: Number(process.env.MERISTEM_HEARTBEAT_INTERVAL ?? fileConfig.heartbeat?.interval ?? 15000),
            pulse_interval: Number(process.env.MERISTEM_HEARTBEAT_PULSE_INTERVAL ?? fileConfig.heartbeat?.pulse_interval ?? 30000),
        },
        logging: {
            level: (process.env.MERISTEM_LOGGING_LEVEL ?? fileConfig.logging?.level ?? 'info') as 'debug' | 'info' | 'warn' | 'error',
            format: (process.env.MERISTEM_LOGGING_FORMAT ?? fileConfig.logging?.format ?? 'json') as 'json' | 'pretty',
        },
    };

    if (!config.core.address) {
        throw new Error('Configuration Error: core.address is required');
    }

    return config;
}
