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

// Exported so another surface can reuse the transport without a second
// copy of the token handling and the 401 rule. It stays here rather than
// moving to a shared module because this is where the token lives.
export async function request(method, path, body) {
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
    // screen rather than leaving it showing stale takings. Only 401 does this:
    // a PIN lockout comes back as 423 and must not sign the merchant out.
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
  async register(name, email, password) {
    const result = await request('POST', '/api/merchant/register', {
      name,
      email,
      password,
    });
    tokenStore.set(result.token);
    return result.merchant;
  },
  logout: () => tokenStore.clear(),

  me: () => request('GET', '/api/merchant/me'),
  stats: () => request('GET', '/api/merchant/stats'),
  transactions: (limit = 25) =>
    request('GET', `/api/merchant/transactions?limit=${limit}`),
  // The shop is taken from the token server-side, so nothing here names one.
  // When it was sent in the body, the approval check was asking the caller
  // which identity to check them against -- and an unapproved terminal could
  // simply send somebody else's.
  startVerification: (body) => request('POST', '/api/merchant/verify/start', body),

  // `pin` is absent on the first call: the till cannot ask whose PIN to enter
  // until the face has been identified, so the flow is scan, prompt, charge.
  charge: (sessionId, amount, pin) =>
    request('POST', '/api/merchant/charge', { sessionId, amount, pin }),
};

export { MerchantApiError };
