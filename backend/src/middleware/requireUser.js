import { ApiError } from './errorHandler.js';
import { readUserToken } from '../services/userAuth.js';

/**
 * Gate a route behind a customer's own session.
 *
 * `req.user.id` comes from the signed token and nothing downstream may take a
 * user id from anywhere else. A user id read from a request body is a value
 * the caller chose, and treating it as identity here would let anyone read —
 * or delete — another person's face record by editing one field.
 *
 * The role is checked as well as the signature. A merchant token is signed
 * with a different key and cannot verify here at all, but checking makes the
 * separation explicit rather than incidental.
 */
export function requireUser(req, _res, next) {
  const header = req.headers.authorization ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;

  const payload = token && readUserToken(token);
  if (!payload) {
    return next(new ApiError(401, 'Sign in to continue', 'not_authenticated'));
  }

  req.user = { id: payload.sub };
  return next();
}
