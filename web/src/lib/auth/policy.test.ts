import { describe, expect, it } from 'vitest';
import {
	DEFAULT_NEXT_PATH,
	PASSWORD_MAX_BYTES,
	passwordByteLength,
	safeNextPath,
	validateNewPassword
} from './policy';

describe('validateNewPassword', () => {
	it('rejects 14 characters', () => {
		expect(validateNewPassword('a'.repeat(14))).toBe('Use at least 15 characters.');
	});

	it('accepts exactly 15 characters', () => {
		expect(validateNewPassword('a'.repeat(15))).toBeNull();
	});

	it('accepts exactly 128 characters', () => {
		expect(validateNewPassword('a'.repeat(128))).toBeNull();
	});

	it('rejects 129 characters', () => {
		expect(validateNewPassword('a'.repeat(129))).toBe(
			'Use 128 characters or fewer.'
		);
	});

	it('rejects a multibyte value over the byte cap', () => {
		const value = '😀'.repeat(129);
		expect(Array.from(value)).toHaveLength(129);
		expect(passwordByteLength(value)).toBeGreaterThan(PASSWORD_MAX_BYTES);
		expect(validateNewPassword(value)).not.toBeNull();
	});

	it('accepts 128 four-byte code points at exactly the byte cap', () => {
		const value = '😀'.repeat(128);
		expect(passwordByteLength(value)).toBe(PASSWORD_MAX_BYTES);
		expect(validateNewPassword(value)).toBeNull();
	});

	it('counts Unicode code points, not UTF-16 units', () => {
		expect(validateNewPassword('😀'.repeat(15))).toBeNull();
		expect(validateNewPassword('😀'.repeat(14))).toBe(
			'Use at least 15 characters.'
		);
	});
});

describe('safeNextPath', () => {
	it('defaults when missing or empty', () => {
		expect(safeNextPath(null)).toBe(DEFAULT_NEXT_PATH);
		expect(safeNextPath(undefined)).toBe(DEFAULT_NEXT_PATH);
		expect(safeNextPath('')).toBe(DEFAULT_NEXT_PATH);
		expect(safeNextPath('   ')).toBe(DEFAULT_NEXT_PATH);
	});

	it('keeps same-site paths and their query strings', () => {
		expect(safeNextPath('/photos')).toBe('/photos');
		expect(safeNextPath('/photos?cursor=abc')).toBe('/photos?cursor=abc');
		expect(safeNextPath('/trash?page=2#top')).toBe('/trash?page=2#top');
	});

	it('rejects protocol-relative and scheme URLs', () => {
		expect(safeNextPath('//evil.example')).toBe(DEFAULT_NEXT_PATH);
		expect(safeNextPath('https://evil.example')).toBe(DEFAULT_NEXT_PATH);
		expect(safeNextPath('javascript:alert(1)')).toBe(DEFAULT_NEXT_PATH);
		expect(safeNextPath('photos')).toBe(DEFAULT_NEXT_PATH);
	});

	it('rejects backslash and control-character tricks', () => {
		expect(safeNextPath('/\\evil.example')).toBe(DEFAULT_NEXT_PATH);
		expect(safeNextPath('/photos\r\nSet-Cookie: x')).toBe(DEFAULT_NEXT_PATH);
		expect(safeNextPath('/photos\u0000')).toBe(DEFAULT_NEXT_PATH);
	});

	it('rejects the login route to avoid a loop', () => {
		expect(safeNextPath('/login')).toBe(DEFAULT_NEXT_PATH);
		expect(safeNextPath('/login?next=/photos')).toBe(DEFAULT_NEXT_PATH);
	});
});
