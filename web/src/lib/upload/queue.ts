import {
	ApiRequestError,
	MAX_UPLOAD_BYTES,
	isAcceptedUploadMimeType,
	statusMessage,
	type ApiError,
	type Asset
} from '#lib/api';

export type UploadItemStatus =
	| 'pending'
	| 'uploading'
	| 'success'
	| 'error'
	| 'uncertain';

/**
 * Why the queue stopped sending further files. A halt is never cleared by the
 * queue itself: only an explicit user retry/dismiss can resume it.
 */
export type UploadBlock =
	| 'unauthorized'
	| 'forbidden'
	| 'rate-limited'
	| 'unavailable'
	| 'uncertain';

export interface UploadItem {
	id: string;
	file: File;
	name: string;
	size: number;
	lastModified: number;
	/** Duplicate identity for one selection: name + size + lastModified. */
	key: string;
	status: UploadItemStatus;
	error: ApiError | null;
}

export interface UploadSnapshot {
	items: UploadItem[];
	active: boolean;
	blocked: UploadBlock | null;
	duplicateCount: number;
}

export interface AddFilesResult {
	added: number;
	duplicates: number;
}

export interface UploadQueueOptions {
	/** Sends exactly one file per request. Never called concurrently. */
	upload: (file: File) => Promise<Asset>;
	onSuccess?: (asset: Asset, item: UploadItem) => void;
	onUnauthorized?: () => void;
	onChange?: (snapshot: UploadSnapshot) => void;
}

/** Stable duplicate identity used before a file is enqueued. */
export function uploadKey(file: File): string {
	return `${file.name}\u0000${file.size}\u0000${file.lastModified}`;
}

/**
 * Client-side gate. The backend still validates actual bytes and repeats both
 * checks; this only avoids sending a request that is certain to fail.
 */
export function uploadValidationError(file: File): ApiError | null {
	if (!isAcceptedUploadMimeType(file.type)) {
		return {
			status: 415,
			message: statusMessage(415),
			kind: 'http'
		};
	}
	if (file.size > MAX_UPLOAD_BYTES) {
		return {
			status: 413,
			message: statusMessage(413),
			kind: 'http'
		};
	}
	return null;
}

function errorOf(caught: unknown): ApiError {
	if (caught instanceof ApiRequestError) return caught.api;
	return {
		status: 0,
		message: statusMessage(0),
		kind: 'network'
	};
}

function blockFor(error: ApiError): UploadBlock | null {
	if (error.status === 0) return 'uncertain';
	if (error.status === 401) return 'unauthorized';
	if (error.status === 403) return 'forbidden';
	if (error.status === 429) return 'rate-limited';
	if (error.status >= 500) return 'unavailable';
	return null;
}

/**
 * A conservative, one-at-a-time upload queue. It only moves an item from
 * `pending` to `uploading`; failures never become retries on their own. A
 * network failure is recorded as `uncertain` and halts the queue because the
 * server may already have committed the file.
 */
export class UploadQueue {
	private readonly options: UploadQueueOptions;
	private items: UploadItem[] = [];
	private block: UploadBlock | null = null;
	private duplicateCount = 0;
	private pumping = false;
	private sequence = 0;
	private epoch = 0;

	constructor(options: UploadQueueOptions) {
		this.options = options;
	}

	snapshot(): UploadSnapshot {
		return {
			items: this.items.map((item) => ({ ...item })),
			active:
				this.items.some((item) => item.status === 'uploading') ||
				(this.block === null &&
					this.items.some((item) => item.status === 'pending')),
			blocked: this.block,
			duplicateCount: this.duplicateCount
		};
	}

	/**
	 * Drops every row and ignores any response still in flight. Used when the
	 * signed-in owner changes so one account never sees another's filenames.
	 */
	reset(): void {
		this.epoch += 1;
		this.items = [];
		this.block = null;
		this.duplicateCount = 0;
		this.notify();
	}

