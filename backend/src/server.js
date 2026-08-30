import mongoose from 'mongoose';

import { createApp } from './app.js';
import { config } from './config/index.js';
import { buildCandidatePool } from './services/candidatePool.js';
import * as gallerySync from './services/gallerySync.js';

async function main() {
  await mongoose.connect(config.MONGODB_URI);
  console.log("DB connected successfull");

  // Without this the TTL index on sessions is only created lazily, and an
  // abandoned kiosk session would sit in the collection until someone noticed.
  await mongoose.connection.syncIndexes?.().catch(() => {});

  const server = createApp().listen(config.PORT, () => {
    console.log(`[api] listening on http://127.0.0.1:${config.PORT}`);
    console.log(`[api] ML service at ${config.ML_SERVICE_URL}`);
  });

  // Build the gallery and hand it to the ML service before a customer asks
  // for it. The first scan after a restart otherwise pays for the whole
  // thing: 1.2 seconds at two thousand signatures, and about 30 at ten
  // thousand -- past the ML timeout, so at that size the first person after a
  // deploy does not wait, they fail.
  //
  // Deliberately not awaited. The service is already listening and answering
  // /health; making startup depend on a warm cache would turn a slow first
  // scan into a deployment that never comes up.
  gallerySync
    .warm(() => buildCandidatePool({ narrow: false }))
    .catch((cause) => console.error('[gallery] warm-up rejected:', cause.message));

  const shutdown = async (signal) => {
    console.log(`\n[api] ${signal} received, shutting down`);
    server.close();
    await mongoose.disconnect();
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((error) => {
  console.error('[api] failed to start:', error.message);
  process.exit(1);
});
