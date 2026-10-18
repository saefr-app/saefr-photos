import { isAbsolute, relative, resolve, sep } from 'node:path';
import type { ConfigService } from '@nestjs/config';

export interface MlOptions {
  url: string;
  token: string;
  scopeId: string;
  stateDir: string;
  backfill: boolean;
}

export function mlOptions(config: ConfigService): MlOptions | null {
  const enabled = config.get<string>('ML_ENABLED', 'false');
  if (enabled === 'false') return null;
  const invalid = () => new Error('Invalid ML integration configuration');
  if (enabled !== 'true') throw invalid();
  const host = config.get<string>('HOST', '127.0.0.1').toLowerCase();
  const backfill = config.get<string>('ML_BACKFILL_ENABLED', 'false');
  if (
    !['127.0.0.1', '::1', 'localhost'].includes(host) ||
    !['true', 'false'].includes(backfill)
  )
    throw invalid();
  let url: URL;
  try {
    url = new URL(config.getOrThrow<string>('ML_COORDINATOR_URL'));
  } catch {
    throw invalid();
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    !['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.hash ||
    url.search
  )
    throw invalid();
  const token = config.get<string>('ML_COORDINATOR_TOKEN', '');
  const scopeId = config.get<string>('ML_SCOPE_ID', '');
  const state = config.get<string>('ML_BRIDGE_STATE_DIR', '');
  if (
    !/^[A-Za-z0-9_-]{32,256}$/.test(token) ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      scopeId,
    ) ||
    !state ||
    state.includes('\0')
  )
    throw invalid();
  const stateDir = resolve(state);
  const storage = resolve(config.get<string>('STORAGE_ROOT', '../storage'));
  const fromStorage = relative(storage, stateDir);
  if (
    !fromStorage ||
    (fromStorage !== '..' &&
      !fromStorage.startsWith('..' + sep) &&
      !isAbsolute(fromStorage))
  )
    throw invalid();
  return {
    url: url.origin,
    token,
    scopeId,
    stateDir,
    backfill: backfill === 'true',
  };
}
