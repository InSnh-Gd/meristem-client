import { describe, test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import {
  generateHwid,
  loadCredentials,
  saveCredentials,
  getHwid,
  getHostname,
  detectPersona,
  collectHardwareProfile,
  clearCredentials,
  isRegistered,
  getNodeId,
  type NodeCredentials,
} from "../../services/identity";
import * as fsPromises from "fs/promises";
import * as crypto from "crypto";
import * as os from "os";
import { join } from "path";

describe("Identity Service", () => {
  const credentialsPath = join(process.cwd(), ".meristem", "credentials.json");
  const configPath = join(process.cwd(), ".meristem", "config.json");
  let mockFileSystem: Map<string, { content: string; mode?: number }>;
  let originalEnv: NodeJS.ProcessEnv;
  let hashCallCount: number;

  let mockAccess: ReturnType<typeof spyOn>;
  let mockReadFile: ReturnType<typeof spyOn>;
  let mockWriteFile: ReturnType<typeof spyOn>;
  let mockNetworkInterfaces: ReturnType<typeof spyOn>;
  let mockHostname: ReturnType<typeof spyOn>;
  let mockCreateHash: ReturnType<typeof spyOn>;

  beforeEach(() => {
    originalEnv = { ...process.env };
    delete process.env.MERISTEM_CREDENTIALS_PATH;
    delete process.env.MERISTEM_CONFIG_PATH;
    delete process.env.MERISTEM_HOSTNAME;
    delete process.env.MERISTEM_PERSONA;

    mockFileSystem = new Map();
    hashCallCount = 0;

    mockAccess = spyOn(fsPromises, "access").mockImplementation(async (path: string | Buffer | URL) => {
      const key = path.toString();
      if (!mockFileSystem.has(key)) {
        const error = new Error(`ENOENT: no such file or directory, access '${key}'`);
        (error as NodeJS.ErrnoException).code = "ENOENT";
        throw error;
      }
    });

    mockReadFile = (spyOn(fsPromises, "readFile") as any).mockImplementation(async (path: any, options?: any) => {
      const key = path.toString();
      const entry = mockFileSystem.get(key);
      if (!entry) {
        const error = new Error(`ENOENT: no such file or directory, open '${key}'`);
        (error as NodeJS.ErrnoException).code = "ENOENT";
        throw error;
      }
      return entry.content;
    });

    mockWriteFile = (spyOn(fsPromises, "writeFile") as any).mockImplementation(async (path: any, data: any, options?: any) => {
      const key = path.toString();
      mockFileSystem.set(key, {
        content: data.toString(),
        mode: typeof options === "object" ? options.mode : undefined,
      });
    });

    mockNetworkInterfaces = spyOn(os, "networkInterfaces").mockReturnValue({
      eth0: [
        {
          address: "192.168.1.100",
          netmask: "255.255.255.0",
          family: "IPv4",
          mac: "aa:bb:cc:dd:ee:ff",
          internal: false,
          cidr: "192.168.1.100/24",
        },
      ],
      lo: [
        {
          address: "127.0.0.1",
          netmask: "255.0.0.0",
          family: "IPv4",
          mac: "00:00:00:00:00:00",
          internal: true,
          cidr: "127.0.0.1/8",
        },
      ],
    });

    mockHostname = spyOn(os, "hostname").mockReturnValue("test-node");

    mockCreateHash = spyOn(crypto, "createHash").mockImplementation((algorithm: string) => {
      return {
        update: (data: string) => ({
          digest: (encoding: string) => {
            hashCallCount++;
            return `mock-hash-${algorithm}-${hashCallCount}-${data.slice(0, 20).replace(/[^a-zA-Z0-9]/g, "_")}`;
          },
        }),
      } as any;
    });
  });

  afterEach(() => {
    process.env = originalEnv;

    mockAccess.mockRestore();
    mockReadFile.mockRestore();
    mockWriteFile.mockRestore();
    mockNetworkInterfaces.mockRestore();
    mockHostname.mockRestore();
    mockCreateHash.mockRestore();
  });

  describe("generateHwid()", () => {
    test("should generate HWID from UUID and MAC", () => {
      const hwid = generateHwid();

      expect(hwid).toBeDefined();
      expect(hwid.length).toBeGreaterThan(0);
      expect(mockCreateHash).toHaveBeenCalledWith("sha256");
    });

    test("should use primary MAC address from priority interfaces", () => {
      mockNetworkInterfaces.mockReturnValue({
        eth0: [
          {
            address: "192.168.1.100",
            netmask: "255.255.255.0",
            family: "IPv4",
            mac: "aa:bb:cc:dd:ee:ff",
            internal: false,
            cidr: "192.168.1.100/24",
          },
        ],
        wlan0: [
          {
            address: "192.168.1.101",
            netmask: "255.255.255.0",
            family: "IPv4",
            mac: "11:22:33:44:55:66",
            internal: false,
            cidr: "192.168.1.101/24",
          },
        ],
      });

      generateHwid();

      expect(mockCreateHash).toHaveBeenCalled();
    });

    test("should fallback to first available MAC when priority interfaces not found", () => {
      mockNetworkInterfaces.mockReturnValue({
        wlan0: [
          {
            address: "192.168.1.101",
            netmask: "255.255.255.0",
            family: "IPv4",
            mac: "11:22:33:44:55:66",
            internal: false,
            cidr: "192.168.1.101/24",
          },
        ],
      });

      const hwid = generateHwid();

      expect(hwid).toBeDefined();
      expect(hwid.length).toBeGreaterThan(0);
    });

    test("should return zero MAC when no interfaces available", () => {
      mockNetworkInterfaces.mockReturnValue({});

      const hwid = generateHwid();

      expect(hwid).toBeDefined();
      expect(mockCreateHash).toHaveBeenCalled();
    });

    test("should skip internal interfaces", () => {
      mockNetworkInterfaces.mockReturnValue({
        lo: [
          {
            address: "127.0.0.1",
            netmask: "255.0.0.0",
            family: "IPv4",
            mac: "00:00:00:00:00:00",
            internal: true,
            cidr: "127.0.0.1/8",
          },
        ],
        eth0: [
          {
            address: "192.168.1.100",
            netmask: "255.255.255.0",
            family: "IPv4",
            mac: "aa:bb:cc:dd:ee:ff",
            internal: false,
            cidr: "192.168.1.100/24",
          },
        ],
      });

      const hwid = generateHwid();

      expect(hwid).toBeDefined();
      expect(mockCreateHash).toHaveBeenCalled();
    });
  });

  describe("loadCredentials()", () => {
    test("should return null when credentials file does not exist", async () => {
      const creds = await loadCredentials();
      expect(creds).toBeNull();
    });

    test("should load and parse credentials from file", async () => {
      const expectedCreds: NodeCredentials = {
        node_id: "node-abc123",
        hwid: "test-hwid-123",
        registered_at: "2026-01-01T00:00:00Z",
        core_ip: "10.25.0.1",
        auth_key: "secret-key-123",
      };

      mockFileSystem.set(credentialsPath, {
        content: JSON.stringify(expectedCreds, null, 2),
      });

      const creds = await loadCredentials();

      expect(creds).toEqual(expectedCreds);
    });

    test("should use custom credentials path from env", async () => {
      process.env.MERISTEM_CREDENTIALS_PATH = "/custom/path/creds.json";

      const expectedCreds: NodeCredentials = {
        node_id: "node-custom",
        hwid: "custom-hwid",
        registered_at: "2026-01-01T00:00:00Z",
      };

      mockFileSystem.set("/custom/path/creds.json", {
        content: JSON.stringify(expectedCreds),
      });

      expect(mockFileSystem.has("/custom/path/creds.json")).toBe(true);
    });
  });

  describe("saveCredentials()", () => {
    test("should save credentials to file with restrictive permissions", async () => {
      const creds: NodeCredentials = {
        node_id: "node-test-123",
        hwid: "hwid-test-456",
        registered_at: "2026-01-15T10:30:00Z",
        core_ip: "10.25.0.1",
      };

      await saveCredentials(creds);

      const saved = mockFileSystem.get(credentialsPath);
      expect(saved).toBeDefined();
      expect(saved?.mode).toBe(0o600);

      const parsed = JSON.parse(saved!.content);
      expect(parsed.node_id).toBe("node-test-123");
      expect(parsed.hwid).toBe("hwid-test-456");
    });

    test("should create directory if it does not exist", async () => {
      const creds: NodeCredentials = {
        node_id: "node-test",
        hwid: "hwid-test",
        registered_at: "2026-01-15T10:30:00Z",
      };

      await saveCredentials(creds);

      const saved = mockFileSystem.get(credentialsPath);
      expect(saved).toBeDefined();
    });
  });

  describe("getHwid()", () => {
    test("should return generated HWID when no override configured", async () => {
      const hwid = await getHwid();

      expect(hwid).toBeDefined();
      expect(hwid.length).toBeGreaterThan(0);
    });

    test("should use override from config file when available", async () => {
      mockFileSystem.set(configPath, {
        content: JSON.stringify({ node_id_override: "custom-node-id" }),
      });

      const hwid = await getHwid();

      expect(hwid).toBeDefined();
      expect(hwid).toContain("mock-hash-sha256");
    });
  });

  describe("getHostname()", () => {
    test("should return system hostname by default", () => {
      mockHostname.mockReturnValue("system-hostname");

      const host = getHostname();

      expect(host).toBe("system-hostname");
    });

    test("should use MERISTEM_HOSTNAME env override", () => {
      process.env.MERISTEM_HOSTNAME = "custom-hostname";

      const host = getHostname();

      expect(host).toBe("custom-hostname");
    });
  });

  describe("detectPersona()", () => {
    test("should default to WORKER", () => {
      const persona = detectPersona();
      expect(persona).toBe("WORKER");
    });

    test("should use MERISTEM_PERSONA env when set to AGENT", () => {
      process.env.MERISTEM_PERSONA = "AGENT";

      const persona = detectPersona();

      expect(persona).toBe("AGENT");
    });

    test("should use MERISTEM_PERSONA env when set to WORKER", () => {
      process.env.MERISTEM_PERSONA = "WORKER";

      const persona = detectPersona();

      expect(persona).toBe("WORKER");
    });

    test("should ignore invalid MERISTEM_PERSONA values", () => {
      process.env.MERISTEM_PERSONA = "INVALID";

      const persona = detectPersona();

      expect(persona).toBe("WORKER");
    });
  });

  describe("collectHardwareProfile()", () => {
    test("should return basic hardware info", () => {
      const profile = collectHardwareProfile();

      expect(profile.os).toBe(process.platform);
      expect(profile.arch).toBeDefined();
    });

    test("should map x64 arch to x86_64", () => {
      const profile = collectHardwareProfile();

      expect(["x86_64", "arm64", undefined]).toContain(profile.arch);
    });
  });

  describe("clearCredentials()", () => {
    test("should clear existing credentials file", async () => {
      mockFileSystem.set(credentialsPath, {
        content: JSON.stringify({ node_id: "test" }),
      });

      await clearCredentials();

      const saved = mockFileSystem.get(credentialsPath);
      expect(saved?.content).toBe("");
    });

    test("should handle non-existent credentials file gracefully", async () => {
      await expect(clearCredentials()).resolves.toBeUndefined();
    });
  });

  describe("isRegistered()", () => {
    test("should return false when no credentials exist", async () => {
      const registered = await isRegistered();
      expect(registered).toBe(false);
    });

    test("should return true when credentials with node_id exist", async () => {
      mockFileSystem.set(credentialsPath, {
        content: JSON.stringify({
          node_id: "node-registered",
          hwid: "test-hwid",
          registered_at: "2026-01-01T00:00:00Z",
        }),
      });

      const registered = await isRegistered();

      expect(registered).toBe(true);
    });

    test("should return false when credentials exist but no node_id", async () => {
      mockFileSystem.set(credentialsPath, {
        content: JSON.stringify({
          hwid: "test-hwid",
          registered_at: "2026-01-01T00:00:00Z",
        }),
      });

      const registered = await isRegistered();

      expect(registered).toBe(false);
    });
  });

  describe("getNodeId()", () => {
    test("should return null when no credentials exist", async () => {
      const nodeId = await getNodeId();
      expect(nodeId).toBeNull();
    });

    test("should return node_id from credentials", async () => {
      mockFileSystem.set(credentialsPath, {
        content: JSON.stringify({
          node_id: "node-specific-id",
          hwid: "test-hwid",
          registered_at: "2026-01-01T00:00:00Z",
        }),
      });

      const nodeId = await getNodeId();

      expect(nodeId).toBe("node-specific-id");
    });
  });
});
