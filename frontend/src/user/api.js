const BASE = import.meta.env.VITE_API_URL ?? '';
const TOKEN_KEY = 'facepay.user.token';

/**
 * The portal token, kept separately from the merchant's.
 *
 * Separate keys as well as separate signing keys, so signing out of a till on
 * a shared machine cannot leave a customer signed in, and neither can be
 * mistaken for the other by anything reading storage.
 */
export const userToken = {
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
      // The session simply is not remembered across a reload.
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

class PortalError extends Error {
  constructor(message, { status, code } = {}) {
    super(message);
    this.name = 'PortalError';
    this.status = status;
    this.code = code;
  }
}

async function call(method, path, body) {
  const token = userToken.get();

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
    throw new PortalError('Cannot reach the server. Check your connection.', {
      code: 'network',
    });
  }

  const payload = await response.json().catch(() => null);

  if (!response.ok) {
    // An expired or deleted session should return someone to the sign-in
    // screen rather than showing an error they can do nothing about.
    if (response.status === 401 || response.status === 404) userToken.clear();

    const error = payload?.error ?? {};
    throw new PortalError(error.message ?? `Request failed (${response.status})`, {
      status: response.status,
      code: error.code,
    });
  }

  return payload;
}

export const userApi = {
  claim: (body) =>
    call('POST', '/api/user/claim', body).then((r) => {
      userToken.set(r.token);
      return r.user;
    }),

  login: (email, password) =>
    call('POST', '/api/user/login', { email, password }).then((r) => {
      userToken.set(r.token);
      return r.user;
    }),

  me: () => call('GET', '/api/user/me'),
  transactions: () => call('GET', '/api/user/transactions'),
  changePin: (currentPin, newPin) => call('POST', '/api/user/pin', { currentPin, newPin }),

  deleteFaceData: (pin) =>
    call('DELETE', '/api/user/me', { confirm: 'DELETE MY FACE DATA', pin }),

  signOut: () => userToken.clear(),
};