	/** Dedupes by name + size + lastModified before an item is queued. */
	addFiles(files: ArrayLike<File> | Iterable<File>): AddFilesResult {
		const seen = new Set(this.items.map((item) => item.key));
		let added = 0;
		let duplicates = 0;

		for (const file of Array.from(files)) {
			const key = uploadKey(file);
			if (seen.has(key)) {
				duplicates += 1;
				continue;
			}
			seen.add(key);
			this.items.push(this.createItem(file, key));
			added += 1;
		}

		this.duplicateCount = duplicates;
		this.notify();
		if (added > 0) void this.pump();

		return { added, duplicates };
	}

	/**
	 * Explicit user action. Only settled failures can be retried; an uncertain
	 * upload is never replayed until the user has acted on the warning.
	 */
	retry(id: string): void {
		const item = this.items.find((candidate) => candidate.id === id);
		if (
			!item ||
			(item.status !== 'error' && item.status !== 'uncertain') ||
			this.block === 'unauthorized'
		)
			return;

		// Re-check locally before sending. A video or oversized file must never
		// reach the network just because a user retried its error row.
		const validation = uploadValidationError(item.file);
		if (validation) {
			item.status = 'error';
			item.error = validation;
			this.notify();
			return;
		}

		item.status = 'pending';
		item.error = null;
		this.block = null;
		this.notify();
		void this.pump();
	}

	/** Removes a settled row, and resumes the queue if it was the last halt. */
	dismiss(id: string): void {
		const item = this.items.find((candidate) => candidate.id === id);
		if (!item || item.status === 'pending' || item.status === 'uploading')
			return;

		this.items = this.items.filter((candidate) => candidate.id !== id);
		// An expired session stays halted until the owner/session changes.
		if (
			this.block !== 'unauthorized' &&
			!this.items.some(
				(candidate) =>
					candidate.status === 'error' || candidate.status === 'uncertain'
			)
		) {
			this.block = null;
		}
		this.notify();
		void this.pump();
	}

	/** Closing is allowed only after every queued file was confirmed (201). */
	canClose(): boolean {
		return this.items.every((item) => item.status === 'success');
	}

	dismissAll(): boolean {
		if (!this.canClose()) return false;
		this.items = [];
		this.block = null;
		this.duplicateCount = 0;
		this.notify();
		return true;
	}

	clearDuplicateNotice(): void {
		if (this.duplicateCount === 0) return;
		this.duplicateCount = 0;
		this.notify();
	}

	private createItem(file: File, key: string): UploadItem {
		this.sequence += 1;
		const error = uploadValidationError(file);
		return {
			id: `upload-${this.sequence}`,
			file,
			name: file.name,
			size: file.size,
			lastModified: file.lastModified,
			key,
			status: error ? 'error' : 'pending',
			error
		};
	}

	private notify(): void {
		this.options.onChange?.(this.snapshot());
	}

	/** Exactly one request is in flight; re-entrant calls share this loop. */
	private async pump(): Promise<void> {
		if (this.pumping) return;
		this.pumping = true;

		try {
			while (this.block === null) {
				const item = this.items.find(
					(candidate) => candidate.status === 'pending'
				);
				if (!item) break;

				const requestEpoch = this.epoch;
				item.status = 'uploading';
				item.error = null;
				this.notify();

				try {
					const asset = await this.options.upload(item.file);
					// The owner changed while this request was in flight. Never
					// publish its result into the new owner's queue or gallery.
					if (requestEpoch !== this.epoch) continue;
					item.status = 'success';
					this.notify();
					this.options.onSuccess?.(asset, { ...item });
				} catch (caught) {
					if (requestEpoch !== this.epoch) continue;
					const api = errorOf(caught);
					const block = blockFor(api);
					item.status = block === 'uncertain' ? 'uncertain' : 'error';
					item.error = api;
					this.block = block;
					this.notify();
					if (block === 'unauthorized') this.options.onUnauthorized?.();
					if (block !== null) break;
				}
			}
		} finally {
			this.pumping = false;
			this.notify();
		}
	}
}
