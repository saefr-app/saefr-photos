import { describe, expect, it } from 'vitest';

import {
	clampPanOffset,
	clampZoom,
	ZOOM_MAX,
	ZOOM_MIN,
	ZOOM_STEP,
	zoomIn,
	zoomOut
} from './zoom';

describe('zoom levels', () => {
	it('exposes the approved bounds and step', () => {
		expect(ZOOM_MIN).toBe(1);
		expect(ZOOM_MAX).toBe(4);
		expect(ZOOM_STEP).toBe(0.5);
	});

	it('clamps to the zoom range', () => {
		expect(clampZoom(0.5)).toBe(1);
		expect(clampZoom(1)).toBe(1);
		expect(clampZoom(2.5)).toBe(2.5);
		expect(clampZoom(4)).toBe(4);
		expect(clampZoom(8)).toBe(4);
		expect(clampZoom(Number.NaN)).toBe(1);
	});

	it('steps in and out without leaving the range', () => {
		expect(zoomIn(1)).toBe(1.5);
		expect(zoomIn(3.5)).toBe(4);
		expect(zoomIn(4)).toBe(4);
		expect(zoomOut(1.5)).toBe(1);
		expect(zoomOut(1)).toBe(1);
		expect(zoomOut(4)).toBe(3.5);
	});
});

describe('clampPanOffset', () => {
	it('pins the image at 1x', () => {
		expect(clampPanOffset(500, -500, 1000, 500, 1)).toEqual({
			x: 0,
			y: 0
		});
	});

	it('allows base * (zoom - 1) / 2 per axis', () => {
		expect(clampPanOffset(600, -400, 1000, 500, 2)).toEqual({
			x: 500,
			y: -250
		});
		expect(clampPanOffset(100, 100, 1000, 500, 2)).toEqual({
			x: 100,
			y: 100
		});
	});

	it('scales the limit with fractional zoom', () => {
		expect(clampPanOffset(-999, 999, 1000, 500, 1.5)).toEqual({
			x: -250,
			y: 125
		});
	});

	it('clamps zoom below the minimum to no pan', () => {
		expect(clampPanOffset(10, 10, 1000, 500, 0.5)).toEqual({
			x: 0,
			y: 0
		});
	});
});
