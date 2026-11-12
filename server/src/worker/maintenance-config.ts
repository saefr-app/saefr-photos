import { WorkerConfigError } from './worker-config.js';

export interface MaintenanceConfig {
  enabled: boolean;
  intervalMs: number;
  renewMs: number;
  budgetMs: number;
  shutdownMs: number;
  pageSize: number;
}

export function maintenanceConfig(env: NodeJS.ProcessEnv): MaintenanceConfig {
  const raw = env.SAEFR_MAINTENANCE_ENABLED;
  if (raw !== undefined && raw !== 'true' && raw !== 'false')
    throw new WorkerConfigError('SAEFR_MAINTENANCE_ENABLED');
  const number = (key: string, fallback: number, min: number, max: number) => {
    const value = env[`SAEFR_MAINTENANCE_${key}`] ?? String(fallback);
    const n = Number(value);
    if (
      !/^[1-9][0-9]*$/.test(value) ||
      !Number.isSafeInteger(n) ||
      n < min ||
      n > max
    )
      throw new WorkerConfigError(`SAEFR_MAINTENANCE_${key}`);
    return n;
  };
  return {
    enabled: raw === 'true',
    intervalMs: number('INTERVAL_MS', 60000, 1000, 60000),
    renewMs: number('RENEW_MS', 10000, 1000, 10000),
    budgetMs: number('BUDGET_MS', 20000, 1000, 20000),
    shutdownMs: number('SHUTDOWN_MS', 8000, 1000, 10000),
    pageSize: number('PAGE_SIZE', 25, 1, 100),
  };
}
