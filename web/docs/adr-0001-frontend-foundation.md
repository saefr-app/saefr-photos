# ADR 0001 — Frontend foundation and API boundary

**Status:** Accepted for W2 (2026-11-12)  
**Scope:** `web/` alpha SvelteKit application

## Context

The approved W2 work connects the existing static SvelteKit screens to the merged NestJS/Fastify backend. The backend owns authentication, authorization, cookies, Origin/CSRF validation and all API contracts. The frontend must not weaken or duplicate those rules.

## Decisions

1. **SvelteKit 3 + TypeScript + Vite 8.** The existing `web/` app is the only frontend; protected routes run client-only (`ssr = false`) so private data is never rendered in an SSR cache or flashed before a guard runs.
2. **Same-origin development topology.**
   - Web: `http://localhost:5180` (`strictPort`).
   - API: `http://127.0.0.1:3100`.
   - Vite proxies `/api` to the API with `changeOrigin: false`, preserving the browser's exact `Origin` so the backend's `APP_ORIGIN` check continues to work. No CORS shortcut, no backend security bypass.
3. **One typed API boundary.** All requests go through `src/lib/api/`. Components never build API URLs, auth headers, CSRF headers or status parsing themselves.
4. **Cookie-only authentication.** The session is an opaque, HttpOnly, `SameSite=Lax` cookie. The browser sends it automatically. No bearer token, no cookie reads in JavaScript, and no credential or CSRF persistence in `localStorage` or `sessionStorage`.
5. **CSRF only in module memory.** The base64url CSRF token from `POST /auth/login` or `GET /me` is held in a module-level value for the lifetime of the page and reacquired from `/me` after a refresh. It is never logged or persisted.
6. **Login hygiene.** Login sends `X-Saefr-Login: 1`, exact JSON `{ username, password }`, and no CSRF header. Before login, the client calls `GET /me`; if a stale cookie is present (401), it calls `POST /auth/logout` to let the backend clear the cookie, then logs in. Login never attaches a `Cookie` header itself.
7. **Empty mutations are real empty requests.** Trash/restore/delete/logout/revoke calls send no body and no JSON `Content-Type`; the transport has an explicit no-body path.
8. **Safe status mapping.** `400`, `401`, `403`, `404`, `409`, `412`, `413`, `415`, `428`, `429` and `503` map to fixed, user-safe copy. Raw backend error text is not displayed. `429` honours `Retry-After`. There are no automatic retries.
9. **Testing.** Vitest unit tests cover the transport, CSRF holder and status mapping with a mocked `fetch`. Browser verification uses Browse paired with Microsoft Edge only. The backend remains authoritative; a 403 is never hidden by client navigation.
10. **Deferred work.** Gallery cursor/media (W3), upload (W4), trash lifecycle and deletion receipts (W5), admin CRUD (W6) and cross-flow polish (W7) are out of W2 scope. No fake backend feature is exposed in the meantime.

## Consequences

- The frontend needs the API running behind the Vite proxy for authenticated development.
- A production deployment must serve the web app and `/api` from the same origin, with HTTPS and a matching `APP_ORIGIN`; this ADR does not approve a deployment topology.
- Client-side guards improve UX only. Every protected action still depends on backend authorization.
