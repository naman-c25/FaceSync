import express from 'express';

import { errorHandler, notFound } from './middleware/errorHandler.js';
import { enrollmentRoutes } from './routes/enrollmentRoutes.js';
import { verificationRoutes } from './routes/verificationRoutes.js';
import { mlService } from './services/mlServiceClient.js';

export function createApp() {
  const app = express();

  app.disable('x-powered-by');

  // Frames arrive as base64 JPEG. A kiosk frame is well under a megabyte, but
  // the default 100kb limit would reject them, and an unbounded limit would
  // let one caller exhaust memory.
  app.use(express.json({ limit: '8mb' }));

  app.get('/health', async (_req, res) => {
    // Reports the ML service too: this layer being up is not much use if the
    // thing that does the recognition is down, and a health check that hides
    // that is worse than none.
    let ml = { reachable: false };
    try {
      ml = { reachable: true, ...(await mlService.health()) };
    } catch (error) {
      ml.error = error.message;
    }

    res.status(ml.reachable ? 200 : 503).json({ status: 'ok', mlService: ml });
  });

  app.use('/api/enroll', enrollmentRoutes);
  app.use('/api/verify', verificationRoutes);

  app.use(notFound);
  app.use(errorHandler);

  return app;
}
