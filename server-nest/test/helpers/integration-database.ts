import { execFileSync } from 'node:child_process';
import { ConfigService } from '@nestjs/config';

export function testConfig(): ConfigService {
  const containerId = process.env.SAEFR_M7_TEST_CONTAINER_ID;
  const name = process.env.SAEFR_M7_TEST_DB;
  const user = process.env.SAEFR_M7_TEST_USER;
  const password = process.env.SAEFR_M7_TEST_PASSWORD;
  const port = process.env.SAEFR_M7_TEST_PORT;

  if (
    !containerId ||
    !name ||
    !/^saefr_m7_[a-f0-9]{12}$/.test(name) ||
    user !== 'saefr_m7_test' ||
    !password ||
    !port ||
    !/^[1-9][0-9]*$/.test(port)
  ) {
    throw new Error('Run integration tests through npm run test:integration');
  }

  // Inspect the exact container before issuing any schema or fixture SQL.
  const inspected = JSON.parse(
    execFileSync('docker', ['inspect', containerId], {
      encoding: 'utf8',
      timeout: 5000,
    }),
  ) as Array<{
    Name: string;
    Config: { Image: string; Labels: Record<string, string>; Env: string[] };
    HostConfig: { AutoRemove: boolean; Tmpfs: Record<string, string> | null };
    Mounts: Array<{ Type: string }>;
    NetworkSettings: {
      Ports: Record<string, Array<{ HostIp: string; HostPort: string }>>;
    };
  }>;
  const container = inspected[0];
  const binding = container?.NetworkSettings.Ports['5432/tcp']?.[0];
  const env = new Map(
    container?.Config.Env.map((entry) => {
      const separator = entry.indexOf('=');
      return [entry.slice(0, separator), entry.slice(separator + 1)];
    }),
  );

  if (
    container?.Name !== `/saefr-m7-test-${name.slice('saefr_m7_'.length)}` ||
    container.Config.Image !== 'postgres:18' ||
    container.Config.Labels['dev.saefr.purpose'] !==
      'milestone-07-integration' ||
    !container.HostConfig.AutoRemove ||
    !container.HostConfig.Tmpfs?.['/var/lib/postgresql'] ||
    container.Mounts.some((mount) => mount.Type !== 'tmpfs') ||
    binding?.HostIp !== '127.0.0.1' ||
    binding.HostPort !== port ||
    env.get('POSTGRES_DB') !== name ||
    env.get('POSTGRES_USER') !== user ||
    env.get('POSTGRES_PASSWORD') !== password
  ) {
    throw new Error(
      'Refusing to use a database without verified test-container isolation',
    );
  }

  // Internal values take precedence over inherited POSTGRES_* variables;
  // this instance never loads .env.
  const config = new ConfigService({
    POSTGRES_HOST: '127.0.0.1',
    POSTGRES_PORT: port,
    POSTGRES_DB: name,
    POSTGRES_USER: user,
    POSTGRES_PASSWORD: password,
  });
  return config;
}
