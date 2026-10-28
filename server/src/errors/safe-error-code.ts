const SAFE_CODES: Readonly<Record<string, string>> = {
  EACCES: 'EACCES',
  EADDRINUSE: 'EADDRINUSE',
  ECONNREFUSED: 'ECONNREFUSED',
  EEXIST: 'EEXIST',
  EIO: 'EIO',
  EMFILE: 'EMFILE',
  ENOENT: 'ENOENT',
  ENOSPC: 'ENOSPC',
  EPERM: 'EPERM',
  EROFS: 'EROFS',
  ETIMEDOUT: 'ETIMEDOUT',
  '08006': 'PostgreSQL connection failure',
  '23505': 'PostgreSQL unique constraint',
  '28P01': 'PostgreSQL authentication failure',
  '3D000': 'PostgreSQL database missing',
  '42P01': 'PostgreSQL table missing',
  '53300': 'PostgreSQL connection limit',
  '57P01': 'PostgreSQL shutdown',
};

export function safeErrorCode(error: unknown): string {
  let code: unknown;
  try {
    code =
      typeof error === 'object' && error !== null && 'code' in error
        ? error.code
        : undefined;
  } catch {
    return 'unclassified';
  }

  if (typeof code === 'string' && Object.hasOwn(SAFE_CODES, code)) {
    return SAFE_CODES[code];
  }

  if (error instanceof TypeError) return 'TypeError';
  if (error instanceof RangeError) return 'RangeError';
  if (error instanceof SyntaxError) return 'SyntaxError';

  return 'unclassified';
}
