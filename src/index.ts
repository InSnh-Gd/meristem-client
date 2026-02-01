/**
 * Meristem Client - Zero-touch Node Join
 * 
 * Implements NETWORK_SYSTEM.md §3 Zero-touch Join flow:
 * 1. Detect/generate HWID (SHA-256 of UUID + MAC)
 * 2. POST /api/v1/join to Core
 * 3. Persist node_id and auth_key
 * 4. MVP: Auto-approved (no admin approval wait)
 */

import {
  getHwid,
  getHostname,
  detectPersona,
  collectHardwareProfile,
  loadCredentials,
  saveCredentials,
  isRegistered,
  type JoinResponse,
  type NodeCredentials,
} from './services/identity.js';

import { natsManager } from './nats/connection.js';
import { HeartbeatService } from './services/heartbeat.js';
import { PulseService } from './services/pulse.js';
import { TaskExecutorService } from './services/task-executor.js';

// Core endpoint configuration
const CORE_URL = process.env.MERISTEM_CORE_URL || 'http://localhost:3000';
const JOIN_ENDPOINT = `${CORE_URL}/api/v1/join`;

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
async function performJoin(): Promise<JoinResult> {
  try {
    // Check if already registered
    if (await isRegistered()) {
      const creds = await loadCredentials();
      console.log(`[Join] Already registered as ${creds?.node_id}`);
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

    const result = await response.json() as JoinResponse;

    if (!result.success || !result.data) {
      throw new Error(result.error || 'Join request failed');
    }

    // Persist credentials
    const credentials: NodeCredentials = {
      node_id: result.data.node_id,
      hwid,
      core_ip: result.data.core_ip,
      registered_at: new Date().toISOString(),
    };

    await saveCredentials(credentials);

    console.log(`[Join] Success! Node ID: ${result.data.node_id}`);
    console.log(`[Join] Core IP: ${result.data.core_ip}`);
    console.log(`[Join] Status: ${result.data.status}`);

    return {
      success: true,
      nodeId: result.data.node_id,
      coreIp: result.data.core_ip,
      status: result.data.status,
      message: result.data.message,
    };
  } catch (error) {
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
async function main(): Promise<void> {
  console.log('=== Meristem Client ===');
  console.log(`Version: ${process.env.npm_package_version || '0.1.0'}`);
  console.log('');

  // Perform zero-touch join
  const joinResult = await performJoin();

  if (!joinResult.success) {
    console.error('[Client] Failed to join cluster');
    process.exit(1);
  }

  console.log('');
  console.log('[Client] Joined successfully, starting services...');

  const nodeId = joinResult.nodeId || process.env.MERISTEM_NODE_ID || 'unknown';
  process.env.MERISTEM_NODE_ID = nodeId;

  await natsManager.connect();

  const heartbeat = new HeartbeatService();
  const pulse = new PulseService();
  const executor = new TaskExecutorService({ nodeId });

  await heartbeat.start();
  await pulse.start();
  await executor.start();

  console.log('[Client] Running (Ctrl+C to exit)');

  const shutdown = async () => {
    console.log('\n[Client] Shutting down...');
    try {
      await executor.stop();
    } catch {
      // ignore
    }
    try {
      await pulse.stop();
    } catch {
      // ignore
    }
    try {
      await heartbeat.stop();
    } catch {
      // ignore
    }
    try {
      await natsManager.disconnect();
    } catch {
      // ignore
    }
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

// Run if executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error('[Client] Fatal error:', error);
    process.exit(1);
  });
}

// Export for programmatic use
export { performJoin, main };
