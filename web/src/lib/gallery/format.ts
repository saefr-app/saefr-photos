const KB = 1024;
const MB = KB * 1024;

/** One decimal place, without a redundant `.0`. */
function trimFixed(value: number): string {
	const fixed = value.toFixed(1);
	return fixed.endsWith('.0') ? fixed.slice(0, -2) : fixed;
}

export function formatFileSize(bytes: number): string {
	if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
	if (bytes < KB) return `${Math.round(bytes)} B`;
	if (bytes < MB) return `${trimFixed(bytes / KB)} KB`;
	return `${trimFixed(bytes / MB)} MB`;
}

const MIME_LABELS: Readonly<Record<string, string>> = {
	'image/jpeg': 'JPEG',
	'image/png': 'PNG',
	'image/webp': 'WebP'
};

/** Formats known photo types; unknown values fall back to the raw MIME. */
export function formatMimeType(mime: string): string {
	return MIME_LABELS[mime.toLowerCase()] ?? mime;
}

/** `created_at` is date added, not capture date. Invalid values stay honest. */
export function formatDateAdded(iso: string): string {
	const date = new Date(iso);
	if (Number.isNaN(date.getTime())) return 'Not reported';
	return date.toLocaleString(undefined, {
		dateStyle: 'long',
		timeStyle: 'short'
	});
}

export function formatMonthLabel(iso: string): string {
	const date = new Date(iso);
	if (Number.isNaN(date.getTime())) return 'Date added · Unknown';
	const monthYear = date.toLocaleString(undefined, {
		month: 'long',
		year: 'numeric'
	});
	return `Date added · ${monthYear}`;
}
