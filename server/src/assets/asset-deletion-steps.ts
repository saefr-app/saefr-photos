import type { StorageRole } from '../storage/storage-marker.js';

/** M12 ordering, shared by manual and controlled execution. Each callback owns
 * its fresh checks and dispatch, with no added await between them. */
export async function removeJournalFiles<T>(steps: {
  remove(role: StorageRole): Promise<T | undefined>;
  persist(role: StorageRole): Promise<T | undefined>;
}): Promise<T | undefined> {
  for (const role of ['originals', 'thumbnails'] as const) {
    const removal = await steps.remove(role);
    if (removal !== undefined) return removal;
    const persistence = await steps.persist(role);
    if (persistence !== undefined) return persistence;
  }
}
