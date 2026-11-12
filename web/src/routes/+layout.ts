// Protected routes are client-only: the session lives in an HttpOnly cookie
// and every decision is made by GET /api/v1/me from the browser.
export const ssr = false;
export const prerender = false;
