import { existsSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import express from 'express';

import { config } from './config/index.js';
import { errorHandler, notFound } from './middleware/errorHandler.js';
import { enrollmentRoutes } from './routes/enrollmentRoutes.js';
import { merchantRoutes } from './routes/merchantRoutes.js';
import { userRoutes } from './routes/userRoutes.js';
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

  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  // Authorization was missing, which worked only because the dev server
  // proxies the API onto the same origin. Deployed on two hosts, every
  // signed-in request would have failed its preflight.
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
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

    // `models_loaded` has to count, not just reachability. A container with a
    // missing native library starts fine, answers this endpoint, and fails
    // every liveness check — and a health check that returns 200 through that
    // tells the platform to keep sending traffic to it. This exact case
    // happened: MediaPipe dlopen()s libEGL lazily, so the image built and the
    // service ran while face detection was dead.
    const healthy = ml.reachable && ml.models_loaded === true;

    res.status(healthy ? 200 : 503).json({
      status: healthy ? 'ok' : 'degraded',
      mlService: ml,
    });
  });

  app.use('/api/enroll', enrollmentRoutes);
  app.use('/api/verify', verificationRoutes);
  app.use('/api/merchant', merchantRoutes);
  app.use('/api/user', userRoutes);

  serveFrontendIfBuilt(app);

  app.use(notFound);
  app.use(errorHandler);

  return app;
}

/**
 * Serve the built kiosk from this process, when it is present.
 *
 * Optional on purpose. Locally the Vite dev server owns the frontend and this
 * does nothing. Deployed, dropping `frontend/dist` here means one origin for
 * everything — no CORS, no second host to keep awake, and one URL to share.
 */
function serveFrontendIfBuilt(app) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'public');
  if (!existsSync(join(root, 'index.html'))) return;

  // Hashed asset filenames are safe to cache hard; index.html must not be, or
  // a redeploy leaves people on a stale page pointing at assets that are gone.
  app.use(
    express.static(root, {
      index: false,
      setHeaders(res, filePath) {
        // Compared by path segment rather than by substring: the separator is
        // a backslash on Windows, so a check for "assets/" silently never
        // matches there and every asset is served uncached.
        if (basename(dirname(filePath)) === 'assets') {
          res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        }
      },
    }),
  );

  app.get(/^\/(?!api\/|health$).*/, (_req, res) => {
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(join(root, 'index.html'));
  });

  console.log('[api] serving the kiosk from backend/public');
}
