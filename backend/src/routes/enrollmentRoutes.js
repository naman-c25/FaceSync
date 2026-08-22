import { Router } from 'express';

import {
  captureSample,
  finalizeEnrollment,
  startEnrollment,
} from '../controllers/enrollmentController.js';
import { asyncRoute } from '../middleware/errorHandler.js';

export const enrollmentRoutes = Router();

enrollmentRoutes.post('/start', asyncRoute(startEnrollment));
enrollmentRoutes.post('/capture', asyncRoute(captureSample));
enrollmentRoutes.post('/finalize', asyncRoute(finalizeEnrollment));
