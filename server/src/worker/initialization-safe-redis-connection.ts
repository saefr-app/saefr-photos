import { RedisConnection } from 'bullmq';

// Existing backoff <= 2s + connect <= 2s + 1s disposal allowance.
export const INITIALIZING_REDIS_CLOSE_MS = 5000;

/** Keep error forwarding until initialization AND local transport retirement settle. */
export class InitializationSafeRedisConnection extends RedisConnection {
  private closeTask?: Promise<void>;

  override close(force = false): Promise<void> {
    this.closeTask ??= this.closeInitialized(force);
    return this.closeTask;
  }

  private async closeInitialized(force: boolean): Promise<void> {
    const client = this._client;
    // Capture the real driver acknowledgement before BullMQ can assign status=end.
    // disconnect() only starts a TCP half-close; its void return is not evidence.
    const ended =
      client.status === 'end'
        ? Promise.resolve()
        : new Promise<void>((resolve) => client.once('end', resolve));
    const disconnect = () => client.disconnect();
    // Clearing an existing reconnect timer can strand initialization. Permit only
    // that scheduled attempt to settle, then prevent every subsequent reconnect.
    client.options.retryStrategy = () => null;
    client.once('connect', disconnect);
    try {
      if (client.status !== 'reconnecting') disconnect();
      await Promise.all([this.client.catch(() => undefined), ended]);
    } finally {
      client.off('connect', disconnect);
    }
    // In 5.81.5 this removes error listeners. Its initialization emission must precede it.
    await super.close(force);
  }
}
