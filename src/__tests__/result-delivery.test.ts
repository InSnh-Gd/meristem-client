import { afterEach, describe, expect, it } from 'bun:test';
import { access, mkdtemp, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { createResultDelivery } from '../gig/result-delivery.js';
import type { ResultRecord } from '../services/result-inbox.js';

const tempRoots: string[] = [];

const createTempRoot = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), 'meristem-result-delivery-'));
  tempRoots.push(root);
  return root;
};

afterEach(async () => {
  for (const root of tempRoots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

describe('createResultDelivery', () => {
  it('应提供稳定的投递接口', () => {
    const delivery = createResultDelivery({
      sendResult: async () => undefined,
    });

    expect(typeof delivery.start).toBe('function');
    expect(typeof delivery.stop).toBe('function');
    expect(typeof delivery.deliver).toBe('function');
    expect(typeof delivery.ack).toBe('function');
  });

  it('应通过包装层投递并确认结果', async () => {
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
      },
    });

    const record: ResultRecord = {
      task_id: 'task-ack',
      status: 'completed',
      result: { ok: true },
    };

    await delivery.start();
    await delivery.deliver(record);

    expect(sent.length).toBe(1);
    expect(sent[0]?.task_id).toBe('task-ack');

    await delivery.ack('task-ack');
    await delivery.stop();

    await expect(access(join(pendingDir, 'task-ack'))).rejects.toThrow();
  });

  it('超过重试上限后应标记为 orphaned', async () => {
    const root = await createTempRoot();
    const pendingDir = join(root, 'pending');
    const stagingDir = join(root, 'staging');
    const orphaned: string[] = [];

    const delivery = createResultDelivery({
      pendingDir,
      stagingDir,
      retryDelaysMs: [5],
      maxRetries: 1,
      sendResult: async () => {
        throw new Error('network down');
      },
      onOrphaned: (taskId) => {
        orphaned.push(taskId);
      },
    });

    await delivery.start();
    await delivery.deliver({
      task_id: 'task-orphaned',
      status: 'failed',
      error: 'boom',
    });

    await Bun.sleep(30);
    await delivery.stop();

    expect(orphaned).toEqual(['task-orphaned']);
    await expect(access(join(pendingDir, 'task-orphaned', 'orphaned'))).resolves.toBeNull();
  });
});
