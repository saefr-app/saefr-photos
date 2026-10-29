# Saefr Photos Web Design System

**Status:** Approved foundation for frontend implementation  
**Scope:** `web/` SvelteKit application, alpha release  
**Design mode:** Operate for account/library tasks; Experience for the immersive viewer  
**Authority:** The approved visual direction in `web-ui-spec.md`, the API contracts in `api-integration.md`, and the product boundaries in `sahil-handoff.md`

## 1. Product and design intent

Saefr is a privacy-first, self-hosted photo library. The product succeeds when people can return to their photographs, understand where they are in the library, and complete private account and lifecycle actions without the interface competing with the photographs.

The interface is an original Saefr identity: quiet, dark, precise and content-first. It is not a reproduction of Immich or the supplied visual references. Reference images are mood and composition input only; the approved shell explicitly rejects their visible frame and divider lines.

### Non-negotiable principles

- Photographs are the primary content; chrome recedes.
- Dark-first only. Do not ship a non-functional light theme or appearance toggle.
- One continuous near-black canvas. No outer application frame, top rule, sidebar rule or dashboard-card shell.
- Actions are borderless icon, text or icon-plus-text controls. Hit areas remain at least 44px.
- Active navigation is soft white; inactive navigation is muted grey. No active pill, bar or teal navigation highlight.
- Harbor Teal is rare intentional emphasis, not the default color for navigation, success, toasts or upload progress.
- Never invent unsupported data or capabilities.
- Every loading, empty, error, disabled and uncertain state must be explicit and recoverable.

## 2. Visual language

### Color tokens

Use one CSS-variable token layer. Components and Tailwind utilities must consume these tokens rather than inventing local colors.

| Token | Value | Use |
|---|---|---|
| `--color-canvas` | `#090B0B` | Shared application canvas |
| `--color-viewer` | `#0D0F12` | Immersive viewer surface |
| `--color-text-primary` | `#F5F6F6` | Headings, active chrome, primary actions |
| `--color-text-secondary` | `#9BA4A1` | Supporting copy, inactive labels |
| `--color-text-disabled` | `#707A76` | Disabled and unavailable controls only |
| `--color-elevated` | `#1A1F1E` | Menus, dialogs, upload panel, toasts |
| `--color-input` | `#202524` | Borderless filled fields |
| `--color-brand` | `#0F766E` | Sparse intentional brand emphasis |
| `--color-brand-highlight` | `#5EEAD4` | Rare high-contrast accent |
| `--color-danger` | `#F18B88` | Destructive actions and warnings |
| `--color-focus` | `#F5F6F6` | Visible keyboard focus |

Validate actual contrast in a browser. Body text must reach 4.5:1, large text 3:1. If a token fails in context, tune the token rather than weakening the hierarchy.

### Typography

- Primary UI face: Inter, with a system sans fallback.
- Body: 14px / 400.
- Controls and navigation: 14px / 500.
- Section headings: 16–18px / 600.
- Page titles: 24px / 600.
- Supporting metadata: 12–13px / 400.
- Use restrained negative tracking only on headings, never below `-0.04em`.
- Do not use oversized marketing headings, decorative display faces or monospace as a visual costume.

### Geometry and spacing

- Base spacing unit: 4px.
- Desktop content padding: 24px.
- Mobile content padding: 8–12px.
- Expanded sidebar: approximately 200–224px.
- Collapsed rail: approximately 60–68px.
- Gallery gaps: exactly 4px.
- Gallery tile radius: 2–4px.
- Inputs: 8–10px radius, filled and borderless.
- Menus and upload panels: 12–16px radius.
- Dialogs: 16px radius.
- Elevation uses one soft offset shadow system; do not combine decorative borders with broad shadows.

### Icons and controls

- Use one consistent outline icon family at approximately 18–22px.
- Current implementation uses Lucide Svelte; animated icon treatments may be introduced only when they clarify state or affordance.
- Use semantic buttons and links, not clickable generic containers.
- Focus-visible rings remain visible even for borderless controls.
- Hover changes brightness or opacity; it does not add a rectangle or active background.

## 3. Application shell

### Desktop: 900px and above

- Header contains the Saefr wordmark at left and account/help access at right.
- Sidebar contains Photos, Trash and Settings.
- Sidebar can collapse into an icon rail.
- No separator rules or framed content area.
- Gallery content is edge-to-edge within the shared canvas.

