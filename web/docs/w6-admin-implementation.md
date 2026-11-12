# W6 administrator user management — implementation record

**Status:** implemented, gates green, ready for review  
**Branch:** `web/w6-admin` (based on `83aa53f`)  
**Scope:** W6 administrator user list, add-user and disable-account flows only.  
**Sources of truth:** `sahil-handoff.md` Phase W6, `web-ui-spec.md` §4.6–4.7,
`api-integration.md` §5–6, and the merged backend controllers at the branch
baseline (`server/src/users/users.controller.ts`,
`server/src/users/users.service.ts`).

No `server/`, migration, root-file, environment, dependency or storage change
was made. No real account was created or disabled and no live admin request was
sent.

## 1. API boundary

`web/src/lib/api/users.ts` is the only administrator API module. All calls go
through the existing `request` transport, which keeps same-origin credentials,
`cache: 'no-store'`, the in-memory CSRF header on unsafe methods, no retries and
the safe `ApiRequestError` status mapping.

| Function | Request | Result |
|---|---|---|
| `listUsers({limit, offset})` | `GET /api/v1/users?limit=50&offset=0` | `AdminUser[]` in server order |
| `createUser(username, initialPassword, currentPassword)` | `POST /api/v1/users` with exact JSON `{username, initialPassword, currentPassword}` | created `AdminUser` |
| `disableUser(id, currentPassword)` | `POST /api/v1/users/:id/disable` with exact JSON `{currentPassword}` | `204` → `void` |

Types in `web/src/lib/api/types.ts`:

```ts
type UserStatus = 'active' | 'disabled';
interface AdminUser {
  id; username; role; status; passwordChangeRequired; createdAt; updatedAt;
}
```

The API guide describes the list response as an array. The merged backend
controller actually returns `{items, limit, offset}` with no total. The client
reads the backend envelope and also tolerates a bare array, so either shape is
safe; pagination never depends on a fabricated total. A malformed payload is an
error, not an empty list.

Only ordinary-user creation is exposed. The backend has no role edit, enable,
delete or invite route, so the UI has none.

## 2. `/settings/users`

`web/src/routes/(app)/settings/users/+page.svelte` replaces the placeholder.

- The page renders no admin data unless `session.isAdmin` is true. A non-admin
  direct navigation gets the restricted explanation and no request is sent.
- Backend `403` on any admin call also switches to the restricted state and
  clears the loaded list; backend authorization remains authoritative.
- A `401` on any admin call calls `session.expire()`; `SessionGate` owns the
  redirect to sign-in with the current path as `next`.
- List states: skeleton with an assistive status, empty message, retryable
  error, restricted, and ready.
- Rows are a borderless vertical list: understated user glyph, username,
  role/status metadata line, and an overflow menu on active accounts. Disabled
  accounts have no actions because enable is not supported.
- Pagination is cursorless (`limit=50`, offset advanced by the number of rows
  returned). "Load more" appears only after a full page; there is no count or
  total. Rows are deduplicated by `id` if pages overlap.
- Loading-more failures keep the loaded rows and offer an explicit Retry.

### Add user

The borderless icon+text `Add user` action opens a soft floating dialog with:

- username, validated against the backend's canonical username shape;
- initial password, validated with the shared client password policy;
- the administrator's current password.

The dialog traps Tab/Shift+Tab, focuses its first field, supports Escape,
Cancel and backdrop dismissal, and restores focus to `Add user`. Field errors
are announced through `aria-invalid`/`aria-describedby`; a `409` is attached to
the username field as "already in use". Other failures use operation-specific
safe copy for `400`, `403`, `429` and `503`. The initial and current password
values are cleared on success and on close; nothing is written to browser
storage.

### Disable account

The row overflow menu exposes only `Disable account`. It opens a confirmation
dialog that explains sign-in and session revocation, requires the
administrator's current password, and restores focus to the row's overflow
button on close. `409` explains that the last active administrator and protected
accounts cannot be disabled; `404` refreshes the list; `400`, `429` and `503`
have safe contextual copy. A successful `204` marks that row disabled locally;
the list is not refetched because the server confirmed the only changed field.

## 3. Accessibility and visual conventions

- Svelte 5 runes, `#lib` imports, scoped CSS and existing color tokens.
- No table, card, row border or section divider; whitespace separates rows.
- Every action is a semantic button or link with a 44px hit area and visible
  focus. The overflow menu supports Escape and arrow keys and returns focus.
- Dialogs use `role="dialog"`, `aria-modal`, labelled/described content and a
  Tab trap from `web/src/lib/a11y/focus.ts`.
- Loading pulses and spinners stop under `prefers-reduced-motion`.
- No appearance/theme control was added because no light theme exists.

## 4. Tests

`npm run test` covers mocked-fetch behavior only; there are no live calls.

| File | Coverage |
|---|---|
| `web/src/lib/api/users.test.ts` | list envelope/array shape, server order, `limit`/`offset`, malformed payload, exact create body, exact disable body and encoded id, `204`, `400/401/403/409/429/503`, Retry-After, one-fetch/no-retry, same-origin/no-store/no Cookie header, no browser-storage writes and no secrets in URLs |
| `web/src/lib/admin/users.test.ts` | username/password/current-password validation, aggregate add-form errors, operation-specific create/disable copy for `400/403/404/409/429/503` |

## 5. Gates

Run from `web/` (recorded in the branch report):

- `npm run check` — 4575 files, 0 errors, 0 warnings.
- `npm run test` — 12 files, 99 tests, twice.
- `npm run build` — succeeded.

## 6. Limitations and follow-ups

1. **No live verification.** Account creation, disabling, last-admin conflict
   behavior and backend authorization were not exercised against a running
   server. The contract was read from the merged controller/service.
2. **401 ambiguity.** The backend answers `401` both for an expired session and
   for a failed current-password reauthentication. Per the transport contract,
   the client treats `401` as session expiry, so a wrong confirmation password
   signs the administrator out. Distinguishing the two would need a backend
   status change, which is out of scope.
3. **Offset pagination.** Concurrent inserts/removals between page requests can
   shift offsets; rows are deduplicated by `id`, but a concurrent change may
   delay or repeat a boundary row. No total count exists to reconcile.
4. **No refetch after disable.** The server's `204` confirms the operation; the
   row status is updated locally. `updatedAt` remains the pre-disable value
   until the next reload, and no timestamp is rendered.
5. **Unsupported actions stay absent.** There is no delete, enable, invite or
   role-edit UI because the backend exposes none.
