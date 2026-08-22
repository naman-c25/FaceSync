import { ZodError } from 'zod';

import { MlServiceError } from '../services/mlServiceClient.js';

/** An error with an HTTP status already decided. */
export class ApiError extends Error {
  constructor(status, message, code = null) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

/** Wrap an async route so a rejected promise reaches the error handler. */
export function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

export function notFound(req, res) {
  res.status(404).json({
    error: { code: 'not_found', message: `No route for ${req.method} ${req.path}` },
  });
}

/**
 * Turn thrown errors into a consistent response shape.
 *
 * Nothing here echoes an unexpected error's message back to the client. A
 * stack trace or a driver error can name collections, paths, or configuration,
 * and a kiosk screen is a poor place to publish any of it — the details go to
 * the server log instead, where the response's status still points at them.
 */
// eslint-disable-next-line no-unused-vars -- Express identifies the error
// handler by arity; dropping `next` turns this into ordinary middleware.
export function errorHandler(error, req, res, next) {
  if (error instanceof ZodError) {
    return res.status(400).json({
      error: {
        code: 'invalid_request',
        message: 'Request body failed validation',
        issues: error.issues.map((issue) => ({
          field: issue.path.join('.'),
          message: issue.message,
        })),
      },
    });
  }

  if (error instanceof ApiError) {
    return res.status(error.status).json({
      error: { code: error.code ?? 'error', message: error.message },
    });
  }

  if (error instanceof MlServiceError) {
    console.error(`[ml-service] ${error.message}`, {
      endpoint: error.endpoint,
      status: error.status,
      detail: error.detail,
    });

    // An upstream fault is ours to own — 502. A 4xx from the ML service means
    // the request itself was wrong, and passing that status through keeps the
    // distinction visible to the caller.
    return error.isUpstreamFault
      ? res.status(502).json({
          error: {
            code: 'ml_service_unavailable',
            message: 'Face recognition service is unavailable',
          },
        })
      : res.status(error.status).json({
          error: { code: 'ml_service_rejected', message: error.detail ?? error.message },
        });
  }

  // Mongoose surfaces a malformed ObjectId as a CastError, which is a client
  // mistake rather than a server fault.
  if (error.name === 'CastError') {
    return res.status(400).json({
      error: { code: 'invalid_id', message: `Malformed ${error.path}` },
    });
  }

  console.error('[unhandled]', error);
  return res.status(500).json({
    error: { code: 'internal_error', message: 'Something went wrong' },
  });
}
