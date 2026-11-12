import { randomBytes, randomUUID } from 'node:crypto';
import { execFile as callback, spawn } from 'node:child_process';
import { promisify } from 'node:util';

const execFile = promisify(callback);
const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
const name = `saefr-m13a-redis-${suffix}`;
const password = randomBytes(24).toString('hex');
const image = 'redis:7.4';
let containerId;
let child;
let interrupted = false;
let forceKill;
const maintenanceOnly =
  process.argv.length === 3 && process.argv[2] === '--maintenance';
const deliveryOnly =
  process.argv.length === 3 && process.argv[2] === '--delivery';

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => {
    interrupted = true;
    process.exitCode = 1;
    if (child && child.exitCode === null) {
      child.kill(signal);
      // The nested PostgreSQL runner needs time to stop its child and remove its own container.
      forceKill ??= setTimeout(
        () => child.kill('SIGKILL'),
        maintenanceOnly ? 20000 : 5000,
      );
      forceKill.unref();
    }
  });
}

async function docker(...args) {
  return execFile('docker', args, { timeout: 120_000 });
}

function owned(info) {
  return (
    info?.Name === `/${name}` &&
    info.Config.Image === image &&
    info.Config.Labels['dev.saefr.purpose'] === 'm13a-disposable-redis' &&
    info.Config.Cmd.includes(password) &&
    info.HostConfig.AutoRemove === true &&
    Boolean(info.HostConfig.Tmpfs?.['/data']) &&
    info.Mounts.every((mount) => mount.Type === 'tmpfs')
  );
}

try {
  if (process.argv.length !== 2 && !maintenanceOnly && !deliveryOnly)
    throw new Error('Unsupported Redis test arguments');
  // No Compose project, named volume, bind mount, or application .env is used.
  const started = await docker(
    'run',
    '--detach',
    '--rm',
    '--name',
    name,
    '--label',
    'dev.saefr.purpose=m13a-disposable-redis',
    '--tmpfs',
    '/data:rw,nosuid,size=64m',
    '--publish',
    '127.0.0.1::6379',
    image,
    // Keep container/network identity stable while restarting only the test process.
    'sh',
    '-c',
    'trap \'kill -TERM "$redis_pid" 2>/dev/null; wait "$redis_pid"; exit 0\' TERM INT HUP; while :; do /usr/local/bin/docker-entrypoint.sh "$@" & redis_pid=$!; wait "$redis_pid"; sleep 0.1; done',
    'saefr-disposable-redis',
    'redis-server',
    '--requirepass',
    password,
    '--maxmemory',
    '64mb',
    '--maxmemory-policy',
    'noeviction',
    '--save',
    '',
    '--appendonly',
    'no',
  );
  containerId = started.stdout.trim();
  const info = JSON.parse((await docker('inspect', name)).stdout)[0];
  const binding = info.NetworkSettings.Ports['6379/tcp']?.[0];
  if (
    info.Id !== containerId ||
    !owned(info) ||
    binding?.HostIp !== '127.0.0.1' ||
    !/^[1-9][0-9]*$/.test(binding.HostPort)
  ) {
    throw new Error('Disposable Redis isolation check failed');
  }
  let ready = false;
  for (let attempt = 0; attempt < 30; attempt++) {
    if (interrupted) throw new Error('Redis test interrupted');
    try {
      const pong = await docker(
        'exec',
        containerId,
        'redis-cli',
        '-a',
        password,
        '--no-auth-warning',
        'ping',
      );
      if (pong.stdout.trim() === 'PONG') {
        ready = true;
        break;
      }
    } catch {
      // A failed probe is retried only within the bounded readiness window.
    }
    if (attempt < 29) await new Promise((resolve) => setTimeout(resolve, 500));
  }
  if (!ready) throw new Error('Disposable Redis did not become ready');
  if (interrupted) throw new Error('Redis test interrupted');
  console.log(
    `Testing disposable Redis in ${name} on localhost:${binding.HostPort}`,
  );
  const code = await new Promise((resolve, reject) => {
    child = spawn(
      process.execPath,
      maintenanceOnly
        ? ['test/run-integration.mjs', '--maintenance']
        : [
            'node_modules/vitest/vitest.mjs',
            'run',
            '--config',
            'vitest.config.redis.ts',
            ...(deliveryOnly
              ? ['test/recovery-delivery.redis-spec.ts', '--reporter=verbose']
              : []),
          ],
      {
        stdio: 'inherit',
        env: {
          ...process.env,
          SAEFR_REDIS_HOST: '127.0.0.1',
          SAEFR_REDIS_PORT: binding.HostPort,
          SAEFR_REDIS_PASSWORD: password,
          SAEFR_REDIS_PREFIX: `m13a_${suffix}`,
          SAEFR_REDIS_TEST_CONTAINER_ID: containerId,
          SAEFR_WORKER_CONTROL_INTERVAL_MS: '1000',
        },
      },
    );
    child.once('error', reject);
    child.once('close', (exitCode) => {
      clearTimeout(forceKill);
      resolve(exitCode ?? 1);
    });
  });
  process.exitCode = interrupted ? 1 : code;
} catch (error) {
  // execFile errors may contain the password in their command field.
  console.error(
    error && typeof error === 'object' && 'cmd' in error
      ? 'Docker command failed during disposable Redis test'
      : error instanceof Error
        ? error.message
        : 'Disposable Redis test failed',
  );
  process.exitCode = 1;
} finally {
  try {
    const info = JSON.parse((await docker('inspect', name)).stdout)[0];
    if (!owned(info) || (containerId && info.Id !== containerId)) {
      console.error(
        `Could not verify disposable container ${name}; inspect before manual cleanup.`,
      );
      process.exitCode = 1;
    } else {
      await docker('stop', '--timeout', '1', info.Id);
      console.log(`Removed disposable container ${name}`);
    }
  } catch (error) {
    if (!(
      error &&
      typeof error === 'object' &&
      'stderr' in error &&
      typeof error.stderr === 'string' &&
      /no such object/i.test(error.stderr)
    )) {
      console.error(
        `Could not verify or remove disposable container ${name}; inspect before manual cleanup.`,
      );
      process.exitCode = 1;
    }
  }
}
