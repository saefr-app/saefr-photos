import { Writable } from 'node:stream';
import { createInterface } from 'node:readline/promises';

import { validateNewPassword } from '../auth/password.service.js';
import { OperatorConfigurationError } from './operator-config.js';

export async function readConfirmedPassword(): Promise<string> {
  if (!process.stdin.isTTY || !process.stdout.isTTY)
    throw new OperatorConfigurationError(
      'An interactive terminal is required for password entry.',
    );

  const hidden = new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
  const prompt = createInterface({
    input: process.stdin,
    output: hidden,
    terminal: true,
  });
  try {
    process.stdout.write('Password: ');
    const first = await prompt.question('');
    process.stdout.write('\nConfirm password: ');
    const confirmation = await prompt.question('');
    process.stdout.write('\n');
    if (first !== confirmation)
      throw new OperatorConfigurationError('Passwords did not match.');
    validateNewPassword(first);
    return first;
  } finally {
    prompt.close();
    hidden.destroy();
  }
}
