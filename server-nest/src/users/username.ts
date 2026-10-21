export class UsernameError extends Error {
  constructor() {
    super('Invalid username.');
  }
}

export function canonicalUsername(value: unknown): string {
  if (typeof value !== 'string') throw new UsernameError();
  const canonical = value.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{2,63}$/.test(canonical)) throw new UsernameError();
  return canonical;
}
