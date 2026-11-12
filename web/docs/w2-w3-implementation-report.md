# Web W2–W3 implementation report

**Status:** implemented, verified, ready for review  
**Branch:** `ui-integration` (based on the merged backend baseline, not `main`)  
**Code verified at:** `a014ad8`  
**Documentation commit:** `1ad4f6e` plus this report  
**Sources of truth:** `sahil-handoff.md` §Phase W2–W3, `web-ui-spec.md` §4.2–4.3,
§5–6, `api-integration.md` §3 and §6, `AGENTS.md`, and the merged backend
controllers at the branch baseline.

This report covers both web phases that are present on the branch and not yet on
`origin/ui-integration`: the W2 session/auth integration and the W3 live gallery
and viewer. It records what is rendered, which API contract each screen uses,
which states were verified, and what is deliberately not implemented.

## 1. Scope and non-negotiable boundaries

- No backend, auth, storage, migration, Compose, development-database or
  `storage/` change was made. The web app consumes the existing owner-scoped API.
- No bearer token, `localStorage`/`sessionStorage` credential, cookie read in
  JavaScript, public media URL, CORS shortcut, SSR cache of private data or
  invented API field was added.
- The branch merges `origin/integration` (`82b8ef6`) to stay current. The
  `integration` and `main` branches are not modified or pushed by this work.
- W4 upload, W5 Trash/lifecycle, W6 admin CRUD and W7 cross-flow polish remain
  out of scope. The gallery's Upload button remains the existing W4 placeholder;
  it does not pretend to upload.

## 2. W2 — session, auth and protected navigation

### Architecture

| Concern | Implementation |
|---|---|
| Transport | `web/src/lib/api/transport.ts`: same-origin `fetch`, `credentials: 'same-origin'`, no retries, fixed status mapping, explicit empty-body path |
| Auth calls | `web/src/lib/api/auth.ts`: `/me`, login, logout, logout-all, change password, sessions, revoke |
| CSRF | `web/src/lib/api/csrf.ts`: module memory only, reacquired from `/me`; never persisted |
| Errors | `web/src/lib/api/errors.ts`: safe copy for `400/401/403/404/409/412/413/415/428/429/503` and network (`0`) |
| Session state | `web/src/lib/session/session.svelte.ts`: `loading → anonymous | authenticated | unavailable` |
| Guard | `web/src/lib/components/SessionGate.svelte`: the single redirect authority |
| Return paths | `web/src/lib/auth/policy.ts`: preserves only same-site absolute paths |
| Private rendering | `web/src/routes/+layout.ts`: client-only (`ssr = false`) |
| Dev topology | Vite `/api` proxy to `127.0.0.1:3100` with `changeOrigin: false`, preserving exact `Origin` |

### Behavior

- Login preflights `/me`; an existing valid session is adopted without sending a
  second credential. A stale cookie is cleared through the logout route before
  login. Login sends `X-Saefr-Login: 1`, exact JSON credentials and no CSRF
  header.
- `passwordChangeRequired` routes to `/change-password`; a successful change
  clears the local session and goes to `/login?changed=1`.
- `SessionGate` redirects anonymous users to `/login?next=…` with a validated
  same-site return path. A protected request returning `401` calls
  `session.expire()`, clears the local session and lets the guard redirect.
- Account, security, sessions, sidebar and mobile navigation are wired to the
  real session identity and actions. Sign-out and sign-out-all use empty
  requests; a current-session revoke clears local state.
- `assetsAvailable` is capability state, not proof that physical storage is
  ready. Asset screens still handle a real `503` honestly.

### W2 file inventory

`web/src/lib/api/{auth,csrf,errors,transport,types,index}.ts`,
`web/src/lib/session/{session.svelte.ts,index.ts}`,
`web/src/lib/auth/policy.ts`,
`web/src/lib/components/{SessionGate.svelte,GalleryShell.svelte,MobileNav.svelte}`,
`web/src/routes/+layout.{svelte,ts}`,
`web/src/routes/(auth)/{login,change-password}/+page.svelte`,
`web/src/routes/(app)/settings/{+layout.svelte,account,security,sessions}/+page.svelte`,
plus `web/vite.config.ts`, `web/vitest.config.ts`, `web/tsconfig.json`,
`web/package.json` and `web/docs/adr-0001-frontend-foundation.md`.

