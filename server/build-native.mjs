import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Only the proposed Linux profile has a native observer. Other platforms
// remain unsupported and fail closed at runtime without a generated helper.
if (process.platform === 'linux') {
  const root = fileURLToPath(new URL('./', import.meta.url));
  mkdirSync(fileURLToPath(new URL('./dist/native/', import.meta.url)), {
    recursive: true,
  });
  const result = spawnSync(
    'cc',
    [
      '-std=c11',
      '-Wall',
      '-Wextra',
      '-Werror',
      '-O2',
      'native/storage-identity-observer.c',
      '-o',
      'dist/native/storage-identity-observer',
    ],
    { cwd: root, stdio: 'inherit' },
  );
  if (result.status !== 0) process.exitCode = 1;
}
