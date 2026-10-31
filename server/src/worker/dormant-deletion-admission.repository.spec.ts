import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// This is an explicit architecture gate: activating either strict manual
// semantics or automatic admission requires a separately reviewed cutover.
describe('B.4.1 production dormancy', () => {
  it('has no importing production source or Nest registration', async () => {
    const root = join(dirname(fileURLToPath(import.meta.url)), '..');
    const filename = 'dormant-deletion-admission.repository.ts';
    async function check(directory: string): Promise<void> {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) await check(path);
        else if (
          entry.name.endsWith('.ts') &&
          !entry.name.endsWith('.spec.ts') &&
          entry.name !== filename
        ) {
          expect(await readFile(path, 'utf8'), path).not.toMatch(
            /dormant-deletion-admission|DormantDeletionAdmissionRepository/,
          );
        }
      }
    }
    await check(root);
  });
});
