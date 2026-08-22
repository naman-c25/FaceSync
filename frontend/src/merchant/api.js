const BASE = import.meta.env.VITE_API_URL ?? '';
const TOKEN_KEY = 'facepay.merchant.token';

/**
 * The merchant token lives in localStorage so a terminal survives a reload.
 *
 * Wrapped because the accessor itself throws in a private window or with site
 * data blocked — the terminal should still work for the session in that case,
 * just not remember the login.
 */
export const tokenStore = {
  get() {
    try {
      return localStorage.getItem(TOKEN_KEY);
    } catch {
      return null;
    }
  },
  set(token) {
    try {
      localStorage.setItem(TOKEN_KEY, token);
    } catch {
      // Nothing to do — the session simply is not remembered.
    }
  },
  clear() {
    try {
      localStorage.removeItem(TOKEN_KEY);
    } catch {
      /* as above */
    }
  },
};

class MerchantApiError extends Error {
  constructor(message, { status, code } = {}) {
    super(message);
    this.name = 'MerchantApiError';
    this.status = status;
    this.code = code;
  }
}

async function request(method, path, body) {
  const token = tokenStore.get();

  let response;
  try {
    response = await fetch(`${BASE}${path}`, {
      method,
      headers: {
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new MerchantApiError('Cannot reach the server', { code: 'network' });
  }

  const payload = await response.json().catch(() => null);

  if (!response.ok) {
    // An expired or revoked session should drop the terminal back to the login
    // screen rather than leaving it showing stale takings.
    if (response.status === 401) tokenStore.clear();

    const error = payload?.error ?? {};
    throw new MerchantApiError(error.message ?? `Request failed (${response.status})`, {
      status: response.status,
      code: error.code,
    });
  }

  return payload;
}

export const merchantApi = {
  async login(email, password) {
    const result = await request('POST', '/api/merchant/login', { email, password });
    tokenStore.set(result.token);
    return result.merchant;
  },
  logout: () => tokenStore.clear(),

  me: () => request('GET', '/api/merchant/me'),
  stats: () => request('GET', '/api/merchant/stats'),
  transactions: (limit = 25) =>
    request('GET', `/api/merchant/transactions?limit=${limit}`),
  charge: (sessionId, amount) =>
    request('POST', '/api/merchant/charge', { sessionId, amount }),
};

export { MerchantApiError };
