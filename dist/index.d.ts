/**
 * Meristem Client - Zero-touch Node Join
 *
 * Implements NETWORK_SYSTEM.md §3 Zero-touch Join flow:
 * 1. Detect/generate HWID (SHA-256 of UUID + MAC)
 * 2. POST /api/v1/join to Core
 * 3. Persist node_id and auth_key
 * 4. MVP: Auto-approved (no admin approval wait)
 */
/**
 * Join result interface
 */
interface JoinResult {
    success: boolean;
    nodeId?: string;
    coreIp?: string;
    status?: 'new' | 'existing';
    message?: string;
    error?: string;
}
/**
 * Perform zero-touch join with Core
 * Implements NETWORK_SYSTEM.md §3.2 automatic handshake flow
 */
declare function performJoin(): Promise<JoinResult>;
/**
 * Main client initialization
 */
declare function main(): Promise<void>;
export { performJoin, main };
//# sourceMappingURL=index.d.ts.map