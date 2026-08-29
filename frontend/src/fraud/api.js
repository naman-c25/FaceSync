import { request, tokenStore } from '../merchant/api.js';

/**
 * The fraud dashboard's calls.
 *
 * Admins sign in through the merchant login endpoint and get a token with
 * `role: 'admin'` — one account table, one token format, two roles. So the
 * transport and the token store are the merchant module's, reused rather than
 * copied: a second implementation of "attach the bearer, sign out on 401" is a
 * second place for that rule to drift.
 *
 * What is *not* shared is what the API will serve. `/api/fraud/*` is gated on
 * the admin role at the router, so a merchant token reaching these calls gets
 * a 403 rather than somebody else's traffic.
 */
export const fraudApi = {
  async login(email, password) {
    const result = await request('POST', '/api/merchant/login', {
      email,
      password,
    });
    tokenStore.set(result.token);
    return result.merchant;
  },
  logout: () => tokenStore.clear(),
  hasToken: () => Boolean(tokenStore.get()),

  flags: ({ status = 'open', severity } = {}) => {
    const params = new URLSearchParams({ status });
    if (severity) params.set('severity', severity);
    return request('GET', `/api/fraud/flags?${params}`);
  },

  detail: (id) => request('GET', `/api/fraud/flags/${id}`),

  // Shops waiting to be allowed to point a camera at customers.
  pendingMerchants: () => request('GET', '/api/fraud/merchants/pending'),
  approveMerchant: (id) =>
    request('POST', `/api/fraud/merchants/${id}/verify`),

  clear: (id, note) => request('POST', `/api/fraud/flags/${id}/clear`, { note }),
  confirm: (id, note) =>
    request('POST', `/api/fraud/flags/${id}/confirm`, { note }),
};
