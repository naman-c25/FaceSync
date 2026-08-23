import { Router } from 'express';

import {
  confirmPin,
  matchFace,
  startVerification,
  submitFrame,
} from '../controllers/verificationController.js';
import { asyncRoute } from '../middleware/errorHandler.js';

export const verificationRoutes = Router();

verificationRoutes.post('/start', asyncRoute(startVerification));
verificationRoutes.post('/frame', asyncRoute(submitFrame));
verificationRoutes.post('/match', asyncRoute(matchFace));

// The second factor. A match identifies; this approves — so the kiosk is two
// factors, the same as the till, rather than one.
verificationRoutes.post('/confirm', asyncRoute(confirmPin));
