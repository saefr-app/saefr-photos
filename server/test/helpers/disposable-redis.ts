import { execFileSync } from 'node:child_process';
import { workerConfig } from '../../src/worker/worker-config.js';

/** Reinspect the exact owned Redis before clients or destructive synthetic fixtures. */
export function disposableRedis() {
  const id = process.env.SAEFR_REDIS_TEST_CONTAINER_ID;
  if (!id || !/^[a-f0-9]{64}$/.test(id))
    throw new Error('Disposable Redis runner required');
  const info = JSON.parse(
    execFileSync('docker', ['inspect', id], {
      encoding: 'utf8',
      timeout: 5000,
    }),
  ) as Array<{
    Id: string;
    Name: string;
    Config: { Image: string; Labels: Record<string, string>; Cmd: string[] };
    HostConfig: { AutoRemove: boolean; Tmpfs: Record<string, string> | null };
    Mounts: Array<{ Type: string }>;
    NetworkSettings: {
      Ports: Record<string, Array<{ HostIp: string; HostPort: string }>>;
    };
  }>;
  const item = info[0];
  const binding = item?.NetworkSettings.Ports['6379/tcp']?.[0];
  const suffix = item?.Name.match(/^\/saefr-m13a-redis-([a-f0-9]{12})$/)?.[1];
  const config = workerConfig(process.env);
  if (
    item?.Id !== id ||
    !suffix ||
    item.Config.Image !== 'redis:7.4' ||
    item.Config.Labels['dev.saefr.purpose'] !== 'm13a-disposable-redis' ||
    !config.password ||
    !item.Config.Cmd.includes(config.password) ||
    config.host !== '127.0.0.1' ||
    config.prefix !== `m13a_${suffix}` ||
    item.HostConfig.AutoRemove !== true ||
    !item.HostConfig.Tmpfs?.['/data'] ||
    item.Mounts.some((mount) => mount.Type !== 'tmpfs') ||
    binding?.HostIp !== '127.0.0.1' ||
    binding.HostPort !== String(config.port)
  )
    throw new Error('Disposable Redis isolation check failed');
  return { id, config };
}

export function wipeDisposableRedis(): void {
  const { id, config } = disposableRedis();
  try {
    const result = execFileSync(
      'docker',
      [
        'exec',
        id,
        'redis-cli',
        '-a',
        config.password!,
        '--no-auth-warning',
        'flushdb',
      ],
      { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    if (result.trim() !== 'OK') throw new Error('Unexpected fixture response');
  } catch {
    throw new Error('Disposable Redis fixture wipe failed');
  }
}

/** Restart only the owned Redis process; Docker's verified binding stays fixed. */
export async function restartDisposableRedis(): Promise<void> {
  const { id, config } = disposableRedis();
  const command = (args: string[]) => {
    try {
      return execFileSync(
        'docker',
        [
          'exec',
          id,
          'redis-cli',
          '-a',
          config.password!,
          '--no-auth-warning',
          ...args,
        ],
        { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'] },
      );
    } catch {
      throw new Error('Disposable Redis process unavailable');
    }
  };
  const previous = /process_id:(\d+)/.exec(command(['info', 'server']))?.[1];
  if (!previous)
    throw new Error('Disposable Redis process identity unavailable');
  command(['shutdown', 'nosave']);
  for (let attempt = 0; attempt < 30; attempt++) {
    disposableRedis();
    try {
      const next = /process_id:(\d+)/.exec(command(['info', 'server']))?.[1];
      if (next && next !== previous) return;
    } catch {
      /* The supervised process may be restarting. */
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Disposable Redis did not restart');
}
