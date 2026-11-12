export interface ToastInput {
	title: string;
	description?: string;
	actionLabel?: string;
	onAction?: () => void | Promise<void>;
	duration?: number;
}

export interface ToastMessage extends ToastInput {
	id: number;
}

// One quiet, app-wide toast at a time. The host lives in the root layout so a
// viewer can hand off an actionable Undo after it navigates back to /photos.
let current = $state<ToastMessage | null>(null);
let nextId = 0;

function show(input: ToastInput): number {
	const id = ++nextId;
	current = { ...input, id };
	return id;
}

/** Clears only the identified toast so a late close cannot dismiss a newer one. */
function dismiss(id?: number): void {
	if (id === undefined || current?.id === id) current = null;
}

export const toast = {
	get current(): ToastMessage | null {
		return current;
	},
	show,
	dismiss
};
