/**
 * Identity Service - HWID Generation and Node Identity Management
 * 
 * Implements HARDWARE_PROTOCOL.md §2 HWID generation specification:
 * - HWID = SHA-256(UUID + MAC)
 * - UUID sourced from /sys/class/dmi/id/product_uuid (Linux)
 * - Fallback to system-specific identifiers on other platforms
 * - Supports node_id_override for manual configuration
 */

import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import { networkInterfaces, hostname } from 'os';
import { writeFile, readFile, access, mkdir } from 'fs/promises';
import { join } from 'path';
import type {
  HardwareProfile as SharedHardwareProfile,
  JoinRequestPayload,
  JoinResponsePayload,
  NodePersona,
} from '@insnh-gd/meristem-shared';
import { resolveNodePersona } from '../utils/persona.js';

// Path for persisting node credentials
const resolveCredentialsPath = (): string =>
  process.env.MERISTEM_CREDENTIALS_PATH
  ?? join(process.cwd(), '.meristem', 'credentials.json');

// Path for node ID override configuration
const resolveOverridePath = (): string =>
  process.env.MERISTEM_CONFIG_PATH
  ?? join(process.cwd(), '.meristem', 'config.json');

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

export type HardwareProfile = SharedHardwareProfile;
export type JoinRequest = JoinRequestPayload;
export type JoinResponse = JoinResponsePayload;

/**
 * Read system UUID from DMI (Linux only)
 * Falls back to synthetic UUID on other platforms
 */
function readSystemUuid(): string {
  try {
    // Try Linux DMI path first
    const uuid = readFileSync('/sys/class/dmi/id/product_uuid', 'utf-8').trim();
    if (uuid && uuid.length > 0) {
      return uuid.toLowerCase();
    }
  } catch {
    // DMI not available (non-Linux or no permissions)
  }

  // Fallback: Generate synthetic UUID from hostname + machine-specific data
  const host = hostname();
  const machineId = getMachineFingerprint();
  return createHash('sha256')
    .update(`${host}:${machineId}`)
    .digest('hex')
    .substring(0, 32);
}

/**
 * Get machine fingerprint from available system data
 */
function getMachineFingerprint(): string {
  const interfaces = networkInterfaces();
  const macs: string[] = [];
  
  for (const [, addrs] of Object.entries(interfaces)) {
    if (!addrs) continue;
    for (const addr of addrs) {
      // Skip internal and non-physical interfaces
      if (addr.internal) continue;
      if (addr.mac && addr.mac !== '00:00:00:00:00:00') {
        macs.push(addr.mac);
      }
    }
  }
  
  // Sort for consistency
  macs.sort();
  return macs.join(':') || 'no-mac-available';
}

/**
 * Get primary MAC address
 */
function getPrimaryMac(): string {
  const interfaces = networkInterfaces();
  
  // Priority order for interface selection
  const priorityNames = ['eth0', 'en0', 'ens160', 'ens192', 'enp3s0', 'wlan0'];
  
  for (const name of priorityNames) {
    const addrs = interfaces[name];
    if (addrs) {
      for (const addr of addrs) {
        if (!addr.internal && addr.mac && addr.mac !== '00:00:00:00:00:00') {
          return addr.mac;
        }
      }
    }
  }
  
  // Fallback: first available non-internal MAC
  for (const [, addrs] of Object.entries(interfaces)) {
    if (!addrs) continue;
    for (const addr of addrs) {
      if (!addr.internal && addr.mac && addr.mac !== '00:00:00:00:00:00') {
        return addr.mac;
      }
    }
  }
  
  return '00:00:00:00:00:00';
}

/**
 * Generate HWID according to HARDWARE_PROTOCOL.md §2
 * Algorithm: SHA-256(UUID + MAC)
 */
export function generateHwid(): string {
  const uuid = readSystemUuid();
  const mac = getPrimaryMac();
  const combined = `${uuid}:${mac}`;
  
  const hwid = createHash('sha256')
    .update(combined)
    .digest('hex')
    .toLowerCase();
  
  return hwid;
}

