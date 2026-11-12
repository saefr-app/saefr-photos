import { uploadAsset } from '#lib/api';
import { gallery } from '#lib/gallery/gallery.svelte';
import { session } from '#lib/session';
import {
	UploadQueue,
	type AddFilesResult,
	type UploadBlock,
	type UploadItem,
	type UploadSnapshot
} from './queue';

let snapshot = $state<UploadSnapshot>({
	items: [],
	active: false,
	blocked: null,
	duplicateCount: 0
});

const queue = new UploadQueue({
	upload: uploadAsset,
	onSuccess: () => {
		// A 201 is the only confirmation. Reload the owner's page honestly rather
		// than inventing a local tile or count.
		void gallery.refreshAfterUpload();
	},
	onUnauthorized: () => session.expire(),
	onChange: (next) => {
		snapshot = next;
	}
});

snapshot = queue.snapshot();

// Upload rows are owner-scoped: signing out or switching accounts must never
// leave another user's filenames in the panel, and in-flight results from the
// previous owner are ignored by the queue's epoch.
let ownerId: string | null = null;

function ensureOwner(id: string | null): void {
	if (id === ownerId) return;
	ownerId = id;
	queue.reset();
	snapshot = queue.snapshot();
}

export const upload = {
	ensureOwner,
	get items(): UploadItem[] {
		return snapshot.items;
	},
	get total(): number {
		return snapshot.items.length;
	},
	get completed(): number {
		return snapshot.items.filter((item) => item.status === 'success').length;
	},
	get failed(): number {
		return snapshot.items.filter(
			(item) => item.status === 'error' || item.status === 'uncertain'
		).length;
	},
	get active(): boolean {
		return snapshot.active;
	},
	get blocked(): UploadBlock | null {
		return snapshot.blocked;
	},
	get duplicateCount(): number {
		return snapshot.duplicateCount;
	},
	get canClose(): boolean {
		return snapshot.items.every((item) => item.status === 'success');
	},
	addFiles(files: ArrayLike<File> | Iterable<File>): AddFilesResult {
		ensureOwner(session.user?.id ?? null);
		return queue.addFiles(files);
	},
	retry(id: string): void {
		ensureOwner(session.user?.id ?? null);
		queue.retry(id);
	},
	dismiss(id: string): void {
		queue.dismiss(id);
	},
	dismissAll(): boolean {
		return queue.dismissAll();
	},
	clearDuplicateNotice(): void {
		queue.clearDuplicateNotice();
	}
};
