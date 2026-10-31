import { createServer, connect, type Socket } from 'node:net';
import { testConfig } from './integration-database.js';

interface Session {
  client: Socket;
  backend: Socket;
  proof: boolean;
  dropped: Buffer[];
}
/** Disposable-only protocol fixture. Never accepts a configured development host/port. */
export class PostgresFaultProxy {
  private readonly target = testConfig();
  private readonly sessions: Session[] = [];
  private readonly server = createServer((client) => this.accept(client));
  private listeningPort = 0;
  fault: 'none' | 'after-auth' | 'after-identity' = 'none';
  preserveBackend = false;
  blockProof = false;
  primaryConnections = 0;
  droppedBytes = 0;
  port() {
    return this.listeningPort;
  }
  async start() {
    await new Promise<void>((resolve) =>
      this.server.listen(0, '127.0.0.1', resolve),
    );
    const address = this.server.address();
    if (!address || typeof address === 'string')
      throw new Error('Disposable proxy unavailable');
    this.listeningPort = address.port;
  }
  private accept(client: Socket) {
    client.setNoDelay(true);
    const backend = connect({
      host: '127.0.0.1',
      port: this.target.getOrThrow<number>('POSTGRES_PORT'),
    });
    backend.setNoDelay(true);
    const session: Session = { client, backend, proof: false, dropped: [] };
    this.sessions.push(session);
    let identified = false;
    let incoming = Buffer.alloc(0);
    let outgoing = Buffer.alloc(0);
    let ready = 0;
    client.on('error', () => undefined);
    backend.on('error', () => client.destroy());
    client.on('close', () => {
      if (!this.preserveBackend || session.proof) backend.destroy();
    });
    backend.on('close', () => {
      if (!client.destroyed) client.destroy();
    });
    client.on('data', (bytes) => {
      if (identified) {
        backend.write(bytes);
        return;
      }
      incoming = Buffer.concat([incoming, bytes]);
      if (incoming.length > 65536) {
        client.destroy();
        backend.destroy();
        return;
      }
      if (incoming.length < 4 || incoming.length < incoming.readInt32BE(0))
        return;
      session.proof = incoming.includes(Buffer.from('saefr-permit-proof-'));
      if (!session.proof) this.primaryConnections++;
      identified = true;
      backend.write(incoming);
      incoming = Buffer.alloc(0);
    });
    backend.on('data', (bytes) => {
      outgoing = Buffer.concat([outgoing, bytes]);
      if (outgoing.length > 1048576) {
        backend.destroy();
        client.destroy();
        return;
      }
      while (outgoing.length >= 5) {
        const size = outgoing.readInt32BE(1) + 1;
        if (outgoing.length < size) return;
        const frame = outgoing.subarray(0, size);
        outgoing = outgoing.subarray(size);
        const threshold = this.fault === 'after-auth' ? 1 : 2;
        const drop = session.proof
          ? this.blockProof && ready >= 1
          : this.fault !== 'none' && ready >= threshold;
        if (drop) {
          this.droppedBytes += frame.length;
          if (session.dropped.reduce((n, b) => n + b.length, 0) < 65536)
            session.dropped.push(Buffer.from(frame));
        } else if (!client.destroyed) client.write(frame);
        if (frame[0] === 90) ready++;
      }
    });
  }
  releaseRetiredBackends() {
    for (const s of this.sessions)
      if (s.client.destroyed && !s.proof) s.backend.destroy();
  }
  flushLateReplies() {
    for (const s of this.sessions) {
      if (!s.client.destroyed)
        for (const frame of s.dropped) s.client.write(frame);
      s.dropped = [];
    }
  }
  async close() {
    for (const s of this.sessions) {
      s.client.destroy();
      s.backend.destroy();
    }
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}
