import { Router } from 'express';

import {
  clear,
  confirm,
  detail,
  list,
} from '../controllers/fraudDashboardController.js';
import { asyncRoute } from '../middleware/errorHandler.js';
import { requireAdmin } from '../middleware/requireAdmin.js';

export const fraudRoutes = Router();

// Every route here, without exception. Flags span terminals, so there is no
// version of this a shop should see — which makes a router-level gate the
// right shape: a new route added below cannot forget to ask.
fraudRoutes.use(requireAdmin);

fraudRoutes.get('/flags', asyncRoute(list));
fraudRoutes.get('/flags/:id', asyncRoute(detail));

// Two separate verdicts rather than one "reviewed" state, because the
// difference is the only feedback the thresholds will ever get. A pile of
// cleared flags on one rule is that rule saying it is tuned too tight.
fraudRoutes.post('/flags/:id/clear', asyncRoute(clear));
fraudRoutes.post('/flags/:id/confirm', asyncRoute(confirm));
