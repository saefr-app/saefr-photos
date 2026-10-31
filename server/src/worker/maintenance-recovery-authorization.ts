import { RecoveryPermitStore } from './recovery-permit-store.js';
import {
  createPermitPairing,
  permitLocation,
} from './recovery-permit-config.js';
import { RecoveryPermitService } from './recovery-permit.service.js';
import { validGeneration } from './recovery-permit.js';

/** Fresh observations only; neither a reservation nor permission for filesystem I/O. */
export class MaintenanceRecoveryAuthorization {
  constructor(private readonly permit: RecoveryPermitService) {}

  /** Discover the current generation afresh; callers must still recheck boundaries. */
  observe() {
    return this.permit.check();
  }

  async allowed(expectedGeneration: string): Promise<boolean> {
    if (!validGeneration(expectedGeneration)) return false;
    return (await this.permit.check(expectedGeneration)).allowed;
  }
}

/** Explicit B.2 configuration, no .env/application credential fallback or runtime registration. */
export function createMaintenanceRecoveryAuthorization(env: NodeJS.ProcessEnv) {
  const location = permitLocation(env);
  const pairing = createPermitPairing(env, location);
  return {
    authorization: new MaintenanceRecoveryAuthorization(
      new RecoveryPermitService(
        new RecoveryPermitStore(location),
        pairing.pairing,
      ),
    ),
    close: pairing.close,
  };
}
