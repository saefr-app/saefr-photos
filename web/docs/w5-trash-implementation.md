# W5 — Trash, deletion receipts and recovery

**Status:** implemented on `web/w5-trash` from `83aa53f`
**Sources of truth:** `sahil-handoff.md` Phase W5, `web-ui-spec.md` §4.3 and §4.5,
`api-integration.md` §4 and §6, merged backend controllers at the branch base.

This record covers the web-only W5 boundary. No backend, migration, Compose,
storage or root file changed. No live provider call, real media or real
destructive operation was executed.

## 1. Typed lifecycle API boundary

`web/src/lib/api/assets.ts` is the only lifecycle URL/validator builder.
`web/src/lib/api/transport.ts` gained `requestDetailed`, which follows exactly
the same rules as `request` (same-origin credentials, `cache: 'no-store'`, no
retries, no Cookie header, CSRF for unsafe methods) but also preserves the
response status, strong `ETag` and `Location`. `request` now delegates to it.

| Function | Request |
|---|---|
| `listTrash({limit,cursor})` | `GET /api/v1/assets/trash?limit=50&cursor=…` |
| `assetTrashThumbnailPath(id)` | `GET /api/v1/assets/trash/:id/thumbnail` (never original) |
| `trashAsset(id, ifMatch)` | `POST /api/v1/assets/:id/trash`, empty body, strong `If-Match`, CSRF |
| `restoreAsset(id, ifMatch)` | `POST /api/v1/assets/:id/restore`, same preconditions |
| `permanentlyDeleteAsset(id, ifMatch)` | `DELETE /api/v1/assets/:id`, empty body, strong `If-Match` |
| `listDeletions({limit,cursor})` | `GET /api/v1/assets/deletions?limit=50&cursor=…` |
| `getDeletion(id)` | `GET /api/v1/assets/deletions/:id` |
| `retryDeletion(id)` | `POST /api/v1/assets/deletions/:id/retry`, empty body, no `If-Match` |

`lifecycleEtag(id, version)` returns the exact strong validator including its
double quotes:

```
"asset-lifecycle:<asset UUID>:<decimal lifecycle_version>"
```

There is no `W/` path. `parseLifecycleEtag` accepts only the strong form and
returns `null` for weak, quoted-list or malformed values. A mutation with a
missing/weak validator fails locally with `428` semantics before `fetch`, so the
client never issues a precondition-less lifecycle request.

Lifecycle mutations have no JSON body and no `Content-Type`. They do carry the
session CSRF token and Origin behavior through the shared transport. No wrapper
retries.

## 2. ETag availability on `GET /api/v1/assets/:id`

Verified by reading the merged backend (read-only):

- `AssetsController.findById` calls `findByIdWithVersion` and sets
  `reply.header('ETag', lifecycleEtag(assetId, version))`. The response
  **does** expose the current strong lifecycle ETag.
- The JSON body (`AssetResponseDto`) intentionally contains no
  `lifecycle_version`; the header is the authoritative source for a direct link.
- Active-page items expose `lifecycle_version` in the body.
- Trash-page items expose both `lifecycle_version` and `trashed_at`.

Accordingly, the viewer uses `getAssetWithEtag` and parses the response ETag for
a direct-link photo. When opened from the gallery, the cached
`lifecycle_version` is available immediately and the fresh ETag replaces it.
If neither exists, the viewer refuses to invent a version and explains that the
photo must be refreshed. The ETag returned by Trash/Restore supplies the new
version used by Undo.

## 3. UI states

### `/trash`

- Same square grid/chrome as Photos: 5/4/3/2 columns, 4px gaps, `Trash` title.
- Owner-only Trash thumbnail route; there is no original or lightbox route.
- Cursor pagination plus Load more, initial skeleton, empty, first-load error
  with Retry, and pagination error with Retry.
- Per-item Restore and Permanently delete with busy and inline failure states.
- Restore uses the listed fresh ETag. A confirmed `200` removes the row and
  shows a quiet toast. `412` refreshes Trash and requires the owner to act
  again; `404` removes the stale row; `401` expires the local session;
  `503`/network failures stay visible and never claim success.
- Permanent delete is offered only inside Trash. The accessible dark
  `alertdialog` traps focus, focuses Cancel, closes on Escape/backdrop, returns
  focus to the trigger on cancel, and moves focus to a stable announced heading
  when the row disappears. Copy and the muted-red action match §4.5.
- `200` shows completed; `202` removes the row but says the deletion is
  **accepted and pending**, surfaces a persistent notice, and never claims
  automatic completion or retry. `409` refreshes Trash. A network failure says
  the outcome is unconfirmed and directs the owner to Pending deletions.

### Viewer `/photos/[id]`

- A menu now exposes `Move to Trash` (and no permanent delete). The menu has a
  labelled trigger, roving focus, Escape close with focus return, and
  outside-click close.
- Trash uses the current ETag from the cached item or the metadata response.
- On confirmed `200`: remove from the gallery cache, navigate to `/photos`, and
  show an actionable `Undo` toast. Undo restores with the version returned by
  the Trash transition. If the restore is stale, uncertain or unavailable, the
  UI says so and does not force the action.
- `412` refreshes metadata and asks for renewed confirmation; `428` is reported
  as a client/precondition defect; `409`, `401`, `503` and network uncertainty
  use safe, status-specific copy. No path silently retries.

### `/trash/pending` and `/trash/pending/[id]`

- Real owner-scoped receipt list and individual receipt lookup with requested
  time, completed time, status, safe reason category, and encoded navigation.
- Retry is explicit, empty-body, and sends no `If-Match`. `200`/completed
  removes the pending row and states completion; `202` keeps it visible as
  pending; `503`/network leaves the status unchanged with an inline error.
- Completed receipts show no Retry control (a completed retry is a UI no-op).
- No countdown, scheduler, bulk action or automatic retry is implied.

## 4. Tests

New/extended Vitest coverage (mocked `fetch` only, no live calls):

| File | Coverage |
|---|---|
| `src/lib/api/lifecycle.test.ts` | exact quoted ETag, int8 versions, weak/malformed rejection, empty-body/no-content-type, CSRF/If-Match, Trash/Restore/Delete 200/202/409/412/428/503/network, receipt list/lookup/retry, no retry |
| `src/lib/deletions/format.test.ts` | safe reason mapping, unknown codes never echoed, completed predicate |
| `src/lib/deletions/store-helpers.test.ts` | receipt page dedupe, 200 removal, 202 replacement, input immutability |
| `src/lib/trash/trash-merge.test.ts` | Trash pagination dedupe/order/`trashed_at`, cursor stop |
| existing suites | unchanged transport, CSRF, asset URL, gallery helpers |

## 5. Shared change

`src/routes/+layout.svelte` mounts one minimal `ToastHost` so the viewer can
hand an actionable Undo toast to `/photos` after it navigates away. The host
dismisses only its own toast id, so a late close cannot clear a newer message.

## 6. Explicit limitation

Real lifecycle acceptance — a real Trash, Restore, permanent deletion,
`200`/`202` receipt transition or Retry against storage — was **not** executed.
The backend's exact-removal capability requires the Linux storage-backed
environment tracked by issue #16; the local Windows environment cannot provide
it. This branch is verified offline with mocked transport and must be accepted
in that Linux environment before W5 is called end-to-end complete.
