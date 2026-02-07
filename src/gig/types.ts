export const GIG_STATES = ['idle', 'running', 'degraded', 'stopped'] as const;

export type GigState = (typeof GIG_STATES)[number];

export const GIG_EXECUTION_STATUSES = ['queued', 'running', 'completed', 'failed', 'cancelled'] as const;

export type GigExecutionStatus = (typeof GIG_EXECUTION_STATUSES)[number];

// 统一字面量集合判断，避免上层处理未知状态值。
const isLiteralMember = <T extends readonly string[]>(
  value: unknown,
  literals: T,
): value is T[number] => {
  return typeof value === 'string' && literals.includes(value as T[number]);
};

export const isGigState = (value: unknown): value is GigState => {
  return isLiteralMember(value, GIG_STATES);
};

export const isGigExecutionStatus = (value: unknown): value is GigExecutionStatus => {
  return isLiteralMember(value, GIG_EXECUTION_STATUSES);
};