### Tablet: 600–899px

- Prefer a compact icon rail only when 44px targets and the gallery remain usable.
- Otherwise use the mobile navigation pattern.
- Never force horizontal scrolling.

### Mobile: below 600px

- Compact header with page title, Upload where relevant, and account access.
- Fixed bottom navigation: Photos, Trash, Settings.
- Respect safe-area insets.
- Floating upload panel and toasts must sit above the bottom navigation.

### Global shell state rules

- Authentication state is never stored in localStorage or sessionStorage.
- Harmless UI preferences, such as sidebar collapse, may be persisted only if they do not contain authentication or private media data.
- Viewer mode replaces the shell with the always-dark viewer surface.

## 4. Page and route map

The frontend route map mirrors user tasks while the API client mirrors backend resources. Frontend routes must not invent backend endpoints.

### `/login`

**Backend:** `POST /api/v1/auth/login`

- Center a minimal form directly on the near-black canvas.
- Show a small Saefr wordmark, `Welcome back`, username, password with show/hide, and a borderless `Sign in` action.
- Do not show marketing imagery, a sign-up path, forgot-password link, OAuth or a form card.
- Handle idle, invalid fields, waiting, authentication failure, rate limiting, unavailable service and keyboard focus.
- Login sends exactly the required origin, `X-Saefr-Login: 1`, JSON content type and body fields. It must not attach an old cookie or Authorization header.

### `/change-password`

**Backend:** `POST /api/v1/auth/password`

- Use the same minimal visual language as login.
- Fields: current password, new password, confirmation.
- Explain that a successful change clears the session and requires sign-in again.
- When `/api/v1/me` returns `passwordChangeRequired`, route here instead of the gallery.

### `/photos`

**Backend:** `GET /api/v1/assets`, `POST /api/v1/assets/upload`

- Page title: `Photos`.
- Group by date added, not capture date. Use the API `created_at`; never label it as date taken.
- Use square thumbnails, 4px gaps, restrained tile radius and lazy loading.
- Do not show fabricated counts, timeline claims, search, albums, selection checkboxes or bulk actions.
- States: loading skeletons, empty library, pagination, network failure, expired session, media unavailable and an item disappearing from another tab.
- Preserve loaded page context and scroll position when entering and leaving the viewer.

### `/photos/[id]`

**Backend:** asset metadata, thumbnail and original routes.

- Use a full or near-full-screen `#0D0F12` viewer.
- Preserve original aspect ratio; never crop the original.
- Toolbar: close/back, safe filename, information, download original and overflow actions.
- Keyboard: Escape, left/right navigation and appropriate zoom controls.
- Information may show only filename, MIME/format, file size and date added.
- Never expose public media URLs. Use authenticated same-origin responses or carefully managed private Blob URLs and release them when no longer needed.

### Upload experience

**Backend:** one `POST /api/v1/assets/upload` request per file.

- Upload is a top text-plus-icon action and may accept drag/drop.
- Compact bottom-right desktop panel; bottom safe-area adaptation on mobile.
- Default concurrency is one.
- File types: JPEG, PNG and WebP; maximum 20 MiB per file.
- Distinguish confirmed success, confirmed failure and uncertain timeout/disconnect.
- Never automatically retry an uncertain upload. Persist the message `Check gallery before retry`.
- Client byte progress must not be presented as server processing completion.

### `/trash`

**Backend:** trash listing, Trash thumbnail, restore, permanent deletion.

- Reuse gallery geometry while making the `Trash` state unmistakable.
- Display Trash thumbnails only; there is no Trash original route.
- Single-photo actions: Restore and Permanently delete.
- Permanent deletion requires an accessible confirmation dialog and is available only for a trashed item.
- Restore and delete mutations send an empty body, exact Origin, CSRF and a fresh strong `If-Match`.
- Handle stale `412` by refreshing and requiring confirmation again. Treat `428` as an implementation defect.
- `202` means pending, not completed and not scheduled for automatic retry.

### `/trash/pending` and `/trash/pending/[id]`

**Backend:** deletion list, receipt status and explicit retry.

- Keep pending deletion discovery inside Trash.
- Show requested time, safe reason category when available, current status and explicit Retry.
- Never display internal tokens, storage paths, mount identities or raw errors.
- Completed receipts are terminal; retry is user initiated and does not use `If-Match`.
- Handle 200, 202, 404 and 503 without false completion.

