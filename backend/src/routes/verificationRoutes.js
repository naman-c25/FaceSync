import { Router } from 'express';

import {
  matchFace,
  startVerification,
  submitFrame,
} from '../controllers/verificationController.js';
import { asyncRoute } from '../middleware/errorHandler.js';

export const verificationRoutes = Router();

verificationRoutes.post('/start', asyncRoute(startVerification));
verificationRoutes.post('/frame', asyncRoute(submitFrame));
verificationRoutes.post('/match', asyncRoute(matchFace));