## 3. W3 — live gallery and immersive viewer

### 3.1 API boundary

`web/src/lib/api/assets.ts` is the only asset URL builder:

| Function | Request | Use |
|---|---|---|
| `listAssets({limit, cursor})` | `GET /api/v1/assets?limit=50&cursor=…` | owner-scoped active page |
| `getAsset(id)` | `GET /api/v1/assets/:id` | direct link and freshness metadata |
| `assetThumbnailPath(id)` | `GET /api/v1/assets/:id/thumbnail` | grid thumbnail |
| `assetOriginalPath(id)` | `GET /api/v1/assets/:id/original` | viewer image and download |
| `fetchAssetOriginal(id)` | same original through `requestBlob` | explicit blob download |

`requestBlob` reuses the transport rules: GET, same-origin credentials, no
browser cache, no CSRF, no retries, no JSON parsing, and the same
`ApiRequestError` mapping. A failed fetch/body read becomes a network error with
status `0`.

Types in `web/src/lib/api/types.ts`:

```ts
type AssetMimeType = 'image/jpeg' | 'image/png' | 'image/webp';
interface Asset { id; filename; mime_type; size; created_at }
interface AssetPageItem extends Asset { lifecycle_version }
interface AssetPage { items: AssetPageItem[]; next_cursor: string | null }
```

`lifecycle_version` is carried for W5 and is unused in W3. `created_at` is date
added; it is never labeled as capture time.

### 3.2 Gallery cache and state

`web/src/lib/gallery/gallery.svelte.ts` is a module-level, owner-scoped store:

- state: `ownerId`, `items`, `nextCursor`, `status`
  (`idle/loading/ready/error`), `error`, `loadingMore`, `loadMoreError`,
  `hasLoadedPages`, `scrollY`, `returningFromGallery`, and an internal epoch;
- changing signed-in owner clears the cache; a `401` clears it and calls
  `session.expire()`;
- `loadFirstPage()` requests `limit=50`; `loadMore()` forwards the opaque cursor
  unchanged, dedupes by id, preserves server order and keeps existing items if a
  later page fails;
- `nextCursorAfterPage()` stops if the server echoes the same cursor, preventing
  a loop;
- `markOpenedFromGallery()` snapshots `scrollY`; `consumeReturnedFromGallery()`
  is one-shot; `recordScroll()` is suppressed during the return navigation so
  SvelteKit's outgoing scroll-to-top cannot overwrite the saved position;
- all getters are owner-scoped, including `fromGallery`, so another account and
  a cold direct link never inherit the previous user's context.

### 3.3 `/photos`

`web/src/routes/(app)/photos/+page.svelte` plus
`web/src/lib/components/gallery/PhotoTile.svelte`:

- uniform square grid, 5 columns at ≥900px, 4 at 600–899px, 3 at 361–599px and
  2 at ≤360px; 4px gaps and a 3px tile radius;
- lazy-loaded private thumbnails (`loading="lazy"`, `decoding="async"`); an
  unavailable thumbnail becomes a neutral placeholder, never a real image URL
  from a CDN;
- each tile is an anchor to `/photos/:id` with `aria-label="Open <filename>"`;
  modifier/alternate-button activation does not create a false return marker;
- month groups use the literal `Date added · <month year>`; grouping preserves
  first-seen month order and merges non-contiguous same-month items, including
  across page boundaries;
- no client sort, count, selection, checkbox or bulk toolbar;
- states: initial skeleton, empty library, first-load error with Retry, loading
  more, pagination error with Retry, and `assetsAvailable === false`;
- pagination: an `IntersectionObserver` with `900px` root margin plus an
  accessible “Load more” button. The observer is re-armed after each appended
  page so a sentinel inside the margin still advances;
