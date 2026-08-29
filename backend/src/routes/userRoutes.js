import { Router } from 'express';

import {
  changePin,
  claimAccount,
  deleteFaceData,
  history,
  login,
  profile,
  resetPassword,
} from '../controllers/userController.js';
import { asyncRoute } from '../middleware/errorHandler.js';
import { authLimiter, limit } from '../middleware/rateLimit.js';
import { requireUser } from '../middleware/requireUser.js';

export const userRoutes = Router();

// Attaching an account to a face that is already enrolled, and signing back
// in. Neither is how a face gets registered — that still needs nothing.
userRoutes.post('/claim', limit(authLimiter), asyncRoute(claimAccount));
userRoutes.post('/login', limit(authLimiter), asyncRoute(login));
// Signed out by definition. The PIN is the proof, checked through the same
// lockout that guards it at a till -- there is no mail to send a link with.
userRoutes.post('/password/reset', limit(authLimiter), asyncRoute(resetPassword));

userRoutes.use(requireUser);

userRoutes.get('/me', asyncRoute(profile));
userRoutes.get('/transactions', asyncRoute(history));
userRoutes.post('/pin', asyncRoute(changePin));

// The one the consent screen promises. DELETE rather than POST because it is
// exactly what the verb is for, and it is not idempotent by accident.
userRoutes.delete('/me', asyncRoute(deleteFaceData));
