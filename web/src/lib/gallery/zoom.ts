export const ZOOM_MIN = 1;
export const ZOOM_MAX = 4;
export const ZOOM_STEP = 0.5;

export interface PanOffset {
	x: number;
	y: number;
}

function clampAxis(value: number, max: number): number {
	const clamped = Math.min(max, Math.max(-max, value));
	// Avoid exposing -0 when clamping to a zero offset.
	return clamped === 0 ? 0 : clamped;
}

export function clampZoom(value: number): number {
	if (Number.isNaN(value)) return ZOOM_MIN;
	return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, value));
}

export function zoomIn(value: number): number {
	return clampZoom(value + ZOOM_STEP);
}

export function zoomOut(value: number): number {
	return clampZoom(value - ZOOM_STEP);
}

/**
 * Clamps panning so no edge of the scaled image can leave the viewport:
 * `base * (zoom - 1) / 2` per axis, which is zero at 1x.
 */
export function clampPanOffset(
	x: number,
	y: number,
	baseWidth: number,
	baseHeight: number,
	zoom: number
): PanOffset {
	const level = clampZoom(zoom);
	const maxX = (Math.max(0, baseWidth) * (level - 1)) / 2;
	const maxY = (Math.max(0, baseHeight) * (level - 1)) / 2;

	return {
		x: clampAxis(x, maxX),
		y: clampAxis(y, maxY)
	};
}
