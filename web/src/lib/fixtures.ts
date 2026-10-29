export type PhotoFixture = {
	id: string;
	filename: string;
	mime: string;
	size: string;
	added: string;
	color: string;
	trashed?: boolean;
};

const art = (background: string, foreground: string, accent: string) =>
	`data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 800 800'%3E%3Crect width='800' height='800' fill='${background}'/%3E%3Ccircle cx='570' cy='210' r='175' fill='${accent}' opacity='.75'/%3E%3Cpath d='M0 620 240 390 390 540 510 430 800 720V800H0Z' fill='${foreground}' opacity='.72'/%3E%3Cpath d='M0 690 170 540 280 630 420 500 800 760V800H0Z' fill='${accent}' opacity='.42'/%3E%3C/svg%3E`;

export const photos: PhotoFixture[] = [
	{ id: 'moss-light', filename: 'moss-light.jpg', mime: 'image/jpeg', size: '3.2 MB', added: 'October 24, 2026', color: art('%231b2b2a', '%23d3e2d5', '%235eead4') },
	{ id: 'quiet-coast', filename: 'quiet-coast.webp', mime: 'image/webp', size: '2.8 MB', added: 'October 24, 2026', color: art('%23252a3d', '%23e7d8bd', '%2390a9d8') },
	{ id: 'late-sun', filename: 'late-sun.png', mime: 'image/png', size: '4.1 MB', added: 'October 24, 2026', color: art('%233b2927', '%23f3c7a6', '%23f59e77') },
	{ id: 'field-notes', filename: 'field-notes.jpg', mime: 'image/jpeg', size: '1.9 MB', added: 'October 18, 2026', color: art('%23262b24', '%23bdcaa0', '%23d6a86a') },
	{ id: 'blue-hour', filename: 'blue-hour.jpg', mime: 'image/jpeg', size: '5.6 MB', added: 'October 18, 2026', color: art('%2317243a', '%23b6c8ed', '%235b8def') },
	{ id: 'window-seat', filename: 'window-seat.webp', mime: 'image/webp', size: '2.4 MB', added: 'October 18, 2026', color: art('%2333272d', '%23e5c4b8', '%23a78bfa') },
	{ id: 'rain-path', filename: 'rain-path.jpg', mime: 'image/jpeg', size: '3.7 MB', added: 'October 11, 2026', color: art('%23272d32', '%23c8d1d8', '%2367a7a4') },
	{ id: 'soft-horizon', filename: 'soft-horizon.jpg', mime: 'image/jpeg', size: '2.1 MB', added: 'October 11, 2026', color: art('%23352722', '%23f2d0ae', '%23e4a866') }
];

export const trashedPhotos: PhotoFixture[] = [
	{ ...photos[2], id: 'late-sun-trash', trashed: true },
	{ ...photos[5], id: 'window-seat-trash', trashed: true }
];

export const pendingDeletions = [
	{ id: 'receipt-204', filename: 'old-trip.png', requested: 'October 27, 2026 · 09:14', status: 'Retry available', reason: 'Storage temporarily unavailable' },
	{ id: 'receipt-198', filename: 'duplicate-export.jpg', requested: 'October 26, 2026 · 18:42', status: 'Waiting for storage', reason: 'Deletion is still being processed' }
];
