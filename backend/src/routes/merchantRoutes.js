import { Router } from 'express';

import {
  history,
  login,
  stats,
  whoami,
} from '../controllers/merchantController.js';
import { charge } from '../controllers/paymentController.js';
import { asyncRoute } from '../middleware/errorHandler.js';
import { requireMerchant } from '../middleware/requireMerchant.js';

export const merchantRoutes = Router();

merchantRoutes.post('/login', asyncRoute(login));

// Everything past this point needs a signed-in merchant.
merchantRoutes.use(requireMerchant);

merchantRoutes.get('/me', asyncRoute(whoami));
merchantRoutes.get('/stats', asyncRoute(stats));
merchantRoutes.get('/transactions', asyncRoute(history));
merchantRoutes.post('/charge', asyncRoute(charge));
