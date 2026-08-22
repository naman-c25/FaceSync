import { ApiError } from './errorHandler.js';
import { readToken } from '../services/merchantAuth.js';

/**
 * Gate a route behind a merchant session.
 *
 * Sets `req.merchant` from the *token*, and nothing downstream should read a
 * merchant id from anywhere else. A merchantId taken from a request body or a
 * query string is a value the caller chose, and treating it as identity is how
 * one terminal ends up able to read — or book takings to — another shop.
 */
export function requireMerchant(req, _res, next) {
  const header = req.headers.authorization ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;

  const payload = token && readToken(token);
  if (!payload) {
    return next(new ApiError(401, 'Sign in to continue', 'not_authenticated'));
  }

  // Belt and braces: the role is signed into the token, but the token was
  // issued from a database record whose role is the authority. Checking it
  // here means a future token type cannot reach merchant routes by accident.
  if (payload.role !== 'merchant') {
    return next(new ApiError(403, 'Not a merchant account', 'wrong_role'));
  }

  req.merchant = { id: payload.sub, merchantId: payload.merchantId };
  return next();
}
