import {
  ResultInbox,
  type ResultInboxOptions,
  type ResultRecord,
  type ResultSendOutcome,
} from '../services/result-inbox.js';

export type ResultDeliveryRecord = ResultRecord;
export type ResultDeliveryOptions = ResultInboxOptions;
export type ResultDeliverySendOutcome = ResultSendOutcome;

export interface ResultDelivery {
  start(): Promise<void>;
  stop(): Promise<void>;
  deliver(record: ResultDeliveryRecord): Promise<void>;
  ack(taskId: string): Promise<void>;
}

export const createResultDelivery = (options: ResultDeliveryOptions): ResultDelivery => {
  const inbox = new ResultInbox(options);

  // 通过工厂屏蔽底层类实现，仅暴露稳定接口。
  return Object.freeze({
    start: () => inbox.start(),
    stop: () => inbox.stop(),
    deliver: (record: ResultDeliveryRecord) => inbox.enqueueResult(record),
    ack: (taskId: string) => inbox.handleAck(taskId),
  });
};
