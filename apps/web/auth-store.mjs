const AUTH_KEY = 'pos_auth_v2';
const LEGACY_TOKEN_KEY = 'pos_token';
const LEGACY_REFRESH_KEY = 'pos_refresh_token';

function tokenExpiry(token) {
  try {
    const payload = token.split('.')[1];
    if (!payload) return null;
    const normalized = payload.replace(/-/g, '+').replace(/_/g, '/');
    const decoded = JSON.parse(atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=')));
    return Number(decoded.exp) || null;
  } catch {
    return null;
  }
}

export function loadAuth(storage = localStorage) {
  try {
    const stored = JSON.parse(storage.getItem(AUTH_KEY) ?? 'null');
    if (stored?.token || stored?.refreshToken) return stored;
  } catch {
    storage.removeItem(AUTH_KEY);
  }

  const token = storage.getItem(LEGACY_TOKEN_KEY);
  const refreshToken = storage.getItem(LEGACY_REFRESH_KEY);
  if (!token && !refreshToken) return { token: null, refreshToken: null, expiresAt: null };

  const migrated = { token, refreshToken, expiresAt: tokenExpiry(token) };
  storage.setItem(AUTH_KEY, JSON.stringify(migrated));
  return migrated;
}

export function saveAuth(data, previous = {}, storage = localStorage) {
  const auth = {
    token: data.token ?? previous.token ?? null,
    refreshToken: data.refreshToken ?? previous.refreshToken ?? null,
    expiresAt: Number(data.expiresAt)
      || (Number(data.expiresIn) ? Math.floor(Date.now() / 1000) + Number(data.expiresIn) : tokenExpiry(data.token))
      || previous.expiresAt
      || null
  };
  storage.setItem(AUTH_KEY, JSON.stringify(auth));
  if (auth.token) storage.setItem(LEGACY_TOKEN_KEY, auth.token);
  if (auth.refreshToken) storage.setItem(LEGACY_REFRESH_KEY, auth.refreshToken);
  return auth;
}

export function clearStoredAuth(storage = localStorage) {
  storage.removeItem(AUTH_KEY);
  storage.removeItem(LEGACY_TOKEN_KEY);
  storage.removeItem(LEGACY_REFRESH_KEY);
}

export function isAuthStorageEvent(event) {
  return [AUTH_KEY, LEGACY_TOKEN_KEY, LEGACY_REFRESH_KEY].includes(event.key);
}
