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
    if (stored?.token || stored?.refreshToken) {
      storage.removeItem(LEGACY_TOKEN_KEY);
      storage.removeItem(LEGACY_REFRESH_KEY);
      return stored;
    }
  } catch {
    storage.removeItem(AUTH_KEY);
  }

  const token = storage.getItem(LEGACY_TOKEN_KEY);
  const refreshToken = storage.getItem(LEGACY_REFRESH_KEY);
  if (!token && !refreshToken) return { token: null, refreshToken: null, expiresAt: null };

  const migrated = { token, refreshToken, expiresAt: tokenExpiry(token) };
  storage.setItem(AUTH_KEY, JSON.stringify(migrated));
  storage.removeItem(LEGACY_TOKEN_KEY);
  storage.removeItem(LEGACY_REFRESH_KEY);
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
  storage.removeItem(LEGACY_TOKEN_KEY);
  storage.removeItem(LEGACY_REFRESH_KEY);
  return auth;
}

export function shouldRefreshAuth(auth, nowSeconds = Math.floor(Date.now() / 1000), leewaySeconds = 60) {
  if (!auth?.refreshToken) return false;
  if (!auth.token) return true;
  const expiresAt = Number(auth.expiresAt);
  if (!Number.isFinite(expiresAt) || expiresAt <= 0) return false;
  return expiresAt <= Number(nowSeconds) + Math.max(0, Number(leewaySeconds) || 0);
}

export function clearStoredAuth(storage = localStorage) {
  // Hapus kunci lama lebih dahulu agar tab lain tidak sempat memigrasikannya
  // kembali ketika menerima storage event untuk kunci utama.
  storage.removeItem(LEGACY_TOKEN_KEY);
  storage.removeItem(LEGACY_REFRESH_KEY);
  storage.removeItem(AUTH_KEY);
}

export function isAuthStorageEvent(event) {
  return [AUTH_KEY, LEGACY_TOKEN_KEY, LEGACY_REFRESH_KEY].includes(event.key);
}