- returning from the viewer restores the exact saved scroll offset after
  `tick()` and two animation frames, suppressing that frame's scroll event.

### 3.4 `/photos/[id]`

`web/src/routes/(app)/photos/[id]/+page.svelte` remounts
`web/src/lib/components/viewer/PhotoViewer.svelte` per id.

Viewer behavior:

- always-dark `#0D0F12`; body scroll locked; close button focused on entry;
- metadata is fetched fresh; a cached gallery copy renders immediately while the
  freshness request runs;
- `400`/`404` removes the item from the gallery cache and shows “Photo
  unavailable” — no fixture fallback;
- `401` expires the local session; other failure keeps a cached item visible or
  shows a retryable error when there is no cache;
- original is centered and contained uncropped over the square thumbnail
  placeholder; `ZoomableImage.svelte` measures the stage with `ResizeObserver`
  and does not upscale beyond the available box at 1x;
- toolbar: close, truncating filename, information, download. There is no menu
  and no `Move to Trash` before W5, so no dead action is shown;
- previous/next exist only for neighbours loaded in the gallery cache. A direct
  link shows just that photo, without invented neighbours or counts;
- arrow navigation replaces the viewer history entry
  (`goto(url, { replace: true, reset: false })`), so Back/close returns to the
  gallery rather than stacking photos;
- `Escape` closes information first, then the viewer; arrow keys are ignored
  while information is open, a modifier is held, or a typing target is focused;
  `+`/`-` zoom; touch swipe navigates only at 1x; pinch/double-tap zooms with
  clamped pan;
- information shows only Filename, Format (`JPEG (image/jpeg)` style), File size
  and Date added. No dimensions, camera, GPS or capture date are fabricated;
- desktop information is a 300px floating panel at `top: 84`, `right: 24`;
  below 600px it is a full-width bottom sheet with a 520px cap and safe-area
  padding;
- download fetches the original as a blob, creates an object URL, sets
  `download=<filename>`, clicks one anchor, and revokes on a 1.5s timer and on
  unmount; failure is shown with an explicit Retry, never an automatic retry;
- original image failure keeps the thumbnail and offers a user-initiated Retry
  with a cache-busting `?retry=N` nonce.

### 3.5 Pure helpers and tests

| Module | Behavior |
|---|---|
| `gallery/format.ts` | B/KB/MB with one decimal and no redundant `.0`; JPEG/PNG/WebP labels; locale long date added; literal month label |
| `gallery/groups.ts` | first-seen month grouping; append + id dedupe preserving server order |
| `gallery/navigation.ts` | neighbour lookup from loaded items only |
| `gallery/cursor.ts` | stop when the next cursor equals the request cursor |
| `gallery/zoom.ts` | 1–4× (0.5 steps), clamped pan based on contained base size, zero pan at 1×, avoids `-0` |
| `gallery/gesture.ts` | 56px swipe threshold with horizontal dominance; pinch zoom clamped to 1–4×; double-tap to 2× |

Ten Vitest files cover the API boundary, CSRF, transport/status mapping, return
path policy, asset URLs and blob errors, grouping/merge, formatting, neighbours,
cursor stop, zoom and gesture math.

## 4. Contract compliance

| Contract | Implementation |
|---|---|
| `{items, next_cursor}`, server ordering | consumed as returned; cursor forwarded unchanged; no local sorting |
| No total count | no count rendered anywhere |
| `created_at` = date added | only labeled “Date added”; month key uses local date |
| Private thumbnail/original | same-origin endpoints only; no public asset copy |
| Metadata fields | only the five `AssetResponse` fields are rendered |
| 404 = foreign/missing/trashed | “Photo unavailable”; cached tile removed |
| 401 = expired session | local expiry + SessionGate redirect with safe next path |
| 503 = DB/storage/capability unavailable | explicit retryable UI; never success copy |
| No automatic retries | all retries are user-initiated; original retry uses a nonce |
| No fake totals/timeline/multi-select | not rendered |
| No unsupported viewer actions | no Move to Trash before W5 |