/**
 * Check if node_id_override is configured
 */
async function getOverrideNodeId(): Promise<string | null> {
  const overridePath = resolveOverridePath();
  try {
    await access(overridePath);
    const config = JSON.parse(await readFile(overridePath, 'utf-8'));
    return config.node_id_override || null;
  } catch {
    return null;
  }
}

/**
 * Load persisted credentials
 */
export async function loadCredentials(): Promise<NodeCredentials | null> {
  const credentialsPath = resolveCredentialsPath();
  try {
    await access(credentialsPath);
    const data = await readFile(credentialsPath, 'utf-8');
    return JSON.parse(data) as NodeCredentials;
  } catch {
    return null;
  }
}

/**
 * Save credentials to disk
 */
export async function saveCredentials(credentials: NodeCredentials): Promise<void> {
  const credentialsPath = resolveCredentialsPath();
  const dir = join(credentialsPath, '..');
  await mkdir(dir, { recursive: true });
  
  await writeFile(
    credentialsPath,
    JSON.stringify(credentials, null, 2),
    { mode: 0o600 } // Restrictive permissions for credentials
  );
}

/**
 * Get or generate HWID
 * Uses override if configured, otherwise generates from system
 */
export async function getHwid(): Promise<string> {
  // Check for override first
  const override = await getOverrideNodeId();
  if (override) {
    // If override is set, use it as the HWID basis
    return createHash('sha256')
      .update(`override:${override}`)
      .digest('hex')
      .toLowerCase();
  }
  
  return generateHwid();
}

/**
 * Get system hostname
 */
export function getHostname(): string {
  return process.env.MERISTEM_HOSTNAME || hostname();
}

/**
 * Detect node persona from runtime environment.
 * Priority: MERISTEM_IDENTITY_PERSONA > default.
 */
export function detectPersona(): NodePersona {
  return resolveNodePersona(process.env.MERISTEM_IDENTITY_PERSONA);
}

/**
 * Collect basic hardware profile
 * Full implementation would read /proc/cpuinfo, /proc/meminfo, etc.
 */
export function collectHardwareProfile(): HardwareProfile {
  const resolveArch = (): HardwareProfile['arch'] => {
    if (process.arch === 'x64') {
      return 'x86_64';
    }

    if (process.arch === 'arm64') {
      return 'arm64';
    }

    return 'unknown';
  };

  const profile: HardwareProfile = {
    os: process.platform,
    arch: resolveArch(),
  };
  
  // CPU info would be parsed from /proc/cpuinfo on Linux
  // Memory info from /proc/meminfo
  // For MVP, we provide basic runtime-available info
  
  return profile;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const canonicalizeProfileValue = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map((item) => canonicalizeProfileValue(item));
  }

  if (isRecord(value)) {
    const next: Record<string, unknown> = {};
    const keys = Object.keys(value).sort();
    for (const key of keys) {
      const candidate = value[key];
      if (candidate !== undefined) {
        next[key] = canonicalizeProfileValue(candidate);
      }
    }
    return next;
  }

  return value;
};

/**
 * 生成硬件画像哈希，保证不同平台序列化顺序一致。
 */
export const createHardwareProfileHash = (profile: HardwareProfile): string => {
  const canonical = canonicalizeProfileValue(profile);
  return createHash('sha256')
    .update(JSON.stringify(canonical))
    .digest('hex')
    .toLowerCase();
};

/**
 * Clear persisted credentials (for re-join scenarios)
 */
export async function clearCredentials(): Promise<void> {
  const credentialsPath = resolveCredentialsPath();
  try {
    await access(credentialsPath);
    await writeFile(credentialsPath, '', { mode: 0o600 });
  } catch {
    // File doesn't exist, nothing to clear
  }
}

/**
 * Check if node is already registered
 */
export async function isRegistered(): Promise<boolean> {
  const creds = await loadCredentials();
  return creds !== null && creds.node_id !== undefined;
}

/**
 * Get registered node ID
 */
export async function getNodeId(): Promise<string | null> {
  const creds = await loadCredentials();
  return creds?.node_id || null;
}
