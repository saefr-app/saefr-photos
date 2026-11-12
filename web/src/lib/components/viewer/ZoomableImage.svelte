<script lang="ts">
	import { onMount } from 'svelte';
	import {
		doubleTapZoom,
		type GesturePoint,
		pinchZoom,
		swipeNavigation,
		touchDistance,
		touchMidpoint
	} from '#lib/gallery/gesture';
	import {
		clampPanOffset,
		ZOOM_MIN,
		type PanOffset
	} from '#lib/gallery/zoom';

	type Props = {
		src: string;
		thumbnailSrc: string;
		alt: string;
		zoom?: number;
		onprevious?: () => void;
		onnext?: () => void;
		onloaderror?: () => void;
	};

	let {
		src,
		thumbnailSrc,
		alt,
		zoom = $bindable(ZOOM_MIN),
		onprevious,
		onnext,
		onloaderror
	}: Props = $props();

	const TAP_SLOP = 10;
	const DOUBLE_TAP_SLOP = 30;
	const DOUBLE_TAP_WINDOW = 320;
	const TAP_MAX_DURATION = 500;

	let stage = $state<HTMLDivElement | null>(null);
	let natural = $state({ width: 0, height: 0 });
	let base = $state({ width: 0, height: 0 });
	let pan = $state<PanOffset>({ x: 0, y: 0 });
	let originalBroken = $state(false);
	let interacting = $state(false);

	// Pointer bookkeeping is intentionally non-reactive: it changes many times
	// per frame and only base/pan/zoom need to drive rendering.
	const pointers = new Map<number, GesturePoint>();
	let mode: 'idle' | 'drag' | 'pinch' = 'idle';
	let pinched = false;
	let pointerType = 'mouse';
	let startPoint: GesturePoint = { x: 0, y: 0 };
	let startPan: PanOffset = { x: 0, y: 0 };
	let startTime = 0;
	let startZoom = ZOOM_MIN;
	let pinchStartDistance = 0;
	let pinchStartMidpoint: GesturePoint = { x: 0, y: 0 };
	let pinchStartPan: PanOffset = { x: 0, y: 0 };
	let lastTapTime = 0;
	let lastTapPoint: GesturePoint = { x: 0, y: 0 };

	// A retry changes only the query nonce, so clear the broken-image marker.
	$effect(() => {
		void src;
		originalBroken = false;
	});

	// Pan is only meaningful while zoomed; reset it at 1x and keep every edge
	// inside the viewport whenever zoom or the contained base size changes.
	$effect(() => {
		const next =
			zoom <= ZOOM_MIN
				? { x: 0, y: 0 }
				: clampPanOffset(
						pan.x,
						pan.y,
						base.width,
						base.height,
						zoom
					);
		if (next.x !== pan.x || next.y !== pan.y) pan = next;
	});

	function measure() {
		if (!stage) return;
		const availableWidth = stage.clientWidth;
		const availableHeight = stage.clientHeight;
		if (
			natural.width <= 0 ||
			natural.height <= 0 ||
			availableWidth <= 0 ||
			availableHeight <= 0
		) {
			base = { width: 0, height: 0 };
			return;
		}
		const scale = Math.min(
			availableWidth / natural.width,
			availableHeight / natural.height
		);
		base = {
			width: natural.width * scale,
			height: natural.height * scale
		};
	}

	onMount(() => {
		const observer = new ResizeObserver(measure);
		if (stage) observer.observe(stage);
		measure();
		return () => observer.disconnect();
	});

	function handleThumbnailLoad(event: Event) {
		if (natural.width > 0 && natural.height > 0) return;
		const image = event.currentTarget as HTMLImageElement;
		if (image.naturalWidth <= 0 || image.naturalHeight <= 0) return;
		natural = { width: image.naturalWidth, height: image.naturalHeight };
		measure();
	}

	function handleOriginalLoad(event: Event) {
		const image = event.currentTarget as HTMLImageElement;
		originalBroken = false;
		if (image.naturalWidth <= 0 || image.naturalHeight <= 0) return;
		natural = { width: image.naturalWidth, height: image.naturalHeight };
		measure();
	}

	function handleOriginalError() {
		originalBroken = true;
		onloaderror?.();
	}

	function pointOf(event: PointerEvent): GesturePoint {
		return { x: event.clientX, y: event.clientY };
	}

	function handlePointerDown(event: PointerEvent) {
		if (event.pointerType === 'mouse' && event.button !== 0) return;
		if (pointers.size === 0) {
			interacting = true;
			pointerType = event.pointerType;
		}

		pointers.set(event.pointerId, pointOf(event));
		const target = event.currentTarget as HTMLElement;
		try {
			target.setPointerCapture(event.pointerId);
		} catch {
			// Pointer capture is an enhancement; gestures still work without it.
		}

		if (pointers.size === 1) {
			startPoint = pointOf(event);
			startPan = { ...pan };
			startTime = performance.now();
			mode = zoom > ZOOM_MIN ? 'drag' : 'idle';
		} else if (pointers.size === 2) {
			const [a, b] = [...pointers.values()];
			mode = 'pinch';
			pinched = true;
			startZoom = zoom;
			pinchStartDistance = touchDistance(a, b);
			pinchStartMidpoint = touchMidpoint(a, b);
			pinchStartPan = { ...pan };
		}

		event.preventDefault();
	}

	function handlePointerMove(event: PointerEvent) {
		if (!pointers.has(event.pointerId)) return;
		pointers.set(event.pointerId, pointOf(event));

		if (mode === 'pinch') {
			if (pointers.size < 2) return;
			const [a, b] = [...pointers.values()];
			const distance = touchDistance(a, b);
			if (distance > 0) {
				const midpoint = touchMidpoint(a, b);
				const nextZoom = pinchZoom(
					startZoom,
					pinchStartDistance,
					distance
				);
				zoom = nextZoom;
				pan = clampPanOffset(
					pinchStartPan.x + midpoint.x - pinchStartMidpoint.x,
					pinchStartPan.y + midpoint.y - pinchStartMidpoint.y,
					base.width,
					base.height,
					nextZoom
				);
			}
			event.preventDefault();
			return;
		}

		if (mode === 'drag' && pointers.size === 1 && zoom > ZOOM_MIN) {
			const point = pointOf(event);
			pan = clampPanOffset(
				startPan.x + point.x - startPoint.x,
				startPan.y + point.y - startPoint.y,
				base.width,
				base.height,
				zoom
			);
			event.preventDefault();
		}
	}

	function registerTap(point: GesturePoint) {
		const now = performance.now();
		const elapsed = now - lastTapTime;
		const moved = Math.hypot(
			point.x - lastTapPoint.x,
			point.y - lastTapPoint.y
		);

		if (elapsed <= DOUBLE_TAP_WINDOW && moved <= DOUBLE_TAP_SLOP) {
			lastTapTime = 0;
			zoom = doubleTapZoom(zoom);
			return;
		}

		lastTapTime = now;
		lastTapPoint = point;
	}

	function handlePointerUp(event: PointerEvent) {
		if (!pointers.has(event.pointerId)) return;
		const point = pointOf(event);
		pointers.delete(event.pointerId);

		if (pointers.size === 0) {
			const wasPinch = pinched;
			pinched = false;
			interacting = false;
			mode = 'idle';
			if (wasPinch) return;

			const deltaX = point.x - startPoint.x;
			const deltaY = point.y - startPoint.y;
			const duration = performance.now() - startTime;
			// Swipe navigation is a touch gesture and only applies unzoomed.
			const direction =
				pointerType !== 'mouse' && zoom <= ZOOM_MIN
					? swipeNavigation(deltaX, deltaY)
					: null;

			if (direction === 'next') {
				onnext?.();
				return;
			}
			if (direction === 'previous') {
				onprevious?.();
				return;
			}

			if (
				duration <= TAP_MAX_DURATION &&
				Math.abs(deltaX) <= TAP_SLOP &&
				Math.abs(deltaY) <= TAP_SLOP
			) {
				registerTap(point);
			}
			return;
		}

		if (mode === 'pinch') {
			// One finger remains after a pinch: continue as a pan without
			// allowing the gesture to turn into navigation.
			const [remaining] = [...pointers.values()];
			startPoint = { ...remaining };
			startPan = { ...pan };
			startTime = performance.now();
			mode = zoom > ZOOM_MIN ? 'drag' : 'idle';
		}
	}

	function handlePointerCancel(event: PointerEvent) {
		pointers.delete(event.pointerId);
		if (pointers.size === 0) {
			pinched = false;
			mode = 'idle';
			interacting = false;
		}
	}
