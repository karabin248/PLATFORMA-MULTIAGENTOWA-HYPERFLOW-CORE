import { setBaseUrl, setAuthTokenGetter } from "@workspace/api-client-react";

const TOKEN_STORAGE_KEY = "hyperflow.apiToken";

function readEnvToken(): string | null {
  const raw = (import.meta.env.VITE_API_TOKEN as string | undefined) ?? null;
  return raw && raw.length > 0 ? raw : null;
}

function readStoredToken(): string | null {
  try {
    const raw = window.localStorage.getItem(TOKEN_STORAGE_KEY);
    return raw && raw.length > 0 ? raw : null;
  } catch {
    return null;
  }
}

export function setOperatorToken(token: string | null): void {
  try {
    if (token && token.length > 0) {
      window.localStorage.setItem(TOKEN_STORAGE_KEY, token);
    } else {
      window.localStorage.removeItem(TOKEN_STORAGE_KEY);
    }
  } catch {
    // ignore storage errors (private mode, quota, etc.)
  }
}

export function getOperatorToken(): string | null {
  return readEnvToken() ?? readStoredToken();
}

function isSameOriginBaseUrl(baseUrl: string): boolean {
  // Relative URLs (path-only, "/api", "./api") are always same-origin.
  if (!/^[a-z][a-z0-9+.-]*:/i.test(baseUrl)) return true;
  try {
    const target = new URL(baseUrl, window.location.href);
    return target.origin === window.location.origin;
  } catch {
    return false;
  }
}

export function initApiClient(): void {
  const baseUrl = (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? "/api";
  setBaseUrl(baseUrl);
  // Only attach the bearer token when the API target is same-origin. This
  // prevents accidental token exfiltration if VITE_API_BASE_URL is ever
  // misconfigured to point at a third-party host.
  if (isSameOriginBaseUrl(baseUrl)) {
    setAuthTokenGetter(() => getOperatorToken());
  } else {
    // eslint-disable-next-line no-console
    console.warn(
      "[hyperflow] VITE_API_BASE_URL is cross-origin; bearer token injection is disabled.",
    );
  }
}
