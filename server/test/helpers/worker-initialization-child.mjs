// Isolated child probes use real WorkerRuntime/BullMQ with a controlled driver,
// or ownership-verified disposable Redis for the sticky cleanup regression.
// No production factory/config hook, ordinary database, marker or media is used.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { RedisConnection, Worker } from 'bullmq';
import { execFileSync } from 'node:child_process';
import { workerConfig } from '../../dist/worker/worker-config.js';

const mode = process.argv[2];
const modulePath =
  process.argv[3] ?? `${process.cwd()}/dist/worker/worker-runtime.js`;
const { WorkerRuntime } = await import(pathToFileURL(modulePath));

if (mode === 'real-consumer-sticky-error') {
  const config = workerConfig(process.env);
  const id = process.env.SAEFR_REDIS_TEST_CONTAINER_ID;
  assert.match(id ?? '', /^[a-f0-9]{64}$/);
  const info = JSON.parse(
    execFileSync('docker', ['inspect', id], {
      encoding: 'utf8',
      timeout: 5000,
    }),
  )[0];
  assert.equal(info.Id, id);
  assert.equal(info.Config.Image, 'redis:7.4');
  assert.equal(
    info.Config.Labels['dev.saefr.purpose'],
    'm13a-disposable-redis',
  );
  assert.ok(info.Config.Cmd.includes(config.password));
  assert.ok(info.HostConfig.AutoRemove && info.HostConfig.Tmpfs['/data']);
  assert.ok(info.Mounts.every((m) => m.Type === 'tmpfs'));
  assert.equal(info.NetworkSettings.Ports['6379/tcp'][0].HostIp, '127.0.0.1');
  assert.equal(
    info.NetworkSettings.Ports['6379/tcp'][0].HostPort,
    String(config.port),
  );
  let terminations = 0;
  let injected = 0;
  // oxlint-disable-next-line typescript/unbound-method -- Isolated child invokes the original receiver.
  const close = Worker.prototype.close;
  Worker.prototype.close = async function (...args) {
    const transports = await Promise.all([this.client, this.waitUntilReady()]);
    const ended = Promise.all(
      transports.map(
        (client) =>
          new Promise((resolve) => {
            assert.notEqual(client.status, 'end');
            client.once('end', () => {
              terminations++;
              resolve();
            });
          }),
      ),
    );
    // Production has installed its cleanup listeners before entering close.
    // No test-owned error listener hides a missing production handler.
    transports[0].emit(
      'error',
      new Error('synthetic-private-sticky-cleanup-error'),
    );
    injected++;
    await close.apply(this, args);
    await ended;
  };
  const runtime = new WorkerRuntime(config);
  try {
    await runtime.start();
    const result = await runtime.stop();
    assert.equal(terminations, 2);
    assert.equal(injected, 1);
    console.log(JSON.stringify({ mode, terminations, injected, result }));
    assert.equal(result, false);
    assert.equal(await runtime.stop(), false);
    assert.equal(runtime.diagnostics().state, 'incomplete');
  } finally {
    await runtime.stop();
    Worker.prototype.close = close;
  }
} else {
  const events = [];
  const clients = [];
  let thirdCreated;
  const consumerCreated = new Promise((resolve) => {
    thirdCreated = resolve;
  });
  class ControlledClient extends EventEmitter {
    status = 'connecting';
    options = {};
    isCluster = false;
    disconnects = 0;
    ends = 0;
    autoEnd = false;
    disconnect() {
      if (mode === 'consumer-close-error' && clients.indexOf(this) === 2) {
        events.push('cleanup-error');
        throw Object.assign(new Error('synthetic-private-cleanup-error'), {
          code: 'EIO',
        });
      }
      this.disconnects++;
      events.push('disconnect-requested');
      if (this.autoEnd) queueMicrotask(() => this.end());
    }
    end() {
      if (this.ends) return;
      this.status = 'end';
      this.ends++;
      events.push('transport-ended');
      this.emit('end');
    }
    ready() {
      this.status = 'ready';
      this.emit('ready');
    }
    defineCommand() {}
    info() {
      return Promise.resolve(
        'redis_version:7.4.0\r\nredis_mode:standalone\r\n',
      );
    }
    quit() {
      this.end();
      return Promise.resolve('OK');
    }
  }
  // BullMQ's supported driver factory is overridden only inside this isolated child.
  RedisConnection.clientFactory = () => {
    const client = new ControlledClient();
    clients.push(client);
    events.push('connection-created');
    if (clients.length === 3) thirdCreated();
    return client;
  };
  const runtime = new WorkerRuntime({
    host: '127.0.0.1',
    port: 1,
    tls: false,
    prefix: 'synthetic-init-control',
    concurrency: 1,
    controlIntervalMs: 60000,
  });
  const watchdog = setTimeout(() => process.exit(2), 11000);
  try {
    if (mode === 'before-start') {
      assert.equal(await runtime.stop(), true);
      await assert.rejects(runtime.start(), /already started or stopping/);
      assert.equal(clients.length, 0);
      console.log(JSON.stringify({ mode, result: true, resources: 0 }));
    } else if (mode === 'recovery-error') {
      const { createRecoveryQueue } =
        await import('../../dist/worker/redis-recovery-delivery.js');
      const queue = createRecoveryQueue({
        host: '127.0.0.1',
        port: 1,
        tls: false,
        prefix: 'synthetic-recovery-init-control',
        concurrency: 1,
        controlIntervalMs: 60000,
      });
      const first = clients[0];
      first.emit('error', new Error('synthetic-private-initialization-error'));
      let settled = false;
      const stopping = queue.stopProducer().then(() => {
        settled = true;
      });
      await nextTurn();
      assert.equal(settled, false);
      first.end();
      await stopping;
      await queue.stopProducer();
      assert.equal(queue.closed, true);
      console.log(
        JSON.stringify({ mode, result: true, resources: clients.length }),
      );
    } else {
      const starting = runtime.start().then(
        () => 'started',
        () => 'rejected',
      );
      const first = clients[0];
      assert.ok(first);
      const consumer =
        mode.startsWith('consumer-') || mode === 'after-initialization';
      if (consumer) {
        first.ready();
        await consumerCreated; // actual Queue init completed and actual Worker constructed
        events.push('consumer-initializing');
        for (const client of clients) client.autoEnd = true;
        if (mode === 'consumer-error') {
          for (const client of clients.slice(1))
            client.emit(
              'error',
              new Error('synthetic-private-initialization-error'),
            );
        }
        if (
          [
            'after-initialization',
            'consumer-close-error',
            'consumer-delayed-end',
          ].includes(mode)
        ) {
          for (const client of clients.slice(1)) client.ready();
          if (mode === 'consumer-delayed-end') clients[2].autoEnd = false;
        }
      } else if (mode !== 'late-ready' && mode !== 'stuck-end') {
        first.emit(
          'error',
          new Error('synthetic-private-initialization-error'),
        );
      }
      if (mode === 'reconnecting-error') first.status = 'reconnecting';
      events.push('shutdown-requested');
      let settled = false;
      const began = Date.now();
      const stopping = runtime.stop().then((result) => {
        settled = true;
        events.push('shutdown-settled');
        return result;
      });
      const repeated =
        mode === 'concurrent-stop' ? [runtime.stop(), runtime.stop()] : [];
      await nextTurn();
      const premature = settled;
      if (mode === 'reconnecting-error') {
        assert.equal(typeof first.options.retryStrategy, 'function');
        assert.equal(first.options.retryStrategy(1), null);
        first.status = 'connect';
        first.emit('connect');
      }
      if (mode === 'late-ready' || mode === 'stuck-end') {
        first.ready();
        await nextTurn();
        assert.equal(settled, false); // initialized is not equivalent to transport-disposed
      }
      if (mode === 'consumer-late-ready') {
        for (const client of clients.slice(1)) client.ready();
      }
      const incomplete = [
        'stuck-init',
        'stuck-end',
        'consumer-error',
        'consumer-close-error',
        'consumer-delayed-end',
      ].includes(mode);
      if (!incomplete && !consumer) first.end();
      const result = await stopping;
      assert.equal(result, !incomplete);
      if (mode === 'consumer-close-error')
        assert.ok(events.includes('cleanup-error'));
      if (mode === 'consumer-delayed-end') assert.equal(clients[2].ends, 0);

      assert.ok(Date.now() - began < 8500);
      assert.equal(await runtime.stop(), result);
      for (const value of await Promise.all(repeated))
        assert.equal(value, result);
      const diagnostic = runtime.diagnostics();
      assert.equal(diagnostic.state, incomplete ? 'incomplete' : 'stopped');
      assert.equal(diagnostic.consumerRunning, false);
      if (!incomplete) assert.ok(clients.every((client) => client.ends === 1));
      // Explicitly release only the synthetic driver barriers, after incomplete was established.
      for (const client of clients) client.end();
      assert.equal(await starting, 'rejected');
      await nextTurn();
      if (mode !== 'after-initialization') assert.equal(premature, false);
      assert.equal(await runtime.stop(), result); // a late end never rewrites an incomplete result
      assert.equal(runtime.diagnostics().state, diagnostic.state);
      if (!consumer) assert.equal(clients.length, 1); // no consumer created after the fence
      console.log(
        JSON.stringify({
          mode,
          result,
          premature,
          events,
          diagnostic,
          resources: clients.length,
        }),
      );
    }
  } finally {
    clearTimeout(watchdog);
  }
}
