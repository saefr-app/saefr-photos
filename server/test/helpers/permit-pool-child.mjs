// Child-only listener negative control; no production config hook or test-owned error listener.
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
const id = process.env.SAEFR_M7_TEST_CONTAINER_ID;
if (!/^[a-f0-9]{64}$/.test(id ?? ''))
  throw new Error('Disposable database runner required');
const info = JSON.parse(
  execFileSync('docker', ['inspect', id], { encoding: 'utf8', timeout: 5000 }),
)[0];
const vars = new Map(
  info.Config.Env.map((v) => [
    v.slice(0, v.indexOf('=')),
    v.slice(v.indexOf('=') + 1),
  ]),
);
if (
  info.Id !== id ||
  info.Config.Image !== 'postgres:18' ||
  info.Config.Labels['dev.saefr.purpose'] !== 'milestone-07-integration' ||
  !info.HostConfig.AutoRemove ||
  !info.HostConfig.Tmpfs?.['/var/lib/postgresql'] ||
  info.Mounts.some((m) => m.Type !== 'tmpfs') ||
  info.NetworkSettings.Ports['5432/tcp'][0].HostIp !== '127.0.0.1' ||
  info.NetworkSettings.Ports['5432/tcp'][0].HostPort !==
    process.env.SAEFR_M7_TEST_PORT ||
  vars.get('POSTGRES_DB') !== process.env.SAEFR_M7_TEST_DB ||
  vars.get('POSTGRES_USER') !== process.env.SAEFR_M7_TEST_USER ||
  vars.get('POSTGRES_PASSWORD') !== process.env.SAEFR_M7_TEST_PASSWORD
)
  throw new Error('Disposable isolation mismatch');
const modulePath =
  process.argv[2] ?? `${process.cwd()}/dist/worker/permit-database-pool.js`;
const { PermitDatabasePool } = await import(pathToFileURL(modulePath).href);
const pool = new PermitDatabasePool({
  host: '127.0.0.1',
  port: Number(process.env.SAEFR_M7_TEST_PORT),
  database: process.env.SAEFR_M7_TEST_DB,
  user: process.env.SAEFR_M7_TEST_USER,
  password: process.env.SAEFR_M7_TEST_PASSWORD,
  options: '-c default_transaction_read_only=on -c statement_timeout=5000',
});
const client = await pool.connect();
const { rows } = await client.query('select pg_backend_pid() as pid', []);
console.log(JSON.stringify({ ready: rows[0].pid }));
const timer = setTimeout(() => {
  console.error('Disposable child fault deadline');
  process.exit(2);
}, 10000);
const poll = setInterval(async () => {
  if (!pool.diagnostics().unconfirmedSessions) return;
  clearInterval(poll);
  try {
    await client.query('select 1', []).then(
      () => {
        throw new Error('Retired client reused');
      },
      () => undefined,
    );
    client.release();
    const fresh = await pool.connect();
    const next = await fresh.query('select pg_backend_pid() as pid', []);
    if (next.rows[0].pid === rows[0].pid)
      throw new Error('Retired backend reused');
    fresh.release();
    await pool.end();
    await pool.end();
    clearTimeout(timer);
    console.log('production-listener-recovered');
  } catch {
    console.error('Production pool recovery unavailable');
    process.exitCode = 1;
    clearTimeout(timer);
    await pool.end().catch(() => undefined);
  }
}, 20);
