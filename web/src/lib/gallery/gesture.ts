import { clampZoom, ZOOM_MIN } from './zoom';

export interface GesturePoint {
	x: number;
	y: number;
}

/** Pixels a horizontal swipe must travel before it navigates. */
export const SWIPE_MIN_DISTANCE = 56;

/** Level a double tap/double click toggles to from 1x. */
export const DOUBLE_TAP_ZOOM = 2;

export type SwipeDirection = 'previous' | 'next';

/** Straight-line distance between two active touch pointers. */
export function touchDistance(a: GesturePoint, b: GesturePoint): number {
	return Math.hypot(b.x - a.x, b.y - a.y);
}

/** Midpoint between two active touch pointers, in client coordinates. */
export function touchMidpoint(a: GesturePoint, b: GesturePoint): GesturePoint {
	return {
		x: (a.x + b.x) / 2,
		y: (a.y + b.y) / 2
	};
}

/**
 * Scales the zoom that was active when a pinch began by how far apart the
 * pointers are now. Invalid or zero start distances keep the starting zoom.
 */
export function pinchZoom(
	startZoom: number,
	startDistance: number,
	currentDistance: number
): number {
	if (
		!Number.isFinite(startDistance) ||
		startDistance <= 0 ||
		!Number.isFinite(currentDistance) ||
		currentDistance < 0
	)
		return clampZoom(startZoom);
	return clampZoom(startZoom * (currentDistance / startDistance));
}

/**
 * Direction of a completed swipe, or `null` when the gesture is too short or
 * mostly vertical. A leftward swipe (negative x) advances to the next photo.
 */
export function swipeNavigation(
	deltaX: number,
	deltaY: number,
	threshold = SWIPE_MIN_DISTANCE
): SwipeDirection | null {
	if (!Number.isFinite(deltaX) || !Number.isFinite(deltaY)) return null;
	const horizontal = Math.abs(deltaX);
	if (horizontal < threshold || horizontal <= Math.abs(deltaY)) return null;
	return deltaX < 0 ? 'next' : 'previous';
}

/** Double tap/double click returns to 1x when zoomed, otherwise zooms to 2x. */
export function doubleTapZoom(currentZoom: number): number {
	return currentZoom > ZOOM_MIN ? ZOOM_MIN : DOUBLE_TAP_ZOOM;
}
