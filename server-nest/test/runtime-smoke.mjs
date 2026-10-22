import { spawn } from 'node:child_process';

const marker = 'private-smoke-password-and-path';

function start(extraEnv) {
  const child = spawn(process.execPath, ['dist/main.js'], {
    cwd: process.cwd(),
    env: {
      PATH: process.env.PATH,
      NODE_ENV: 'test',
      HOST: '127.0.0.1',
      APP_ORIGIN: 'http://127.0.0.1:3000',
      POSTGRES_HOST: '127.0.0.1',
      POSTGRES_PORT: '1',
      POSTGRES_DB: 'saefr_runtime_smoke',
      POSTGRES_USER: 'saefr_runtime_smoke',
      POSTGRES_PASSWORD: marker,
      STORAGE_ROOT: '/tmp/saefr-runtime-smoke-unused',
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  for (const stream of [child.stdout, child.stderr])
    stream.on('data', (chunk) => {
      output += chunk.toString();
    });
  const exited = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) => resolve(code));
  });
  return { child, exited, output: () => output };
}

async function expectSafeFailure(extraEnv, category) {
  const run = start(extraEnv);
  let timer;
  try {
    const code = await Promise.race([
      run.exited,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Startup timeout')), 8000);
      }),
    ]);
    if (
      code === 0 ||
      !run.output().includes(category) ||
      run.output().includes(marker) ||
      run.output().includes('/tmp/saefr-runtime-smoke-unused')
    )
      throw new Error('Startup failure was not safe and clear');
  } finally {
    clearTimeout(timer);
    if (run.child.exitCode === null) run.child.kill('SIGKILL');
  }
}

await expectSafeFailure({ NODE_ENV: marker }, 'NODE_ENV');
console.log('Invalid configuration: safe nonzero exit');
await expectSafeFailure({}, 'ECONNREFUSED');
console.log('Unavailable authentication database: safe nonzero exit');
// A real listener/SIGTERM check now runs only in auth-http.integration-spec.ts
// against the verified disposable PostgreSQL 18 container.
