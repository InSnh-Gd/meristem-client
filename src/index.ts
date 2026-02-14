/**
 * Meristem Client - Zero-touch Node Join
 * 
 * Implements NETWORK_SYSTEM.md §3 Zero-touch Join flow:
 * 1. Detect/generate HWID (SHA-256 of UUID + MAC)
 * 2. POST /api/v1/join to Core
 * 3. Persist node_id and auth_key
 * 4. MVP: Auto-approved (no admin approval wait)
 */

import type { WsTopic } from '@insnh-gd/meristem-shared';
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
import { createCoreHttpClient } from './services/core-http.js';
import { createCoreEdenWsClient } from './services/core-eden-ws.js';
import { parseJoinNetworkBootstrap } from './services/network/contract.js';
import { createTunnelPlanner } from './services/network/tunnel-planner.js';
import { waitForNatsWithRetryDetailed } from './services/ota-preflight.js';
import { createClientLogger, type Logger } from './utils/logger.js';
import { natsManager } from './nats/connection.js';
import packageJson from '../package.json';

const CLIENT_VERSION =
  typeof packageJson.version === 'string' ? packageJson.version : '0.1.0';

// Core endpoint configuration
const CORE_URL = process.env.MERISTEM_CORE_URL || 'http://localhost:3000';
const NATS_URL = process.env.MERISTEM_NATS_URL || process.env.NATS_URL || 'nats://localhost:4222';
const ADDRESS_FAMILY_PREFERENCE =
  process.env.MERISTEM_ADDRESS_FAMILY_PREFERENCE === 'ipv6-first' ||
  process.env.MERISTEM_ADDRESS_FAMILY_PREFERENCE === 'ipv4-first'
    ? process.env.MERISTEM_ADDRESS_FAMILY_PREFERENCE
    : 'dual-stack';
const coreHttpClient = createCoreHttpClient(CORE_URL);
const ENABLE_EDEN_WS = process.env.ENABLE_EDEN_WS === 'true';

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

const resolveNodeStatusTopic = (nodeId: string): WsTopic => `node.${nodeId}.status` as WsTopic;

const resolveEdenWsToken = async (): Promise<string | undefined> => {
  const envToken = process.env.MERISTEM_CORE_WS_TOKEN;
  if (typeof envToken === 'string' && envToken.trim().length > 0) {
    return envToken;
  }
  const credentials = await loadCredentials();
  if (typeof credentials?.auth_key === 'string' && credentials.auth_key.trim().length > 0) {
    return credentials.auth_key;
  }
  return undefined;
};

const createEdenWsService = async (nodeId: string, logger: Logger): Promise<ServiceHandle | null> => {
  if (!ENABLE_EDEN_WS) {
    return null;
  }

  const token = await resolveEdenWsToken();
  if (!token) {
    console.warn('[EdenWS] ENABLE_EDEN_WS=true but no ws token found, skip subscribe');
    logger.warn('[EdenWS] ENABLE_EDEN_WS=true but no ws token found, skip subscribe');
    return null;
  }

  const topic = resolveNodeStatusTopic(nodeId);
  const wsClient = createCoreEdenWsClient(CORE_URL);

  try {
    const session = await wsClient.subscribeTopic({
      token,
      topic,
      onPush: (message) => {
        logger.info('[EdenWS] push received', {
          topic: message.topic,
        });
      },
    });
    logger.info('[EdenWS] subscribed', { topic });
    return {
      stop: async () => {
        session.close();
      },
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.warn(`[EdenWS] subscribe failed: ${reason}`);
    logger.warn('[EdenWS] subscribe failed', { error: reason });
    return null;
  }
};

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
        console.error(`[Client] Shutdown task failed: ${reason}`);
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
    const result: JoinResponse = await coreHttpClient.join(joinRequest);

    if (!result.success) {
      throw new Error(result.error || 'Join request failed');
    }
    const joinData = result.data;
    const joinDataRecord = joinData as unknown as Record<string, unknown>;
    const networkBootstrap = parseJoinNetworkBootstrap(joinDataRecord, joinData.core_ip);

    // Persist credentials
    const credentials: NodeCredentials = {
      node_id: joinData.node_id,
      hwid,
      core_ip: joinData.core_ip,
      auth_key: networkBootstrap.authKey,
      registered_at: new Date().toISOString(),
    };

    await saveCredentials(credentials);

    const isJoined = true;
    const logger = createClientLogger(isJoined, joinData.node_id);
    logger.info(`[Join] Success! Node ID: ${joinData.node_id}`);
    logger.info(`[Join] Core IP: ${joinData.core_ip}`);
    logger.info(`[Join] Status: ${joinData.status}`);
    if (networkBootstrap.mode === 'OVERLAY') {
      const planner = createTunnelPlanner(ADDRESS_FAMILY_PREFERENCE);
      const plan = planner.plan(networkBootstrap);
      logger.info('[Join] Overlay network bootstrap resolved', {
        network_provider: networkBootstrap.provider ?? 'unknown',
        relay_regions: networkBootstrap.derpMap
          ? Object.keys(networkBootstrap.derpMap.Regions).length
          : 0,
        has_auth_key:
          typeof networkBootstrap.authKey === 'string' &&
          networkBootstrap.authKey.length > 0,
        planned_path: plan?.mode ?? 'UNRESOLVED',
        planned_family: plan?.family ?? 'unknown',
      });
    }

    return {
      success: true,
      nodeId: joinData.node_id,
      coreIp: joinData.core_ip,
      status: joinData.status,
      message: joinData.message,
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
  console.log(`Version: ${CLIENT_VERSION}`);
  console.log('');

  let logger: Logger | null = null;
  let isJoined = false;
  let shutdownHandler: ((exitCode?: number) => Promise<void>) | null = null;

  try {
    // Perform zero-touch join
    const joinResult = await performJoin();

    if (!joinResult.success) {
      console.error(`[Client] Failed to join cluster: ${joinResult.error ?? 'unknown error'}`);
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

    const natsPreflight = await waitForNatsWithRetryDetailed(NATS_URL);
    if (!natsPreflight.connected) {
      const failureMeta = {
        natsUrl: NATS_URL,
        attempts: natsPreflight.attempts,
        error: natsPreflight.lastError ?? 'unknown',
      };
      console.error(
        `[Client] OTA preflight failed: NATS not reachable after ${failureMeta.attempts} attempts (${failureMeta.error})`,
      );
      logger.error('[Client] OTA preflight failed: NATS not reachable after retries', failureMeta);
      if (shutdownHandler) {
        await shutdownHandler(1);
        return;
      }
      process.exit(1);
    }

    await natsManager.connect();
    await heartbeatService.start();
    await pulseService.start();
    const edenWsService = await createEdenWsService(nodeId, logger);
    if (edenWsService) {
      services.push(edenWsService);
    }

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
    console.error(`[Client] Fatal error: ${errorMessage}`);
    if (isJoined && logger) {
      logger.error('[Client] Fatal error:', { error: errorMessage });
    }
    if (shutdownHandler) {
      await shutdownHandler(1);
      return;
    }
    process.exit(1);
  }
}

const isDirectEntrypoint =
  import.meta.main
  || process.argv[1]?.endsWith('/src/index.ts')
  || process.argv[1]?.endsWith('\\src\\index.ts')
  || process.argv[1]?.endsWith('/dist/index.js')
  || process.argv[1]?.endsWith('\\dist\\index.js');

if (isDirectEntrypoint) {
  await main();
}

// Export for programmatic use
export { performJoin, main };
