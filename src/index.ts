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
  createHardwareProfileHash,
  loadCredentials,
  saveCredentials,
  isRegistered,
  type JoinResponse,
  type NodeCredentials,
} from './services/identity.js';
import { createClientLogger, type Logger } from './utils/logger.js';
import { natsManager } from './nats/connection.js';

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
  status?: 'new' | 'existing' | 'pending_approval';
  message?: string;
  error?: string;
}

type ServiceHandle = Readonly<{
  stop: () => Promise<void>;
}>;

type GracefulShutdownOptions = Readonly<{
  logger?: Logger | null;
  services?: readonly (ServiceHandle | null | undefined)[];
  closeConnection?: () => Promise<void>;
  onExit?: (code?: number) => void;
}>;

export function createGracefulShutdown(options: GracefulShutdownOptions): (exitCode?: number) => Promise<void> {
  let isShuttingDown = false;
  const services = options.services ?? [];
  const closeConnection = options.closeConnection ?? (async () => undefined);
  const onExit = options.onExit ?? (() => undefined);

  return async (exitCode = 0): Promise<void> => {
    if (isShuttingDown) {
      return;
    }
    isShuttingDown = true;
    options.logger?.info('[Client] Shutting down...');

    const tasks: Promise<void>[] = [];
    for (const service of services) {
      if (service?.stop) {
        tasks.push(service.stop());
      }
    }

    tasks.push(closeConnection());

    const results = await Promise.allSettled(tasks);
    for (const outcome of results) {
      if (outcome.status === 'rejected') {
        const reason = outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason);
        options.logger?.warn('[Client] Shutdown task failed', { error: reason });
      }
    }

    onExit(exitCode);
  };
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
      if (creds?.node_id) {
        const logger = createClientLogger(true, creds.node_id);
        logger.info(`[Join] Already registered as ${creds.node_id}`);
      } else {
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
    const hardwareProfile = collectHardwareProfile();
    const joinRequest = {
      hwid,
      hostname: getHostname(),
      persona: detectPersona(),
      hardware_profile: hardwareProfile,
      hardware_profile_hash: createHardwareProfileHash(hardwareProfile),
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

  let logger: Logger | null = null;
  let isJoined = false;
  let shutdownHandler: ((exitCode?: number) => Promise<void>) | null = null;

  try {
    // Perform zero-touch join
    const joinResult = await performJoin();

    if (!joinResult.success) {
      console.error('[Client] Failed to join cluster');
      process.exit(1);
    }

    isJoined = joinResult.success;
    const nodeId = joinResult.nodeId ?? 'unknown';
    process.env.MERISTEM_NODE_ID = nodeId;
    logger = createClientLogger(isJoined, nodeId);

    logger.info('');
    logger.info('[Client] Joined successfully, starting services...');

    const heartbeatModule = await import('./services/heartbeat.js');
    const pulseModule = await import('./services/pulse.js');

    const heartbeatService = new heartbeatModule.HeartbeatService();
    const pulseService = new pulseModule.PulseService();
    const services: ServiceHandle[] = [heartbeatService, pulseService];

    shutdownHandler = createGracefulShutdown({
      logger,
      services,
      closeConnection: async () => {
        await natsManager.close();
      },
      onExit: (code = 0) => {
        process.exit(code);
      },
    });

    await natsManager.connect();
    await heartbeatService.start();
    await pulseService.start();

    // Keep process alive
    logger.info('[Client] Running (Ctrl+C to exit)');

    const handleSignal = (): void => {
      void shutdownHandler?.();
    };

    // Graceful shutdown
    process.on('SIGINT', handleSignal);
    process.on('SIGTERM', handleSignal);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    if (isJoined && logger) {
      logger.error('[Client] Fatal error:', { error: errorMessage });
    } else {
      console.error('[Client] Fatal error:', error);
    }
    if (shutdownHandler) {
      await shutdownHandler(1);
      return;
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
