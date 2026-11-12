// CSRF is deliberately short-lived and module-local. It is never written to
// localStorage, sessionStorage, cookies or logs; a refresh reacquires it from
// GET /api/v1/me.
let csrfToken: string | null = null;

export function setCsrfToken(token: string): void {
	csrfToken = token;
}

export function getCsrfToken(): string | null {
	return csrfToken;
}

export function clearCsrfToken(): void {
	csrfToken = null;
}
