import { pathToFileURL } from 'node:url';

import {
  createPermitPairing,
  parsePermitCommand,
  permitLocation,
} from './recovery-permit-config.js';
import { RecoveryPermitStore } from './recovery-permit-store.js';
import { RecoveryPermitOperator } from './recovery-permit.service.js';
import { RecoveryPermitError } from './recovery-permit.js';

async function main(): Promise<void> {
  const location = permitLocation(process.env);
  const command = parsePermitCommand(process.argv.slice(2), location);
  const store = new RecoveryPermitStore(location);
  // Status/disarm remain usable without any database or media configuration.
  if (command.action === 'status' || command.action === 'disarm') {
    const permit =
      command.action === 'status'
        ? await store.readOperator()
        : await store.update('disarm', command.expected);
    console.log(
      JSON.stringify({ armed: permit.armed, generation: permit.generation }),
    );
    return;
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY)
    throw new RecoveryPermitError('approval_invalid');
  const database = createPermitPairing(process.env, location);
  try {
    const operator = new RecoveryPermitOperator(store, database.pairing);
    const permit = await operator.approvedUpdate(
      command.action,
      command.expected,
      command.evidence,
      command.digest,
    );
    console.log(
      JSON.stringify({ armed: permit.armed, generation: permit.generation }),
    );
  } finally {
    await database.close();
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    await main();
  } catch (error) {
    console.error(
      error instanceof RecoveryPermitError
        ? error.message
        : 'Recovery permit operation unavailable.',
    );
    process.exitCode = 1;
  }
}
