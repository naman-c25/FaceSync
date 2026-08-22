import mongoose from 'mongoose';

import { createApp } from '../../src/app.js';
import { config } from '../../src/config/index.js';
import { createFakeMlService } from './fakeMlService.js';

/**
 * Boot everything a request test needs: a real Express app, a real MongoDB
 * connection to a throwaway database, and the fake ML service.
 *
 * The database is real rather than mocked because most of what is worth
 * testing here — TTL expiry, the candidate pool query, whether an embedding
 * survives a round trip through BSON — is behaviour of the database layer, and
 * a mock would be asserting that the mock works.
 */
export async function createTestContext() {
  if (!config.MONGODB_URI.includes('test')) {
    throw new Error(
      `Refusing to run tests against ${config.MONGODB_URI} — the database is ` +
        'dropped between tests and the URI does not look like a test one.',
    );
  }

  const ml = createFakeMlService();

  // The fake service binds the one fixed port the backend is configured to
  // call, and every test file shares one throwaway database that `reset()`
  // empties between tests. Both make running test files in parallel — which is
  // the runner's default — a deadlock on the port and a race on the data, so
  // `npm test` passes --test-concurrency=1. Said out loud here because the
  // symptom otherwise is several test processes hanging with no output at all,
  // which looks like a slow machine rather than a configuration mistake.
  try {
    await ml.listen();
  } catch (cause) {
    if (cause.code !== 'EADDRINUSE') throw cause;
    throw new Error(
      'The fake ML service port is already taken. Test files cannot run in ' +
        'parallel — use `npm test`, which sets --test-concurrency=1.',
    );
  }

  await mongoose.connect(config.MONGODB_URI);

  const server = createApp().listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  return {
    ml,
    baseUrl,

    async request(method, path, body) {
      const response = await fetch(`${baseUrl}${path}`, {
        method,
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
      const text = await response.text();
      return {
        status: response.status,
        body: text ? JSON.parse(text) : null,
      };
    },

    async reset() {
      ml.reset();
      const { collections } = mongoose.connection;
      await Promise.all(
        Object.values(collections).map((collection) => collection.deleteMany({})),
      );
    },

    async close() {
      await mongoose.connection.dropDatabase();
      await mongoose.disconnect();
      await new Promise((resolve) => server.close(resolve));
      await ml.close();
    },
  };
}

/** A tiny valid base64 payload — the fake ML service never decodes it. */
export const FAKE_FRAME = Buffer.from('not-a-real-jpeg').toString('base64');
