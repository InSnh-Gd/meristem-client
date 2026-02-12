import { afterEach, describe, expect, it } from 'bun:test';
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { createResultDelivery } from '../gig/result-delivery.js';
import type { ResultRecord } from '../services/result-inbox.js';

const tempRoots: string[] = [];

const createTempRoot = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), 'meristem-result-atomicity-'));
  tempRoots.push(root);
  return root;
};

afterEach(async () => {
  for (const root of tempRoots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

describe('result atomicity and idempotency', () => {
  it('应在 sendResult 返回 acked 后自动完成 ACK 清理', async () => {
    const root = await createTempRoot();
    const pendingDir = join(root, 'pending');
    const stagingDir = join(root, 'staging');
    const sent: ResultRecord[] = [];

    const delivery = createResultDelivery({
      pendingDir,
      stagingDir,
      retryDelaysMs: [1000],
      maxRetries: 1,
      sendResult: async (record) => {
        sent.push(record);
        return { acked: true };
      },
    });

    await delivery.start();
    await delivery.deliver({
      task_id: 'task-auto-ack',
      status: 'completed',
      result_uri: 'mfs://result/output.json',
    });
    await delivery.stop();

    expect(sent).toHaveLength(1);
    expect(typeof sent[0]?.delivery_id).toBe('string');
    expect(access(join(pendingDir, 'task-auto-ack'))).rejects.toThrow();
  });

  it('应在启动时恢复已 commit 的 staging 目录并重发', async () => {
    const root = await createTempRoot();
    const pendingDir = join(root, 'pending');
    const stagingDir = join(root, 'staging');
    const stagingTaskDir = join(stagingDir, 'task-recover.tmp');

    await mkdir(join(stagingTaskDir, 'payload'), { recursive: true });
    await writeFile(join(stagingTaskDir, 'checkpoint.prepare'), '2026-02-12T00:00:00.000Z\n');
    await writeFile(
      join(stagingTaskDir, 'result.json'),
      JSON.stringify(
        {
          task_id: 'task-recover',
          status: 'completed',
          result_uri: 'mfs://result/recovered.json',
          delivery_id: '0'.repeat(64),
        },
        null,
        2,
      ),
    );
    await writeFile(join(stagingTaskDir, 'checksum.sha256'), `${'a'.repeat(64)}\n`);
    await writeFile(join(stagingTaskDir, 'retry_count'), '0\n');
    await writeFile(join(stagingTaskDir, 'delivery_id'), `${'0'.repeat(64)}\n`);
    await writeFile(join(stagingTaskDir, 'checkpoint.commit'), '2026-02-12T00:00:01.000Z\n');

    const sent: ResultRecord[] = [];
    const delivery = createResultDelivery({
      pendingDir,
      stagingDir,
      retryDelaysMs: [1000],
      maxRetries: 1,
      sendResult: async (record) => {
        sent.push(record);
        return { acked: true };
      },
    });

    await delivery.start();
    await delivery.stop();

    expect(sent).toHaveLength(1);
    expect(sent[0]?.task_id).toBe('task-recover');
    expect(access(join(pendingDir, 'task-recover'))).rejects.toThrow();
    const remainingStaging = await readdir(stagingDir);
    expect(remainingStaging).toEqual([]);
  });

  it('同一 task_id 的不同 delivery_id 不应覆盖已落盘结果', async () => {
    const root = await createTempRoot();
    const pendingDir = join(root, 'pending');
    const stagingDir = join(root, 'staging');

    const delivery = createResultDelivery({
      pendingDir,
      stagingDir,
      retryDelaysMs: [60000],
      maxRetries: 1,
      sendResult: async () => {
        throw new Error('network unavailable');
      },
    });

    await delivery.start();
    await delivery.deliver({
      task_id: 'task-duplicate',
      status: 'completed',
      result_uri: 'mfs://result/first.json',
    });
    await delivery.deliver({
      task_id: 'task-duplicate',
      status: 'failed',
      error: 'should-not-overwrite',
      delivery_id: 'f'.repeat(64),
    });
    await delivery.stop();

    const persisted = JSON.parse(
      await readFile(join(pendingDir, 'task-duplicate', 'result.json'), 'utf-8'),
    ) as ResultRecord;
    expect(persisted.status).toBe('completed');
    expect(persisted.result_uri).toBe('mfs://result/first.json');
    expect(persisted.error).toBeUndefined();
  });
});
