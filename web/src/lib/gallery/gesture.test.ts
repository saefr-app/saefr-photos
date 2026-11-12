import { describe, expect, it } from 'vitest';

import {
	DOUBLE_TAP_ZOOM,
	SWIPE_MIN_DISTANCE,
	doubleTapZoom,
	pinchZoom,
	swipeNavigation,
	touchDistance,
	touchMidpoint
} from './gesture';
import { ZOOM_MAX, ZOOM_MIN } from './zoom';

describe('touchDistance', () => {
	it('measures a 3-4-5 triangle', () => {
		expect(touchDistance({ x: 0, y: 0 }, { x: 3, y: 4 })).toBe(5);
	});

	it('is zero for coincident pointers', () => {
		expect(touchDistance({ x: 12, y: 8 }, { x: 12, y: 8 })).toBe(0);
	});
});

describe('touchMidpoint', () => {
	it('returns the center of both pointers', () => {
		expect(touchMidpoint({ x: -10, y: 4 }, { x: 30, y: -8 })).toEqual({
			x: 10,
			y: -2
		});
	});
});

describe('pinchZoom', () => {
	it('scales the starting zoom by the distance ratio', () => {
		expect(pinchZoom(1, 100, 200)).toBe(2);
		expect(pinchZoom(2, 100, 50)).toBe(1);
		expect(pinchZoom(3, 80, 120)).toBe(4);
	});

	it('clamps to the approved zoom range', () => {
		expect(pinchZoom(1, 100, 1000)).toBe(ZOOM_MAX);
		expect(pinchZoom(2, 100, 1)).toBe(ZOOM_MIN);
	});

	it('keeps the starting zoom for invalid distances', () => {
		expect(pinchZoom(2.5, 0, 200)).toBe(2.5);
		expect(pinchZoom(2.5, Number.NaN, 200)).toBe(2.5);
		expect(pinchZoom(2.5, 100, Number.NaN)).toBe(2.5);
		expect(pinchZoom(2.5, 100, -1)).toBe(2.5);
	});
});

describe('swipeNavigation', () => {
	it('advances on a leftward swipe and returns on a rightward swipe', () => {
		expect(swipeNavigation(-SWIPE_MIN_DISTANCE, 0)).toBe('next');
		expect(swipeNavigation(-200, 12)).toBe('next');
		expect(swipeNavigation(SWIPE_MIN_DISTANCE, 0)).toBe('previous');
	});

	it('ignores short or mostly vertical gestures', () => {
		expect(swipeNavigation(-(SWIPE_MIN_DISTANCE - 1), 0)).toBeNull();
		expect(swipeNavigation(-120, 140)).toBeNull();
		expect(swipeNavigation(0, 0)).toBeNull();
		expect(swipeNavigation(Number.NaN, 0)).toBeNull();
	});

	it('honors a custom threshold', () => {
		expect(swipeNavigation(-30, 0, 20)).toBe('next');
		expect(swipeNavigation(-30, 0, 40)).toBeNull();
	});
});

describe('doubleTapZoom', () => {
	it('toggles between 1x and 2x', () => {
		expect(DOUBLE_TAP_ZOOM).toBe(2);
		expect(doubleTapZoom(1)).toBe(2);
		expect(doubleTapZoom(1.5)).toBe(1);
		expect(doubleTapZoom(2)).toBe(1);
		expect(doubleTapZoom(4)).toBe(1);
	});
});
