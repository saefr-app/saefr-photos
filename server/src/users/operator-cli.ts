import { PasswordPolicyError } from '../auth/password.service.js';
import { MigrationSafetyError } from '../database/migrations/legacy-asset-schema.js';
import { readConfirmedPassword } from './hidden-password.js';
import {
  OperatorAccountError,
  OperatorAccountsService,
} from './operator-accounts.service.js';
import {
  createOperatorDatabase,
  OperatorConfigurationError,
  operatorDatabaseConfig,
  parseOperatorCommand,
} from './operator-config.js';
import { UsernameError } from './username.js';
import { UsernameConflictError } from './users.repository.js';

export function safeOperatorError(error: unknown): string {
  if (
    error instanceof OperatorConfigurationError ||
    error instanceof OperatorAccountError ||
    error instanceof PasswordPolicyError ||
    error instanceof UsernameError ||
    error instanceof UsernameConflictError
  )
    return error.message;
  if (error instanceof MigrationSafetyError)
    return 'Authentication schema or migration history is incompatible.';
  return 'Authentication operator command failed; inspect database availability.';
}

async function main(): Promise<void> {
  const config = operatorDatabaseConfig(process.env);
  const command = parseOperatorCommand(process.argv.slice(2), config.database!);
  if (
    command.action !== 'prune' &&
    (!process.stdin.isTTY || !process.stdout.isTTY)
  )
    throw new OperatorConfigurationError(
      'An interactive terminal is required for password entry.',
    );

  const db = createOperatorDatabase(config);
  try {
    const service = new OperatorAccountsService(db);
    await service.requireManagedAuthSchema();
    if (command.action === 'bootstrap') {
      const password = await readConfirmedPassword();
      const user = await service.bootstrapFirstAdmin(
        command.username,
        password,
      );
      console.log(`Administrator created: ${user.id}`);
    } else if (command.action === 'recover') {
      const password = await readConfirmedPassword();
      const result = await service.recoverPassword(command.userId, password);
      console.log(
        `Account password replaced: ${result.userId}; sessions revoked: ${result.revokedSessions}`,
      );
    } else {
      const count = await service.pruneExpiredSessions(command.limit);
      console.log(`Expired sessions removed: ${count}`);
    }
  } finally {
    await db.destroy();
  }
}

if (process.argv[1]?.endsWith('/users/operator-cli.js')) {
  try {
    await main();
  } catch (error) {
    console.error(safeOperatorError(error));
    process.exitCode = 1;
  }
}
