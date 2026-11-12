// Node --import fixture only: hold actual production main's transport disposal at an IPC barrier.
import { EventEmitter } from 'node:events';
import { RedisConnection } from 'bullmq';
let client;
class SignalDriver extends EventEmitter {
  status = 'connecting';
  options = {};
  isCluster = false;
  disconnect() {
    process.send?.({ phase: 'disposal-requested' });
  }
  defineCommand() {}
}
RedisConnection.clientFactory = () => {
  client = new SignalDriver();
  // Record a real initialization error before shutdown, without logging its contents.
  queueMicrotask(() => {
    client.emit(
      'error',
      new Error('synthetic-private-signal-initialization-error'),
    );
    process.send?.({ phase: 'initializing' });
  });
  return client;
};
process.on('message', (message) => {
  if (message?.release !== true) return;
  client.status = 'end';
  client.emit('end');
  // The test must not keep main alive merely because its IPC channel is open.
  setImmediate(() => process.disconnect?.());
});
