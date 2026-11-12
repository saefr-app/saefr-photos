# Web W4 upload implementation

**Status:** implemented with mocked-`fetch` tests; live upload acceptance is blocked  
**Branch:** `web/w4-upload` (based on `83aa53f`)  
**Scope:** Phase W4 only. No Trash (W5), admin (W6), backend, migration, storage,
root file or dependency change was made.

## 1. Contract

`POST /api/v1/assets/upload` is the only upload endpoint.

- One `multipart/form-data` request per file, with exactly one part named
  `file`. The browser supplies the multipart boundary; the client never sets
  `Content-Type`.
- Accepted formats are JPEG (`image/jpeg`), PNG (`image/png`) and WebP
  (`image/webp`); videos and every other type are rejected client-side.
- Maximum size is 20 MiB (`20 * 1024 * 1024`) per file, checked client-side and
  still enforced by the backend.
- `201` plus an `AssetResponse` is the only confirmed success. The gallery
  reloads its owner-scoped first page; no local tile, count or progress is
  invented from bytes sent.
- The shared transport keeps `credentials: 'same-origin'`, `cache: 'no-store'`
  and the in-memory `X-CSRF-Token` on this unsafe method. It never adds a
  bearer token, a `Cookie` header, an Origin override or a retry.
- A five-minute abort and any disconnect/body-read failure become status `0`
  (`kind: 'network'`). Because the server may already have committed, the queue
  records an **uncertain** outcome and stops.

Relevant code:

- `web/src/lib/api/transport.ts` — `requestForm()` with no manual content type,
  CSRF, no retries and an abort signal.
- `web/src/lib/api/assets.ts` — `uploadAsset()` and the type/size constants.
- `web/src/lib/upload/queue.ts` — framework-free queue and validation.
- `web/src/lib/upload/upload.svelte.ts` — owner-scoped Svelte 5 runes wrapper.
- `web/src/lib/components/upload/UploadPanel.svelte` — floating summary panel.
- `web/src/lib/components/GalleryShell.svelte` — top `Upload` picker and panel.
- `web/src/routes/(app)/photos/+page.svelte` — drag/drop overlay.
- `web/src/lib/gallery/gallery.svelte.ts` — honest post-`201` reload.

## 2. Queue behavior

- Concurrency is **1**. A single pump loop takes the first `pending` row and
  awaits it before looking for the next.
- Duplicate selection is deduped by `name + size + lastModified` before enqueue,
  across statuses and across selections. The panel reports how many duplicates
  were skipped; selecting a file with a different `lastModified` is a new,
  explicit enqueue.
- Client validation runs before any request and again on an explicit retry, so
  a video or oversized file can never reach the network through the retry row.
- Statuses: `pending`, `uploading`, `success`, `error`, `uncertain`.
- `413`, `415`, `400` are per-file failures; the next pending file continues.
- `401` calls `session.expire()`, halts the queue and is not retryable locally.
- `403`, `429` and `503`/other 5xx halt the queue with fixed copy. Pending files
  stay pending until the user retries the failed row or dismisses it.
- Status `0`/timeout marks the file `uncertain`, shows the persistent exact
  copy **“Check gallery before retry.”** and sends nothing else automatically.
  Only an explicit user retry re-enqueues it.
- `close` is available only when every row is a confirmed `201` success; failed
  and uncertain rows must be retried or explicitly dismissed. Minimizing keeps
  a visible summary pill and never claims a server-side background queue. The
  expanded panel states that uploads continue only while the tab stays open.
- The queue is owner-scoped. A sign-out or account switch resets it, and an
  in-flight response from the previous owner is ignored.

## 3. UI states

| Surface | Behavior |
|---|---|
| Top `Upload` | Opens the OS picker (`image/jpeg,image/png,image/webp`, multiple). Disabled when `assetsAvailable` is false. |
| Drag/drop | Whole photos screen; quiet translucent `Drop photos to upload` overlay, no dashed border or drop-zone card. |
| Compact panel | Bottom-right, `Uploading · N of M completed` while active, neutral grey progress, white/grey only. |
| Expanded panel | Per-file name, status and error; Retry for error/uncertain; Dismiss for settled rows. |
| Minimized | Bottom-right summary pill with progress; click restores the panel. |
| Refresh | Each confirmed `201` reloads the gallery's first page; overlapping confirmations queue one more reload. |
| Errors | `400`, `401`, `403`, `413`, `415`, `429`, `503` and network use safe client-authored copy; raw backend text is never shown. |

## 4. Tests

`npm run test` (mocked global `fetch`; no live API call):

- `web/src/lib/api/upload.test.ts` (8 tests) — POST path/method/credentials/
  `no-store`, exactly one `file` part, filename/type/size, CSRF header, no manual
  content type, `201`, malformed `201`, `401`, `413`, `415`, `503`, disconnect,
  and one-call-only behavior.
- `web/src/lib/upload/queue.test.ts` (16 tests) — strict one-at-a-time ordering,
  `201` success, `400`/`413`/`415` continuation, `401` expiry callback, `403`
  and `429` halts, `503` halt and explicit resume, uncertain disconnect with no
  automatic retry, explicit retry, duplicate identity across selections,
  client-side video/oversize rejection (including retry), owner reset ignoring
  an in-flight result, and close restrictions.
- Existing transport, asset, CSRF, gallery and viewer tests continue to pass.

Measured gate results are recorded in section 6 below.

## 5. Live limitation

The isolated backend in this environment has **no storage binding**. Per the W3
report, Windows storage provisioning is not available and is Linux-only, so a
real `POST /api/v1/assets/upload` returns `503` even with a valid session. Live
upload acceptance is therefore blocked on **issue #16**.

No real upload was attempted, no storage check was weakened or bypassed, and no
saved-media outcome is claimed. The upload work is verified only against mocked
`fetch` responses plus the TypeScript/Svelte/build gates.

## 6. Verification

Run from `C:/Users/Sahil/Documents/saefr-photos-wt/w4/web`:

- `npm run check` — 4575 files, 0 errors, 0 warnings, 0 files with problems.
- `npm run test` — 12 files, 98 tests passed (run twice).
- `npm run build` — succeeded with `adapter-auto` (no production platform
  selected; deployment topology is out of scope).

## 7. Residual risks

1. A confirmed upload reloads the gallery's first page, which resets pagination
   and scroll position. This is honest but potentially disruptive in a large
   library; no local insertion or fake count is used instead.
2. The five-minute abort is a conservative client bound. A slow server commit
   after a disconnect remains `uncertain` until the user checks the gallery.
3. Uploads are not resumable or server-backgrounded. They continue only while
   the tab (and its JavaScript) stays alive; the UI says so.
4. Browser end-to-end upload behavior could not be exercised against storage in
   this environment. Re-run the acceptance checklist on a Linux storage binding
   once issue #16 is resolved.
