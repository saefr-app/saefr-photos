// This accepts only synthetic test permits. It is never a real deletion permit.
export function syntheticGateAllows(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return false;
  const permit = value as Record<string, unknown>;
  return (
    Object.keys(permit).length === 3 &&
    permit.kind === 'synthetic' &&
    permit.version === 1 &&
    permit.armed === true
  );
}
