import { describe, expect, it } from 'vitest';

import {
	formatDateAdded,
	formatFileSize,
	formatMimeType,
	formatMonthLabel
} from './format';

function localIso(
	year: number,
	monthIndex: number,
	day: number,
	hour = 12,
	minute = 0
): string {
	return new Date(year, monthIndex, day, hour, minute).toISOString();
}

describe('formatFileSize', () => {
	it('uses bytes below 1 KiB', () => {
		expect(formatFileSize(0)).toBe('0 B');
		expect(formatFileSize(1)).toBe('1 B');
		expect(formatFileSize(1023)).toBe('1023 B');
	});

	it('uses KB with at most one decimal', () => {
		expect(formatFileSize(1024)).toBe('1 KB');
		expect(formatFileSize(1100)).toBe('1.1 KB');
		expect(formatFileSize(1536)).toBe('1.5 KB');
		expect(formatFileSize(93217)).toBe('91 KB');
	});

	it('uses MB with at most one decimal', () => {
		expect(formatFileSize(1024 * 1024)).toBe('1 MB');
		expect(formatFileSize(1024 * 1024 * 1.5)).toBe('1.5 MB');
		expect(formatFileSize(20 * 1024 * 1024)).toBe('20 MB');
	});

	it('does not invent a size for invalid input', () => {
		expect(formatFileSize(-1)).toBe('0 B');
		expect(formatFileSize(Number.NaN)).toBe('0 B');
	});
});

describe('formatMimeType', () => {
	it('labels the supported photo types', () => {
		expect(formatMimeType('image/jpeg')).toBe('JPEG');
		expect(formatMimeType('image/png')).toBe('PNG');
		expect(formatMimeType('image/webp')).toBe('WebP');
		expect(formatMimeType('IMAGE/JPEG')).toBe('JPEG');
	});

	it('falls back to the raw MIME value', () => {
		expect(formatMimeType('application/pdf')).toBe('application/pdf');
		expect(formatMimeType('')).toBe('');
	});
});

describe('formatDateAdded', () => {
	it('uses a long local date and time', () => {
		const iso = localIso(2026, 9, 15, 14, 30);
		const expected = new Date(iso).toLocaleString(undefined, {
			dateStyle: 'long',
			timeStyle: 'short'
		});

		expect(formatDateAdded(iso)).toBe(expected);
		expect(formatDateAdded(iso)).toContain('2026');
	});

	it('reports invalid dates honestly', () => {
		expect(formatDateAdded('not-a-date')).toBe('Not reported');
		expect(formatDateAdded('')).toBe('Not reported');
	});
});

describe('formatMonthLabel', () => {
	it('prefixes the month and year with Date added', () => {
		const iso = localIso(2026, 9, 15);
		const monthYear = new Date(iso).toLocaleString(undefined, {
			month: 'long',
			year: 'numeric'
		});

		expect(formatMonthLabel(iso)).toBe(`Date added · ${monthYear}`);
	});

	it('uses Unknown for an invalid date', () => {
		expect(formatMonthLabel('not-a-date')).toBe('Date added · Unknown');
		expect(formatMonthLabel('')).toBe('Date added · Unknown');
	});
});
