import { Router } from 'express';

import {
  history,
  login,
  register,
  stats,
  whoami,
} from '../controllers/merchantController.js';
import { charge } from '../controllers/paymentController.js';
import { startMerchantVerification } from '../controllers/verificationController.js';
import { asyncRoute } from '../middleware/errorHandler.js';
import { authLimiter, limit, sessionLimiter } from '../middleware/rateLimit.js';
import { requireMerchant } from '../middleware/requireMerchant.js';

export const merchantRoutes = Router();

merchantRoutes.post('/login', limit(authLimiter), asyncRoute(login));
// Open to anyone, and it grants nothing on its own: the account it makes
// cannot start a verification until somebody approves it.
merchantRoutes.post('/register', limit(authLimiter), asyncRoute(register));

// Everything past this point needs a signed-in merchant.
merchantRoutes.use(requireMerchant);

merchantRoutes.get('/me', asyncRoute(whoami));
merchantRoutes.get('/stats', asyncRoute(stats));
merchantRoutes.get('/transactions', asyncRoute(history));
merchantRoutes.post('/charge', asyncRoute(charge));

// The till's scan. Here rather than on the public verification router so
// that the shop it is booked to comes from the token, never the body.
merchantRoutes.post('/verify/start', limit(sessionLimiter), asyncRoute(startMerchantVerification));