## 5. Verification

Code gates ran from `web/` at `a014ad8`:

- `npm run check` — 4570 files, 0 errors, 0 warnings.
- `npm run test` — 10 files, 74 tests passed; run twice.
- `npm run build` — succeeded. `adapter-auto` reports no production platform;
  deployment topology is not part of this work.

Live verification ran in Microsoft Edge through Browse against the isolated
backend. The full measured record is in
[`w3-gallery-plan.md`](./w3-gallery-plan.md#verification-record--2026-11-12).
Summary:

- real login/session/logout and the real empty library were exercised;
- 60 contract-shaped assets paginated as `limit=50` then
  `cursor=cursor-page-2`, rendering five groups and 60 tiles;
- responsive columns/tiles measured as 5/196px, 4/156px, 3/117px and 2/153px at
  1280/768/390/340, with 4px gaps and no horizontal overflow;
- scroll left at 1200 returned at 1200 with no list refetch;
- viewer containment, information fields, desktop panel, mobile sheet, keyboard
  navigation, direct links, 404, 503, pagination failure, gallery failure and
  `401 → /login?next=%2Fphotos` were checked;
- the isolated Windows backend has no storage binding, so real uploads return
  `503` and provisioning is Linux-only. Live media was therefore served through
  Playwright request fulfillment; real auth and session endpoints stayed live.
  No gate, database or `storage/` was bypassed;
- the relay has no accepted-download channel, so the authenticated `/original`
  request was verified but no saved-file outcome is claimed;
- the live test user was signed out and the Browse session deleted.

## 6. Known limitations and follow-ups

1. **Storage availability:** real media verification needs a Linux backend with
   a provisioned binding. The Windows isolated environment cannot provide one
   without prohibited provisioning/bypass. W4 upload acceptance is blocked on
   the same constraint.
2. **Download save path:** the blob → anchor path is implemented and the network
   fetch was verified; a real browser save was not observable in this automation
   relay. Recheck in a manual browser pass.
3. **Windowing:** no virtualization was added. The specification permits it if
   real-browser performance requires it; no measurement has justified it yet.
   Profile a genuinely large library before changing the DOM strategy.
4. **Browser E2E:** live checks were exploratory Browse sessions, not a committed
   Playwright suite. Unit tests are the reproducible gate today.
5. **Cross-tab disappearance:** a photo trashed in another tab is handled when
   the viewer receives `404`; there is no websocket or polling synchronizer in
   alpha.
6. **Deferred by phase:** upload (W4), Trash/restore/permanent delete and
   receipts (W5), admin CRUD (W6), mixed-account polish and cross-flow QA (W7).
   No UI for those is presented as working.

## 7. Files changed for W3

```text
web/docs/w3-gallery-plan.md
web/src/lib/api/{assets.ts,assets.test.ts,index.ts,transport.ts,types.ts}
web/src/lib/components/gallery/PhotoTile.svelte
web/src/lib/components/viewer/{PhotoViewer,ZoomableImage,ViewerInfo}.svelte
web/src/lib/gallery/{cursor,format,gesture,groups,navigation,zoom}.ts
web/src/lib/gallery/{cursor,format,gesture,groups,navigation,zoom}.test.ts
web/src/lib/gallery/gallery.svelte.ts
web/src/lib/session/session.svelte.ts   (adds local-only expire())
web/src/routes/(app)/photos/+page.svelte
web/src/routes/(app)/photos/[id]/+page.svelte
```

## 8. Review checklist

- [ ] No backend or real-data change in the pushed range.
- [ ] `/photos` shows only server-ordered, owner-scoped assets; no counts or
      selection controls.
- [ ] Month labels say “Date added”; no capture-date claim.
- [ ] Viewer shows only the five real metadata fields and no dead Trash action.
- [ ] 401/404/503 and pagination failures remain explicit and retryable.
- [ ] Return navigation preserves the gallery scroll and does not refetch.
- [ ] A direct link never invents neighbours.
- [ ] No credential, token, private media or `.env` content is committed.