### `/settings/account`

**Backend:** `GET /api/v1/me`, logout.

- Show username, role and useful session identity information only.
- Provide sign out.
- Do not add profile editing or avatar upload unless the backend gains those contracts.

### `/settings/security`

**Backend:** password change and logout-all.

- Show change-password form and a deliberate logout-all confirmation.
- Explain session consequences.
- No recovery, email reset or unsupported identity provider controls.

### `/settings/sessions`

**Backend:** session list and individual revocation.

- Show current and other active sessions using only id, created time, expiry and current status.
- Do not invent device, browser, location or IP metadata.
- Revoking the current session clears local state and routes to login.

### `/settings/users`

**Backend:** `GET /api/v1/users`, `POST /api/v1/users`, `POST /api/v1/users/:id/disable`

- Admin-only route and navigation entry.
- Use a clean vertical list, not a table or card dashboard.
- Each row shows username, role, status and an overflow action.
- Add user dialog fields: username, initial password and administrator current password.
- Disable requires confirmation and administrator reauthentication.
- Do not add role editing, account deletion, enable, invite or public registration.
- Hide the route for non-admins, while relying on backend authorization for real protection.

### Infrastructure routes

`GET /health` and `GET /health/ready` are service/readiness endpoints for development and operations. They are not user-facing application pages.

## 5. Component system

Use Tailwind and shadcn-svelte primitives where they improve semantics and accessibility, but keep the approved frameless visual language. Svelte Bits and Motion are enhancements, not reasons to add decorative complexity.

Core reusable components:

- `AppShell`
- `SideNav`
- `MobileNav`
- `TextAction`
- `IconAction`
- `FilledTextField`
- `PhotoGrid`
- `PhotoTile`
- `PhotoViewer`
- `UploadPanel`
- `Toast`
- `Menu`
- `Dialog`
- `SessionList`
- `UserList`

Components must expose clear loading, empty, error, disabled and focus-visible states. Prefer composition over a large global state abstraction.

## 6. API and privacy design constraints

- Keep a single typed API boundary under `web/src/lib/api/`.
- Use same-origin credentials with the HttpOnly cookie.
- Never read or persist the session cookie in browser JavaScript.
- Keep CSRF only in short-lived in-memory application state and reacquire it from `/api/v1/me` after refresh.
- Exact `Origin` is required for unsafe requests.
- Lifecycle requests have no request body at all.
- Opaque pagination cursors are passed through unchanged.
- API error envelopes are sanitized; map statuses to safe, actionable copy.
- No broad CORS, bearer substitute, open proxy or public object URL.
- W1 fixture mode must not touch real storage, PostgreSQL, `.env`, Docker volumes or backend routes.

## 7. Accessibility, motion and quality bar

- Keyboard navigation must reach every action.
- Focus-visible indication must be obvious.
- Touch targets are at least 44x44px.
- Dialogs manage focus and close safely.
- Status messages use semantic live regions where appropriate.
- Reduced-motion preferences disable nonessential movement.
- Motion is purposeful: 120–160ms brightness/opacity changes, 160–200ms panel transitions, and no distracting spring or zoom effects.
- Validate body contrast, text overflow, image loading, empty/error states, responsive behavior and browser surfaces such as selection and scrollbars.
- Never use emoji or Unicode glyphs as an icon substitute.
- Never use gradient text, decorative glass, fake metrics, card grids as the primary layout, or unsupported product claims.

## 8. Delivery and review gates

### W1: synthetic foundation

- All core screens and states exist against fixtures.
- No real API, media, database or persistent storage access.
- Visual QA at desktop, tablet and mobile sizes.
- Design review occurs before backend integration.

### W2+: integration

- Revalidate API contracts against the actual merged `integration` source.
- Prove same-origin cookie, Origin and CSRF behavior with an isolated synthetic backend/test environment.
- Add typed route clients and explicit status mapping.
- Do not modify backend security or lifecycle contracts for UI convenience.

### Final alpha review

- Capture desktop and mobile screenshots.
- Review design deviations against this document.
- Verify no private media is in public static assets.
- Run typecheck, lint, unit/component and browser tests.
- Keep commits scoped to the current `ui-integration` branch and obtain maintainer approval before pushing, merging or deploying.
