export interface ClientConfig {
    core: {
        address: string;
    };
    identity: {
        auth_key?: string;
        persona: 'AGENT' | 'GIG';
    };
    paths: {
        data_dir: string;
        temp_dir: string;
        pending_dir: string;
    };
    network: {
        extreme_mode: boolean;
        forced_tcp: boolean;
        stun_timeout: number;
    };
    heartbeat: {
        interval: number;
        pulse_interval: number;
    };
    logging: {
        level: 'debug' | 'info' | 'warn' | 'error';
        format: 'json' | 'pretty';
    };
}
