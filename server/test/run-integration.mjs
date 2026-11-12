import { randomBytes, randomUUID } from 'node:crypto';
import { execFile as execFileCallback, spawn } from 'node:child_process';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);
const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
const name = `saefr-m7-test-${suffix}`;
const database = `saefr_m7_${suffix}`;
const user = 'saefr_m7_test';
const password = randomBytes(24).toString('hex');
let containerId;
let child;
let interrupted = false;
let forceKillTimer;

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => {
    interrupted = true;
    process.exitCode = 1;
    if (child && child.exitCode === null) {
      child.kill(signal);
      forceKillTimer ??= setTimeout(() => child.kill('SIGKILL'), 5000);
      forceKillTimer.unref();
    }
  });
}

async function docker(...args) {
  return execFile('docker', args, { timeout: 120_000 });
}

function isOwnedContainer(container) {
  return (
    container?.Name === `/${name}` &&
    container.Config.Image === 'postgres:18' &&
    container.Config.Labels['dev.saefr.purpose'] ===
      'milestone-07-integration' &&
    container.Config.Env.includes(`POSTGRES_DB=${database}`) &&
    container.Config.Env.includes(`POSTGRES_USER=${user}`) &&
    container.Config.Env.includes(`POSTGRES_PASSWORD=${password}`) &&
    container.HostConfig.AutoRemove &&
    container.HostConfig.Tmpfs?.['/var/lib/postgresql'] &&
    container.Mounts.every((mount) => mount.Type === 'tmpfs')
  );
}

async function waitForDatabase() {
  for (let attempt = 0; attempt < 60; attempt++) {
    if (interrupted) throw new Error('Integration test interrupted');
    try {
      await docker(
        'exec',
        containerId,
        'pg_isready',
        '-U',
        user,
        '-d',
        database,
      );
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
  throw new Error(
    'Disposable PostgreSQL did not become ready within 60 seconds',
  );
}

try {
  const migrationsOnly = process.argv.includes('--migrations');
  const nativeOnly = process.argv.includes('--native-storage-http');
  const maintenanceOnly = process.argv.includes('--maintenance');
  if (
    process.argv
      .slice(2)
      .some(
        (argument) =>
          argument !== '--migrations' &&
          argument !== '--native-storage-http' &&
          argument !== '--maintenance',
      ) ||
    Number(migrationsOnly) + Number(nativeOnly) + Number(maintenanceOnly) > 1
  ) {
    throw new Error('Unsupported integration test filter');
  }
  if (maintenanceOnly && !process.env.SAEFR_REDIS_TEST_CONTAINER_ID)
    throw new Error(
      'Combined maintenance tests require the disposable Redis runner',
    );
  if (
    nativeOnly &&
    (process.env.GITHUB_ACTIONS !== 'true' ||
      process.env.EXPECTED_RUNNER_ENVIRONMENT !== 'github-hosted' ||
      process.env.EXPECTED_RUNNER_OS !== 'Linux' ||
      !process.env.RUNNER_TEMP ||
      !process.env.SAEFR_NATIVE_FIRST?.startsWith(
        `${process.env.RUNNER_TEMP}/saefr-m12c-ext4.`,
      ))
  ) {
    throw new Error('Disposable native ext4 runner required');
  }
  // No Compose project, named volume, bind mount, or application .env is used.
  const result = await docker(
    'run',
    '--detach',
    '--rm',
    '--name',
    name,
    '--label',
    'dev.saefr.purpose=milestone-07-integration',
    '--tmpfs',
    '/var/lib/postgresql:rw,nosuid,size=256m',
    '--publish',
    '127.0.0.1::5432',
    '--env',
    `POSTGRES_DB=${database}`,
    '--env',
    `POSTGRES_USER=${user}`,
    '--env',
    `POSTGRES_PASSWORD=${password}`,
    'postgres:18',
  );
  containerId = result.stdout.trim();

  const inspected = JSON.parse((await docker('inspect', name)).stdout)[0];
  const binding = inspected.NetworkSettings.Ports['5432/tcp']?.[0];
  if (
    inspected.Id !== containerId ||
    !isOwnedContainer(inspected) ||
    binding?.HostIp !== '127.0.0.1' ||
    !/^[1-9][0-9]*$/.test(binding.HostPort)
  ) {
    throw new Error('Disposable PostgreSQL isolation check failed');
  }

  await waitForDatabase();
  if (interrupted) throw new Error('Integration test interrupted');

  console.log(
    `Testing PostgreSQL 18 in disposable container ${name} on localhost:${binding.HostPort}`,
  );
  const exitCode = await new Promise((resolve, reject) => {
    child = spawn(
      process.execPath,
      [
        'node_modules/vitest/vitest.mjs',
        'run',
        '--config',
        maintenanceOnly
          ? 'vitest.config.maintenance.ts'
          : 'vitest.config.integration.ts',
        ...(migrationsOnly
          ? ['test/migrations.integration-spec.ts']
          : nativeOnly
            ? ['test/storage-native-http.integration-spec.ts']
            : []),
      ],
      {
        stdio: 'inherit',
        env: {
          ...process.env,
          SAEFR_M7_TEST_CONTAINER_ID: containerId,
          SAEFR_M7_TEST_DB: database,
          SAEFR_M7_TEST_USER: user,
          SAEFR_M7_TEST_PASSWORD: password,
          SAEFR_M7_TEST_PORT: binding.HostPort,
        },
      },
    );
    child.once('error', reject);
    child.once('close', (code) => {
      clearTimeout(forceKillTimer);
      resolve(code ?? 1);
    });
  });
  process.exitCode = interrupted ? 1 : exitCode;
} catch (error) {
  // execFile errors include the full docker command, including its password.
  console.error(
    error && typeof error === 'object' && 'cmd' in error
      ? 'Docker command failed during integration setup or execution'
      : error instanceof Error
        ? error.message
        : String(error),
  );
  process.exitCode = 1;
} finally {
  try {
    // Look up by our random name even when `docker run` created the container
    // but failed before returning its ID. Never stop a name collision.
    const inspected = JSON.parse((await docker('inspect', name)).stdout)[0];
    if (
      !isOwnedContainer(inspected) ||
      (containerId && inspected.Id !== containerId)
    ) {
      console.error(
        `Could not verify disposable container ${name}; inspect it before manual cleanup.`,
      );
      process.exitCode = 1;
    } else {
      await docker('stop', '--timeout', '1', inspected.Id);
      console.log(`Removed disposable container ${name}`);
    }
  } catch (error) {
    if (
      error &&
      typeof error === 'object' &&
      'stderr' in error &&
      typeof error.stderr === 'string' &&
      /no such object/i.test(error.stderr)
    ) {
      // Docker already removed it (or it was never created).
    } else {
      console.error(
        `Could not verify or remove disposable container ${name}; inspect it before manual cleanup.`,
      );
      process.exitCode = 1;
    }
  }
}