</script>

<div
	class="stage"
	bind:this={stage}
	role="group"
	aria-label="Zoomable photo"
	onpointerdown={handlePointerDown}
	onpointermove={handlePointerMove}
	onpointerup={handlePointerUp}
	onpointercancel={handlePointerCancel}
>
	<div
		class="frame"
		class:interacting
		style={`width:${base.width}px;height:${base.height}px;transform:translate3d(${pan.x}px, ${pan.y}px, 0) scale(${zoom})`}
	>
		<img
			class="thumbnail"
			src={thumbnailSrc}
			alt=""
			aria-hidden="true"
			draggable="false"
			onload={handleThumbnailLoad}
		/>
		{#if !originalBroken}
			<img
				class="original"
				{src}
				{alt}
				draggable="false"
				decoding="async"
				onload={handleOriginalLoad}
				onerror={handleOriginalError}
			/>
		{/if}
	</div>
</div>

<style>
	.stage {
		position: absolute;
		inset: 0;
		display: flex;
		align-items: center;
		justify-content: center;
		overflow: hidden;
		touch-action: none;
		user-select: none;
		-webkit-user-select: none;
		-webkit-tap-highlight-color: transparent;
	}

	.frame {
		position: relative;
		flex: 0 0 auto;
		transform-origin: center;
		will-change: transform;
		transition: transform var(--duration-fast) var(--ease-out);
	}

	.frame.interacting {
		transition: none;
	}

	img {
		position: absolute;
		inset: 0;
		display: block;
		width: 100%;
		height: 100%;
		object-fit: contain;
		pointer-events: none;
	}

	.thumbnail {
		z-index: 0;
	}

	.original {
		z-index: 1;
	}

	@media (prefers-reduced-motion: reduce) {
		.frame {
			transition: none;
		}
	}
</style>
