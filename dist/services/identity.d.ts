/**
 * Identity Service - HWID Generation and Node Identity Management
 *
 * Implements HARDWARE_PROTOCOL.md §2 HWID generation specification:
 * - HWID = SHA-256(UUID + MAC)
 * - UUID sourced from /sys/class/dmi/id/product_uuid (Linux)
 * - Fallback to system-specific identifiers on other platforms
 * - Supports node_id_override for manual configuration
 */
/**
 * Node credentials interface
 */
export interface NodeCredentials {
    node_id: string;
    auth_key?: string;
    hwid: string;
    registered_at: string;
    core_ip?: string;
}
/**
 * Join request payload
 */
export interface JoinRequest {
    hwid: string;
    hostname: string;
    persona: 'AGENT' | 'GIG';
    hardwareProfile?: HardwareProfile;
}
/**
 * Hardware profile interface
 */
export interface HardwareProfile {
    cpu?: {
        model: string;
        cores: number;
        threads?: number;
    };
    memory?: {
        total: number;
        available?: number;
        type?: string;
    };
    storage?: Array<{
        type?: string;
        size?: number;
        total?: number;
        available?: number;
    }>;
    gpu?: Array<{
        model: string;
        vram?: number;
        memory?: number;
    }>;
    os?: string;
    arch?: 'x86_64' | 'arm64';
}
/**
 * Join response from Core
 */
export interface JoinResponse {
    success: boolean;
    data?: {
        node_id: string;
        core_ip: string;
        status: 'new' | 'existing';
        message: string;
    };
    error?: string;
}
/**
 * Generate HWID according to HARDWARE_PROTOCOL.md §2
 * Algorithm: SHA-256(UUID + MAC)
 */
export declare function generateHwid(): string;
/**
 * Load persisted credentials
 */
export declare function loadCredentials(): Promise<NodeCredentials | null>;
/**
 * Save credentials to disk
 */
export declare function saveCredentials(credentials: NodeCredentials): Promise<void>;
/**
 * Get or generate HWID
 * Uses override if configured, otherwise generates from system
 */
export declare function getHwid(): Promise<string>;
/**
 * Get system hostname
 */
export declare function getHostname(): string;
/**
 * Detect system persona based on environment
  * Can be overridden via MERISTEM_IDENTITY_PERSONA env var
  */
export declare function detectPersona(): 'AGENT' | 'GIG';
/**
 * Collect basic hardware profile
 * Full implementation would read /proc/cpuinfo, /proc/meminfo, etc.
 */
export declare function collectHardwareProfile(): HardwareProfile;
/**
 * Clear persisted credentials (for re-join scenarios)
 */
export declare function clearCredentials(): Promise<void>;
/**
 * Check if node is already registered
 */
export declare function isRegistered(): Promise<boolean>;
/**
 * Get registered node ID
 */
export declare function getNodeId(): Promise<string | null>;
//# sourceMappingURL=identity.d.ts.map