import mongoose from 'mongoose';

import { createApp } from './app.js';
import { config } from './config/index.js';

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
