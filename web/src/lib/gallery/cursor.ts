/**
 * Chooses the cursor for the next page. A server that echoes the opaque cursor
 * it was given cannot advance, so that page is treated as the end rather than
 * looping on the same cursor.
 */
export function nextCursorAfterPage(
	requestedCursor: string | null,
	nextCursor: string | null
): string | null {
	if (nextCursor === null) return null;
	if (requestedCursor !== null && nextCursor === requestedCursor) return null;
	return nextCursor;
}
