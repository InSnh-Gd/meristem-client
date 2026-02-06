/**
 * Meristem Client - Zero-touch Node Join
 *
 * Implements NETWORK_SYSTEM.md §3 Zero-touch Join flow:
 * 1. Detect/generate HWID (SHA-256 of UUID + MAC)
 * 2. POST /api/v1/join to Core
 * 3. Persist node_id and auth_key
 * 4. MVP: Auto-approved (no admin approval wait)
 */
import { getHwid, getHostname, detectPersona, collectHardwareProfile, loadCredentials, saveCredentials, isRegistered, } from './services/identity.js';
import { createClientLogger } from './utils/logger.js';
// Core endpoint configuration
const CORE_URL = process.env.MERISTEM_CORE_URL || 'http://localhost:3000';
const JOIN_ENDPOINT = `${CORE_URL}/api/v1/join`;
/**
 * Perform zero-touch join with Core
 * Implements NETWORK_SYSTEM.md §3.2 automatic handshake flow
 */
async function performJoin() {
    try {
        // Check if already registered
        if (await isRegistered()) {
            const creds = await loadCredentials();
            if (creds?.node_id) {
                const logger = createClientLogger(true, creds.node_id);
                logger.info(`[Join] Already registered as ${creds.node_id}`);
            }
            else {
                console.log(`[Join] Already registered as ${creds?.node_id}`);
            }
            return {
                success: true,
                nodeId: creds?.node_id,
                coreIp: creds?.core_ip,
                status: 'existing',
                message: 'Using existing registration',
            };
        }
        // Generate HWID per HARDWARE_PROTOCOL.md §2
        const hwid = await getHwid();
        console.log(`[Join] HWID: ${hwid.substring(0, 16)}...`);
        // Prepare join request
        const joinRequest = {
            hwid,
            hostname: getHostname(),
            persona: detectPersona(),
            hardwareProfile: collectHardwareProfile(),
        };
        console.log(`[Join] Connecting to Core at ${CORE_URL}...`);
        console.log(`[Join] Persona: ${joinRequest.persona}, Hostname: ${joinRequest.hostname}`);
        // Send join request
        const response = await fetch(JOIN_ENDPOINT, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(joinRequest),
        });
        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`HTTP ${response.status}: ${errorText}`);
        }
        const result = await response.json();
        if (!result.success || !result.data) {
            throw new Error(result.error || 'Join request failed');
        }
        // Persist credentials
        const credentials = {
            node_id: result.data.node_id,
            hwid,
            core_ip: result.data.core_ip,
            registered_at: new Date().toISOString(),
        };
        await saveCredentials(credentials);
        const isJoined = true;
        const logger = createClientLogger(isJoined, result.data.node_id);
        logger.info(`[Join] Success! Node ID: ${result.data.node_id}`);
        logger.info(`[Join] Core IP: ${result.data.core_ip}`);
        logger.info(`[Join] Status: ${result.data.status}`);
        return {
            success: true,
            nodeId: result.data.node_id,
            coreIp: result.data.core_ip,
            status: result.data.status,
            message: result.data.message,
        };
    }
    catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        console.error(`[Join] Failed: ${errorMessage}`);
        return {
            success: false,
            error: errorMessage,
        };
    }
}
/**
 * Main client initialization
 */
async function main() {
    console.log('=== Meristem Client ===');
    console.log(`Version: ${process.env.npm_package_version || '0.1.0'}`);
    console.log('');
    let logger = null;
    let isJoined = false;
    try {
        // Perform zero-touch join
        const joinResult = await performJoin();
        if (!joinResult.success) {
            console.error('[Client] Failed to join cluster');
            process.exit(1);
        }
        isJoined = joinResult.success;
        logger = createClientLogger(isJoined, joinResult.nodeId);
        logger.info('');
        logger.info('[Client] Joined successfully, starting services...');
        // TODO: Start NATS connection, heartbeat, pulse reporting
        // These will be implemented in subsequent tasks
        // Keep process alive
        logger.info('[Client] Running (Ctrl+C to exit)');
        const shutdown = () => {
            logger?.info('\n[Client] Shutting down...');
            process.exit(0);
        };
        // Graceful shutdown
        process.on('SIGINT', shutdown);
        process.on('SIGTERM', shutdown);
    }
    catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        if (isJoined && logger) {
            logger.error('[Client] Fatal error:', { error: errorMessage });
        }
        else {
            console.error('[Client] Fatal error:', error);
        }
        process.exit(1);
    }
}
// Run if executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
    void main();
}
// Export for programmatic use
export { performJoin, main };
//# sourceMappingURL=index.js.map