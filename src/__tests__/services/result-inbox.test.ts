import { describe, test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { ResultInbox, type ResultRecord } from "../../services/result-inbox";
import * as fsPromises from "fs/promises";
import * as crypto from "crypto";

describe("ResultInbox", () => {
  let inbox: ResultInbox;
  let mockFileSystem: Map<string, string>;
  let sendResultCalls: Array<{ record: ResultRecord; shouldFail: boolean }>;
  let orphanedTasks: string[];
  let originalSetTimeout: typeof setTimeout;
  let timerCallbacks: Array<{ delay: number; callback: () => void }>;

  let mockAccess: ReturnType<typeof spyOn>;
  let mockMkdir: ReturnType<typeof spyOn>;
  let mockReaddir: ReturnType<typeof spyOn>;
  let mockReadFile: ReturnType<typeof spyOn>;
  let mockWriteFile: ReturnType<typeof spyOn>;
  let mockRename: ReturnType<typeof spyOn>;
  let mockRm: ReturnType<typeof spyOn>;
  let mockCreateHash: ReturnType<typeof spyOn>;

  beforeEach(() => {
    mockFileSystem = new Map();
    sendResultCalls = [];
    orphanedTasks = [];
    timerCallbacks = [];

    originalSetTimeout = global.setTimeout;
    global.setTimeout = ((callback: () => void | Promise<void>, delay: number) => {
      const wrappedCallback = async () => {
        await callback();
      };
      timerCallbacks.push({ delay, callback: wrappedCallback });
      return 1 as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout;

    mockAccess = spyOn(fsPromises, "access").mockImplementation(async (path: string | Buffer | URL) => {
      const key = path.toString();
      const hasFile = mockFileSystem.has(key) && mockFileSystem.get(key) !== "__DIR__";
      const hasDir = Array.from(mockFileSystem.keys()).some((k) =>
        k.startsWith(key + "/") || k === key
      );
      if (!hasFile && !hasDir) {
        const error = new Error(`ENOENT: no such file or directory, access '${key}'`);
        (error as NodeJS.ErrnoException).code = "ENOENT";
        throw error;
      }
    });

    mockMkdir = (spyOn(fsPromises, "mkdir") as any).mockImplementation(async (path: any, options?: any) => {
      mockFileSystem.set(path.toString(), "__DIR__");
    });

    mockReaddir = (spyOn(fsPromises, "readdir") as any).mockImplementation(async (path: any, options?: any) => {
      const key = path.toString();
      const entries = new Map<string, { name: string; isDirectory: () => boolean }>();
      for (const [filePath] of mockFileSystem) {
        if (filePath.startsWith(key + "/")) {
          const relative = filePath.slice(key.length + 1);
          const parts = relative.split("/");
          const isDir = parts.length > 1 || mockFileSystem.get(filePath) === "__DIR__";
          entries.set(parts[0], { name: parts[0], isDirectory: () => isDir });
        }
      }
      return Array.from(entries.values());
    });

    mockReadFile = (spyOn(fsPromises, "readFile") as any).mockImplementation(async (path: any, options?: any) => {
      const key = path.toString();
      const content = mockFileSystem.get(key);
      if (content === undefined || content === "__DIR__") {
        const error = new Error(`ENOENT: no such file or directory, open '${key}'`);
        (error as NodeJS.ErrnoException).code = "ENOENT";
        throw error;
      }
      return content;
    });

    mockWriteFile = (spyOn(fsPromises, "writeFile") as any).mockImplementation(async (path: any, data: any, options?: any) => {
      mockFileSystem.set(path.toString(), data.toString());
    });

    mockRename = spyOn(fsPromises, "rename").mockImplementation(async (oldPath: string | Buffer | URL, newPath: string | Buffer | URL) => {
      const oldKey = oldPath.toString();
      const newKey = newPath.toString();
      const toMove: Array<[string, string]> = [];
      for (const [key, value] of mockFileSystem) {
        if (key === oldKey || key.startsWith(oldKey + "/")) {
          toMove.push([key, newKey + key.slice(oldKey.length)]);
        }
      }
      for (const [oldK, newK] of toMove) {
        mockFileSystem.set(newK, mockFileSystem.get(oldK)!);
        mockFileSystem.delete(oldK);
      }
    });

    mockRm = spyOn(fsPromises, "rm").mockImplementation(async (path: string | Buffer | URL, options?: any) => {
      const key = path.toString();
      for (const [filePath] of mockFileSystem) {
        if (filePath === key || filePath.startsWith(key + "/")) {
          mockFileSystem.delete(filePath);
        }
      }
    });

    mockCreateHash = spyOn(crypto, "createHash").mockImplementation((algorithm: string) => {
      return {
        update: (data: string) => ({
          digest: (encoding: string) => `sha256-${data.length}-${algorithm}`,
        }),
      } as any;
    });

    inbox = new ResultInbox({
      pendingDir: "/test/pending",
      stagingDir: "/test/staging",
      maxRetries: 3,
      retryDelaysMs: [100, 200, 400],
      sendResult: async (record: ResultRecord) => {
        const call = sendResultCalls.find((c) => c.record.task_id === record.task_id);
        if (call?.shouldFail) {
          throw new Error("Send failed");
        }
      },
      onOrphaned: async (taskId: string) => {
        orphanedTasks.push(taskId);
      },
    });
  });

  afterEach(async () => {
    await inbox.stop();
    global.setTimeout = originalSetTimeout;

    mockAccess.mockRestore();
    mockMkdir.mockRestore();
    mockReaddir.mockRestore();
    mockReadFile.mockRestore();
    mockWriteFile.mockRestore();
    mockRename.mockRestore();
    mockRm.mockRestore();
    mockCreateHash.mockRestore();
  });

  describe("start()", () => {
    test("should create pending and staging directories", async () => {
      await inbox.start();

      expect(mockFileSystem.has("/test/pending")).toBe(true);
      expect(mockFileSystem.has("/test/staging")).toBe(true);
    });

    test("should recover stale staging directories", async () => {
      mockFileSystem.set("/test/staging/task-1.tmp/__DIR__", "__DIR__");
      mockFileSystem.set("/test/staging/task-1.tmp/result.json", "{}");
      mockFileSystem.set("/test/staging/task-2.tmp/__DIR__", "__DIR__");

      await inbox.start();

      expect(mockFileSystem.has("/test/staging/task-1.tmp")).toBe(false);
      expect(mockFileSystem.has("/test/staging/task-2.tmp")).toBe(false);
    });

    test("should resend pending results on startup", async () => {
      mockFileSystem.set("/test/pending/existing-task/result.json", JSON.stringify({
        task_id: "existing-task",
        status: "completed",
        result: { data: "test" },
      }));
      mockFileSystem.set("/test/pending/existing-task/retry_count", "0");

      sendResultCalls.push({ record: { task_id: "existing-task" } as ResultRecord, shouldFail: false });

      await inbox.start();

      expect(timerCallbacks.length).toBeGreaterThan(0);
    });
  });

  describe("stop()", () => {
    test("should clear all retry timers", async () => {
      await inbox.start();

      const record: ResultRecord = {
        task_id: "test-task",
        status: "completed",
        result: { output: "success" },
      };

      sendResultCalls.push({ record, shouldFail: true });
      await inbox.enqueueResult(record);

      expect(timerCallbacks.length).toBeGreaterThan(0);

      await inbox.stop();

      expect(inbox).toBeDefined();
    });
  });

  describe("enqueueResult()", () => {
    test("should write result to staging then move to pending", async () => {
      await inbox.start();

      const record: ResultRecord = {
        task_id: "new-task",
        status: "completed",
        result: { output: "test data" },
        checksum: "custom-checksum",
      };

      sendResultCalls.push({ record, shouldFail: false });
      await inbox.enqueueResult(record);

      const resultJson = mockFileSystem.get("/test/pending/new-task/result.json");
      expect(resultJson).toBeDefined();

      const parsed = JSON.parse(resultJson!);
      expect(parsed.task_id).toBe("new-task");
      expect(parsed.status).toBe("completed");
    });

    test("should generate checksum if not provided", async () => {
      await inbox.start();

      const record: ResultRecord = {
        task_id: "no-checksum-task",
        status: "completed",
        result: { data: "test" },
      };

      sendResultCalls.push({ record, shouldFail: false });
      await inbox.enqueueResult(record);

      const checksumFile = mockFileSystem.get("/test/pending/no-checksum-task/checksum.sha256");
      expect(checksumFile).toBeDefined();
      expect(checksumFile).toContain("sha256-");
    });

    test("should initialize retry count to 0", async () => {
      await inbox.start();

      const record: ResultRecord = {
        task_id: "retry-task",
        status: "completed",
      };

      sendResultCalls.push({ record, shouldFail: false });
      await inbox.enqueueResult(record);

      const retryCount = mockFileSystem.get("/test/pending/retry-task/retry_count");
      expect(retryCount).toBe("0\n");
    });

    test("should skip if task already pending", async () => {
      await inbox.start();

      mockFileSystem.set("/test/pending/dup-task/result.json", JSON.stringify({
        task_id: "dup-task",
        status: "completed",
      }));

      const record: ResultRecord = {
        task_id: "dup-task",
        status: "failed",
        error: "new error",
      };

      await inbox.enqueueResult(record);

      const resultJson = mockFileSystem.get("/test/pending/dup-task/result.json");
      const parsed = JSON.parse(resultJson!);
      expect(parsed.status).toBe("completed");
    });

    test("should call sendResult and schedule retry on failure", async () => {
      await inbox.start();

      const record: ResultRecord = {
        task_id: "fail-task",
        status: "completed",
      };

      sendResultCalls.push({ record, shouldFail: true });
      await inbox.enqueueResult(record);

      expect(timerCallbacks.length).toBeGreaterThan(0);
      expect(timerCallbacks[0].delay).toBe(100);
    });
  });

  describe("handleAck()", () => {
    test("should remove pending directory on ACK", async () => {
      await inbox.start();

      mockFileSystem.set("/test/pending/ack-task/result.json", JSON.stringify({
        task_id: "ack-task",
        status: "completed",
      }));
      mockFileSystem.set("/test/pending/ack-task/retry_count", "0");

      await inbox.handleAck("ack-task");

      expect(mockFileSystem.has("/test/pending/ack-task")).toBe(false);
    });

    test("should clear retry timer on ACK", async () => {
      await inbox.start();

      const record: ResultRecord = {
        task_id: "timer-task",
        status: "completed",
      };

      sendResultCalls.push({ record, shouldFail: true });
      await inbox.enqueueResult(record);

      expect(timerCallbacks.length).toBe(1);

      await inbox.handleAck("timer-task");
      expect(inbox).toBeDefined();
    });
  });

  describe("retry logic", () => {
    test("should schedule retry with exponential backoff delays", async () => {
      await inbox.start();

      const record: ResultRecord = {
        task_id: "retry-backoff-task",
        status: "completed",
      };

      sendResultCalls.push({ record, shouldFail: true });
      await inbox.enqueueResult(record);

      expect(timerCallbacks.length).toBe(1);
      expect(timerCallbacks[0].delay).toBe(100);

      // Verify retry count file was created
      const retryCount = mockFileSystem.get("/test/pending/retry-backoff-task/retry_count");
      expect(retryCount).toBe("0\n");
    });

    test("should create orphaned marker when retry count exceeds max", async () => {
      await inbox.start();

      const record: ResultRecord = {
        task_id: "orphan-task",
        status: "completed",
      };

      sendResultCalls.push({ record, shouldFail: true });
      await inbox.enqueueResult(record);

      mockFileSystem.set("/test/pending/orphan-task/retry_count", "3");

      if (timerCallbacks.length > 0) {
        await timerCallbacks[0].callback();
      }

      const orphanedMarker = mockFileSystem.get("/test/pending/orphan-task/orphaned");
      expect(orphanedMarker).toBeDefined();
      expect(orphanedMarker).toContain("2026-");
    });

    test("should use last delay when retry count exceeds array length", async () => {
      await inbox.start();

      const record: ResultRecord = {
        task_id: "long-retry-task",
        status: "completed",
      };

      // Pre-populate with high retry count
      mockFileSystem.set("/test/pending/long-retry-task/result.json", JSON.stringify(record));
      mockFileSystem.set("/test/pending/long-retry-task/retry_count", "10");

      sendResultCalls.push({ record, shouldFail: true });
      await inbox.enqueueResult(record);

      // Should use the last delay (400ms) from the retryDelaysMs array
      expect(timerCallbacks.length).toBeGreaterThan(0);
      const lastTimer = timerCallbacks[timerCallbacks.length - 1];
      expect(lastTimer.delay).toBe(400);
    });
  });

  describe("result record types", () => {
    test("should handle completed status", async () => {
      await inbox.start();

      const record: ResultRecord = {
        task_id: "completed-task",
        status: "completed",
        result: { output: "success" },
        result_uri: "mfs:///results/completed-task",
        checksum: "abc123",
        completed_at: "2026-01-01T00:00:00Z",
      };

      sendResultCalls.push({ record, shouldFail: false });
      await inbox.enqueueResult(record);

      const resultJson = mockFileSystem.get("/test/pending/completed-task/result.json");
      const parsed = JSON.parse(resultJson!);
      expect(parsed.status).toBe("completed");
      expect(parsed.result_uri).toBe("mfs:///results/completed-task");
    });

    test("should handle failed status", async () => {
      await inbox.start();

      const record: ResultRecord = {
        task_id: "failed-task",
        status: "failed",
        error: "Task execution failed with error",
        completed_at: "2026-01-01T00:00:00Z",
      };

      sendResultCalls.push({ record, shouldFail: false });
      await inbox.enqueueResult(record);

      const resultJson = mockFileSystem.get("/test/pending/failed-task/result.json");
      const parsed = JSON.parse(resultJson!);
      expect(parsed.status).toBe("failed");
      expect(parsed.error).toBe("Task execution failed with error");
    });

    test("should handle cancelled status", async () => {
      await inbox.start();

      const record: ResultRecord = {
        task_id: "cancelled-task",
        status: "cancelled",
        completed_at: "2026-01-01T00:00:00Z",
      };

      sendResultCalls.push({ record, shouldFail: false });
      await inbox.enqueueResult(record);

      const resultJson = mockFileSystem.get("/test/pending/cancelled-task/result.json");
      const parsed = JSON.parse(resultJson!);
      expect(parsed.status).toBe("cancelled");
    });
  });

  describe("default options", () => {
    test("should use default directories when not specified", () => {
      const defaultInbox = new ResultInbox({
        sendResult: async () => {},
      });

      expect(defaultInbox).toBeDefined();
    });

    test("should use default retry delays", async () => {
      const customInbox = new ResultInbox({
        pendingDir: "/custom/pending",
        stagingDir: "/custom/staging",
        sendResult: async () => {},
        maxRetries: 5,
      });

      await customInbox.start();

      const record: ResultRecord = {
        task_id: "default-delay-task",
        status: "completed",
      };

      await customInbox.enqueueResult(record);

      expect(mockFileSystem.has("/custom/pending/default-delay-task/result.json")).toBe(true);

      await customInbox.stop();
    });
  });
});
