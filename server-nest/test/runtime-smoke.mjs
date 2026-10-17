import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const marker = 'private-smoke-password-and-path';
const storageRoot = await mkdtemp(join(tmpdir(), 'saefr-runtime-smoke-'));
const children = new Set();

function start(extraEnv) {
  const child = spawn(process.execPath, ['dist/main.js'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      NODE_ENV: 'test',
      HOST: '127.0.0.1',
      POSTGRES_HOST: '127.0.0.1',
      POSTGRES_PORT: '1',
      POSTGRES_DB: 'saefr_runtime_smoke',
      POSTGRES_USER: 'saefr_runtime_smoke',
      POSTGRES_PASSWORD: marker,
      STORAGE_ROOT: storageRoot,
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.add(child);
  let output = '';
  for (const stream of [child.stdout, child.stderr]) {
    stream.on('data', (chunk) => {
      output += chunk.toString();
    });
  }
  const exited = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => {
      children.delete(child);
      resolve({ code, signal });
    });
  });
  return { child, exited, output: () => output };
}

async function waitForExit(run) {
  let timer;
  try {
    return await Promise.race([
      run.exited,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('Application did not exit in time')),
          8000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function listenOnFreePort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Could not reserve a localhost port');
  }
  return { server, port: address.port };
}

function assertSafeOutput(run) {
  if (run.output().includes(marker) || run.output().includes(storageRoot)) {
    throw new Error('Startup or shutdown output exposed private settings');
  }
}

try {
  const invalid = start({ NODE_ENV: marker, PORT: '3000' });
  const invalidResult = await waitForExit(invalid);
  assertSafeOutput(invalid);
  if (invalidResult.code === 0 || !invalid.output().includes('NODE_ENV')) {
    throw new Error('Invalid configuration did not fail clearly');
  }
  console.log('Invalid configuration: safe nonzero exit');

  const occupied = await listenOnFreePort();
  try {
    const failedListen = start({ PORT: String(occupied.port) });
    const listenResult = await waitForExit(failedListen);
    assertSafeOutput(failedListen);
    if (
      listenResult.code === 0 ||
      !failedListen.output().includes('EADDRINUSE')
    ) {
      throw new Error('Occupied listen port did not fail clearly');
    }
    console.log('Occupied listen port: safe nonzero exit and cleanup');
  } finally {
    await new Promise((resolve) => occupied.server.close(resolve));
  }

  const free = await listenOnFreePort();
  await new Promise((resolve) => free.server.close(resolve));
  const running = start({ PORT: String(free.port) });
  try {
    let ready = false;
    for (let attempt = 0; attempt < 80; attempt++) {
      try {
        const response = await fetch(`http://127.0.0.1:${free.port}/health`, {
          signal: AbortSignal.timeout(500),
        });
        if (response.ok) {
          ready = true;
          break;
        }
      } catch {
        // The server is still starting; no database request is made.
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (!ready) throw new Error('Application did not start on localhost');

    running.child.kill('SIGTERM');
    const stopped = await waitForExit(running);
    assertSafeOutput(running);
    if (stopped.code !== 0 && stopped.signal !== 'SIGTERM') {
      throw new Error(
        `Application did not shut down cleanly on SIGTERM (code ${stopped.code}, signal ${stopped.signal})`,
      );
    }
    let acceptedRequest = false;
    try {
      await fetch(`http://127.0.0.1:${free.port}/health`, {
        signal: AbortSignal.timeout(500),
      });
      acceptedRequest = true;
    } catch {
      // A closed listener rejects the request.
    }
    if (acceptedRequest)
      throw new Error('Application still accepted requests after SIGTERM');
    console.log('SIGTERM: server closed after localhost health response');
  } finally {
    if (running.child.exitCode === null) running.child.kill('SIGKILL');
  }
} finally {
  for (const child of children) child.kill('SIGKILL');
  await rm(storageRoot, { recursive: true, force: true });
}
