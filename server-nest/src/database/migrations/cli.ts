import {
  createMigrationDatabase,
  migrationConfig,
  validateMigrationCommand,
} from './migration-config.js';
import {
  getMigrationStatus,
  migrateToLatest,
  safeMigrationError,
} from './migration-runner.js';

async function main(): Promise<void> {
  const config = migrationConfig(process.env);
  const options = validateMigrationCommand(
    process.argv.slice(2),
    config.database!,
  );
  const db = createMigrationDatabase(config);
  try {
    if (options.command === 'status') {
      const status = await getMigrationStatus(db);
      console.log(`Installation: ${status.installation}`);
      for (const migration of status.migrations) {
        console.log(
          `${migration.name}: ${migration.applied ? 'applied' : 'pending'}`,
        );
      }
    } else {
      const results = await migrateToLatest(db, options.baselineLegacy);
      for (const result of results)
        console.log(`${result.migrationName}: applied`);
      if (!results.length)
        console.log('Database is up to date; no migrations applied.');
    }
  } finally {
    await db.destroy();
  }
}

try {
  await main();
} catch (error) {
  console.error(safeMigrationError(error));
  process.exitCode = 1;
}
