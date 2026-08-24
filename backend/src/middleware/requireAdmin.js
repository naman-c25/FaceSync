import { ApiError } from './errorHandler.js';
import { readToken } from '../services/merchantAuth.js';

/**
 * Gate a route behind an admin account.
 *
 * Separate from `requireMerchant` rather than a flag on it, because the two
 * answer different questions. A merchant token proves "this request belongs to
 * shop X" and everything downstream scopes itself to X. An admin token proves
 * the opposite: that this request is allowed to see across every shop.
 *
 * Fraud flags are the second kind. They span terminals by definition — a rule
 * about one device is only interesting next to the others — so serving them to
 * a merchant account would show one shop the failure patterns of every other.
 * Admins are created from the command line, the same way merchants are, for
 * the same reason: an account that can read everyone's traffic is not something
 * anyone should be able to grant themselves.
 */
export function requireAdmin(req, _res, next) {
  const header = req.headers.authorization ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;

  const payload = token && readToken(token);
  if (!payload) {
    return next(new ApiError(401, 'Sign in to continue', 'not_authenticated'));
  }

  if (payload.role !== 'admin') {
    return next(new ApiError(403, 'Not an admin account', 'wrong_role'));
  }

  req.admin = { id: payload.sub, merchantId: payload.merchantId };
  return next();
}
