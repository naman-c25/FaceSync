import { Router } from 'express';

import {
  confirmPin,
  matchFace,
  startVerification,
  submitFrame,
} from '../controllers/verificationController.js';
import { asyncRoute } from '../middleware/errorHandler.js';
import { limit, sessionLimiter } from '../middleware/rateLimit.js';

export const verificationRoutes = Router();

verificationRoutes.post('/start', limit(sessionLimiter), asyncRoute(startVerification));
verificationRoutes.post('/frame', asyncRoute(submitFrame));
verificationRoutes.post('/match', asyncRoute(matchFace));

// The second factor. A match identifies; this approves — so the kiosk is two
// factors, the same as the till, rather than one.
verificationRoutes.post('/confirm', asyncRoute(confirmPin));
