import express from 'express';

import { config } from './config/index.js';
import { errorHandler, notFound } from './middleware/errorHandler.js';
import { enrollmentRoutes } from './routes/enrollmentRoutes.js';
import { verificationRoutes } from './routes/verificationRoutes.js';
import { mlService } from './services/mlServiceClient.js';

const allowedOrigins = config.CORS_ORIGINS.split(',').map((value) => value.trim());

/**
 * Allow the deployed frontend to call this API from a browser.
 *
 * `Access-Control-Allow-Credentials` is deliberately never set. The API uses
 * no cookies — session ids travel in the request body — so echoing an origin
 * back grants a third-party page nothing it could not obtain by calling this
 * API from its own server.
 */
function cors(req, res, next) {
  const origin = req.headers.origin;

  if (allowedOrigins.includes('*')) {
    res.setHeader('Access-Control-Allow-Origin', '*');
  } else if (origin && allowedOrigins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    // Caches must not serve one origin's response to another.
    res.setHeader('Vary', 'Origin');
  }

  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Max-Age', '86400');

  // A preflight carries no body and expects no content.
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  return next();
}

export function createApp() {
  const app = express();

  app.disable('x-powered-by');
  app.use(cors);

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
