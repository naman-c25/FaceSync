import { Router } from 'express';

import {
  captureSample,
  finalizeEnrollment,
  startEnrollment,
} from '../controllers/enrollmentController.js';
import { asyncRoute } from '../middleware/errorHandler.js';
import { limit, sessionLimiter } from '../middleware/rateLimit.js';

export const enrollmentRoutes = Router();

enrollmentRoutes.post('/start', limit(sessionLimiter), asyncRoute(startEnrollment));
enrollmentRoutes.post('/capture', asyncRoute(captureSample));
enrollmentRoutes.post('/finalize', asyncRoute(finalizeEnrollment));
