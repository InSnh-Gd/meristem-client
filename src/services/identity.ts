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
import { writeFile, readFile, access } from 'fs/promises';
import { join } from 'path';

// Path for persisting node credentials
const CREDENTIALS_PATH = process.env.MERISTEM_CREDENTIALS_PATH || 
  join(process.cwd(), '.meristem', 'credentials.json');

// Path for node ID override configuration
const OVERRIDE_PATH = process.env.MERISTEM_CONFIG_PATH || 
  join(process.cwd(), '.meristem', 'config.json');

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
  persona: 'AGENT' | 'WORKER';
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
  try {
    await access(OVERRIDE_PATH);
    const config = JSON.parse(await readFile(OVERRIDE_PATH, 'utf-8'));
    return config.node_id_override || null;
  } catch {
    return null;
  }
}

/**
 * Load persisted credentials
 */
export async function loadCredentials(): Promise<NodeCredentials | null> {
  try {
    await access(CREDENTIALS_PATH);
    const data = await readFile(CREDENTIALS_PATH, 'utf-8');
    return JSON.parse(data) as NodeCredentials;
  } catch {
    return null;
  }
}

/**
 * Save credentials to disk
 */
export async function saveCredentials(credentials: NodeCredentials): Promise<void> {
  const dir = join(CREDENTIALS_PATH, '..');
  try {
    await access(dir);
  } catch {
    // Directory doesn't exist, will be created by writeFile with recursive
  }
  
  await writeFile(
    CREDENTIALS_PATH, 
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
 * Detect system persona based on environment
 * Can be overridden via MERISTEM_PERSONA env var
 */
export function detectPersona(): 'AGENT' | 'WORKER' {
  const envPersona = process.env.MERISTEM_PERSONA;
  if (envPersona === 'AGENT' || envPersona === 'WORKER') {
    return envPersona;
  }
  
  // Default to WORKER for compute nodes
  // AGENT is typically for storage/relay nodes
  return 'WORKER';
}

/**
 * Collect basic hardware profile
 * Full implementation would read /proc/cpuinfo, /proc/meminfo, etc.
 */
export function collectHardwareProfile(): HardwareProfile {
  const profile: HardwareProfile = {
    os: process.platform,
    arch: process.arch === 'x64' ? 'x86_64' : 
          process.arch === 'arm64' ? 'arm64' : 
          process.arch as any,
  };
  
  // CPU info would be parsed from /proc/cpuinfo on Linux
  // Memory info from /proc/meminfo
  // For MVP, we provide basic Node.js available info
  
  return profile;
}

/**
 * Clear persisted credentials (for re-join scenarios)
 */
export async function clearCredentials(): Promise<void> {
  try {
    await access(CREDENTIALS_PATH);
    await writeFile(CREDENTIALS_PATH, '', { mode: 0o600 });
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
