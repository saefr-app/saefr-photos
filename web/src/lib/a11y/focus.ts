const FOCUSABLE =
	'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Visible, enabled focus targets in document order. */
export function focusableWithin(container: HTMLElement | null): HTMLElement[] {
	if (!container) return [];
	return Array.from(
		container.querySelectorAll<HTMLElement>(FOCUSABLE)
	).filter(
		(element) =>
			!element.hasAttribute('disabled') &&
			element.getAttribute('aria-hidden') !== 'true'
	);
}

/**
 * Keeps Tab and Shift+Tab inside an open dialog. Call from the dialog's
 * keydown handler; the caller owns Escape and focus restoration.
 */
export function trapTab(
	event: KeyboardEvent,
	container: HTMLElement | null
): void {
	if (event.key !== 'Tab' || !container) return;
	const targets = focusableWithin(container);
	if (targets.length === 0) {
		event.preventDefault();
		return;
	}

	const first = targets[0];
	const last = targets[targets.length - 1];
	const active = document.activeElement;
	const outside = active === null || !container.contains(active);

	if (event.shiftKey) {
		if (active === first || outside) {
			event.preventDefault();
			last.focus();
		}
		return;
	}

	if (active === last || outside) {
		event.preventDefault();
		first.focus();
	}
}
