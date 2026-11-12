# W3 — Photos gallery and immersive viewer

**Goal:** replace the fixture-backed `/photos` and `/photos/[id]` screens with the
real owner-scoped asset API, preserving the approved visual system and every
honest loading, empty, error and unavailable state.

**Sources of truth:** `sahil-handoff.md` §Phase W3, `api-integration.md` §3,
`web-ui-spec.md` §4.2–4.3 and §6, plus the merged backend controllers at the
current `integration` commit. No new backend routes, fields or client-side
counts.

## Backend contract used

| Method | Route | Use |
|---|---|---|
| `GET` | `/api/v1/assets?limit=50&cursor=…` | owner active page `{items, next_cursor}` |
| `GET` | `/api/v1/assets/:id` | metadata for direct links and freshness |
| `GET` | `/api/v1/assets/:id/thumbnail` | private JPEG thumbnail in the grid |
| `GET` | `/api/v1/assets/:id/original` | viewer image and explicit download |

`AssetResponse`: `id, filename, mime_type, size, created_at`.
`AssetPageItem` adds `lifecycle_version` (kept for W5; unused in W3).
`created_at` is **date added**. Ordering and pagination come from the server
unchanged; `next_cursor` is opaque. No total count exists.

## Stage plan

### Stage 1 — typed asset boundary

- `web/src/lib/api/assets.ts`: `listAssets`, `getAsset`, thumbnail/original URL
  builders, and `fetchAssetOriginal` through the existing transport.
- Add `requestBlob` to `transport.ts` so binary downloads reuse the same
  same-origin/no-store/no-retry/error-mapping rules.
- Add the documented asset types to `api/types.ts` and exports.
- Add `session.expire()` so a `401` from gallery/viewer ends local session state
  and lets `SessionGate` perform the single redirect.
- Pure helpers under `web/src/lib/gallery/`: month grouping, file-size/MIME/date
  formatting, neighbour lookup, zoom/pan clamping.
- Unit tests for URL construction, blob errors, grouping, merge/dedupe,
  formatting, neighbours and zoom clamps.

### Stage 2 — gallery

- `web/src/lib/gallery/gallery.svelte.ts`: module-level cursor cache scoped to
  the signed-in user, first-load / loading-more / error state, dedupe, scroll
  memory, and the "returning from viewer" marker. Clear on `401`.
- `/photos`: skeleton, empty, first-load error with retry, paginating state,
  pagination error with retry, cursor sentinel plus an accessible Load more
  fallback.
- Square 5/4/3/2-column grid, 4px gaps, 2–4px radius, lazy thumbnails,
  hover brightness only, no selection or fake counts.
- Month groups use `Date added · <month year>`; group across page boundaries.
- Preserve page position when returning from the viewer.
- Remove the fixture error toggle and fake upload summary from this screen.

### Stage 3 — viewer

- `/photos/[id]`: near-black immersive page, metadata fetched privately,
  original contained uncropped over the thumbnail placeholder.
- Toolbar: close/back, truncating filename, information, download. No
  `Move to Trash` until W5 (no dead action).
- Info panel on desktop, bottom sheet below 600px; only filename, format/MIME,
  file size and date added.
- Previous/next from loaded gallery context only; a direct link with no context
  shows no invented neighbours or counts.
- Keyboard `Escape`, `ArrowLeft`, `ArrowRight`, `+`/`-`; swipe when unzoomed;
  double-tap/double-click and pinch zoom with pan when zoomed; reduced motion.
- Download original as a Blob URL with explicit progress/failure and cleanup.
- Honest states: metadata 404, privacy/session expiry, 503 media, original load
  failure with user-initiated retry.
- Direct-link validation: invalid UUID and unknown IDs show a safe not-found
  state, never a fixture fallback.

### Stage 4 — review and verification

- Independent review of the W3 diff for correctness, privacy, accessibility and
  fake state.
- Gates: `npm run check`, `npm run test` twice, `npm run build` from `web/`.
- Live verification in Microsoft Edge via Browse against the isolated API,
  using synthetic seeded images only. Check desktop, tablet and 390px mobile,
  cursor pagination, scroll restoration, keyboard navigation, download, and
  intercepted 404/503 states.
- Record actual measurements only. Do not claim throughput or virtualization
  results without a larger-library profile; windowing remains a follow-up if
  real-browser evidence requires it.

## Non-goals / deferred

- Upload UI and queue (W4). The existing placeholder is not extended.
- Trash, restore, permanent delete, receipts and Undo (W5).
- Admin user CRUD (W6).
- Capture date, dimensions, camera/lens/GPS, justified layout, multi-select,
  albums, search, sharing and videos. The backend does not expose them.
- No backend, auth, storage, migration or dev-database changes.

## Acceptance

- Only real API data is rendered; no fixture fallback on `/photos` or viewer.
- Every shown action works; errors are safe, specific and retryable where
  appropriate.
- Deep links stay private and owner-scoped.
- Scroll position survives viewer navigation.
- No private media in public assets, no credentials/tokens in storage, no
  automatic retries.
- Gates green twice and the live Edge checklist completed.
